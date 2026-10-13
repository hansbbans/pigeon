import { ARTICLE_AUTHOR_SQL } from './article-author';
import type { Env } from './types';

const ALL = 'user/-/state/com.google/reading-list';
const READ = 'user/-/state/com.google/read';
const STARRED = 'user/-/state/com.google/starred';
const LABEL = 'user/-/label/';
const MAX_CURSOR_LENGTH = 1024;

interface ArticleQuery {
	stream: string;
	q: string;
	filter: 'all' | 'unread' | 'read';
	sort: 'newest' | 'oldest';
	since: string | null;
	before: string | null;
}

interface ArticleCursor {
	v: 1;
	query: string;
	date: number;
	rowid: number;
}

interface ArticleRow {
	rowid: number;
	date: number;
}

/**
 * GET /api/v1/browser/articles (authenticated by handleNativeApiRequest).
 * stream: all/reading-list, feed/<numeric ID>, user/-/label/<literal name>, read, starred.
 * q: literal substring of title, author, feed title, or text; max 200 characters.
 * filter: all/unread/read. sort: newest/oldest. limit: 1..100 (default 50).
 * since/before: UTC ISO timestamps, inclusive/exclusive; pass both for local Today.
 * continuation: opaque, query-bound keyset cursor. Reuse the same query parameters.
 * Response: { itemIds: decimal GReader IDs[], continuation: string|null, hasMore, sort }.
 * Load bodies through /reader/api/0/stream/items/contents with repeated i IDs and
 * preserve itemIds order. This is a live traversal, not an immutable snapshot.
 * Score/recommended sorting uses the separate recommendations API; items has no score.
 */
export async function handleBrowserArticles(request: Request, env: Env): Promise<Response> {
	if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET' } });
	try {
		const params = new URL(request.url).searchParams;
		const allowed = new Set(['stream', 'q', 'filter', 'sort', 'limit', 'since', 'before', 'continuation']);
		for (const key of params.keys()) {
			if (!allowed.has(key) || params.getAll(key).length !== 1) throw new InvalidQuery('Unknown or repeated query parameter');
		}
		const query = parseQuery(params);
		const rawLimit = params.get('limit') ?? '50';
		if (!/^[1-9]\d{0,2}$/.test(rawLimit) || Number(rawLimit) > 100) throw new InvalidQuery('limit must be between 1 and 100');
		const limit = Number(rawLimit);
		const fingerprint = await queryFingerprint(query);
		const cursor = parseCursor(params.get('continuation'), fingerprint);
		const where = ['f.is_active = 1'];
		const binds: (string | number)[] = [];
		if (query.stream === READ) where.push('i.is_read = 1');
		else if (query.stream === STARRED) where.push('i.is_starred = 1');
		else if (query.stream.startsWith(LABEL)) {
			where.push('(f.category = ? OR EXISTS (SELECT 1 FROM feed_tags ft WHERE ft.feed_key = f.feed_key AND ft.label = ?))');
			binds.push(query.stream.slice(LABEL.length), query.stream.slice(LABEL.length));
		} else if (query.stream.startsWith('feed/')) {
			where.push('f.rowid = ?');
			binds.push(Number(query.stream.slice(5)));
		}
		if (query.filter !== 'all') {
			where.push('i.is_read = ?');
			binds.push(query.filter === 'read' ? 1 : 0);
		}
		if (query.q) {
			// Bind the escaped pattern so SQL punctuation and LIKE wildcards are literal.
			const pattern = `%${query.q.replace(/[\\%_]/g, '\\$&')}%`;
			where.push(`(i.subject LIKE ? ESCAPE '\\' OR ${ARTICLE_AUTHOR_SQL} LIKE ? ESCAPE '\\'
				OR COALESCE(f.custom_title, f.display_name) LIKE ? ESCAPE '\\' OR i.text_content LIKE ? ESCAPE '\\')`);
			binds.push(pattern, pattern, pattern, pattern);
		}
		if (query.since) { where.push('julianday(i.received_at) >= julianday(?)'); binds.push(query.since); }
		if (query.before) { where.push('julianday(i.received_at) < julianday(?)'); binds.push(query.before); }
		const comparator = query.sort === 'oldest' ? '>' : '<';
		const direction = query.sort === 'oldest' ? 'ASC' : 'DESC';
		if (cursor) {
			where.push(`(julianday(i.received_at) ${comparator} ? OR (julianday(i.received_at) = ? AND i.rowid ${comparator} ?))`);
			binds.push(cursor.date, cursor.date, cursor.rowid);
		}
		const { results } = await env.DB.prepare(`SELECT i.rowid, julianday(i.received_at) AS date
			FROM items i JOIN feeds f ON f.feed_key = i.feed_key
			WHERE ${where.join(' AND ')} ORDER BY julianday(i.received_at) ${direction}, i.rowid ${direction} LIMIT ?`)
			.bind(...binds, limit + 1).all<ArticleRow>();
		const rows = results.slice(0, limit);
		const last = rows.at(-1);
		const hasMore = results.length > limit;
		return Response.json({
			itemIds: rows.map((row) => String(row.rowid)),
			continuation: hasMore && last ? encodeCursor({ v: 1, query: fingerprint, date: last.date, rowid: last.rowid }) : null,
			hasMore,
			sort: query.sort,
		}, { headers: { 'Cache-Control': 'no-store' } });
	} catch (error) {
		if (error instanceof InvalidQuery) return Response.json({ error: error.message }, { status: 400 });
		console.error('[Browser articles] Query failed', error instanceof Error ? error.message : String(error));
		return Response.json({ error: 'Could not query articles' }, { status: 503 });
	}
}

class InvalidQuery extends Error {}

function parseQuery(params: URLSearchParams): ArticleQuery {
	const rawStream = params.get('stream') ?? 'all';
	const stream = rawStream === 'all' || rawStream === 'reading-list' ? ALL
		: rawStream === 'read' ? READ : rawStream === 'starred' ? STARRED : rawStream;
	if (![ALL, READ, STARRED].includes(stream)) {
		if (stream.startsWith('feed/')) {
			const id = stream.slice(5);
			if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) throw new InvalidQuery('Invalid feed stream');
		} else if (!stream.startsWith(LABEL) || stream.slice(LABEL.length).length < 1 || stream.slice(LABEL.length).length > 80) {
			throw new InvalidQuery('Invalid article stream');
		}
	}
	const q = (params.get('q') ?? '').trim();
	if (q.length > 200 || /[\u0000-\u001f\u007f]/.test(q + stream)) throw new InvalidQuery('Invalid search text or stream');
	const filter = params.get('filter') ?? 'all';
	if (filter !== 'all' && filter !== 'unread' && filter !== 'read') throw new InvalidQuery('Invalid article filter');
	const sort = params.get('sort') ?? 'newest';
	if (sort !== 'newest' && sort !== 'oldest') throw new InvalidQuery('Supported sorts are newest and oldest');
	const since = parseDate(params.get('since'));
	const before = parseDate(params.get('before'));
	if (since && before && since >= before) throw new InvalidQuery('since must be before before');
	return { stream, q, filter, sort, since, before };
}

function parseDate(value: string | null): string | null {
	if (value === null) return null;
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) throw new InvalidQuery('Dates must be UTC ISO timestamps');
	const date = new Date(value);
	if (!Number.isFinite(date.getTime()) || date.toISOString() !== value.replace(/Z$/, value.includes('.') ? 'Z' : '.000Z')) {
		throw new InvalidQuery('Invalid UTC date');
	}
	return date.toISOString();
}

async function queryFingerprint(query: ArticleQuery): Promise<string> {
	const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(query)));
	return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function encodeCursor(cursor: ArticleCursor): string { return btoa(JSON.stringify(cursor)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

function parseCursor(value: string | null, fingerprint: string): ArticleCursor | null {
	if (value === null) return null;
	try {
		if (!value || value.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
		const cursor = JSON.parse(atob(value.replace(/-/g, '+').replace(/_/g, '/'))) as ArticleCursor;
		if (!cursor || cursor.v !== 1 || cursor.query !== fingerprint || !Number.isFinite(cursor.date)
			|| cursor.date < 1721059.5 || cursor.date > 5373484.5 || !Number.isSafeInteger(cursor.rowid) || cursor.rowid < 1) throw new Error();
		return cursor;
	} catch { throw new InvalidQuery('Invalid article continuation'); }
}
