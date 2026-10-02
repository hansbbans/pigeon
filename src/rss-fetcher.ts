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
import { parseFeed, type FeedFormat, type ParsedFeed, type ParsedItem } from './rss-parser';
import { resolveRssItemUrl, rewriteRssContentLinks } from './rss-links';
import { assertBoundedIdentifier, boundedStoredUrl, MAX_TEXT_METADATA_BYTES, truncateUtf8 } from './content-size';
import { decodeHtmlTextEntities } from './preview-text';
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
	queryReservation?: RefreshQueryReservation;
}

/** Shared invocation allowance; reservations happen synchronously before D1 awaits. */
export class RefreshQueryBudget {
	constructor(private remaining: number) {}

	reserve(count: number): boolean {
		if (count > this.remaining) return false;
		this.remaining -= count;
		return true;
	}

	refund(count: number): void { this.remaining += count; }

	reserveFeedClaim(): RefreshQueryReservation | null {
		// Claim, baseline lookup, and a guaranteed conditional lease release.
		return this.reserve(3) ? new RefreshQueryReservation(this) : null;
	}
}

export class RefreshQueryReservation {
	private releaseAvailable = true;
	constructor(readonly budget: RefreshQueryBudget) {}

	consumeRelease(): boolean {
		if (!this.releaseAvailable) return false;
		this.releaseAvailable = false;
		return true;
	}

	finish(): void {
		if (!this.releaseAvailable) return;
		this.releaseAvailable = false;
		this.budget.refund(1);
	}

	unclaimed(): void {
		this.finish();
		this.skipBaseline();
	}

	skipBaseline(): void { this.budget.refund(1); }
}

export interface RefreshResult {
	feedKey: string;
	outcome: RefreshOutcome | 'budget_deferred';
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
// Nine item columns plus two ownership bindings stay below D1's 100-parameter limit.
const MAX_ITEMS_PER_INSERT = 10;
/** Maximum stored plain-text excerpt used by topic matching. */
export const MAX_RSS_TEXT_CONTENT_SIZE = 8_000;
/** Maximum HTML source inspected when deriving a plain-text excerpt. */
export const MAX_RSS_TEXT_SOURCE_SIZE = 32_000;
const PERSISTENCE_LEASE_MINUTES = 3;
const USER_AGENT = 'Pigeon RSS Reader/1.0';
const INITIAL_BASELINE_VERSION = 1;
const INITIAL_BASELINE_KEY_PREFIX = 'feed_initial_baseline:';

export interface InitialImportBaseline {
	version: 1;
	cutoffAt: string | null;
	excludedMessageIds: string[];
	selectedMessageIds: string[];
}

export function initialImportBaselineKey(feedKey: string): string {
	return `${INITIAL_BASELINE_KEY_PREFIX}${feedKey}`;
}

export function serializeInitialImportBaseline(baseline: InitialImportBaseline): string {
	return JSON.stringify(baseline);
}

export function deduplicateParsedItems(items: ParsedItem[]): ParsedItem[] {
	const seen = new Set<string>();
	return items.filter((item) => {
		const identity = item.guid || item.link || [item.title, item.pubDate || '', item.author || '', item.content].join('\n');
		if (seen.has(identity)) return false;
		seen.add(identity);
		return true;
	});
}

export async function buildRssItemStatements(
	db: D1Database,
	feedKey: string,
	parsed: Pick<ParsedFeed, 'link'> & { sourceUrl: string },
	items: ParsedItem[],
	fallbackReceivedAt: string,
	options: { updateExisting?: boolean; compactWrites?: boolean; leaseToken?: string | null } = {},
): Promise<D1PreparedStatement[]> {
	assertBoundedIdentifier(feedKey, 'Feed key');
	const statements: D1PreparedStatement[] = [];
	let bufferedRows: unknown[][] = [];
	let bufferedSql = '';
	const flushRows = () => {
		if (bufferedRows.length === 0) return;
		const placeholders = bufferedRows.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
		const source = options.leaseToken
			? `SELECT column1, column2, column3, column4, column5, column6, column7, column8, column9
			   FROM (VALUES ${placeholders})
			   WHERE EXISTS (SELECT 1 FROM feeds WHERE feed_key = ? AND refresh_lease_token = ?)`
			: `VALUES ${placeholders}`;
		const sql = bufferedSql.replace('VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', source);
		const values = bufferedRows.flat();
		if (options.leaseToken) values.push(feedKey, options.leaseToken);
		statements.push(db.prepare(sql).bind(...values));
		bufferedRows = [];
	};
	for (const item of items) {
		const identity = await createRssItemIdentity(feedKey, item);
		const originalUrl = resolveRssItemUrl({
			itemGuid: item.guid,
			itemLink: item.link,
			content: item.content,
			title: item.title,
			feedSiteUrl: parsed.link,
			feedSourceUrl: parsed.sourceUrl,
		});
		const contentBaseUrl = originalUrl || parsed.link || parsed.sourceUrl;
		let content = rewriteRssContentLinks(
			appendFeedAttachments(item.content, item.attachments),
			contentBaseUrl,
		);
		const textContent = htmlToBoundedText(content);
		const contentBudget = MAX_CONTENT_SIZE - new Blob([textContent ?? '']).size;
		if (new Blob([content]).size > contentBudget) {
			const notice = '\n\n[Content truncated]';
			content = truncateUtf8(content, contentBudget - new Blob([notice]).size) + notice;
		}

		const insertSql = options.updateExisting
			? `INSERT INTO items (
					id, message_id, feed_key, subject,
					from_name, received_at, html_content, text_content, original_url
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(message_id) DO UPDATE SET
						from_name = excluded.from_name,
						from_email = NULL,
						html_content = excluded.html_content,
						text_content = excluded.text_content,
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
						END`
			: `INSERT OR IGNORE INTO items (
					id, message_id, feed_key, subject,
					from_name, received_at, html_content, text_content, original_url
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

		const values = [
			identity.id,
			identity.messageId,
			feedKey,
			truncateUtf8(item.title, MAX_TEXT_METADATA_BYTES),
			item.author ? truncateUtf8(item.author, MAX_TEXT_METADATA_BYTES) : null,
			item.pubDate || fallbackReceivedAt,
			content,
			textContent,
			boundedStoredUrl(originalUrl),
		];
		if (bufferedRows.length === MAX_ITEMS_PER_INSERT) flushRows();
		bufferedSql = insertSql;
		bufferedRows.push(values);
		if (!options.compactWrites) flushRows();
	}
	flushRows();
	return statements;
}

export async function fetchAndStoreRssFeed(env: Env, feed: FeedToFetch): Promise<RefreshResult> {
	await ensureDatabaseSchema(env);
	const startedAt = Date.now();
	const attemptedAt = new Date(startedAt).toISOString();

	try {
		const initialBaseline = await loadInitialImportBaseline(env.DB, feed.feed_key);
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

		// Keep the same bounded source window used by established feeds. Applying
		// the initial baseline to the window avoids hashing or importing an older
		// undated backlog that falls beyond the normal poll limit.
		const pollWindow = parsed.items.slice(0, MAX_ITEMS_PER_FETCH);
		const filteredItems = initialBaseline
			? await filterItemsForInitialBaseline(feed, pollWindow, initialBaseline)
			: pollWindow;
		const items = initialBaseline
			? deduplicateParsedItems(filteredItems).slice(0, MAX_ITEMS_PER_FETCH)
			: filteredItems;
		const statements = await buildRssItemStatements(
			env.DB,
			feed.feed_key,
			{ link: parsed.link, sourceUrl: resource.finalUrl.href },
			items,
			attemptedAt,
			{ updateExisting: true, compactWrites: true, leaseToken: feed.refresh_lease_token },
		);

		const content: SuccessfulContent = {
			statements,
			format: parsed.format,
			siteUrl: boundedStoredUrl(parsed.link ?? null),
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
	const persistence = await persistRefresh(env, feed, result, content);
	if (persistence === 'saved') return result;
	if (persistence === 'budget_deferred') {
		return {
			...result,
			outcome: 'budget_deferred',
			itemsProcessed: 0,
			errorCode: 'query_budget_deferred',
			errorMessage: 'Refresh deferred until the next scheduled invocation',
		};
	}

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
	const reservation = feed.queryReservation;
	if (!reservation || reservation.consumeRelease() || reservation.budget.reserve(1)) {
		await activityStatement(env.DB, leaseLost).run();
	}
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

/**
 * Convert bounded RSS HTML to a compact text excerpt for topic matching.
 * Feed markup is untrusted, so comments and non-content containers are
 * removed before tags are stripped. Numeric entities are decoded only when
 * their code point is valid; malformed entities remain literal text.
 */
export function htmlToBoundedText(value: string): string | null {
	const source = value.slice(0, MAX_RSS_TEXT_SOURCE_SIZE);
	const text = decodeHtmlTextEntities(
		source
			.replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
			.replace(/<head\b[^>]*>[\s\S]*?(?:<\/head\s*>|$)/gi, ' ')
			.replace(/<(style|script)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
			.replace(/<br\b[^>]*\/?>/gi, ' ')
			.replace(/<\/(p|div|li|tr|td|th|section|article|h[1-6])>/gi, ' ')
			.replace(/<[^>]+>/g, ' '),
	);
	const normalized = text
		.replace(/\u00a0/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, MAX_RSS_TEXT_CONTENT_SIZE);
	return normalized || null;
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
): Promise<'saved' | 'lease_lost' | 'budget_deferred'> {
	if (result.outcome === 'budget_deferred') return 'budget_deferred';

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
	let feedUpdate: D1PreparedStatement;

	if (content) {
		feedUpdate = env.DB.prepare(
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
		);

		for (const alias of [...new Set(content.aliases)]) {
			if (alias === content.finalUrl) continue;
			statements.push(
				env.DB.prepare(
					`INSERT OR IGNORE INTO feed_url_aliases (alias_url, feed_key, canonical_url)
					 SELECT ?, ?, ?
					 WHERE ? IS NULL OR EXISTS (SELECT 1 FROM feeds WHERE feed_key = ? AND refresh_lease_token = ?)`,
				).bind(alias, feed.feed_key, content.finalUrl, feed.refresh_lease_token ?? null, feed.feed_key, feed.refresh_lease_token ?? null),
			);
		}
	} else {
		feedUpdate = env.DB.prepare(
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
		);
	}

	// All guarded writes run before the final feed update releases ownership.
	statements.push(activityStatement(env.DB, result, feed.refresh_lease_token));
	statements.push(feedUpdate);

	const reservation = feed.queryReservation;
	const persistenceCost = statements.length + (feed.refresh_lease_token ? 1 : 0);
	if (reservation && !reservation.budget.reserve(persistenceCost)) {
		if (reservation.consumeRelease() || reservation.budget.reserve(1)) {
			await env.DB.prepare(
				`UPDATE feeds SET refresh_lease_until = NULL, refresh_lease_token = NULL
				 WHERE feed_key = ? AND refresh_lease_token = ?`,
			).bind(feed.feed_key, feed.refresh_lease_token).run();
		}
		return 'budget_deferred';
	}
	if (feed.refresh_lease_token) {
		const renewedUntil = new Date(Date.now() + PERSISTENCE_LEASE_MINUTES * 60_000).toISOString();
		const renewal = await env.DB.prepare(
			`UPDATE feeds SET refresh_lease_until = ?
			 WHERE feed_key = ? AND refresh_lease_token = ?`,
		).bind(renewedUntil, feed.feed_key, feed.refresh_lease_token).run();
		if (renewal.meta.changes === 0) {
			reservation?.budget.refund(statements.length);
			return 'lease_lost';
		}
	}
	const results = await env.DB.batch(statements);
	const feedUpdateResult = results?.[statements.length - 1];
	if (feedUpdateResult?.meta?.changes === 0) return 'lease_lost';
	if (feedUpdateResult?.meta?.changes === 1) reservation?.finish();
	return 'saved';
}

function activityStatement(db: D1Database, result: RefreshResult, leaseToken?: string | null): D1PreparedStatement {
	return db.prepare(
		`INSERT INTO refresh_activity (
		  id, feed_key, attempted_at, completed_at, outcome, http_status,
		  duration_ms, items_added, response_bytes, error_code, error_message, retry_at
		) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
		 WHERE ? IS NULL OR EXISTS (SELECT 1 FROM feeds WHERE feed_key = ? AND refresh_lease_token = ?)`,
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
		leaseToken ?? null,
		result.feedKey,
		leaseToken ?? null,
	);
}

export async function createRssItemIdentity(
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

async function loadInitialImportBaseline(
	db: D1Database,
	feedKey: string,
): Promise<InitialImportBaseline | null> {
	const row = await db
		.prepare('SELECT value FROM _meta WHERE key = ?')
		.bind(initialImportBaselineKey(feedKey))
		.first<{ value: string | null }>();
	if (!row?.value) return null;
	try {
		const parsed = JSON.parse(row.value) as Partial<InitialImportBaseline>;
		if (
			parsed.version !== INITIAL_BASELINE_VERSION ||
			(parsed.cutoffAt !== null && typeof parsed.cutoffAt !== 'string') ||
			!Array.isArray(parsed.excludedMessageIds) ||
			parsed.excludedMessageIds.some((id) => typeof id !== 'string') ||
			(parsed.selectedMessageIds !== undefined &&
				(!Array.isArray(parsed.selectedMessageIds) || parsed.selectedMessageIds.some((id) => typeof id !== 'string')))
		) {
			return null;
		}
		return {
			version: 1,
			cutoffAt: parsed.cutoffAt ?? null,
			excludedMessageIds: [...new Set(parsed.excludedMessageIds)],
			selectedMessageIds: [...new Set(parsed.selectedMessageIds ?? [])],
		};
	} catch {
		return null;
	}
}

async function filterItemsForInitialBaseline(
	feed: FeedToFetch,
	items: ParsedItem[],
	baseline: InitialImportBaseline,
): Promise<ParsedItem[]> {
	const excluded = new Set(baseline.excludedMessageIds);
	const selected = new Set(baseline.selectedMessageIds);
	const cutoffAt = baseline.cutoffAt === null ? Number.NaN : Date.parse(baseline.cutoffAt);
	const candidates = await Promise.all(
		items.map(async (item) => ({
			item,
			messageId: (await createRssItemIdentity(feed.feed_key, item)).messageId,
		})),
	);

	return candidates
		.filter(({ item, messageId }) => {
			if (selected.has(messageId)) return true;
			if (excluded.has(messageId)) return false;
			if (!item.pubDate) return true;
			const publishedAt = Date.parse(item.pubDate);
			return !Number.isFinite(cutoffAt) || !Number.isFinite(publishedAt) || publishedAt >= cutoffAt;
		})
		.map(({ item }) => item);
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
