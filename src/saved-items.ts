/**
 * Read It Later: saved links live as items of one system feed.
 *
 * The Worker never fetches or parses a saved page (Free plan, 10 ms CPU).
 * Clients extract with Defuddle and upload the result; a save without content
 * is a pending bare link. Contract: docs/superpowers/plans/2026-11-03-read-it-later-03-core.md.
 */

import { boundedStoredUrl, truncateUtf8 } from './content-size';
import { createCanonicalItemUuid, googleReaderItemId, hasStoredItemId, parseGoogleReaderItemRowid } from './item-identity';
import type { Env } from './types';
import { extractYouTubeVideoId, type MediaKind } from './youtube';

export const SAVED_FEED_KEY = 'pigeon:saved';
export const SAVED_SOURCE_TYPE = 'saved';
export const SAVED_FEED_TITLE = 'Read It Later';

/**
 * SQL condition that leaves out the Read It Later feed, for every list that
 * is about subscriptions (Today, All, folders, refresh, retention, push).
 * Pass the qualified column, e.g. `notSavedFeedSql('f.source_type')`.
 */
export function notSavedFeedSql(column = 'source_type'): string {
	return `${column} <> '${SAVED_SOURCE_TYPE}'`;
}
/** Same body budget as email and RSS ingest: leaves room under D1's 1 MB row cap. */
export const MAX_SAVED_HTML_BYTES = 900_000;
/** A request carrying a full body plus metadata; JSON escaping can inflate HTML. */
export const MAX_SAVE_REQUEST_BYTES = 2_000_000;
export const MAX_SAVED_URL_LENGTH = 2048;
const MAX_TITLE_BYTES = 1_000;
const MAX_LABEL_BYTES = 500;
const MAX_WORD_COUNT = 2_000_000;
const MAX_DURATION_SECONDS = 1_000_000;

export type ExtractionState = 'pending' | 'done' | 'failed';

const TRACKING_PARAMS = new Set(['fbclid', 'gclid', 'mc_cid', 'mc_eid', 'ref_src', 'igshid']);
const YOUTUBE_TRACKING_PARAMS = new Set(['si', 'feature']);
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be']);

export interface NormalizedSavedUrl {
	url: string;
	mediaKind: MediaKind;
}

class BadRequest extends Error {}

/**
 * Canonical form used for dedupe: http(s) only, no credentials, no fragment,
 * no tracking parameters. YouTube video links collapse to the watch URL.
 * Throws BadRequest for anything that cannot be saved.
 */
export function normalizeSavedUrl(input: unknown): NormalizedSavedUrl {
	if (typeof input !== 'string') throw new BadRequest('url must be a string');
	const raw = input.trim();
	if (!raw) throw new BadRequest('url must not be empty');
	if (raw.length > MAX_SAVED_URL_LENGTH) throw new BadRequest(`url must be at most ${MAX_SAVED_URL_LENGTH} characters`);
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new BadRequest('url is not a valid URL');
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BadRequest('url must use http or https');
	if (url.username || url.password) throw new BadRequest('url must not contain credentials');
	if (!url.hostname) throw new BadRequest('url must have a host');

	const videoId = extractYouTubeVideoId(url.href);
	if (videoId) return { url: `https://www.youtube.com/watch?v=${videoId}`, mediaKind: 'video' };

	url.hash = '';
	url.search = withoutTrackingParams(url.search, YOUTUBE_HOSTS.has(url.hostname.replace(/\.$/, '')));
	const normalized = url.href;
	if (normalized.length > MAX_SAVED_URL_LENGTH) throw new BadRequest(`url must be at most ${MAX_SAVED_URL_LENGTH} characters`);
	return { url: normalized, mediaKind: 'text' };
}

/**
 * Drops tracking pairs from the raw query and keeps every other pair's text
 * verbatim, so the key is the same whether or not anything was removed
 * (URLSearchParams would re-encode `%20` as `+`, `/` as `%2F`, `flag` as `flag=`).
 * Empty pairs (`a=1&&b=2`, a trailing `&`) are dropped in every case.
 */
function withoutTrackingParams(search: string, isYouTube: boolean): string {
	const pairs = search.replace(/^\?/, '').split('&').filter((pair) => {
		if (!pair) return false;
		const rawKey = pair.split('=', 1)[0].replace(/\+/g, ' ');
		let key: string;
		try {
			key = decodeURIComponent(rawKey).toLowerCase();
		} catch {
			key = rawKey.toLowerCase();
		}
		return !(key.startsWith('utm_') || TRACKING_PARAMS.has(key) || (isYouTube && YOUTUBE_TRACKING_PARAMS.has(key)));
	});
	return pairs.length > 0 ? `?${pairs.join('&')}` : '';
}

/** `saved:` plus the hex SHA-256 of the normalized URL; the items.message_id dedupe key. */
export async function savedMessageId(normalizedUrl: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalizedUrl));
	return `saved:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** Title shown until extraction finishes: host plus path, without a bare trailing slash. */
export function fallbackSavedTitle(normalizedUrl: string): string {
	const url = new URL(normalizedUrl);
	const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
	return truncateUtf8(`${url.hostname}${path}`, MAX_TITLE_BYTES);
}

export interface SavedContent {
	/** Storable HTML, or null when absent or over the size cap. */
	html: string | null;
	htmlBytes: number;
	htmlTooLarge: boolean;
	/** Plain text of the extraction, for search; capped so html plus text fit the body budget. */
	text?: string;
	title?: string;
	wordCount?: number;
	author?: string;
	publishedAt?: string;
	imageUrl?: string;
	siteName?: string;
	mediaKind?: MediaKind;
	durationSeconds?: number;
}

/**
 * Validates an uploaded extraction. Structure errors (a non-object, a
 * non-string html) are 400s; unusable metadata (an unparseable date, a
 * non-http image) is dropped, because extractors pass such values through.
 */
export function parseSavedContent(value: unknown, urlMediaKind: MediaKind = 'text', now = new Date()): SavedContent {
	if (!isRecord(value)) throw new BadRequest('content must be an object');
	let html: string | null = null;
	let htmlBytes = 0;
	let htmlTooLarge = false;
	if (value.html !== undefined && value.html !== null) {
		if (typeof value.html !== 'string') throw new BadRequest('content.html must be a string');
		if (value.html.trim()) {
			htmlBytes = utf8Length(value.html);
			if (htmlBytes > MAX_SAVED_HTML_BYTES) htmlTooLarge = true;
			else html = value.html;
		}
	}
	const content: SavedContent = { html, htmlBytes: html === null ? 0 : htmlBytes, htmlTooLarge };
	if (value.text !== undefined && value.text !== null) {
		if (typeof value.text !== 'string') throw new BadRequest('content.text must be a string');
		const budget = MAX_SAVED_HTML_BYTES - content.htmlBytes;
		const text = value.text.trim() && budget > 0 ? truncateUtf8(value.text, budget) : '';
		if (text) content.text = text;
	}
	const title = optionalLabel(value.title, 'content.title', MAX_TITLE_BYTES);
	if (title) content.title = title;
	const author = optionalLabel(value.author, 'content.author', MAX_LABEL_BYTES);
	if (author) content.author = author;
	const site = optionalLabel(value.site, 'content.site', MAX_LABEL_BYTES);
	if (site) content.siteName = site;
	const publishedAt = normalizePublished(value.published, now);
	if (publishedAt) content.publishedAt = publishedAt;
	const image = typeof value.image === 'string' ? httpUrlOrNull(value.image) : null;
	if (image) content.imageUrl = image;
	const wordCount = boundedInteger(value.wordCount, MAX_WORD_COUNT);
	if (wordCount !== null) content.wordCount = wordCount;
	const duration = boundedInteger(value.durationSeconds, MAX_DURATION_SECONDS);
	if (duration !== null) content.durationSeconds = duration;
	if (value.mediaKind === 'text' || value.mediaKind === 'video') content.mediaKind = value.mediaKind;
	// A YouTube link is a video whatever the extractor says.
	if (urlMediaKind === 'video') content.mediaKind = 'video';
	if (html === null && !htmlTooLarge && content.mediaKind !== 'video') {
		throw new BadRequest('content.html is required unless the item is a video');
	}
	return content;
}

/**
 * ISO 8601 UTC, or undefined. Only date-shaped strings are read: V8's lenient
 * Date parser turns strings like "1" or "An hour ago 2" into real dates.
 * A date-time without an offset is read as UTC.
 */
export function normalizePublished(value: unknown, now = new Date()): string | undefined {
	if (typeof value !== 'string') return undefined;
	const trimmed = value.trim();
	const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/i.exec(trimmed);
	if (!iso) return undefined;
	const [, , , , hour, , , zone] = iso;
	const candidate = hour === undefined
		? `${trimmed.slice(0, 10)}T00:00:00Z`
		: `${trimmed.replace(' ', 'T')}${zone ? '' : 'Z'}`;
	const date = new Date(candidate);
	const time = date.getTime();
	if (!Number.isFinite(time)) return undefined;
	if (date.getUTCFullYear() < 1900 || time > now.getTime() + 2 * 86_400_000) return undefined;
	return date.toISOString();
}

interface SavedRow {
	rowid: number;
	id: string;
	feed_key: string;
	subject: string;
	is_read: number;
	extraction_state: string | null;
	has_html: number;
	original_url: string | null;
}

const SAVED_ROW_COLUMNS = `rowid, id, feed_key, subject, COALESCE(is_read, 0) AS is_read, extraction_state, original_url,
	CASE WHEN html_content <> '' THEN 1 ELSE 0 END AS has_html`;

/** Routes /api/v1/saved and /api/v1/saved/:id/content (auth and schema checked by the caller). */
export async function handleSavedRequest(request: Request, env: Env): Promise<Response> {
	const path = new URL(request.url).pathname;
	try {
		if (path === '/api/v1/saved') {
			if (request.method !== 'POST') return methodNotAllowed('POST');
			return await handleSave(request, env);
		}
		const content = /^\/api\/v1\/saved\/([^/]+)\/content$/.exec(path);
		if (content) {
			if (request.method !== 'PUT') return methodNotAllowed('PUT');
			return await handleContentUpload(request, env, content[1]);
		}
		return new Response('Not found', { status: 404 });
	} catch (error) {
		if (error instanceof BadRequest) return Response.json({ error: error.message }, { status: 400 });
		if (error instanceof PayloadTooLarge) return Response.json({ error: error.message }, { status: 413 });
		console.error('[Saved] Request failed', error instanceof Error ? error.message : String(error));
		return Response.json({ error: 'Could not save the item' }, { status: 503 });
	}
}

async function handleSave(request: Request, env: Env): Promise<Response> {
	const body = await readJsonBody(request);
	if (!isRecord(body)) throw new BadRequest('Request body must be a JSON object');
	const { url, mediaKind: urlMediaKind } = normalizeSavedUrl(body.url);
	const givenTitle = optionalLabel(body.title, 'title', MAX_TITLE_BYTES);
	const now = new Date();
	const content = body.content === undefined || body.content === null ? null : parseSavedContent(body.content, urlMediaKind, now);
	const messageId = await savedMessageId(url);
	const receivedAt = now.toISOString();

	const existing = await env.DB.prepare(`SELECT ${SAVED_ROW_COLUMNS} FROM items WHERE message_id = ?`)
		.bind(messageId).first<SavedRow>();
	if (!existing) {
		const id = await createCanonicalItemUuid({
			feedKey: SAVED_FEED_KEY, id: null, messageId, subject: '', htmlContent: '',
			fromName: null, fromEmail: null, receivedAt: '',
		});
		const mediaKind = urlMediaKind === 'video' ? 'video' : (content?.mediaKind ?? 'text');
		const state: ExtractionState = content && (content.html !== null || mediaKind === 'video') ? 'done' : 'pending';
		const results = await env.DB.batch([
			ensureSavedFeedStatement(env.DB),
			env.DB.prepare(
				`INSERT OR IGNORE INTO items
				 (id, feed_key, subject, html_content, text_content, original_url, message_id, received_at,
				  is_read, is_starred, content_size, content_version, word_count, media_kind, duration_seconds,
				  author, published_at, image_url, site_name, extraction_state)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
				 RETURNING rowid`,
			).bind(
				id, SAVED_FEED_KEY, content?.title ?? givenTitle ?? fallbackSavedTitle(url), content?.html ?? '',
				content?.text ?? null, url,
				messageId, receivedAt, content?.htmlBytes ?? 0, content?.wordCount ?? null, mediaKind,
				content?.durationSeconds ?? null, content?.author ?? null, content?.publishedAt ?? null,
				content?.imageUrl ?? null, content?.siteName ?? null, state,
			),
		]);
		const inserted = results[1]?.results?.[0] as { rowid: number } | undefined;
		if (inserted) {
			return Response.json(
				savedResult({ rowid: inserted.rowid, id }, url, state, { created: true, contentTooLarge: content?.htmlTooLarge }),
				{ status: 201 },
			);
		}
	}
	// Re-save (or a concurrent save that won the insert): bring it back to the top, unread.
	const row = existing ?? await env.DB.prepare(`SELECT ${SAVED_ROW_COLUMNS} FROM items WHERE message_id = ?`)
		.bind(messageId).first<SavedRow>();
	if (!row) throw new Error('Saved item vanished during save');
	const changes = new ColumnChanges();
	changes.set('received_at', receivedAt);
	if (row.is_read === 1) changes.set('is_read', 0);
	let state = currentState(row);
	if (content) {
		state = applyContent(changes, row, content, urlMediaKind);
	} else {
		if (state === 'failed') {
			state = 'pending';
			changes.set('extraction_state', state);
		}
		if (givenTitle && state === 'pending') changes.set('subject', givenTitle);
	}
	await env.DB.batch([ensureSavedFeedStatement(env.DB), changes.statement(env.DB, row.id)]);
	return Response.json(savedResult(row, url, state, { created: false, contentTooLarge: content?.htmlTooLarge }));
}

async function handleContentUpload(request: Request, env: Env, rawId: string): Promise<Response> {
	const row = await findSavedItem(env.DB, rawId);
	if (!row) return Response.json({ error: 'Saved item not found' }, { status: 404 });
	const body = await readJsonBody(request);
	if (!isRecord(body)) throw new BadRequest('Request body must be a JSON object');
	const url = row.original_url ?? '';
	if (body.failed !== undefined) {
		if (body.failed !== true) throw new BadRequest('failed must be true');
		if (Object.keys(body).length !== 1) throw new BadRequest('A failure report carries no content');
		const state = currentState(row);
		if (state === 'done') return Response.json({ ...savedResult(row, url, state), updated: false });
		const result = await env.DB.prepare(
			`UPDATE items SET extraction_state = 'failed'
			 WHERE id = ? AND extraction_state IS NOT 'failed' AND extraction_state IS NOT 'done'`,
		).bind(row.id).run();
		return Response.json({ ...savedResult(row, url, 'failed'), updated: Number(result.meta?.changes ?? 0) > 0 });
	}
	const urlMediaKind: MediaKind = url && extractYouTubeVideoId(url) ? 'video' : 'text';
	const content = parseSavedContent(body, urlMediaKind);
	const changes = new ColumnChanges();
	const state = applyContent(changes, row, content, urlMediaKind);
	const result = await changes.statement(env.DB, row.id).run();
	return Response.json({
		...savedResult(row, url, state, { contentTooLarge: content.htmlTooLarge }),
		updated: Number(result.meta?.changes ?? 0) > 0,
	});
}

/** Columns an extraction writes; returns the resulting extraction state. */
function applyContent(changes: ColumnChanges, row: SavedRow, content: SavedContent, urlMediaKind: MediaKind): ExtractionState {
	const mediaKind: MediaKind = urlMediaKind === 'video' ? 'video' : (content.mediaKind ?? 'text');
	let state: ExtractionState;
	if (content.html !== null) {
		changes.set('html_content', content.html);
		changes.set('text_content', content.text ?? null);
		changes.set('content_size', content.htmlBytes);
		state = 'done';
	} else if (mediaKind === 'video') {
		state = 'done';
	} else {
		// Oversize: keep a body that is already stored; otherwise the item stays a bare link.
		state = row.has_html === 1 ? currentState(row) : 'pending';
	}
	if (content.html === null && content.text) changes.set('text_content', content.text);
	changes.set('extraction_state', state);
	changes.set('media_kind', mediaKind);
	if (content.title) changes.set('subject', content.title);
	if (content.wordCount !== undefined) changes.set('word_count', content.wordCount);
	if (content.durationSeconds !== undefined) changes.set('duration_seconds', content.durationSeconds);
	if (content.author) changes.set('author', content.author);
	if (content.publishedAt) changes.set('published_at', content.publishedAt);
	if (content.imageUrl) changes.set('image_url', content.imageUrl);
	if (content.siteName) changes.set('site_name', content.siteName);
	return state;
}

/**
 * One UPDATE that writes only when at least one column differs, so a repeat
 * upload or re-save adds no sync event (see the sync compaction notes).
 * content_version (GReader clients refetch on it) goes up only when a column
 * other than the saved time or the read flag changes.
 */
class ColumnChanges {
	private readonly values = new Map<string, string | number | null>();

	set(column: string, value: string | number | null): void {
		this.values.set(column, value);
	}

	statement(db: D1Database, id: string): D1PreparedStatement {
		const entries = [...this.values.entries()];
		const bodyEntries = entries.filter(([column]) => column !== 'received_at' && column !== 'is_read');
		const differs = (list: typeof entries) => list.map(([column]) => `${column} IS NOT ?`).join(' OR ');
		const assignments = entries.map(([column]) => `${column} = ?`);
		// SET expressions read the row as it was before the update.
		if (bodyEntries.length > 0) {
			assignments.push(`content_version = content_version + CASE WHEN ${differs(bodyEntries)} THEN 1 ELSE 0 END`);
		}
		const values = (list: typeof entries) => list.map(([, value]) => value);
		return db.prepare(`UPDATE items SET ${assignments.join(', ')} WHERE id = ? AND feed_key = ? AND (${differs(entries)})`)
			.bind(...values(entries), ...values(bodyEntries), id, SAVED_FEED_KEY, ...values(entries));
	}
}

/**
 * Creates the saved feed on first use and reactivates it if an older client
 * unsubscribed from it. The conditional update keeps repeat saves free of
 * feed sync events.
 */
export function ensureSavedFeedStatement(db: D1Database): D1PreparedStatement {
	return db.prepare(
		`INSERT INTO feeds (feed_key, display_name, source_type, fetch_interval_minutes, is_active)
		 VALUES (?, ?, ?, NULL, 1)
		 ON CONFLICT(feed_key) DO UPDATE SET is_active = 1 WHERE feeds.is_active IS NOT 1`,
	).bind(SAVED_FEED_KEY, SAVED_FEED_TITLE, SAVED_SOURCE_TYPE);
}

async function findSavedItem(db: D1Database, rawId: string): Promise<SavedRow | null> {
	let id: string;
	try {
		id = decodeURIComponent(rawId);
	} catch {
		return null;
	}
	const rowid = hasStoredItemId(id) ? null : parseGoogleReaderItemRowid(id);
	if (!hasStoredItemId(id) && rowid === null) return null;
	const row = rowid === null
		? await db.prepare(`SELECT ${SAVED_ROW_COLUMNS} FROM items WHERE id = ?`).bind(id).first<SavedRow>()
		: await db.prepare(`SELECT ${SAVED_ROW_COLUMNS} FROM items WHERE rowid = ?`).bind(rowid).first<SavedRow>();
	return row && row.feed_key === SAVED_FEED_KEY ? row : null;
}

function savedResult(
	row: { rowid: number; id: string },
	url: string,
	state: ExtractionState,
	options: { created?: boolean; contentTooLarge?: boolean } = {},
) {
	return {
		id: row.id,
		readerId: googleReaderItemId(row.rowid),
		url,
		state,
		...(options.created === undefined ? {} : { created: options.created }),
		...(options.contentTooLarge ? { contentTooLarge: true } : {}),
	};
}

function currentState(row: SavedRow): ExtractionState {
	return row.extraction_state === 'done' || row.extraction_state === 'failed' ? row.extraction_state : 'pending';
}

class PayloadTooLarge extends Error {}

async function readJsonBody(request: Request): Promise<unknown> {
	const declared = Number(request.headers.get('Content-Length') ?? '0');
	if (Number.isFinite(declared) && declared > MAX_SAVE_REQUEST_BYTES) {
		throw new PayloadTooLarge(`Request body must be at most ${MAX_SAVE_REQUEST_BYTES} bytes`);
	}
	// Count bytes as they arrive: a chunked request has no Content-Length to trust.
	const decoder = new TextDecoder();
	let text = '';
	let received = 0;
	const reader = request.body?.getReader();
	while (reader) {
		const { done, value } = await reader.read();
		if (done) break;
		received += value.byteLength;
		if (received > MAX_SAVE_REQUEST_BYTES) {
			await reader.cancel().catch(() => undefined);
			throw new PayloadTooLarge(`Request body must be at most ${MAX_SAVE_REQUEST_BYTES} bytes`);
		}
		text += decoder.decode(value, { stream: true });
	}
	text += decoder.decode();
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new BadRequest('Request body must be valid JSON');
	}
}

function optionalLabel(value: unknown, name: string, maxBytes: number): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== 'string') throw new BadRequest(`${name} must be a string`);
	const collapsed = value.replace(/\s+/g, ' ').trim();
	return collapsed ? truncateUtf8(collapsed, maxBytes) : undefined;
}

function httpUrlOrNull(value: string): string | null {
	try {
		const url = new URL(value.trim());
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
		return boundedStoredUrl(url.href);
	} catch {
		return null;
	}
}

function boundedInteger(value: unknown, max: number): number | null {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) return null;
	return Math.round(value);
}

function utf8Length(value: string): number {
	// UTF-8 never takes fewer bytes than UTF-16 units, so a longer string is over the cap unencoded.
	if (value.length > MAX_SAVED_HTML_BYTES) return value.length;
	return new TextEncoder().encode(value).byteLength;
}

function methodNotAllowed(allow: string): Response {
	return new Response('Method not allowed', { status: 405, headers: { Allow: allow } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Optional saved-item metadata on sync articles (omitted when null). */
export interface SavedMetadataColumns {
	published_at?: string | null;
	image_url?: string | null;
	site_name?: string | null;
	extraction_state?: string | null;
}

export function savedMetadataFields(row: SavedMetadataColumns, urlKey: 'imageURL' | 'imageUrl'): Record<string, string> {
	const fields: Record<string, string> = {};
	if (row.extraction_state === 'pending' || row.extraction_state === 'done' || row.extraction_state === 'failed') {
		fields.extractionState = row.extraction_state;
	}
	if (row.published_at) fields.publishedAt = row.published_at;
	if (row.image_url) fields[urlKey] = row.image_url;
	if (row.site_name) fields.siteName = row.site_name;
	return fields;
}
