/**
 * Cron trigger handler for RSS feed fetching
 * Runs hourly to fetch and update RSS feeds
 */

import { fetchAndStoreRssFeed } from './rss-fetcher';
import type { Env } from './types';

const MAX_CONCURRENT_FETCHES = 50; // Fetch up to 50 feeds in parallel

/**
 * Handle scheduled cron trigger
 * Queries RSS feeds due for refresh and fetches them in parallel
 */
export async function handleCronTrigger(
	env: Env,
): Promise<void> {
	try {
		console.log('[Cron] Starting RSS feed refresh cycle');

		// Query RSS feeds due for refresh
		// A feed is due if:
		// 1. source_type = 'rss'
		// 2. is_active = 1
		// 3. last_fetched_at is NULL OR older than fetch_interval_minutes
		const now = new Date();
		console.log('[Cron] Current time:', now.toISOString());

		const results = await env.DB.prepare(
			`SELECT feed_key, source_url, etag, last_modified, fetch_interval_minutes
			FROM feeds
			WHERE source_type = 'rss'
			  AND is_active = 1
			  AND (
			    last_fetched_at IS NULL
			    OR datetime(last_fetched_at, '+' || fetch_interval_minutes || ' minutes') <= datetime(?)
			  )
			ORDER BY last_fetched_at ASC NULLS FIRST
			LIMIT ?`
		)
			.bind(now.toISOString(), MAX_CONCURRENT_FETCHES)
			.all();

		console.log('[Cron] Query results:', JSON.stringify(results));

		const feeds = results.results as Array<{
			feed_key: string;
			source_url: string;
			etag: string | null;
			last_modified: string | null;
			fetch_interval_minutes: number;
		}>;

		if (feeds.length === 0) {
			console.log('[Cron] No RSS feeds due for refresh');
			return;
		}

		console.log(`[Cron] Fetching ${feeds.length} RSS feeds:`, feeds.map(f => f.feed_key));

		// Fetch all feeds in parallel.
		const fetchPromises = feeds.map((feed) => {
			console.log('[Cron] Starting fetch for:', feed.feed_key);
			return fetchAndStoreRssFeed(env, feed);
		});

		// Wait for all fetches to complete
		await Promise.allSettled(fetchPromises);

		console.log('[Cron] RSS feed refresh cycle complete');
	} catch (error) {
		console.error('[Cron] Error in handleCronTrigger:', error);
		// Don't rethrow - cron will retry which could cause duplicate fetches
	}
}
