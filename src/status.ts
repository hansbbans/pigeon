import { requireApiAuth } from './api-auth';
import type { Env } from './types';

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
		        SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS unread_item_count,
		        SUM(CASE WHEN is_starred = 1 THEN 1 ELSE 0 END) AS starred_item_count,
		        MAX(received_at) AS newest_item_at
		   FROM items`,
	).all<ItemCountsRow>();

	const newestEmailItem = await env.DB.prepare(
		`SELECT MAX(i.received_at) AS value
		   FROM items i
		   JOIN feeds f ON f.feed_key = i.feed_key
		  WHERE f.source_type = 'email'`,
	).first<ValueRow>();

	const newestRssItem = await env.DB.prepare(
		`SELECT MAX(i.received_at) AS value
		   FROM items i
		   JOIN feeds f ON f.feed_key = i.feed_key
		  WHERE f.source_type = 'rss'`,
	).first<ValueRow>();

	const latestFetchAttempt = await env.DB.prepare(
		`SELECT MAX(last_fetched_at) AS value FROM feeds WHERE source_type = 'rss'`,
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
				error: feed.fetch_error,
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
	});
}
