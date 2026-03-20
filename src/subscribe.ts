/**
 * Feed subscription API
 * Handles POST /feeds/subscribe to add external RSS/Atom feeds
 */

import { parseRssFeed } from './rss-parser';
import type { Env } from './types';
import { getFaviconForUrl } from './favicon';
import { requireApiAuth } from './api-auth';

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
	// Validate URL
	let parsedUrl: URL;
	try {
		parsedUrl = new URL(feedUrl);
		if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
			throw new Error('Invalid URL protocol (must be http or https)');
		}
	} catch (error) {
		throw new Error(error instanceof Error ? error.message : 'Invalid URL format');
	}

	// Fetch feed to extract title and validate parsability
	let feedTitle: string;
	try {
		const response = await fetch(parsedUrl.toString(), {
			headers: {
				'User-Agent': 'Pigeon RSS Reader/1.0',
			},
			signal: AbortSignal.timeout(10000), // 10 second timeout
		});

		if (!response.ok) {
			throw new Error(`Failed to fetch feed: HTTP ${response.status}`);
		}

		const xmlText = await response.text();
		const parsed = parseRssFeed(xmlText);
		feedTitle = parsed.title;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to parse feed: ${message}`);
	}

	// Generate feed_key from URL (normalize domain + path)
	const feedKey = await generateFeedKey(parsedUrl);

	// Check if feed already exists (return existing if found)
	const existing = await env.DB.prepare('SELECT rowid, feed_key, display_name FROM feeds WHERE feed_key = ?')
		.bind(feedKey)
		.first<{ rowid: number; feed_key: string; display_name: string }>();

	if (existing) {
		// Reactivate if inactive
		await env.DB.prepare('UPDATE feeds SET is_active = 1 WHERE feed_key = ?')
			.bind(feedKey)
			.run();
		return existing;
	}

	// Insert into feeds table
	const now = new Date().toISOString();
	const iconUrl = getFaviconForUrl(parsedUrl.toString());
	await env.DB.prepare(
		`INSERT INTO feeds (
			feed_key, display_name, source_type, source_url,
			category, icon_url, is_active, first_seen_at
		) VALUES (?, ?, 'rss', ?, ?, ?, 1, ?)`
	)
		.bind(feedKey, feedTitle, parsedUrl.toString(), category || null, iconUrl, now)
		.run();

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
