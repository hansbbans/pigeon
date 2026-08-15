/**
 * Feed subscription API
 * Handles POST /feeds/subscribe to add external RSS/Atom feeds
 */

import type { Env } from './types';
import { getFaviconForUrl } from './favicon';
import { requireApiAuth } from './api-auth';
import { discoverFeeds } from './feed-discovery';

interface SubscribeRequest {
	url: string;
	category?: string;
}

interface SubscribeResponse {
	feed_key: string;
	display_name: string;
	feed_url: string;
}

/**
 * Core subscription logic (exported for reuse in GReader API)
 * @returns Object with feed_key, display_name, and rowid on success
 * @throws Error with message on failure
 */
export async function subscribeToFeed(
	env: Env,
	feedUrl: string,
	category?: string | null
): Promise<{ feed_key: string; display_name: string; rowid: number }> {
	let discovery: Awaited<ReturnType<typeof discoverFeeds>>;
	try {
		discovery = await discoverFeeds(feedUrl);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to discover feed: ${message}`);
	}
	const candidate = discovery.candidates[0];
	if (!candidate) throw new Error('Failed to discover feed: no supported feed was found');
	const canonicalUrl = new URL(candidate.url);
	const feedTitle = candidate.title;
	const siteUrl = candidate.site_url;

	// Generate feed_key from URL (normalize domain + path)
	const feedKey = await generateFeedKey(canonicalUrl);

	// Canonical URLs and their redirect aliases all resolve to one subscription.
	let existing = await env.DB.prepare(
		'SELECT rowid, feed_key, display_name FROM feeds WHERE feed_key = ? OR canonical_url = ? OR source_url = ? LIMIT 1',
	)
		.bind(feedKey, canonicalUrl.href, canonicalUrl.href)
		.first<{ rowid: number; feed_key: string; display_name: string }>();
	if (!existing) {
		const urls = [...new Set([discovery.input_url, ...candidate.aliases])].filter(
			(url) => url !== canonicalUrl.href,
		);
		for (const aliasUrl of urls) {
			existing = await env.DB.prepare(
				`SELECT f.rowid, f.feed_key, f.display_name
				 FROM feed_url_aliases a
				 JOIN feeds f ON f.feed_key = a.feed_key
				 WHERE a.alias_url = ?
				 LIMIT 1`,
			)
				.bind(aliasUrl)
				.first<{ rowid: number; feed_key: string; display_name: string }>();
			if (existing) break;
		}
	}

	if (existing) {
		// Reactivate if inactive
		await env.DB.prepare(
			`UPDATE feeds
			 SET display_name = ?, source_url = ?, canonical_url = ?, feed_format = ?,
			     site_url = COALESCE(?, site_url), is_active = 1,
			     next_fetch_at = COALESCE(next_fetch_at, ?)
			 WHERE feed_key = ?`
		)
			.bind(
				feedTitle,
				canonicalUrl.href,
				canonicalUrl.href,
				candidate.format,
				siteUrl,
				new Date().toISOString(),
				existing.feed_key,
			)
			.run();
		await storeFeedAliases(env.DB, existing.feed_key, canonicalUrl.href, [
			discovery.input_url,
			...candidate.aliases,
		]);
		return {
			rowid: existing.rowid,
			feed_key: existing.feed_key,
			display_name: feedTitle,
		};
	}

	// Insert into feeds table
	const now = new Date().toISOString();
	const iconUrl = getFaviconForUrl(siteUrl ?? canonicalUrl.href);
	await env.DB.prepare(
		`INSERT INTO feeds (
			feed_key, display_name, source_type, source_url, canonical_url, feed_format,
			site_url, category, icon_url, is_active, first_seen_at, next_fetch_at
		) VALUES (?, ?, 'rss', ?, ?, ?, ?, ?, ?, 1, ?, ?)`
	)
		.bind(
			feedKey,
			feedTitle,
			canonicalUrl.href,
			canonicalUrl.href,
			candidate.format,
			siteUrl,
			category || null,
			iconUrl,
			now,
			now,
		)
		.run();
	await storeFeedAliases(env.DB, feedKey, canonicalUrl.href, [
		discovery.input_url,
		...candidate.aliases,
	]);

	// Get the rowid of the inserted feed
	const inserted = await env.DB.prepare('SELECT rowid FROM feeds WHERE feed_key = ?')
		.bind(feedKey)
		.first<{ rowid: number }>();

	if (!inserted) {
		throw new Error('Failed to retrieve inserted feed from database');
	}

	return {
		feed_key: feedKey,
		display_name: feedTitle,
		rowid: inserted.rowid,
	};
}

async function storeFeedAliases(
	db: D1Database,
	feedKey: string,
	canonicalUrl: string,
	aliases: string[],
): Promise<void> {
	const uniqueAliases = [...new Set(aliases)].filter((alias) => alias !== canonicalUrl);
	if (uniqueAliases.length === 0) return;
	await db.batch(
		uniqueAliases.map((alias) =>
			db
				.prepare(
					`INSERT OR IGNORE INTO feed_url_aliases (alias_url, feed_key, canonical_url)
					 VALUES (?, ?, ?)`,
				)
				.bind(alias, feedKey, canonicalUrl),
		),
	);
}

/**
 * Handle POST /feeds/subscribe
 * Subscribes to an external RSS/Atom feed
 */
export async function handleSubscribe(request: Request, env: Env): Promise<Response> {
	// Check auth
	const authErr = await requireApiAuth(request, env.API_PASSWORD);
	if (authErr) return authErr;

	// Parse request body
	let body: SubscribeRequest;
	try {
		body = await request.json();
	} catch {
		return new Response('Invalid JSON', { status: 400 });
	}

	if (!body.url) {
		return new Response('Missing url field', { status: 400 });
	}

	// Subscribe to feed
	try {
		const result = await subscribeToFeed(env, body.url, body.category);

		const response: SubscribeResponse = {
			feed_key: result.feed_key,
			display_name: result.display_name,
			feed_url: `${env.BASE_URL}/feed/${result.feed_key}`,
		};

		return Response.json(response);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return new Response(message, { status: 400 });
	}
}

/**
 * Generate a feed key from a URL
 * Example: https://hnrss.org/newest -> "hnrss-org-newest"
 */
async function generateFeedKey(url: URL): Promise<string> {
	const normalizedQuery = [...url.searchParams.entries()]
		.sort(([leftKey, leftValue], [rightKey, rightValue]) => {
			if (leftKey === rightKey) {
				return leftValue.localeCompare(rightValue);
			}
			return leftKey.localeCompare(rightKey);
		})
		.map(([key, value]) => `${key}=${value}`)
		.join('&');

	// Use hostname + pathname, plus a canonicalized query string when present.
	const parts = [
		url.hostname.replace(/^www\./, ''), // Remove www. prefix
		url.pathname.replace(/^\//, '').replace(/\/$/, ''), // Remove leading/trailing slashes
		normalizedQuery ? `query/${await hashFeedQuery(normalizedQuery)}` : '',
	]
		.filter((p) => p) // Remove empty parts
		.join('/');

	// Normalize to lowercase, replace special chars with hyphens
	return parts
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-') // Replace non-alphanumeric with hyphens
		.replace(/^-|-$/g, ''); // Remove leading/trailing hyphens
}

async function hashFeedQuery(input: string): Promise<string> {
	const data = new TextEncoder().encode(input);
	const hash = await crypto.subtle.digest('SHA-256', data);
	const hex = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

	return hex.slice(0, 24);
}
