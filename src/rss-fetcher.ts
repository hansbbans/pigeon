/**
 * Bounded, idempotent external-feed refresh.
 *
 * Network policy is applied before every request and redirect. Refresh results
 * are persisted as separate operational state so content and sync health do not
 * depend on one overloaded error string.
 */

import { fetchBoundedFeedResource } from './feed-network';
import { ensureDatabaseSchema } from './migrations';
import {
	computeNextFetchAt,
	parseCacheControlMaxAge,
	parseRetryAfter,
	redactRefreshError,
	shouldUseConditionalRequest,
	type RefreshOutcome,
} from './refresh-policy';
import { parseFeed, type FeedFormat } from './rss-parser';
import { resolveRssItemUrl, rewriteRssContentLinks } from './rss-links';
import type { Env } from './types';

export interface FeedToFetch {
	feed_key: string;
	source_url: string;
	etag: string | null;
	last_modified: string | null;
	fetch_interval_minutes?: number | null;
	consecutive_failures?: number | null;
	content_hash?: string | null;
	conditional_checked_at?: string | null;
	refresh_lease_token?: string | null;
}

export interface RefreshResult {
	feedKey: string;
	outcome: RefreshOutcome;
	attemptedAt: string;
	completedAt: string;
	durationMs: number;
	httpStatus: number | null;
	itemsProcessed: number;
	responseBytes: number | null;
	retryAt: string | null;
	cacheUntilAt: string | null;
	errorCode: string | null;
	errorMessage: string | null;
}

interface RssItemIdentity {
	id: string;
	messageId: string;
}

interface SuccessfulContent {
	statements: D1PreparedStatement[];
	format: FeedFormat | null;
	siteUrl: string | null;
	etag: string | null;
	lastModified: string | null;
	contentHash: string;
	finalUrl: string;
	aliases: string[];
	itemsProcessed: number;
	responseBytes: number;
	performedFullFetch: boolean;
}

class RefreshFailure extends Error {
	constructor(
		message: string,
		readonly outcome: RefreshOutcome,
		readonly code: string,
		readonly httpStatus: number | null = null,
		readonly retryAt: string | null = null,
		readonly responseBytes: number | null = null,
	) {
		super(message);
	}
}

const MAX_ITEMS_PER_FETCH = 50;
const MAX_CONTENT_SIZE = 900_000;
const PERSISTENCE_LEASE_MINUTES = 3;
const USER_AGENT = 'Pigeon RSS Reader/1.0';

export async function fetchAndStoreRssFeed(env: Env, feed: FeedToFetch): Promise<RefreshResult> {
	await ensureDatabaseSchema(env);
	const startedAt = Date.now();
	const attemptedAt = new Date(startedAt).toISOString();

	try {
		const headers: Record<string, string> = {
			Accept: 'application/rss+xml, application/atom+xml, application/feed+json, application/rdf+xml, application/xml, text/xml, */*;q=0.1',
			'User-Agent': USER_AGENT,
		};
		const useConditionalRequest = shouldUseConditionalRequest(
			new Date(attemptedAt),
			feed.conditional_checked_at,
			Boolean(feed.etag || feed.last_modified),
		);
		if (useConditionalRequest && feed.etag) headers['If-None-Match'] = feed.etag;
		if (useConditionalRequest && feed.last_modified) headers['If-Modified-Since'] = feed.last_modified;

		let resource: Awaited<ReturnType<typeof fetchBoundedFeedResource>>;
		try {
			resource = await fetchBoundedFeedResource(feed.source_url, { headers });
		} catch (error) {
			const message = redactRefreshError(error);
			const rejected = /private|internal|unsupported|redirect|exceeds|content type|credentials|invalid feed url/i.test(
				message,
			);
			throw new RefreshFailure(
				message,
				rejected ? 'rejected' : 'network_error',
				rejected ? 'request_rejected' : 'network_failure',
			);
		}

		const response = resource.response;
		const completedAt = new Date().toISOString();
		const durationMs = Date.now() - startedAt;
		if (response.status === 304) {
			const result = makeResult({
				feed,
				outcome: 'not_modified',
				attemptedAt,
				completedAt,
				durationMs,
				httpStatus: 304,
				responseBytes: resource.byteLength,
				cacheUntilAt: parseCacheControlMaxAge(
					response.headers.get('Cache-Control'),
					new Date(completedAt),
				),
			});
			return finalizeRefresh(env, feed, result, null);
		}

		if (!response.ok) {
			const retryAt = parseRetryAfter(response.headers.get('Retry-After'), new Date(completedAt));
			const rateLimited = response.status === 429 || (response.status === 503 && retryAt !== null);
			throw new RefreshFailure(
				`HTTP ${response.status}${response.statusText ? `: ${response.statusText}` : ''}`,
				rateLimited ? 'rate_limited' : 'http_error',
				rateLimited ? 'rate_limited' : `http_${response.status}`,
				response.status,
				retryAt,
				resource.byteLength,
			);
		}

		const contentHash = await sha256Hex(resource.text);
		if (feed.content_hash && feed.content_hash === contentHash) {
			const result = makeResult({
				feed,
				outcome: 'unchanged',
				attemptedAt,
				completedAt,
				durationMs,
				httpStatus: response.status,
				responseBytes: resource.byteLength,
				cacheUntilAt: parseCacheControlMaxAge(
					response.headers.get('Cache-Control'),
					new Date(completedAt),
				),
			});
			return finalizeRefresh(env, feed, result, {
				statements: [],
				format: null,
				siteUrl: null,
				etag: response.headers.get('ETag'),
				lastModified: response.headers.get('Last-Modified'),
				contentHash,
				finalUrl: resource.finalUrl.href,
				aliases: [feed.source_url, ...resource.redirects.map((url) => url.href)],
				itemsProcessed: 0,
				responseBytes: resource.byteLength,
				performedFullFetch: !useConditionalRequest,
			});
		}

		let parsed: ReturnType<typeof parseFeed>;
		try {
			parsed = parseFeed(resource.text, {
				sourceUrl: resource.finalUrl.href,
				contentType: resource.contentType,
			});
		} catch (error) {
			throw new RefreshFailure(
				redactRefreshError(error),
				'parse_error',
				'unsupported_or_malformed_feed',
				response.status,
				null,
				resource.byteLength,
			);
		}

		const items = parsed.items.slice(0, MAX_ITEMS_PER_FETCH);
		const statements: D1PreparedStatement[] = [];
		for (const item of items) {
			const identity = await createRssItemIdentity(feed.feed_key, item);
			const originalUrl = resolveRssItemUrl({
				itemGuid: item.guid,
				itemLink: item.link,
				content: item.content,
				title: item.title,
				feedSiteUrl: parsed.link,
				feedSourceUrl: resource.finalUrl.href,
			});
			const contentBaseUrl = originalUrl || parsed.link || resource.finalUrl.href;
			let content = rewriteRssContentLinks(
				appendFeedAttachments(item.content, item.attachments),
				contentBaseUrl,
			);
			if (content.length > MAX_CONTENT_SIZE) {
				content = `${content.slice(0, MAX_CONTENT_SIZE)}\n\n[Content truncated]`;
			}

			statements.push(
				env.DB.prepare(
					`INSERT INTO items (
						id, message_id, feed_key, subject,
						from_email, received_at, html_content, text_content, original_url
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT(message_id) DO UPDATE SET
						html_content = excluded.html_content,
						content_pruned_at = NULL,
						original_url = CASE
								WHEN excluded.original_url IS NOT NULL
								  AND (
									items.original_url IS NULL
									OR items.original_url LIKE 'https://feeds.feedblitz.com/%'
									OR excluded.feed_key LIKE '%feedblitz%'
								  )
								THEN excluded.original_url
							ELSE items.original_url
						END`,
				).bind(
					identity.id,
					identity.messageId,
					feed.feed_key,
					item.title,
					item.author || null,
					item.pubDate || attemptedAt,
					content,
					null,
					originalUrl,
				),
			);
		}

		const content: SuccessfulContent = {
			statements,
			format: parsed.format,
			siteUrl: parsed.link ?? null,
			etag: response.headers.get('ETag'),
			lastModified: response.headers.get('Last-Modified'),
			contentHash,
			finalUrl: resource.finalUrl.href,
			aliases: [feed.source_url, ...resource.redirects.map((url) => url.href)],
			itemsProcessed: items.length,
			responseBytes: resource.byteLength,
			performedFullFetch: !useConditionalRequest,
		};
		const result = makeResult({
			feed,
			outcome: 'success',
			attemptedAt,
			completedAt,
			durationMs,
			httpStatus: response.status,
			itemsProcessed: items.length,
			responseBytes: resource.byteLength,
			cacheUntilAt: parseCacheControlMaxAge(
				response.headers.get('Cache-Control'),
				new Date(completedAt),
			),
		});
		const finalized = await finalizeRefresh(env, feed, result, content);
		if (finalized.outcome === 'success') {
			console.log(`[RSS Fetcher] Refreshed ${feed.feed_key}: ${items.length} items processed`);
		}
		return finalized;
	} catch (error) {
		const failure =
			error instanceof RefreshFailure
				? error
				: new RefreshFailure(
						redactRefreshError(error),
						'network_error',
						'unexpected_refresh_failure',
					);
		const result = makeResult({
			feed,
			outcome: failure.outcome,
			attemptedAt,
			completedAt: new Date().toISOString(),
			durationMs: Date.now() - startedAt,
			httpStatus: failure.httpStatus,
			responseBytes: failure.responseBytes,
			retryAt: failure.retryAt,
			errorCode: failure.code,
			errorMessage: redactRefreshError(failure),
		});
		const finalized = await finalizeRefresh(env, feed, result, null);
		console.error(`[RSS Fetcher] ${feed.feed_key}: ${finalized.errorCode}`);
		return finalized;
	}
}

async function finalizeRefresh(
	env: Env,
	feed: FeedToFetch,
	result: RefreshResult,
	content: SuccessfulContent | null,
): Promise<RefreshResult> {
	if (await persistRefresh(env, feed, result, content)) return result;

	const completedAt = new Date().toISOString();
	const leaseLost = makeResult({
		feed,
		outcome: 'lease_lost',
		attemptedAt: result.attemptedAt,
		completedAt,
		durationMs: Math.max(result.durationMs, new Date(completedAt).getTime() - new Date(result.attemptedAt).getTime()),
		errorCode: 'lease_lost',
		errorMessage: 'Refresh ownership expired before content could be saved',
	});
	await activityStatement(env.DB, leaseLost).run();
	return leaseLost;
}

function appendFeedAttachments(
	content: string,
	attachments: Array<{ url: string; mimeType?: string; title?: string }>,
): string {
	const additions = attachments.flatMap((attachment) => {
		if (content.includes(attachment.url)) return [];
		const url = escapeHtmlAttribute(attachment.url);
		const title = escapeHtmlText(attachment.title || 'Media attachment');
		const isImage = attachment.mimeType?.toLowerCase().startsWith('image/') ||
			/\.(?:avif|gif|jpe?g|png|webp)(?:$|[?#])/i.test(attachment.url);
		if (isImage) {
			return [`<figure><img src="${url}" alt="${title}"></figure>`];
		}
		return [`<p><a href="${url}">${title}</a></p>`];
	});
	return additions.length > 0 ? [content, ...additions].filter(Boolean).join('\n') : content;
}

function escapeHtmlAttribute(value: string): string {
	return escapeHtmlText(value).replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function escapeHtmlText(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function makeResult(input: {
	feed: FeedToFetch;
	outcome: RefreshOutcome;
	attemptedAt: string;
	completedAt: string;
	durationMs: number;
	httpStatus?: number | null;
	itemsProcessed?: number;
	responseBytes?: number | null;
	retryAt?: string | null;
	cacheUntilAt?: string | null;
	errorCode?: string | null;
	errorMessage?: string | null;
}): RefreshResult {
	return {
		feedKey: input.feed.feed_key,
		outcome: input.outcome,
		attemptedAt: input.attemptedAt,
		completedAt: input.completedAt,
		durationMs: input.durationMs,
		httpStatus: input.httpStatus ?? null,
		itemsProcessed: input.itemsProcessed ?? 0,
		responseBytes: input.responseBytes ?? null,
		retryAt: input.retryAt ?? null,
		cacheUntilAt: input.cacheUntilAt ?? null,
		errorCode: input.errorCode ?? null,
		errorMessage: input.errorMessage ?? null,
	};
}

async function persistRefresh(
	env: Env,
	feed: FeedToFetch,
	result: RefreshResult,
	content: SuccessfulContent | null,
): Promise<boolean> {
	if (feed.refresh_lease_token) {
		const renewedUntil = new Date(
			Date.now() + PERSISTENCE_LEASE_MINUTES * 60_000,
		).toISOString();
		const renewal = await env.DB.prepare(
			`UPDATE feeds
			 SET refresh_lease_until = ?
			 WHERE feed_key = ? AND refresh_lease_token = ?`,
		)
			.bind(renewedUntil, feed.feed_key, feed.refresh_lease_token)
			.run();
		if (renewal.meta.changes === 0) return false;
	}

	const succeeded = ['success', 'not_modified', 'unchanged'].includes(result.outcome);
	const nextFetchAt = computeNextFetchAt(new Date(result.completedAt), {
		feedKey: feed.feed_key,
		fetchIntervalMinutes: feed.fetch_interval_minutes,
		consecutiveFailures: feed.consecutive_failures,
		outcome: result.outcome,
		retryAfterAt: result.retryAt,
		cacheUntilAt: result.cacheUntilAt,
	});
	const failureCount = succeeded ? 0 : (feed.consecutive_failures ?? 0) + 1;
	const statements = [...(content?.statements ?? [])];

	if (content) {
		statements.push(
			env.DB.prepare(
				`UPDATE feeds
				 SET last_fetched_at = ?,
				     etag = COALESCE(?, etag),
				     last_modified = COALESCE(?, last_modified),
				     site_url = COALESCE(?, site_url),
				     last_attempt_at = ?,
				     last_success_at = ?,
				     fetch_error = NULL,
				     consecutive_failures = 0,
				     last_http_status = ?,
				     retry_after_at = NULL,
				     content_hash = COALESCE(?, content_hash),
				     conditional_checked_at = COALESCE(?, conditional_checked_at),
				     next_fetch_at = ?,
				     feed_format = COALESCE(?, feed_format),
				     source_url = COALESCE(?, source_url),
				     canonical_url = COALESCE(canonical_url, ?),
				     last_refresh_outcome = ?,
				     last_fetch_duration_ms = ?,
				     refresh_lease_until = NULL,
				     refresh_lease_token = NULL,
				     last_item_at = (SELECT MAX(received_at) FROM items WHERE feed_key = ?),
				     item_count = (SELECT COUNT(*) FROM items WHERE feed_key = ?)
				 WHERE feed_key = ?
				   AND (? IS NULL OR refresh_lease_token = ?)`,
			).bind(
				result.attemptedAt,
				content.etag,
				content.lastModified,
				content.siteUrl,
				result.attemptedAt,
				result.completedAt,
				result.httpStatus,
				content.contentHash,
				content.performedFullFetch ? result.completedAt : null,
				nextFetchAt,
				content.format,
				content.finalUrl,
				content.finalUrl,
				result.outcome,
				result.durationMs,
				feed.feed_key,
				feed.feed_key,
				feed.feed_key,
				feed.refresh_lease_token ?? null,
				feed.refresh_lease_token ?? null,
			),
		);

		for (const alias of [...new Set(content.aliases)]) {
			if (alias === content.finalUrl) continue;
			statements.push(
				env.DB.prepare(
					`INSERT OR IGNORE INTO feed_url_aliases (alias_url, feed_key, canonical_url)
					 VALUES (?, ?, ?)`,
				).bind(alias, feed.feed_key, content.finalUrl),
			);
		}
	} else {
		statements.push(
			env.DB.prepare(
				`UPDATE feeds SET last_fetched_at = ?,
				     last_attempt_at = ?,
				     last_success_at = CASE WHEN ? = 1 THEN ? ELSE last_success_at END,
				     fetch_error = ?,
				     consecutive_failures = ?,
				     last_http_status = ?,
				     retry_after_at = ?,
				     next_fetch_at = ?,
				     last_refresh_outcome = ?,
				     last_fetch_duration_ms = ?,
				     refresh_lease_until = NULL,
				     refresh_lease_token = NULL
				 WHERE feed_key = ?
				   AND (? IS NULL OR refresh_lease_token = ?)`,
			).bind(
				result.attemptedAt,
				result.attemptedAt,
				succeeded ? 1 : 0,
				result.completedAt,
				result.errorMessage,
				failureCount,
				result.httpStatus,
				result.retryAt,
				nextFetchAt,
				result.outcome,
				result.durationMs,
				feed.feed_key,
				feed.refresh_lease_token ?? null,
				feed.refresh_lease_token ?? null,
			),
		);
	}

	statements.push(activityStatement(env.DB, result));

	await env.DB.batch(statements);
	return true;
}

function activityStatement(db: D1Database, result: RefreshResult): D1PreparedStatement {
	return db.prepare(
		`INSERT INTO refresh_activity (
		  id, feed_key, attempted_at, completed_at, outcome, http_status,
		  duration_ms, items_added, response_bytes, error_code, error_message, retry_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).bind(
		crypto.randomUUID(),
		result.feedKey,
		result.attemptedAt,
		result.completedAt,
		result.outcome,
		result.httpStatus,
		result.durationMs,
		result.itemsProcessed,
		result.responseBytes,
		result.errorCode,
		result.errorMessage,
		result.retryAt,
	);
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
		item.guid || item.link || [item.title, item.pubDate || '', item.author || '', item.content].join('\n');
	const digest = await sha256Hex(`${feedKey}\n${rawIdentity}`);
	return { id: hexToUuid(digest), messageId: `rss:${digest}` };
}

async function sha256Hex(input: string): Promise<string> {
	const data = new TextEncoder().encode(input);
	const hash = await crypto.subtle.digest('SHA-256', data);
	return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hexToUuid(hex: string): string {
	const raw = hex.slice(0, 32);
	const versioned = `${raw.slice(0, 12)}5${raw.slice(13, 16)}${(
		(parseInt(raw.slice(16, 18), 16) & 0x3f) |
		0x80
	)
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
