/** Durable, fair, bounded scheduler for external feed refreshes. */

import { fetchAndStoreRssFeed, type FeedToFetch } from './rss-fetcher';
import { safeHost, selectFeedsFairly } from './refresh-policy';
import type { Env } from './types';

const CANDIDATE_LIMIT = 200;
const REFRESH_LIMIT = 100;
const MAX_GLOBAL_CONCURRENCY = 8;
const MAX_HOST_CONCURRENCY = 2;
const LEASE_MINUTES = 3;
const ACTIVITY_RETENTION_DAYS = 30;
const ARTICLE_BODY_RETENTION_DAYS = 180;
const MIN_ITEMS_WITH_BODIES_PER_FEED = 200;
const BODY_PRUNE_BATCH_SIZE = 500;

export const READ_CONTENT_RETENTION_SQL = `WITH ranked_items AS (
  SELECT id,
         received_at,
         is_read,
         is_starred,
         ROW_NUMBER() OVER (
           PARTITION BY feed_key
           ORDER BY datetime(received_at) DESC, id DESC
         ) AS feed_rank
  FROM items
)
UPDATE items
SET html_content = '<p>This older read article is no longer stored offline.</p>',
    text_content = NULL,
    content_size = 0,
    content_pruned_at = ?
WHERE id IN (
  SELECT id
  FROM ranked_items
  WHERE feed_rank > ?
    AND is_read = 1
    AND is_starred = 0
    AND datetime(received_at) < datetime(?, '-' || ? || ' days')
  LIMIT ?
)
AND content_pruned_at IS NULL`;

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

		await pruneRefreshActivity(env.DB, now);
		await pruneOldReadContent(env.DB, now);
	} catch (error) {
		console.error('[Cron] Refresh cycle failed', error instanceof Error ? error.message : String(error));
	}
}

async function pruneOldReadContent(db: D1Database, now: Date): Promise<void> {
	await db.prepare(READ_CONTENT_RETENTION_SQL)
		.bind(
			now.toISOString(),
			MIN_ITEMS_WITH_BODIES_PER_FEED,
			now.toISOString(),
			ARTICLE_BODY_RETENTION_DAYS,
			BODY_PRUNE_BATCH_SIZE,
		)
		.run();
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

async function pruneRefreshActivity(db: D1Database, now: Date): Promise<void> {
	await db.prepare(
		`DELETE FROM refresh_activity
		 WHERE datetime(attempted_at) < datetime(?, '-' || ? || ' days')
		   AND id NOT IN (
		     SELECT activity.id
		     FROM refresh_activity activity
		     JOIN (
		       SELECT feed_key, MAX(attempted_at) AS attempted_at
		       FROM refresh_activity
		       GROUP BY feed_key
		     ) latest
		       ON latest.feed_key = activity.feed_key
		      AND latest.attempted_at = activity.attempted_at
		   )`,
	)
		.bind(now.toISOString(), ACTIVITY_RETENTION_DAYS)
		.run();
}
