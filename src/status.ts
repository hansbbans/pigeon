import { requireApiAuth } from './api-auth';
import { ensureDatabaseSchema } from './migrations';
import type { Env } from './types';
import { redactRefreshError } from './refresh-policy';

interface FeedCountsRow {
	active_feed_count: number | null;
	email_feed_count: number | null;
	rss_feed_count: number | null;
	failing_rss_feed_count: number | null;
}

interface ItemCountsRow {
	total_item_count: number | null;
	unread_item_count: number | null;
	starred_item_count: number | null;
	newest_item_at: string | null;
}

interface ValueRow {
	value: string | null;
}

interface FailingFeedRow {
	feed_key: string;
	title: string;
	fetch_error: string;
	last_fetched_at: string | null;
}

interface SyncHealthCountsRow {
	due_count: number | null;
	backed_off_count: number | null;
	leased_count: number | null;
	healthy_count: number | null;
}

interface FeedHealthRow {
	feed_key: string;
	title: string;
	source_url: string;
	last_attempt_at: string | null;
	last_success_at: string | null;
	next_fetch_at: string | null;
	retry_after_at: string | null;
	consecutive_failures: number;
	last_http_status: number | null;
	last_refresh_outcome: string | null;
	last_fetch_duration_ms: number | null;
	fetch_error: string | null;
}

interface RefreshActivityRow {
	feed_key: string;
	title: string;
	attempted_at: string;
	outcome: string;
	http_status: number | null;
	duration_ms: number;
	items_added: number;
	error_code: string | null;
	error_message: string | null;
	retry_at: string | null;
}

function asCount(value: number | null | undefined): number {
	return value ?? 0;
}

async function getSchemaVersion(env: Env): Promise<string> {
	try {
		const schemaVersion = await env.DB.prepare(
			"SELECT value FROM _meta WHERE key = 'schema_version'",
		).first<ValueRow>();

		return schemaVersion?.value ?? 'unknown';
	} catch {
		return 'unknown';
	}
}

export async function handleStatusRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	const authErr = await requireApiAuth(request, env.API_PASSWORD);
	if (authErr) {
		return authErr;
	}

	try {
		await ensureDatabaseSchema(env);
	} catch (error) {
		console.error('[Migrations] Status request failed because database migration failed', error);
		return new Response('Database migration failed', { status: 503 });
	}

	const currentOrigin = new URL(request.url).origin;
	const schemaVersion = await getSchemaVersion(env);

	const { results: feedCountsResults } = await env.DB.prepare(
		`SELECT COUNT(*) AS active_feed_count,
		        SUM(CASE WHEN source_type = 'email' THEN 1 ELSE 0 END) AS email_feed_count,
		        SUM(CASE WHEN source_type = 'rss' THEN 1 ELSE 0 END) AS rss_feed_count,
		        SUM(CASE WHEN source_type = 'rss' AND COALESCE(fetch_error, '') != '' THEN 1 ELSE 0 END) AS failing_rss_feed_count
		   FROM feeds
		  WHERE is_active = 1`,
	).all<FeedCountsRow>();

	const { results: itemCountsResults } = await env.DB.prepare(
		`SELECT COUNT(*) AS total_item_count,
		        SUM(CASE WHEN i.is_read = 0 AND f.is_active = 1 THEN 1 ELSE 0 END) AS unread_item_count,
		        SUM(CASE WHEN i.is_starred = 1 THEN 1 ELSE 0 END) AS starred_item_count,
		        MAX(CASE WHEN f.is_active = 1 THEN i.received_at ELSE NULL END) AS newest_item_at
		   FROM items i
		   LEFT JOIN feeds f ON f.feed_key = i.feed_key`,
	).all<ItemCountsRow>();

	const newestEmailItem = await env.DB.prepare(
		`SELECT MAX(i.received_at) AS value
		   FROM items i
		   JOIN feeds f ON f.feed_key = i.feed_key
		  WHERE f.source_type = 'email'
		    AND f.is_active = 1`,
	).first<ValueRow>();

	const newestRssItem = await env.DB.prepare(
		`SELECT MAX(i.received_at) AS value
		   FROM items i
		   JOIN feeds f ON f.feed_key = i.feed_key
		  WHERE f.source_type = 'rss'
		    AND f.is_active = 1`,
	).first<ValueRow>();

	const latestFetchAttempt = await env.DB.prepare(
		`SELECT MAX(last_fetched_at) AS value FROM feeds WHERE source_type = 'rss' AND is_active = 1`,
	).first<ValueRow>();

	const { results: failingFeeds } = await env.DB.prepare(
		`SELECT feed_key,
		        COALESCE(custom_title, display_name) AS title,
		        fetch_error,
		        last_fetched_at
		   FROM feeds
		  WHERE is_active = 1
		    AND source_type = 'rss'
		    AND COALESCE(fetch_error, '') != ''
		  ORDER BY last_fetched_at DESC
		  LIMIT 5`,
	).all<FailingFeedRow>();

	const now = new Date().toISOString();
	const { results: syncHealthCountsResults } = await env.DB.prepare(
		`SELECT
		   SUM(CASE WHEN next_fetch_at IS NOT NULL AND datetime(next_fetch_at) <= datetime(?) THEN 1 ELSE 0 END) AS due_count,
		   SUM(CASE WHEN retry_after_at IS NOT NULL AND datetime(retry_after_at) > datetime(?) THEN 1 ELSE 0 END) AS backed_off_count,
		   SUM(CASE WHEN refresh_lease_until IS NOT NULL AND datetime(refresh_lease_until) > datetime(?) THEN 1 ELSE 0 END) AS leased_count,
		   SUM(CASE WHEN last_success_at IS NOT NULL AND consecutive_failures = 0 THEN 1 ELSE 0 END) AS healthy_count
		 FROM feeds
		 WHERE source_type = 'rss' AND is_active = 1`,
	)
		.bind(now, now, now)
		.all<SyncHealthCountsRow>();

	const { results: feedHealth } = await env.DB.prepare(
		`SELECT feed_key,
		        COALESCE(custom_title, display_name) AS title,
		        source_url,
		        last_attempt_at,
		        last_success_at,
		        next_fetch_at,
		        retry_after_at,
		        consecutive_failures,
		        last_http_status,
		        last_refresh_outcome,
		        last_fetch_duration_ms,
		        fetch_error
		 FROM feeds
		 WHERE source_type = 'rss' AND is_active = 1
		 ORDER BY consecutive_failures DESC, COALESCE(last_attempt_at, first_seen_at) DESC
		 LIMIT 100`,
	).all<FeedHealthRow>();

	const { results: recentActivity } = await env.DB.prepare(
		`SELECT activity.feed_key,
		        COALESCE(feeds.custom_title, feeds.display_name, activity.feed_key) AS title,
		        activity.attempted_at,
		        activity.outcome,
		        activity.http_status,
		        activity.duration_ms,
		        activity.items_added,
		        activity.error_code,
		        activity.error_message,
		        activity.retry_at
		 FROM refresh_activity activity
		 LEFT JOIN feeds ON feeds.feed_key = activity.feed_key
		 ORDER BY activity.attempted_at DESC
		 LIMIT 25`,
	).all<RefreshActivityRow>();

	const feedCounts = feedCountsResults[0];
	const itemCounts = itemCountsResults[0];

	return Response.json({
		configuredBaseUrl: env.BASE_URL,
		currentOrigin,
		healthUrl: `${currentOrigin}/health`,
		schemaVersion,
		feeds: {
			activeCount: asCount(feedCounts?.active_feed_count),
			emailCount: asCount(feedCounts?.email_feed_count),
			rssCount: asCount(feedCounts?.rss_feed_count),
			failingRssCount: asCount(feedCounts?.failing_rss_feed_count),
			failing: failingFeeds.map((feed) => ({
				feedKey: feed.feed_key,
				title: feed.title,
				error: redactRefreshError(feed.fetch_error),
				lastFetchedAt: feed.last_fetched_at,
			})),
		},
		items: {
			totalCount: asCount(itemCounts?.total_item_count),
			unreadCount: asCount(itemCounts?.unread_item_count),
			starredCount: asCount(itemCounts?.starred_item_count),
			newestAt: itemCounts?.newest_item_at ?? null,
			newestEmailAt: newestEmailItem?.value ?? null,
			newestRssAt: newestRssItem?.value ?? null,
		},
		rss: {
			latestFetchAttemptAt: latestFetchAttempt?.value ?? null,
		},
		syncHealth: {
			generatedAt: now,
			dueCount: asCount(syncHealthCountsResults[0]?.due_count),
			backedOffCount: asCount(syncHealthCountsResults[0]?.backed_off_count),
			leasedCount: asCount(syncHealthCountsResults[0]?.leased_count),
			healthyCount: asCount(syncHealthCountsResults[0]?.healthy_count),
			feeds: feedHealth.map((feed) => ({
				feedKey: feed.feed_key,
				title: feed.title,
				host: redactedHost(feed.source_url),
				state: feedHealthState(feed, now),
				lastAttemptAt: feed.last_attempt_at,
				lastSuccessAt: feed.last_success_at,
				nextFetchAt: feed.next_fetch_at,
				retryAt: feed.retry_after_at,
				consecutiveFailures: feed.consecutive_failures,
				httpStatus: feed.last_http_status,
				outcome: feed.last_refresh_outcome,
				durationMs: feed.last_fetch_duration_ms,
				error: feed.fetch_error ? redactRefreshError(feed.fetch_error) : null,
				canRetry: !feed.retry_after_at || feed.retry_after_at <= now,
			})),
			recentActivity: recentActivity.map((activity) => ({
				feedKey: activity.feed_key,
				title: activity.title,
				attemptedAt: activity.attempted_at,
				outcome: activity.outcome,
				httpStatus: activity.http_status,
				durationMs: activity.duration_ms,
				itemsProcessed: activity.items_added,
				errorCode: activity.error_code,
				error: activity.error_message ? redactRefreshError(activity.error_message) : null,
				retryAt: activity.retry_at,
			})),
		},
	});
}

export async function handleStatusRetryRequest(request: Request, env: Env): Promise<Response> {
	const authError = await requireApiAuth(request, env.API_PASSWORD);
	if (authError) return authError;
	await ensureDatabaseSchema(env);

	let body: { feed_key?: unknown };
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: 'Invalid JSON' }, { status: 400 });
	}
	if (typeof body.feed_key !== 'string' || body.feed_key.trim() === '') {
		return Response.json({ error: 'Missing feed_key field' }, { status: 400 });
	}

	const now = new Date().toISOString();
	const result = await env.DB.prepare(
		`UPDATE feeds
		 SET next_fetch_at = ?, retry_after_at = NULL
		 WHERE feed_key = ?
		   AND source_type = 'rss'
		   AND is_active = 1
		   AND (retry_after_at IS NULL OR datetime(retry_after_at) <= datetime(?))
		   AND (refresh_lease_until IS NULL OR datetime(refresh_lease_until) <= datetime(?))`,
	)
		.bind(now, body.feed_key, now, now)
		.run();
	if (result.meta.changes === 0) {
		return Response.json(
			{ error: 'Feed not found, waiting for Retry-After, or refresh already in progress' },
			{ status: 409 },
		);
	}
	return Response.json({ feed_key: body.feed_key, queued_at: now });
}

function redactedHost(sourceUrl: string): string {
	try {
		return new URL(sourceUrl).hostname;
	} catch {
		return 'invalid feed host';
	}
}

function feedHealthState(feed: FeedHealthRow, now: string): string {
	if (feed.retry_after_at && feed.retry_after_at > now) return 'backing_off';
	if (feed.consecutive_failures > 0) return 'failing';
	if (feed.next_fetch_at && feed.next_fetch_at <= now) return 'due';
	if (feed.last_success_at) return 'healthy';
	return 'never_refreshed';
}
