import { readingLengthFields } from './reading-length';
import { googleReaderItemId } from './item-identity';
import { savedMetadataFields } from './saved-items';
import type { Env } from './types';
import { ARTICLE_AUTHOR_SQL } from './article-author';
import { isPaywalledHtml } from './paywall';
import { toISO8601 } from './timestamps';

const DEFAULT_SYNC_LIMIT = 100;
const MAX_SYNC_LIMIT = 200;
// Article bodies dominate the Worker's CPU time: D1 hands them over as JSON and
// the response serializes them again. Twelve long newsletters (about 0.6 MB)
// exceeded the 10 ms Free-plan limit while six (about 0.2 MB) did not, so a page
// also stops once its bodies reach this many characters.
export const SYNC_PAGE_BODY_BUDGET = 192_000;
const QUERY_CHUNK_SIZE = 80;
const CURSOR_PREFIX = 'v1:';

interface SyncEventRow {
	sequence: number;
	entity_type: 'feed' | 'article' | 'status';
	entity_id: string;
	operation: 'upsert' | 'delete';
	changed_at: string;
}

interface FeedSyncRow {
	rowid: number;
	feed_key: string;
	title: string;
	source_url: string | null;
	site_url: string | null;
	icon_url: string | null;
	is_active: number;
	source_type: string;
}

interface FeedTagRow {
	feed_key: string;
	label: string;
}

export interface ArticleSyncRow {
	rowid: number;
	id: string;
	feed_key: string;
	source: string;
	title: string;
	author: string | null;
	original_url: string | null;
	received_at: string;
	is_read: number;
	is_starred: number;
	content_pruned_at: string | null;
	word_count: number | null;
	media_kind: string | null;
	duration_seconds: number | null;
	published_at: string | null;
	image_url: string | null;
	site_name: string | null;
	extraction_state: string | null;
	has_transcript: number;
}

/** An article row read with its body (`articleSelectSQL({ includeBody: true })`). */
export interface ArticleBodySyncRow extends ArticleSyncRow {
	html_content: string;
	text_content: string | null;
}

interface StatusSyncRow {
	item_id: string;
	is_read: number;
	is_starred: number;
	updated_at: string;
	version: number;
	mutation_id: string | null;
}

export async function handleIncrementalSync(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	let cursor: number;
	try {
		cursor = decodeCursor(url.searchParams.get('cursor'));
	} catch (error) {
		return Response.json({ error: errorMessage(error) }, { status: 400 });
	}
	const limit = clampedLimit(url.searchParams.get('limit'), DEFAULT_SYNC_LIMIT, MAX_SYNC_LIMIT);
	// Payloads are read from current rows, so an event followed by a later event
	// for the same item would only resend data the later event also carries.
	// Article payloads include read and star state, which also supersedes older
	// status events. Feed events stay uncompacted so feeds precede their articles.
	const { results } = await env.DB.prepare(
		`SELECT c.sequence, c.entity_type, c.entity_id, c.operation, c.changed_at
		 FROM sync_changes c
		 WHERE c.sequence > ?
		   AND NOT (c.entity_type IN ('article', 'status') AND EXISTS (
		     SELECT 1 FROM sync_changes later
		     WHERE later.entity_type = 'article' AND later.entity_id = c.entity_id AND later.sequence > c.sequence
		   ))
		   AND NOT (c.entity_type = 'status' AND EXISTS (
		     SELECT 1 FROM sync_changes later
		     WHERE later.entity_type = 'status' AND later.entity_id = c.entity_id AND later.sequence > c.sequence
		   ))
		 ORDER BY c.sequence ASC
		 LIMIT ?`,
	)
		.bind(cursor, limit + 1)
		.all<SyncEventRow>();

	const candidates = results.slice(0, limit);
	const pageEvents = await withinBodyBudget(env, candidates);
	const hasMore = results.length > limit || pageEvents.length < candidates.length;
	const payloads = await loadPayloads(env, pageEvents);
	const changes = pageEvents.map((event) => {
		const key = eventKey(event.entity_type, event.entity_id);
		const payload = event.operation === 'delete' ? null : (payloads.get(key) ?? null);
		return {
			sequence: event.sequence,
			entityType: event.entity_type,
			entityId: event.entity_id,
			operation: payload === null ? 'delete' : 'upsert',
			changedAt: toISO8601(event.changed_at),
			payload,
		};
	});
	const nextSequence = pageEvents.at(-1)?.sequence ?? cursor;

	return Response.json({
		cursor: encodeCursor(nextSequence),
		hasMore,
		changes,
	});
}

export function encodeCursor(sequence: number): string {
	return `${CURSOR_PREFIX}${sequence}`;
}

export function decodeCursor(value: string | null): number {
	if (value === null || value === '') return 0;
	if (!value.startsWith(CURSOR_PREFIX)) throw new Error('Unsupported sync cursor');
	const raw = value.slice(CURSOR_PREFIX.length);
	if (!/^\d+$/.test(raw)) throw new Error('Invalid sync cursor');
	const sequence = Number(raw);
	if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('Invalid sync cursor');
	return sequence;
}

/** A `limit` query parameter clamped to 1…`max`; missing or junk gives `fallback`. */
export function clampedLimit(value: string | null, fallback: number, max: number): number {
	const parsed = Number.parseInt(value ?? String(fallback), 10);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(Math.max(parsed, 1), max);
}

/** The newest change-log sequence, or 0 for an empty log. */
export async function changeLogHead(env: Pick<Env, 'DB'>): Promise<number> {
	const row = await env.DB.prepare('SELECT COALESCE(MAX(sequence), 0) AS head FROM sync_changes')
		.first<{ head: number }>();
	return row?.head ?? 0;
}

/** Trims a page to the events whose article bodies fit the budget. The first
 * event is always kept, so one oversized article still makes progress. */
async function withinBodyBudget(env: Env, events: SyncEventRow[]): Promise<SyncEventRow[]> {
	const sizes = await loadArticleBodySizes(env, uniqueEntityIDs(events, 'article'));
	let total = 0;
	for (const [index, event] of events.entries()) {
		total += event.entity_type === 'article' ? (sizes.get(event.entity_id) ?? 0) : 0;
		if (index > 0 && total > SYNC_PAGE_BODY_BUDGET) return events.slice(0, index);
	}
	return events;
}

/** Body sizes (html plus text, in characters) of the items that exist, keyed by id. */
export async function loadArticleBodySizes(env: Env, ids: string[]): Promise<Map<string, number>> {
	return new Map(
		(await loadRows<{ id: string; size: number }>(
			env.DB,
			ids,
			`SELECT id, LENGTH(html_content) + COALESCE(LENGTH(text_content), 0) AS size
			 FROM items WHERE id IN`,
		)).map((row) => [row.id, row.size]),
	);
}

async function loadPayloads(env: Env, events: SyncEventRow[]): Promise<Map<string, unknown>> {
	const payloads = new Map<string, unknown>();
	const statusIDs = uniqueEntityIDs(events, 'status');

	const [feeds, articles, statuses] = await Promise.all([
		loadFeedPayloads(env, uniqueEntityIDs(events, 'feed')),
		loadArticlePayloads(env, uniqueEntityIDs(events, 'article'), { includeBody: true }),
		loadRows<StatusSyncRow>(
			env.DB,
			statusIDs,
			`SELECT item_id, is_read, is_starred, updated_at, version, mutation_id
			 FROM item_statuses WHERE account_id = 'default' AND item_id IN`,
		),
	]);

	for (const feed of feeds) {
		payloads.set(eventKey('feed', feed.feedKey), feed);
	}
	for (const [id, article] of articles) {
		payloads.set(eventKey('article', id), article);
	}
	for (const status of statuses) {
		payloads.set(eventKey('status', status.item_id), {
			itemId: status.item_id,
			isRead: status.is_read === 1,
			isStarred: status.is_starred === 1,
			updatedAt: toISO8601(status.updated_at),
			version: status.version,
			mutationId: status.mutation_id,
		});
	}

	return payloads;
}

export interface FeedPayload {
	feedKey: string;
	streamId: string;
	title: string;
	feedURL: string | null;
	siteURL: string | null;
	iconURL: string | null;
	isActive: boolean;
	sourceType: string;
	folders: string[];
}

export type ArticlePayload = Record<string, unknown> & { id: string };

const FEED_PAYLOAD_SQL = `SELECT rowid, feed_key, COALESCE(custom_title, display_name) AS title,
        source_url, site_url, icon_url, is_active, source_type
 FROM feeds`;

/** Feed payloads as sync sends them. `'all'` lists every feed, ordered by rowid. */
export async function loadFeedPayloads(env: Env, feedKeys: string[] | 'all'): Promise<FeedPayload[]> {
	const [feeds, feedTags] = feedKeys === 'all'
		? await Promise.all([
			env.DB.prepare(`${FEED_PAYLOAD_SQL} ORDER BY rowid`).all<FeedSyncRow>().then((page) => page.results),
			env.DB.prepare('SELECT feed_key, label FROM feed_tags').all<FeedTagRow>().then((page) => page.results),
		])
		: await Promise.all([
			loadRows<FeedSyncRow>(env.DB, feedKeys, `${FEED_PAYLOAD_SQL} WHERE feed_key IN`),
			loadRows<FeedTagRow>(env.DB, feedKeys, 'SELECT feed_key, label FROM feed_tags WHERE feed_key IN'),
		]);

	const tagsByFeed = feedTags.reduce((map, row) => {
		const labels = map.get(row.feed_key) ?? [];
		labels.push(row.label);
		map.set(row.feed_key, labels);
		return map;
	}, new Map<string, string[]>());
	return feeds.map((feed) => ({
		feedKey: feed.feed_key,
		streamId: `feed/${feed.rowid}`,
		title: feed.title,
		feedURL: feed.source_url,
		siteURL: feed.site_url,
		iconURL: feed.icon_url,
		isActive: feed.is_active === 1,
		sourceType: feed.source_type,
		folders: [...new Set(tagsByFeed.get(feed.feed_key) ?? [])].sort(),
	}));
}

/** The article columns every payload needs, without the body. Prefix with `SELECT`. */
const ARTICLE_METADATA_COLUMNS = `i.rowid, i.id, i.feed_key,
        COALESCE(f.custom_title, f.display_name) AS source,
        i.subject AS title, ${ARTICLE_AUTHOR_SQL} AS author,
        i.original_url, i.received_at,
        i.is_read, i.is_starred, i.content_pruned_at,
        i.word_count, i.media_kind, i.duration_seconds,
        i.published_at, i.image_url, i.site_name, i.extraction_state,
        EXISTS (SELECT 1 FROM item_transcripts t WHERE t.item_id = i.id) AS has_transcript`;

/**
 * Selects article rows joined to the item's feed: `ArticleSyncRow` metadata,
 * plus the body columns of `ArticleBodySyncRow` when `includeBody` is set.
 * Append a `WHERE` clause.
 */
export function articleSelectSQL(options: { includeBody: boolean }): string {
	const body = options.includeBody ? ', i.html_content, i.text_content' : '';
	return `SELECT ${ARTICLE_METADATA_COLUMNS}${body}
 FROM items i JOIN feeds f ON f.feed_key = i.feed_key`;
}

/**
 * Article payloads keyed by item id. Without the body the query never reads
 * `html_content`, so it stays cheap, and the payload leaves out every field
 * derived from the body (`html`, `text`, `isPaywalled`).
 */
export async function loadArticlePayloads(
	env: Env,
	ids: string[],
	options: { includeBody: boolean },
): Promise<Map<string, ArticlePayload>> {
	const sql = `${articleSelectSQL(options)} WHERE i.id IN`;
	if (options.includeBody) {
		const rows = await loadRows<ArticleBodySyncRow>(env.DB, ids, sql);
		return new Map(rows.map((row) => [row.id, articlePayload(row, row)]));
	}
	const rows = await loadRows<ArticleSyncRow>(env.DB, ids, sql);
	return new Map(rows.map((row) => [row.id, articlePayload(row)]));
}

/** Builds one article payload. Field order matches the sync contract. Without
 * `body` the payload leaves out `html`, `text` and `isPaywalled`. */
export function articlePayload(
	article: ArticleSyncRow,
	body?: Pick<ArticleBodySyncRow, 'html_content' | 'text_content'>,
): ArticlePayload {
	return {
		id: article.id,
		readerId: googleReaderItemId(article.rowid),
		feedKey: article.feed_key,
		source: article.source,
		title: article.title,
		author: article.author,
		...(body ? { html: body.html_content, text: body.text_content } : {}),
		originalURL: article.original_url,
		receivedAt: toISO8601(article.received_at),
		isRead: article.is_read === 1,
		isStarred: article.is_starred === 1,
		isBodyPruned: article.content_pruned_at !== null,
		...(body ? { isPaywalled: isPaywalledHtml(body.html_content) } : {}),
		...readingLengthFields(article),
		...savedMetadataFields(article, 'imageURL'),
		// Omitted unless true; fetch the body from GET /api/v1/items/:id/transcript.
		...(article.has_transcript === 1 ? { hasTranscript: true } : {}),
	};
}

async function loadRows<T>(db: D1Database, ids: string[], sqlPrefix: string): Promise<T[]> {
	if (ids.length === 0) return [];
	const pages = await Promise.all(
		chunk(ids, QUERY_CHUNK_SIZE).map((page) => {
			const placeholders = page.map(() => '?').join(',');
			return db.prepare(`${sqlPrefix} (${placeholders})`).bind(...page).all<T>();
		}),
	);
	return pages.flatMap((page) => page.results);
}

function uniqueEntityIDs(events: SyncEventRow[], type: SyncEventRow['entity_type']): string[] {
	return [...new Set(events.filter((event) => event.entity_type === type).map((event) => event.entity_id))];
}

function eventKey(type: SyncEventRow['entity_type'], id: string): string {
	return `${type}\u0000${id}`;
}

function chunk<T>(values: T[], size: number): T[][] {
	const pages: T[][] = [];
	for (let index = 0; index < values.length; index += size) {
		pages.push(values.slice(index, index + size));
	}
	return pages;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
