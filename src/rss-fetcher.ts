/**
 * RSS feed fetcher - handles fetching, parsing, and storing RSS items
 * Uses conditional GET (ETag/Last-Modified) to minimize bandwidth
 */

import { parseRssFeed } from './rss-parser';
import { resolveRssItemUrl, rewriteRssContentLinks } from './rss-links';
import { ensureDatabaseSchema } from './migrations';
import type { Env } from './types';

interface FeedToFetch {
	feed_key: string;
	source_url: string;
	etag: string | null;
	last_modified: string | null;
}

interface RssItemIdentity {
	id: string;
	messageId: string;
}

const MAX_ITEMS_PER_FETCH = 50; // Prevent spam/abuse
const MAX_CONTENT_SIZE = 900_000; // Leave buffer under D1 1MB row limit

/**
 * Fetch and store items from an RSS feed
 * Handles conditional GET, parsing, deduplication, and error logging
 */
export async function fetchAndStoreRssFeed(env: Env, feed: FeedToFetch): Promise<void> {
	try {
		await ensureDatabaseSchema(env);

		// Build conditional GET headers
		const headers: Record<string, string> = {
			'User-Agent': 'Pigeon RSS Reader/1.0',
		};
		if (feed.etag) {
			headers['If-None-Match'] = feed.etag;
		}
		if (feed.last_modified) {
			headers['If-Modified-Since'] = feed.last_modified;
		}

		// Fetch feed
		const response = await fetch(feed.source_url, {
			headers,
			// 10 second timeout
			signal: AbortSignal.timeout(10000),
		});

		const now = new Date().toISOString();

		// Handle 304 Not Modified
		if (response.status === 304) {
			await env.DB.prepare('UPDATE feeds SET last_fetched_at = ?, fetch_error = NULL WHERE feed_key = ?')
				.bind(now, feed.feed_key)
				.run();
			return;
		}

		// Handle non-OK responses
		if (!response.ok) {
			const error = `HTTP ${response.status}: ${response.statusText}`;
			await env.DB.prepare('UPDATE feeds SET last_fetched_at = ?, fetch_error = ? WHERE feed_key = ?')
				.bind(now, error, feed.feed_key)
				.run();
			console.error(`[RSS Fetcher] Failed to fetch ${feed.feed_key}: ${error}`);
			return;
		}

		// Parse XML
		const xmlText = await response.text();
		const parsed = parseRssFeed(xmlText);

		// Extract conditional headers for next fetch
		const newEtag = response.headers.get('ETag');
		const newLastModified = response.headers.get('Last-Modified');

		// Limit items to prevent spam
		const items = parsed.items.slice(0, MAX_ITEMS_PER_FETCH);

		// Batch insert items and backfill original URLs on refetches.
		const statements: D1PreparedStatement[] = [];

		for (const item of items) {
			const identity = await createRssItemIdentity(feed.feed_key, item);
			const originalUrl = resolveRssItemUrl({
				itemGuid: item.guid,
				itemLink: item.link,
				content: item.content,
				title: item.title,
				feedSiteUrl: parsed.link,
				feedSourceUrl: feed.source_url,
			});
			const contentBaseUrl = originalUrl || parsed.link || feed.source_url;

			// Truncate content if too large
			let content = rewriteRssContentLinks(item.content, contentBaseUrl);
			if (content.length > MAX_CONTENT_SIZE) {
				content = content.slice(0, MAX_CONTENT_SIZE) + '\n\n[Content truncated]';
			}

			statements.push(
				env.DB.prepare(
					`INSERT INTO items (
						id, message_id, feed_key, subject,
						from_email, received_at, html_content, text_content, original_url
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT(message_id) DO UPDATE SET
						html_content = excluded.html_content,
						original_url = CASE
								WHEN excluded.original_url IS NOT NULL
								  AND (
									items.original_url IS NULL
									OR items.original_url LIKE 'https://feeds.feedblitz.com/%'
									OR excluded.feed_key LIKE '%feedblitz%'
								  )
								THEN excluded.original_url
							ELSE items.original_url
						END`
				).bind(
					identity.id,
					identity.messageId,
					feed.feed_key,
					item.title,
					item.author || null,
					item.pubDate || now,
					content,
					null, // RSS items don't have separate text/html
					originalUrl,
				)
			);
		}

		// Update feed metadata
		statements.push(
			env.DB.prepare(
				`UPDATE feeds
				SET last_fetched_at = ?,
				    fetch_error = NULL,
				    etag = ?,
				    last_modified = ?,
				    site_url = COALESCE(?, site_url),
				    last_item_at = (SELECT MAX(received_at) FROM items WHERE feed_key = ?),
				    item_count = (SELECT COUNT(*) FROM items WHERE feed_key = ?)
				WHERE feed_key = ?`
			).bind(now, newEtag, newLastModified, parsed.link || null, feed.feed_key, feed.feed_key, feed.feed_key)
		);

		// Execute all statements in a batch
		await env.DB.batch(statements);

		console.log(
			`[RSS Fetcher] Successfully fetched ${feed.feed_key}: ${items.length} items`
		);
	} catch (error) {
		// Log error to database (don't rethrow - prevents retry loops)
		const errorMessage =
			error instanceof Error ? error.message : String(error);
		const now = new Date().toISOString();

		await env.DB.prepare(
			'UPDATE feeds SET last_fetched_at = ?, fetch_error = ? WHERE feed_key = ?'
		)
			.bind(now, errorMessage, feed.feed_key)
			.run();

		console.error(
			`[RSS Fetcher] Error fetching ${feed.feed_key}:`,
			errorMessage
		);
	}
}

async function createRssItemIdentity(
	feedKey: string,
	item: {
		guid: string;
		link?: string;
		title: string;
		pubDate?: string;
		content: string;
		author?: string;
	},
): Promise<RssItemIdentity> {
	const rawIdentity =
		item.guid ||
		item.link ||
		[item.title, item.pubDate || '', item.author || '', item.content].join('\n');
	const digest = await sha256Hex(`${feedKey}\n${rawIdentity}`);

	return {
		id: hexToUuid(digest),
		messageId: `rss:${digest}`,
	};
}

async function sha256Hex(input: string): Promise<string> {
	const data = new TextEncoder().encode(input);
	const hash = await crypto.subtle.digest('SHA-256', data);
	return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hexToUuid(hex: string): string {
	const raw = hex.slice(0, 32);
	const versioned = `${raw.slice(0, 12)}5${raw.slice(13, 16)}${((parseInt(raw.slice(16, 18), 16) & 0x3f) | 0x80)
		.toString(16)
		.padStart(2, '0')}${raw.slice(18)}`;

	return [
		versioned.slice(0, 8),
		versioned.slice(8, 12),
		versioned.slice(12, 16),
		versioned.slice(16, 20),
		versioned.slice(20, 32),
	].join('-');
}
