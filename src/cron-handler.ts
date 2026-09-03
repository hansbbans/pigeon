/** Durable, fair, bounded scheduler for external feed refreshes. */

import { fetchAndStoreRssFeed, type FeedToFetch } from './rss-fetcher';
import { safeHost, selectFeedsFairly } from './refresh-policy';
import type { Env } from './types';

const CANDIDATE_LIMIT = 200;
// Each leased feed uses up to three D1 calls (claim, renewal, persistence).
// Five leaves headroom under the Workers Free 50-subrequest invocation cap,
// including a first-run migration and daily maintenance coordination.
const REFRESH_LIMIT = 5;
const MAX_GLOBAL_CONCURRENCY = 8;
const MAX_HOST_CONCURRENCY = 2;
const LEASE_MINUTES = 3;
const ACTIVITY_RETENTION_DAYS = 30;
const ARTICLE_BODY_RETENTION_DAYS = 180;
const MIN_ITEMS_WITH_BODIES_PER_FEED = 200;
const BODY_PRUNE_BATCH_SIZE = 500;
const ACTIVITY_PRUNE_BATCH_SIZE = 500;
// Indexed cleanup is also write-bounded: five feeds can prune at most 2,500
// article bodies and 2,500 activity rows before index/trigger maintenance.
const MAINTENANCE_FEED_BATCH_SIZE = 5;
const DAILY_RETENTION_JOB = 'daily_retention';
const DAILY_RETENTION_LEASE_MINUTES = 15;

export const READ_CONTENT_RETENTION_SQL = `WITH retention_boundary AS (
  SELECT datetime(received_at) AS received_sort, id
  FROM items
  WHERE feed_key = ?
  ORDER BY datetime(received_at) DESC, id DESC
  LIMIT 1 OFFSET ?
), prune_candidates AS (
  SELECT candidate.id
  FROM items candidate
  CROSS JOIN retention_boundary boundary
  WHERE candidate.feed_key = ?
    AND candidate.content_pruned_at IS NULL
    AND candidate.is_read = 1
    AND candidate.is_starred = 0
    AND datetime(candidate.received_at) < datetime(?)
    AND (
      datetime(candidate.received_at) < boundary.received_sort
      OR (
        datetime(candidate.received_at) = boundary.received_sort
        AND candidate.id < boundary.id
      )
    )
  ORDER BY datetime(candidate.received_at) ASC, candidate.id ASC
  LIMIT ?
)
UPDATE items
SET html_content = '<p>This older read article is no longer stored offline.</p>',
    text_content = NULL,
    content_size = 0,
    content_pruned_at = ?
WHERE id IN (
  SELECT id
  FROM prune_candidates
)
AND EXISTS (
  SELECT 1
  FROM maintenance_state
  WHERE job_name = ? AND claimed_day = ? AND claim_token = ?
)`;

export const REFRESH_ACTIVITY_RETENTION_SQL = `DELETE FROM refresh_activity
WHERE id IN (
  SELECT candidate.id
  FROM refresh_activity candidate
  WHERE candidate.feed_key = ?
    AND candidate.attempted_at < ?
    AND candidate.id <> (
      SELECT latest.id
      FROM refresh_activity latest
      WHERE latest.feed_key = ?
      ORDER BY latest.attempted_at DESC, latest.id DESC
      LIMIT 1
    )
  ORDER BY candidate.attempted_at ASC, candidate.id ASC
  LIMIT ?
)
AND EXISTS (
  SELECT 1
  FROM maintenance_state
  WHERE job_name = ? AND claimed_day = ? AND claim_token = ?
)`;

interface MaintenanceFeedRow {
	feed_key: string;
}

interface RefreshCandidate extends FeedToFetch {
	fetch_interval_minutes: number | null;
	consecutive_failures: number | null;
	content_hash: string | null;
	conditional_checked_at: string | null;
	next_fetch_at: string | null;
}

export async function handleCronTrigger(env: Env): Promise<void> {
	const now = new Date();
	try {
		const { results } = await env.DB.prepare(
			`SELECT feed_key, source_url, etag, last_modified, fetch_interval_minutes,
			        consecutive_failures, content_hash, conditional_checked_at, next_fetch_at
			 FROM feeds
			 WHERE source_type = 'rss'
			   AND is_active = 1
			   AND source_url IS NOT NULL
			   AND (refresh_lease_until IS NULL OR datetime(refresh_lease_until) <= datetime(?))
			   AND (
			     (next_fetch_at IS NOT NULL AND datetime(next_fetch_at) <= datetime(?))
			     OR (
			       next_fetch_at IS NULL
			       AND (
			         last_fetched_at IS NULL
			         OR datetime(last_fetched_at, '+' || COALESCE(fetch_interval_minutes, 60) || ' minutes') <= datetime(?)
			       )
			     )
			   )
			 ORDER BY COALESCE(next_fetch_at, last_fetched_at, first_seen_at) ASC,
			          consecutive_failures ASC,
			          feed_key ASC
			 LIMIT ?`,
		)
			.bind(now.toISOString(), now.toISOString(), now.toISOString(), CANDIDATE_LIMIT)
			.all<RefreshCandidate>();

		const fairCandidates = selectFeedsFairly(results, REFRESH_LIMIT);
		const leased: RefreshCandidate[] = [];
		for (const candidate of fairCandidates) {
			const token = crypto.randomUUID();
			const leaseUntil = new Date(now.getTime() + LEASE_MINUTES * 60_000).toISOString();
			const leaseResult = await env.DB.prepare(
				`UPDATE feeds
				 SET refresh_lease_until = ?, refresh_lease_token = ?
				 WHERE feed_key = ?
				   AND is_active = 1
				   AND (refresh_lease_until IS NULL OR datetime(refresh_lease_until) <= datetime(?))
				   AND (
				     (next_fetch_at IS NOT NULL AND datetime(next_fetch_at) <= datetime(?))
				     OR next_fetch_at IS NULL
				   )`,
			)
				.bind(leaseUntil, token, candidate.feed_key, now.toISOString(), now.toISOString())
				.run();
			if (leaseResult?.meta?.changes === 0) continue;
			leased.push({ ...candidate, refresh_lease_token: token });
		}

		if (leased.length > 0) {
			console.log(`[Cron] Refreshing ${leased.length} feeds with bounded host concurrency`);
			await runWithRefreshLimits(leased, (feed) => fetchAndStoreRssFeed(env, feed));
		} else {
			console.log('[Cron] No feeds due for refresh');
		}
	} catch (error) {
		console.error('[Cron] Refresh cycle failed', error instanceof Error ? error.message : String(error));
	}

	try {
		const retentionNow = new Date();
		if (await runDailyRetention(env.DB, retentionNow)) {
			console.log(`[Cron] Completed daily retention for ${utcDay(retentionNow)}`);
		}
	} catch (error) {
		console.error('[Cron] Daily retention failed', error instanceof Error ? error.message : String(error));
	}
}

/**
 * Attempts the once-per-UTC-day maintenance lease. The claim is an atomic D1
 * update, so only one cold isolate can run either retention scan for a day.
 * Completion and release both include the claim token to avoid touching a
 * lease that has since expired and been reassigned.
 */
export async function runDailyRetention(db: D1Database, now = new Date()): Promise<boolean> {
	const day = utcDay(now);
	const token = crypto.randomUUID();
	const leaseUntil = new Date(now.getTime() + DAILY_RETENTION_LEASE_MINUTES * 60_000).toISOString();
	const claimResult = await db
		.prepare(
			`UPDATE maintenance_state
			 SET claimed_day = ?, claim_token = ?, lease_until = ?
			 WHERE job_name = ?
			   AND (completed_day IS NULL OR completed_day < ?)
			   AND (
			     claimed_day IS NULL
			     OR claim_token IS NULL
			     OR lease_until IS NULL
			     OR datetime(lease_until) <= datetime(?)
			   )`,
		)
		.bind(day, token, leaseUntil, DAILY_RETENTION_JOB, day, now.toISOString())
		.run();

	if (Number(claimResult?.meta?.changes ?? 0) !== 1) {
		return false;
	}

	try {
		const claim = await db
			.prepare(
				`SELECT cursor_feed_key
				 FROM maintenance_state
				 WHERE job_name = ? AND claimed_day = ? AND claim_token = ?`,
			)
			.bind(DAILY_RETENTION_JOB, day, token)
			.first<{ cursor_feed_key: string | null }>();
		if (!claim) {
			return false;
		}

		const feeds = await selectMaintenanceFeeds(db, claim.cursor_feed_key);
		const selectedFeeds = feeds.slice(0, MAINTENANCE_FEED_BATCH_SIZE);
		const nextCursor = feeds.length > MAINTENANCE_FEED_BATCH_SIZE
			? selectedFeeds.at(-1)?.feed_key ?? null
			: null;
		const statements = selectedFeeds.flatMap(({ feed_key: feedKey }) => [
			pruneRefreshActivityStatement(db, feedKey, now, day, token),
			pruneOldReadContentStatement(db, feedKey, now, day, token),
		]);
		statements.push(
			db
				.prepare(
					`UPDATE maintenance_state
					 SET completed_day = ?, cursor_feed_key = ?,
					     claimed_day = NULL, claim_token = NULL, lease_until = NULL
					 WHERE job_name = ? AND claimed_day = ? AND claim_token = ?`,
				)
				.bind(day, nextCursor, DAILY_RETENTION_JOB, day, token),
		);

		const results = await db.batch(statements);
		const completionResult = results.at(-1);
		if (Number(completionResult?.meta?.changes ?? 0) !== 1) {
			console.error(`[Cron] Daily retention lease was lost before completing ${day}`);
			return false;
		}
		return true;
	} catch (error) {
		try {
			await db
				.prepare(
					`UPDATE maintenance_state
					 SET claimed_day = NULL, claim_token = NULL, lease_until = NULL
					 WHERE job_name = ? AND claimed_day = ? AND claim_token = ?`,
				)
				.bind(DAILY_RETENTION_JOB, day, token)
				.run();
		} catch (releaseError) {
			console.error(
				'[Cron] Failed to release daily retention lease',
				releaseError instanceof Error ? releaseError.message : String(releaseError),
			);
		}
		throw error;
	}
}

function utcDay(now: Date): string {
	return now.toISOString().slice(0, 10);
}

async function selectMaintenanceFeeds(db: D1Database, cursorFeedKey: string | null): Promise<MaintenanceFeedRow[]> {
	const limit = MAINTENANCE_FEED_BATCH_SIZE + 1;
	if (cursorFeedKey !== null) {
		const { results } = await db
			.prepare('SELECT feed_key FROM feeds WHERE feed_key > ? ORDER BY feed_key LIMIT ?')
			.bind(cursorFeedKey, limit)
			.all<MaintenanceFeedRow>();
		if (results.length > 0) {
			return results;
		}
	}

	const { results } = await db
		.prepare('SELECT feed_key FROM feeds ORDER BY feed_key LIMIT ?')
		.bind(limit)
		.all<MaintenanceFeedRow>();
	return results;
}

function pruneOldReadContentStatement(
	db: D1Database,
	feedKey: string,
	now: Date,
	day: string,
	token: string,
): D1PreparedStatement {
	const cutoff = new Date(now.getTime() - ARTICLE_BODY_RETENTION_DAYS * 86_400_000).toISOString();
	return db.prepare(READ_CONTENT_RETENTION_SQL)
		.bind(
			feedKey,
			MIN_ITEMS_WITH_BODIES_PER_FEED - 1,
			feedKey,
			cutoff,
			BODY_PRUNE_BATCH_SIZE,
			now.toISOString(),
			DAILY_RETENTION_JOB,
			day,
			token,
		);
}

export async function runWithRefreshLimits<T extends FeedToFetch>(
	feeds: T[],
	operation: (feed: T) => Promise<unknown>,
	globalLimit = MAX_GLOBAL_CONCURRENCY,
	hostLimit = MAX_HOST_CONCURRENCY,
): Promise<void> {
	if (feeds.length === 0) return;
	const queue = [...feeds];
	const activeByHost = new Map<string, number>();
	let active = 0;

	await new Promise<void>((resolve) => {
		const launch = () => {
			while (active < globalLimit && queue.length > 0) {
				const index = queue.findIndex(
					(feed) => (activeByHost.get(safeHost(feed.source_url)) ?? 0) < hostLimit,
				);
				if (index === -1) break;
				const [feed] = queue.splice(index, 1);
				const host = safeHost(feed.source_url);
				active += 1;
				activeByHost.set(host, (activeByHost.get(host) ?? 0) + 1);
				void operation(feed)
					.catch((error) => {
						console.error(`[Cron] Refresh task failed for ${feed.feed_key}`, error);
					})
					.finally(() => {
						active -= 1;
						const hostActive = (activeByHost.get(host) ?? 1) - 1;
						if (hostActive === 0) activeByHost.delete(host);
						else activeByHost.set(host, hostActive);
						if (queue.length === 0 && active === 0) resolve();
						else launch();
					});
			}
			if (queue.length === 0 && active === 0) resolve();
		};
		launch();
	});
}

function pruneRefreshActivityStatement(
	db: D1Database,
	feedKey: string,
	now: Date,
	day: string,
	token: string,
): D1PreparedStatement {
	const cutoff = new Date(now.getTime() - ACTIVITY_RETENTION_DAYS * 86_400_000).toISOString();
	return db.prepare(REFRESH_ACTIVITY_RETENTION_SQL)
		.bind(
			feedKey,
			cutoff,
			feedKey,
			ACTIVITY_PRUNE_BATCH_SIZE,
			DAILY_RETENTION_JOB,
			day,
			token,
		);
}
