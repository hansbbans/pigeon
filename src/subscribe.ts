/**
 * Feed subscription API
 * Handles POST /feeds/subscribe to add external RSS/Atom feeds
 */

import type { Env } from './types';
import { getFaviconForUrl } from './favicon';
import { requireApiAuth } from './api-auth';
import { discoverFeeds } from './feed-discovery';
import {
	buildRssItemStatements,
	createRssItemIdentity,
	initialImportBaselineKey,
	serializeInitialImportBaseline,
	type InitialImportBaseline,
} from './rss-fetcher';
import type { ParsedItem } from './rss-parser';

interface SubscribeRequest {
	url: string;
	category?: string;
}

interface SubscribeResponse {
	feed_key: string;
	display_name: string;
	feed_url: string;
}

interface ExistingFeed {
	rowid: number;
	feed_key: string;
	display_name: string;
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
): Promise<{ feed_key: string; display_name: string; rowid: number; wasCreated: boolean }> {
	let discovery: Awaited<ReturnType<typeof discoverFeeds>>;
	try {
		discovery = await discoverFeeds(feedUrl, { includeItems: true });
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
	const aliasUrls = [...new Set([discovery.input_url, ...candidate.aliases])].filter(
		(url) => url !== canonicalUrl.href,
	);
	const existing = await findExistingFeed(env.DB, feedKey, canonicalUrl.href, aliasUrls);

	if (existing) {
		// Reactivate if inactive
		await env.DB.prepare(
			`UPDATE feeds
			 SET display_name = ?, source_url = ?, canonical_url = ?, feed_format = ?,
			     site_url = COALESCE(?, site_url), is_active = 1, stale_archived = 0,
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
			wasCreated: false,
		};
	}

	// Insert the feed and its initial unread items atomically. Discovery already
	// fetched and parsed the resource, so a new subscription should not wait for
	// the scheduler before appearing in the library.
	const now = new Date().toISOString();
	const iconUrl = getFaviconForUrl(siteUrl ?? canonicalUrl.href);
	const initialItems = selectInitialItems(candidate.items ?? []);
	const itemStatements = await buildRssItemStatements(
		env.DB,
		feedKey,
		{ link: siteUrl ?? undefined, sourceUrl: canonicalUrl.href },
		initialItems,
		now,
		{ updateExisting: false },
	);
	const baseline = await buildInitialImportBaseline(feedKey, candidate.items ?? [], initialItems);
	const nextFetchAt = new Date(Date.parse(now) + 60 * 60_000).toISOString();
	const feedInsert = env.DB.prepare(
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
		);
	const baselineInsert = env.DB.prepare(
		'INSERT OR IGNORE INTO _meta (key, value) VALUES (?, ?)',
	).bind(initialImportBaselineKey(feedKey), serializeInitialImportBaseline(baseline));
	const initialState = env.DB.prepare(
		`UPDATE feeds
		 SET last_fetched_at = ?,
		     last_attempt_at = ?,
		     last_success_at = ?,
		     fetch_error = NULL,
		     consecutive_failures = 0,
		     last_http_status = 200,
		     next_fetch_at = ?,
		     last_item_at = (SELECT MAX(received_at) FROM items WHERE feed_key = ?),
		     item_count = (SELECT COUNT(*) FROM items WHERE feed_key = ?)
		 WHERE feed_key = ?`,
	).bind(now, now, now, nextFetchAt, feedKey, feedKey, feedKey);
	try {
		await env.DB.batch([
			feedInsert,
			baselineInsert,
			...itemStatements,
			...feedAliasStatements(env.DB, feedKey, canonicalUrl.href, aliasUrls),
			initialState,
		]);
	} catch (error) {
		// Two first-time subscribers can pass the preflight read together. A
		// unique feed conflict means another request won; return that row without
		// replaying its initial items or changing its read state.
		if (!isLikelyFeedConflict(error)) throw error;
		const concurrent = await findExistingFeed(env.DB, feedKey, canonicalUrl.href, aliasUrls);
		if (!concurrent) throw error;
		return {
			rowid: concurrent.rowid,
			feed_key: concurrent.feed_key,
			display_name: concurrent.display_name,
			wasCreated: false,
		};
	}

	// Get the rowid of the inserted feed after the atomic write.
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
		wasCreated: true,
	};
}

async function findExistingFeed(
	db: D1Database,
	feedKey: string,
	canonicalUrl: string,
	aliasUrls: string[],
): Promise<ExistingFeed | null> {
	const canonical = await db.prepare(
		'SELECT rowid, feed_key, display_name FROM feeds WHERE feed_key = ? OR canonical_url = ? OR source_url = ? LIMIT 1',
	)
		.bind(feedKey, canonicalUrl, canonicalUrl)
		.first<ExistingFeed>();
	if (canonical) return canonical;

	for (const aliasUrl of aliasUrls) {
		const alias = await db.prepare(
			`SELECT f.rowid, f.feed_key, f.display_name
			 FROM feed_url_aliases a
			 JOIN feeds f ON f.feed_key = a.feed_key
			 WHERE a.alias_url = ?
			 LIMIT 1`,
		)
			.bind(aliasUrl)
			.first<ExistingFeed>();
		if (alias) return alias;
	}
	return null;
}

function isLikelyFeedConflict(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /unique|duplicate/i.test(message) &&
		/(?:feeds?\.(?:feed_key|canonical_url|source_url)|idx_feeds_canonical_url|feed_url_aliases\.(?:alias_url|feed_key))/i.test(message);
}

function selectInitialItems(items: ParsedItem[]): ParsedItem[] {
	const sortedItems = items
		.map((item, index) => ({ item, index, timestamp: item.pubDate ? Date.parse(item.pubDate) : Number.NaN }))
		.sort((left, right) => {
			const leftDated = Number.isFinite(left.timestamp);
			const rightDated = Number.isFinite(right.timestamp);
			if (leftDated && rightDated) return right.timestamp - left.timestamp || left.index - right.index;
			if (leftDated) return -1;
			if (rightDated) return 1;
			return left.index - right.index;
		});
	const seen = new Set<string>();
	return sortedItems
		.filter(({ item }) => {
			const identity = item.guid || item.link || [item.title, item.pubDate || '', item.author || '', item.content].join('\n');
			if (seen.has(identity)) return false;
			seen.add(identity);
			return true;
		})
		.slice(0, 3)
		.map(({ item }) => item);
}

async function buildInitialImportBaseline(
	feedKey: string,
	allItems: ParsedItem[],
	selectedItems: ParsedItem[],
): Promise<InitialImportBaseline> {
	const selectedMessageIds = new Set(
		(await Promise.all(selectedItems.map((item) => createRssItemIdentity(feedKey, item)))).map(
			(identity) => identity.messageId,
		),
	);
	const excludedMessageIds = new Set<string>();
	for (const item of allItems.slice(0, 50)) {
		const identity = await createRssItemIdentity(feedKey, item);
		if (!selectedMessageIds.has(identity.messageId)) {
			excludedMessageIds.add(identity.messageId);
		}
	}

	const datedSelected = selectedItems
		.map((item) => (item.pubDate ? Date.parse(item.pubDate) : Number.NaN))
		.filter((timestamp) => Number.isFinite(timestamp));
	const cutoffAt = datedSelected.length > 0
		? new Date(Math.min(...datedSelected)).toISOString()
		: null;
	return {
		version: 1,
		cutoffAt,
		excludedMessageIds: [...excludedMessageIds],
		selectedMessageIds: [...selectedMessageIds],
	};
}

function feedAliasStatements(
	db: D1Database,
	feedKey: string,
	canonicalUrl: string,
	aliases: string[],
): D1PreparedStatement[] {
	const uniqueAliases = [...new Set(aliases)].filter((alias) => alias !== canonicalUrl);
	return uniqueAliases.map((alias) =>
		db
			.prepare(
				`INSERT OR IGNORE INTO feed_url_aliases (alias_url, feed_key, canonical_url)
				 VALUES (?, ?, ?)`,
			)
			.bind(alias, feedKey, canonicalUrl),
	);
}

async function storeFeedAliases(
	db: D1Database,
	feedKey: string,
	canonicalUrl: string,
	aliases: string[],
): Promise<void> {
	const statements = feedAliasStatements(db, feedKey, canonicalUrl, aliases);
	if (statements.length === 0) return;
	await db.batch(statements);
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
