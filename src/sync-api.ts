import type { Env } from './types';

const DEFAULT_SYNC_LIMIT = 100;
const MAX_SYNC_LIMIT = 200;
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
}

interface FeedTagRow {
	feed_key: string;
	label: string;
}

interface ArticleSyncRow {
	rowid: number;
	id: string;
	feed_key: string;
	source: string;
	title: string;
	author: string | null;
	html_content: string;
	text_content: string | null;
	original_url: string | null;
	received_at: string;
	is_read: number;
	is_starred: number;
	content_pruned_at: string | null;
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
	const limit = parseLimit(url.searchParams.get('limit'));
	const { results } = await env.DB.prepare(
		`SELECT sequence, entity_type, entity_id, operation, changed_at
		 FROM sync_changes
		 WHERE sequence > ?
		 ORDER BY sequence ASC
		 LIMIT ?`,
	)
		.bind(cursor, limit + 1)
		.all<SyncEventRow>();

	const pageEvents = results.slice(0, limit);
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
		hasMore: results.length > limit,
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

function parseLimit(value: string | null): number {
	const parsed = Number.parseInt(value ?? String(DEFAULT_SYNC_LIMIT), 10);
	if (!Number.isFinite(parsed)) return DEFAULT_SYNC_LIMIT;
	return Math.min(Math.max(parsed, 1), MAX_SYNC_LIMIT);
}

async function loadPayloads(env: Env, events: SyncEventRow[]): Promise<Map<string, unknown>> {
	const payloads = new Map<string, unknown>();
	const feedIDs = uniqueEntityIDs(events, 'feed');
	const articleIDs = uniqueEntityIDs(events, 'article');
	const statusIDs = uniqueEntityIDs(events, 'status');

	const [feeds, feedTags, articles, statuses] = await Promise.all([
		loadRows<FeedSyncRow>(
			env.DB,
			feedIDs,
			`SELECT rowid, feed_key, COALESCE(custom_title, display_name) AS title,
			        source_url, site_url, icon_url, is_active
			 FROM feeds WHERE feed_key IN`,
		),
		loadRows<FeedTagRow>(
			env.DB,
			feedIDs,
			'SELECT feed_key, label FROM feed_tags WHERE feed_key IN',
		),
		loadRows<ArticleSyncRow>(
			env.DB,
			articleIDs,
			`SELECT i.rowid, i.id, i.feed_key,
			        COALESCE(f.custom_title, f.display_name) AS source,
			        i.subject AS title, i.from_name AS author, i.html_content,
			        i.text_content, i.original_url, i.received_at,
			        i.is_read, i.is_starred, i.content_pruned_at
			 FROM items i JOIN feeds f ON f.feed_key = i.feed_key WHERE i.id IN`,
		),
		loadRows<StatusSyncRow>(
			env.DB,
			statusIDs,
			`SELECT item_id, is_read, is_starred, updated_at, version, mutation_id
			 FROM item_statuses WHERE account_id = 'default' AND item_id IN`,
		),
	]);

	const tagsByFeed = feedTags.reduce((map, row) => {
		const labels = map.get(row.feed_key) ?? [];
		labels.push(row.label);
		map.set(row.feed_key, labels);
		return map;
	}, new Map<string, string[]>());
	for (const feed of feeds) {
		payloads.set(eventKey('feed', feed.feed_key), {
			feedKey: feed.feed_key,
			streamId: `feed/${feed.rowid}`,
			title: feed.title,
			feedURL: feed.source_url,
			siteURL: feed.site_url,
			iconURL: feed.icon_url,
			isActive: feed.is_active === 1,
			folders: [...new Set(tagsByFeed.get(feed.feed_key) ?? [])].sort(),
		});
	}

	for (const article of articles) {
		payloads.set(eventKey('article', article.id), {
			id: article.id,
			readerId: toGoogleItemID(article.rowid),
			feedKey: article.feed_key,
			source: article.source,
			title: article.title,
			author: article.author,
			html: article.html_content,
			text: article.text_content,
			originalURL: article.original_url,
			receivedAt: toISO8601(article.received_at),
			isRead: article.is_read === 1,
			isStarred: article.is_starred === 1,
			isBodyPruned: article.content_pruned_at !== null,
		});
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

function toGoogleItemID(rowid: number): string {
	return `tag:google.com,2005:reader/item/${rowid.toString(16).padStart(16, '0')}`;
}

function toISO8601(value: string): string {
	const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
		? `${value.replace(' ', 'T')}Z`
		: value;
	const date = new Date(normalized);
	if (Number.isNaN(date.getTime())) throw new Error(`Invalid database timestamp: ${value}`);
	return date.toISOString();
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
