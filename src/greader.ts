import { ARTICLE_AUTHOR_SQL } from './article-author';
import type { Env } from './types';
import { subscribeToFeed } from './subscribe';
import { createRenderedContent } from './rendered-content';
import { constantTimeEqual, generateApiToken, requireApiAuth } from './api-auth';
import {
	buildStateTransitionEventStatements,
	classifyClientFamily,
	type ClientFamily,
} from './engagement';
import { ensureDatabaseSchema } from './migrations';
import { parseGoogleReaderItemRowid } from './item-identity';

// --- ID conversion utilities ---

function toGoogleItemId(rowid: number): string {
	return 'tag:google.com,2005:reader/item/' + rowid.toString(16).padStart(16, '0');
}

function isMissingColumnError(error: unknown, columnName: string): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes('no such column') && message.includes(columnName);
}

function isMissingTableError(error: unknown, tableName: string): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes('no such table') && message.includes(tableName);
}

function isPigeonClient(request: Request): boolean {
	return request.headers.has('X-Pigeon-Client');
}

function labelFromStreamId(streamId: string | null): string | null {
	if (!streamId || !streamId.startsWith('user/-/label/')) {
		return null;
	}
	// Form/query parsing and the path resolver already decode the transport.
	// A percent escape here is part of the label returned by tag/list.
	return streamId.slice('user/-/label/'.length);
}

function labelsFromForm(body: URLSearchParams, key: string): string[] {
	const labels = body
		.getAll(key)
		.map(labelFromStreamId)
		.filter((label): label is string => Boolean(label));
	return [...new Set(labels)];
}

function isoToUnix(iso: string): number {
	return Math.floor(new Date(iso).getTime() / 1000);
}

type MarkAllTimestampCutoff =
	| { kind: 'none' }
	| { kind: 'cutoff'; seconds: string }
	| { kind: 'invalid' };

function parseMarkAllTimestamp(raw: string | null): MarkAllTimestampCutoff {
	const trimmed = raw?.trim();
	if (!trimmed) {
		return { kind: 'none' };
	}
	if (!/^\d+$/.test(trimmed)) {
		return { kind: 'invalid' };
	}

	const normalized = trimmed.replace(/^0+/, '') || '0';
	const value = BigInt(normalized);
	if (value === 0n) {
		return { kind: 'none' };
	}

	// Compare at millisecond precision, the precision of stored received_at
	// values. A whole-second cutoff still covers that entire second.
	let milliseconds: bigint;
	if (normalized.length <= 10) {
		milliseconds = value * 1_000n + 999n;
	} else if (normalized.length <= 13) {
		milliseconds = value;
	} else if (normalized.length <= 16) {
		milliseconds = value / 1_000n;
	} else if (normalized.length <= 19) {
		milliseconds = value / 1_000_000n;
	} else {
		return { kind: 'invalid' };
	}
	const fraction = (milliseconds % 1_000n).toString().padStart(3, '0');
	return { kind: 'cutoff', seconds: `${milliseconds / 1_000n}.${fraction}` };
}

// datetime() truncates to whole seconds; %f keeps milliseconds on both sides.
const MARK_ALL_CUTOFF_CLAUSE =
	"strftime('%Y-%m-%dT%H:%M:%fZ', received_at) <= strftime('%Y-%m-%dT%H:%M:%fZ', ?, 'unixepoch')";

const MAX_MEMBERSHIP_PAYLOAD_BYTES = 900_000;
const MAX_D1_BATCH_STATEMENTS = 50;

const STREAM_CONTINUATION_VERSION = 1;

function parsePageSize(value: string | null, fallback: number, maximum: number): number {
	const parsed = Number.parseInt(value ?? '', 10);
	if (parsed === 0) return 0;
	return Math.min(Math.max(Number.isFinite(parsed) ? parsed : fallback, 1), maximum);
}

interface StreamCursor {
	v: number;
	streamId: string;
	xt: string;
	ot: string;
	receivedAt: string;
	rowid: number;
}

interface StreamRow {
	rowid: number;
	received_at: string;
	is_read: number | null;
	is_starred: number | null;
	content_version: number;
}

function chunkValues<T>(values: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < values.length; i += size) {
		chunks.push(values.slice(i, i + size));
	}
	return chunks;
}

// JSON membership uses one binding instead of one per ID, while bounded groups
// keep unusually long stored feed keys below the database's parameter limit.
function membershipPages(values: Array<string | number>): string[] {
	const pages: string[] = [];
	const encoder = new TextEncoder();
	let entries: string[] = [];
	let bytes = 2;
	for (const value of values) {
		const entry = JSON.stringify(value);
		const entryBytes = encoder.encode(entry).byteLength;
		if (entryBytes + 2 > MAX_MEMBERSHIP_PAYLOAD_BYTES) throw new Error('Feed identifier exceeds database parameter limit');
		if (entries.length > 0 && bytes + 1 + entryBytes > MAX_MEMBERSHIP_PAYLOAD_BYTES) {
			pages.push(`[${entries.join(',')}]`);
			entries = [];
			bytes = 2;
		}
		bytes += entryBytes + (entries.length > 0 ? 1 : 0);
		entries.push(entry);
	}
	if (entries.length > 0) pages.push(`[${entries.join(',')}]`);
	return pages;
}

async function runStatementChunks(env: Env, statements: D1PreparedStatement[]): Promise<void> {
	for (const chunk of chunkValues(statements, MAX_D1_BATCH_STATEMENTS)) {
		await env.DB.batch(chunk);
	}
}

async function recordEngagementBestEffort(env: Env, statements: D1PreparedStatement[]): Promise<void> {
	if (statements.length === 0) return;
	try {
		await runStatementChunks(env, statements);
	} catch (error) {
		console.error('[GReader] Engagement recording failed after state synchronization succeeded:', error);
	}
}

async function buildTransitionEventsBestEffort(
	env: Env,
	rowids: number[],
	options: Parameters<typeof buildStateTransitionEventStatements>[2],
): Promise<D1PreparedStatement[]> {
	try {
		return await buildStateTransitionEventStatements(env, rowids, options);
	} catch (error) {
		console.error('[GReader] Could not prepare engagement events; continuing state synchronization:', error);
		return [];
	}
}

function encodeBase64UrlUtf8(value: string): string {
	const bytes = new TextEncoder().encode(value);
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary)
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/g, '');
}

function decodeBase64UrlUtf8(value: string): string | null {
	try {
		const encoded = value.replace(/-/g, '+').replace(/_/g, '/');
		const padded = encoded.padEnd(encoded.length + ((4 - (encoded.length % 4)) % 4), '=');
		const binary = atob(padded);
		const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
		return new TextDecoder().decode(bytes);
	} catch {
		return null;
	}
}

function encodeContinuation(cursor: StreamCursor): string {
	return `v1:${encodeBase64UrlUtf8(JSON.stringify(cursor))}`;
}

function decodeContinuation(
	value: string,
	expected: { streamId: string; xt: string; ot: string },
): Pick<StreamCursor, 'receivedAt' | 'rowid'> | null {
	if (!value.startsWith('v1:')) {
		return null;
	}

	try {
		const decodedValue = decodeBase64UrlUtf8(value.slice('v1:'.length));
		if (!decodedValue) {
			return null;
		}
		const decoded = JSON.parse(decodedValue) as Partial<StreamCursor>;
		if (
			decoded.v !== STREAM_CONTINUATION_VERSION ||
			decoded.streamId !== expected.streamId ||
			decoded.xt !== expected.xt ||
			decoded.ot !== expected.ot ||
			typeof decoded.receivedAt !== 'string' ||
			typeof decoded.rowid !== 'number' ||
			!Number.isFinite(decoded.rowid)
		) {
			return null;
		}
		return { receivedAt: decoded.receivedAt, rowid: decoded.rowid };
	} catch {
		return null;
	}
}

// Feed keys can be several KB long. Callers scope label lookups with a
// subquery that yields feed keys instead of repeating keys in bindings.
interface FeedKeyFilter {
	sql: string;
	binds: string[];
}

function feedLabelStatements(env: Env, filter: FeedKeyFilter | null, includeFeedTags: boolean): D1PreparedStatement[] {
	const binds = filter?.binds ?? [];
	const statements: D1PreparedStatement[] = [];
	if (includeFeedTags) {
		statements.push(
			env.DB.prepare(
				`SELECT f.feed_key, ft.label
				   FROM feeds f
				   JOIN feed_tags ft ON ft.feed_key = f.feed_key
				  WHERE f.is_active = 1${filter ? ` AND f.feed_key IN (${filter.sql})` : ''}
				  ORDER BY ft.label COLLATE NOCASE`,
			).bind(...binds),
		);
	}
	statements.push(
		env.DB.prepare(
			`SELECT feed_key, category
			   FROM feeds
			  WHERE is_active = 1 AND category IS NOT NULL AND category <> ''${filter ? ` AND feed_key IN (${filter.sql})` : ''}
			  ORDER BY category COLLATE NOCASE`,
		).bind(...binds),
	);
	return statements;
}

function collectFeedLabels(labelResults: D1Result[], includeFeedTags: boolean): Map<string, string[]> {
	const labelsByFeedKey = new Map<string, string[]>();
	const addLabel = (feedKey: string, label: string | null) => {
		if (!label) {
			return;
		}
		const existing = labelsByFeedKey.get(feedKey) ?? [];
		if (!existing.includes(label)) {
			existing.push(label);
			labelsByFeedKey.set(feedKey, existing);
		}
	};

	const categoryRows = labelResults[labelResults.length - 1].results as Array<{ feed_key: string; category: string | null }>;
	if (includeFeedTags) {
		const tagRows = labelResults[labelResults.length - 2].results as Array<{ feed_key: string; label: string }>;
		for (const row of tagRows) {
			addLabel(row.feed_key, row.label);
		}
	}
	for (const row of categoryRows) {
		addLabel(row.feed_key, row.category);
	}
	return labelsByFeedKey;
}

// Databases that predate feed_tags are remembered per isolate so the first
// failing batch is the only one that repeats its heavier statements.
const databasesWithoutFeedTags = new WeakSet<D1Database>();

// One D1 round trip for a handler's statements plus the label lookups that
// decorate its rows. Databases that predate feed_tags rerun without that lookup.
async function batchWithFeedLabels(
	env: Env,
	statements: D1PreparedStatement[],
	filter: FeedKeyFilter | null = null,
): Promise<{ results: D1Result[]; labelsByFeedKey: Map<string, string[]> }> {
	const run = async (includeFeedTags: boolean) => {
		const results = await env.DB.batch([...statements, ...feedLabelStatements(env, filter, includeFeedTags)]);
		return {
			results: results.slice(0, statements.length),
			labelsByFeedKey: collectFeedLabels(results.slice(statements.length), includeFeedTags),
		};
	};

	if (databasesWithoutFeedTags.has(env.DB)) {
		return run(false);
	}
	try {
		return await run(true);
	} catch (error) {
		if (!isMissingTableError(error, 'feed_tags')) {
			throw error;
		}
		databasesWithoutFeedTags.add(env.DB);
		return run(false);
	}
}

async function syncPrimaryFeedCategory(env: Env, rowid: number, feedKey: string): Promise<void> {
	let primaryLabel: string | null = null;
	try {
		const row = await env.DB.prepare(
			'SELECT label FROM feed_tags WHERE feed_key = ? ORDER BY created_at ASC, label COLLATE NOCASE ASC LIMIT 1',
		)
			.bind(feedKey)
			.first<{ label: string }>();
		primaryLabel = row?.label ?? null;
	} catch (error) {
		if (!isMissingTableError(error, 'feed_tags')) {
			throw error;
		}
		return;
	}

	await env.DB.prepare('UPDATE feeds SET category = ? WHERE rowid = ?').bind(primaryLabel, rowid).run();
}

// --- Route handler ---

export async function handleGreaderRequest(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname;

	// ClientLogin doesn't require auth
	if (path === '/accounts/ClientLogin' && (request.method === 'POST' || request.method === 'GET')) {
		return handleClientLogin(request, env);
	}

	// All /reader/api/0/* routes require auth
	const authErr = await requireApiAuth(request, env.API_PASSWORD);
	if (authErr) return authErr;

	if (path !== '/reader/api/0/token' && path !== '/reader/api/0/user-info') {
		try {
			await ensureDatabaseSchema(env);
		} catch (error) {
			console.error('[Migrations] GReader request failed because database migration failed', error);
			return new Response('Database migration failed', { status: 503 });
		}
	}

	if (path === '/reader/api/0/token') {
		return handleToken(env);
	}
	if (path === '/reader/api/0/user-info') {
		return handleUserInfo();
	}
	if (path === '/reader/api/0/tag/list') {
		return handleTagList(env);
	}
	if (path === '/reader/api/0/subscription/list') {
		return handleSubscriptionList(env);
	}
	if (path === '/reader/api/0/subscription/quickadd') {
		return handleQuickAdd(request, env);
	}
	if (path === '/reader/api/0/unread-count') {
		return handleUnreadCount(env);
	}
	if (path === '/reader/api/0/stream/items/ids') {
		return handleStreamItemIds(request, url, env);
	}
	if (path === '/reader/api/0/stream/items/contents') {
		return handleStreamItemContents(request, env);
	}
	if (path === '/reader/api/0/stream/contents' || path.startsWith('/reader/api/0/stream/contents/')) {
		return handleStreamContents(request, url, env);
	}
	if (path === '/reader/api/0/subscription/edit') {
		return handleSubscriptionEdit(request, env);
	}
	if (path === '/reader/api/0/edit-tag') {
		return handleEditTag(request, env);
	}
	if (path === '/reader/api/0/mark-all-as-read') {
		return handleMarkAllAsRead(request, env);
	}

	return new Response('Not found', { status: 404 });
}

// --- Endpoint handlers ---

async function handleClientLogin(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	let passwd: string | null = url.searchParams.get('Passwd');

	if (!passwd && request.method !== 'GET') {
		const body = await request.formData();
		passwd = body.get('Passwd') as string | null;
	}

	if (!env.API_PASSWORD || !passwd || !constantTimeEqual(passwd, env.API_PASSWORD)) {
		return new Response('Error=BadAuthentication', { status: 401, headers: { 'Content-Type': 'text/plain' } });
	}

	const token = await generateApiToken(env.API_PASSWORD);
	const result = `SID=pigeon/${token}\nLSID=null\nAuth=pigeon/${token}`;
	return new Response(result, { headers: { 'Content-Type': 'text/plain' } });
}

async function handleToken(env: Env): Promise<Response> {
	const token = await generateApiToken(env.API_PASSWORD);
	return new Response(token, { headers: { 'Content-Type': 'text/plain' } });
}

function handleUserInfo(): Response {
	return Response.json({
		userId: '1',
		userName: 'pigeon',
		userProfileId: '1',
		userEmail: '',
	});
}

async function handleTagList(env: Env): Promise<Response> {
	const tags: { id: string }[] = [
		{ id: 'user/-/state/com.google/starred' },
		{ id: 'user/-/state/com.google/read' },
		{ id: 'user/-/state/com.google/reading-list' },
	];

	const { labelsByFeedKey } = await batchWithFeedLabels(env, []);
	const labels = [...new Set([...labelsByFeedKey.values()].flat())].sort((left, right) =>
		left.localeCompare(right, undefined, { sensitivity: 'base', numeric: true }),
	);
	for (const label of labels) {
		tags.push({ id: `user/-/label/${label}` });
	}

	return Response.json({ tags });
}

async function handleSubscriptionList(env: Env): Promise<Response> {
	const { results: [feedResult], labelsByFeedKey } = await batchWithFeedLabels(env, [
		env.DB.prepare(
			'SELECT rowid, feed_key, display_name, from_email, custom_title, category, icon_url, source_url, site_url FROM feeds WHERE is_active = 1',
		),
	]);
	const results = feedResult.results as Array<{
		rowid: number;
		feed_key: string;
		display_name: string;
		from_email: string | null;
		custom_title: string | null;
		category: string | null;
		icon_url: string | null;
		source_url: string | null;
		site_url: string | null;
	}>;

	const subscriptions = results.map((f) => ({
		id: `feed/${f.rowid}`,
		title: f.custom_title || f.display_name,
		categories: (labelsByFeedKey.get(f.feed_key) ?? []).map((label) => ({ id: `user/-/label/${label}`, label })),
		url: `${env.BASE_URL}/feed/${f.feed_key}`,
		sourceUrl: f.source_url,
		htmlUrl: f.site_url || f.source_url || env.BASE_URL,
		iconUrl: f.icon_url || '',
	}));

	return Response.json({ subscriptions });
}

function newestTimestampUsec(current: string | undefined, candidate: string): string | undefined {
	const numericCandidate = Number(candidate);
	if (!Number.isFinite(numericCandidate)) return current;
	return current === undefined || numericCandidate > Number(current) ? candidate : current;
}

async function handleUnreadCount(env: Env): Promise<Response> {
	// Labels are needed only for publishers with unread items; the filter keeps
	// a large read-only library's metadata out of the response path.
	const { results: [countResult], labelsByFeedKey } = await batchWithFeedLabels(
		env,
		[
			env.DB.prepare(
				`SELECT f.rowid, i.feed_key, COUNT(*) as count, MAX(i.received_at) as newest
		 FROM items i JOIN feeds f ON i.feed_key = f.feed_key
		 WHERE f.is_active = 1 AND i.is_read = 0 GROUP BY i.feed_key`,
			),
		],
		{ sql: 'SELECT feed_key FROM items WHERE is_read = 0', binds: [] },
	);
	const results = countResult.results as Array<{
		rowid: number;
		feed_key: string;
		count: number;
		newest: string;
	}>;

	let totalUnreadCount = 0;
	let newestUnreadUsec: string | undefined;
	const unreadcounts = results.map((r) => ({
		id: `feed/${r.rowid}`,
		count: r.count,
		newestItemTimestampUsec: (isoToUnix(r.newest) * 1_000_000).toString(),
	}));
	const labelCounts = new Map<string, { count: number; newestItemTimestampUsec: string | undefined }>();
	for (const unread of unreadcounts) {
		totalUnreadCount += unread.count;
		newestUnreadUsec = newestTimestampUsec(newestUnreadUsec, unread.newestItemTimestampUsec);
	}
	for (const row of results) {
		const newestItemTimestampUsec = (isoToUnix(row.newest) * 1_000_000).toString();
		for (const label of labelsByFeedKey.get(row.feed_key) ?? []) {
			const streamId = `user/-/label/${label}`;
			const existing = labelCounts.get(streamId) ?? { count: 0, newestItemTimestampUsec: undefined };
			existing.count += row.count;
			existing.newestItemTimestampUsec = newestTimestampUsec(existing.newestItemTimestampUsec, newestItemTimestampUsec);
			labelCounts.set(streamId, existing);
		}
	}
	for (const [id, value] of [...labelCounts.entries()].sort(([leftId], [rightId]) =>
		leftId.localeCompare(rightId, undefined, { sensitivity: 'base', numeric: true }),
	)) {
		unreadcounts.push({
			id,
			count: value.count,
			newestItemTimestampUsec: value.newestItemTimestampUsec ?? '0',
		});
	}
	unreadcounts.push({
		id: 'user/-/state/com.google/reading-list',
		count: totalUnreadCount,
		newestItemTimestampUsec: newestUnreadUsec ?? '0',
	});

	return Response.json({ max: 1000, unreadcounts });
}

async function resolveStreamFeedKey(streamId: string, env: Env): Promise<string | null> {
	const feedMatch = streamId.match(/^feed\/(\d+)$/);
	if (feedMatch) {
		const row = await env.DB.prepare('SELECT feed_key FROM feeds WHERE rowid = ?')
			.bind(parseInt(feedMatch[1], 10))
			.first<{ feed_key: string }>();
		return row?.feed_key ?? null;
	}
	return null;
}

async function parseRequestParams(request: Request, url: URL): Promise<URLSearchParams> {
	if (request.method === 'GET' || request.method === 'HEAD') {
		return new URLSearchParams(url.searchParams);
	}

	const contentType = (request.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();

	let params: URLSearchParams;
	if (contentType === 'multipart/form-data') {
		const formData = await request.formData();
		params = new URLSearchParams();
		for (const [key, value] of formData.entries()) {
			if (typeof value === 'string') {
				params.append(key, value);
			}
		}
	} else {
		// Form-encoded, or a raw urlencoded body sent with another content type.
		params = new URLSearchParams(await request.text());
	}

	// Like FreshRSS's $_REQUEST, query-string params fill in keys the body omits.
	for (const key of new Set(url.searchParams.keys())) {
		if (!params.has(key)) {
			for (const value of url.searchParams.getAll(key)) params.append(key, value);
		}
	}
	return params;
}

async function selectStreamRowIds(options: {
	streamId: string;
	limit: number;
	excludeTag: string;
	olderThanUnix: string;
	continuation: string;
	env: Env;
}): Promise<{ rows: StreamRow[]; continuation?: string }> {
	let sql =
		'SELECT i.rowid, i.received_at, i.is_read, i.is_starred, i.content_version FROM items i JOIN feeds f ON f.feed_key = i.feed_key WHERE f.is_active = 1';
	const binds: (string | number)[] = [];
	const label = labelFromStreamId(options.streamId);

	if (options.streamId === 'user/-/state/com.google/starred') {
		sql += ' AND i.is_starred = 1';
	} else if (options.streamId === 'user/-/state/com.google/read') {
		sql += ' AND i.is_read = 1';
	} else if (label) {
		sql +=
			' AND (f.category = ? OR EXISTS (SELECT 1 FROM feed_tags ft WHERE ft.feed_key = f.feed_key AND ft.label = ?))';
		binds.push(label, label);
	} else if (options.streamId === 'user/-/state/com.google/reading-list' || !options.streamId) {
		// The active-feed predicate above fully defines the reading list.
	} else {
		const feedKey = await resolveStreamFeedKey(options.streamId, options.env);
		if (!feedKey) {
			return { rows: [] };
		}
		sql += ' AND i.feed_key = ?';
		binds.push(feedKey);
	}

	if (options.excludeTag === 'user/-/state/com.google/read') {
		sql += ' AND i.is_read = 0';
	}
	const olderThanSeconds = options.olderThanUnix ? parseInt(options.olderThanUnix, 10) : NaN;
	const olderThanDate = Number.isFinite(olderThanSeconds) ? new Date(olderThanSeconds * 1000) : null;
	if (olderThanDate && Number.isFinite(olderThanDate.getTime())) {
		// ot means "not older than": keep items at or after the cutoff, compared at
		// millisecond precision. A malformed or out-of-range ot is ignored rather
		// than turned into an invalid bind.
		sql += " AND strftime('%Y-%m-%dT%H:%M:%fZ', i.received_at) >= strftime('%Y-%m-%dT%H:%M:%fZ', ?, 'unixepoch')";
		binds.push(olderThanSeconds);
		// Let SQLite seek the date indexes: every stored received_at starts with
		// its UTC calendar date, whether written as ISO 8601 or "YYYY-MM-DD HH:MM:SS",
		// so a string comparison against the cutoff's date prefix is a safe coarse
		// bound. The exact strftime predicate above still decides rows on that day.
		sql += ' AND i.received_at >= ?';
		binds.push(olderThanDate.toISOString().slice(0, 10));
	}
	const cursor = options.continuation
		? decodeContinuation(options.continuation, {
				streamId: options.streamId,
				xt: options.excludeTag,
				ot: options.olderThanUnix,
			})
		: null;
	if (cursor) {
		sql += ' AND (i.received_at < ? OR (i.received_at = ? AND i.rowid < ?))';
		binds.push(cursor.receivedAt, cursor.receivedAt, cursor.rowid);
	}

	sql += ' ORDER BY i.received_at DESC, i.rowid DESC LIMIT ?';
	binds.push(options.limit + 1);

	let results: StreamRow[];
	try {
		({ results } = await options.env.DB.prepare(sql).bind(...binds).all<StreamRow>());
	} catch (error) {
		if (!label || !isMissingTableError(error, 'feed_tags')) {
			throw error;
		}
		const fallbackSql = sql.replace(
			'(f.category = ? OR EXISTS (SELECT 1 FROM feed_tags ft WHERE ft.feed_key = f.feed_key AND ft.label = ?))',
			'f.category = ?',
		);
		const fallbackBinds = [label, ...binds.slice(2)];
		({ results } = await options.env.DB.prepare(fallbackSql).bind(...fallbackBinds).all<StreamRow>());
	}
	const page = results.slice(0, options.limit);
	const nextCursor = results.length > options.limit ? page[page.length - 1] : null;
	return {
		rows: page,
		...(nextCursor
			? {
					continuation: encodeContinuation({
						v: STREAM_CONTINUATION_VERSION,
						streamId: options.streamId,
						xt: options.excludeTag,
						ot: options.olderThanUnix,
						receivedAt: nextCursor.received_at,
						rowid: nextCursor.rowid,
					}),
				}
			: {}),
	};
}

interface ResponseFeedRow {
	rowid: number;
	feed_key: string;
	display_name: string;
	custom_title: string | null;
	category: string | null;
	source_url: string | null;
	site_url: string | null;
}

interface ResponseItemRow {
	rowid: number;
	id: string;
	feed_key: string;
	from_name: string | null;
	subject: string;
	html_content: string;
	text_content: string | null;
	content_pruned_at: string | null;
	original_url: string | null;
	received_at: string;
	is_read: number;
	is_starred: number;
	content_version: number;
}

interface ResponseItemBody {
	direction: string;
	content: string;
}

async function loadResponseItems(
	rowids: number[],
	env: Env,
	options: { singleBody: boolean },
): Promise<
	Array<{
		id: string;
		categories: string[];
		title: string;
		published: number;
		updated: number;
		crawlTimeMsec: string;
		timestampUsec: string;
		author: string;
		summary?: ResponseItemBody;
		content: ResponseItemBody;
		contentVersion: string;
		isBodyPruned: boolean;
		alternate?: Array<{ href: string }>;
		origin: { streamId: string; title: string; htmlUrl: string };
	}>
> {
	if (rowids.length === 0) {
		return [];
	}

	// Every lookup depends only on the requested rowids, so each membership
	// page is one D1 round trip: the items, their feeds, and the feeds' labels.
	const loadPage = async (rowidPage: string) => {
		const filter: FeedKeyFilter = {
			sql: 'SELECT feed_key FROM items WHERE rowid IN (SELECT value FROM json_each(?))',
			binds: [rowidPage],
		};
		const statements = (originalUrlExpression: string) => [
			env.DB.prepare(
				`SELECT i.rowid, i.id, i.feed_key, ${ARTICLE_AUTHOR_SQL} AS from_name, i.subject, i.html_content, i.text_content, i.content_pruned_at, ${originalUrlExpression} AS original_url, i.received_at, i.is_read, i.is_starred, i.content_version
				 FROM items i LEFT JOIN feeds f ON f.feed_key = i.feed_key WHERE i.rowid IN (SELECT value FROM json_each(?))`,
			).bind(rowidPage),
			env.DB.prepare(
				`SELECT rowid, feed_key, display_name, custom_title, category, source_url, site_url FROM feeds WHERE feed_key IN (${filter.sql})`,
			).bind(rowidPage),
		];

		try {
			return await batchWithFeedLabels(env, statements('i.original_url'), filter);
		} catch (error) {
			if (!isMissingColumnError(error, 'original_url')) {
				throw error;
			}
			return batchWithFeedLabels(env, statements('NULL'), filter);
		}
	};

	const items: ResponseItemRow[] = [];
	const feedMap = new Map<string, ResponseFeedRow>();
	const labelsByFeedKey = new Map<string, string[]>();
	for (const page of await Promise.all(membershipPages(rowids).map(loadPage))) {
		const [itemResult, feedResult] = page.results;
		items.push(...(itemResult.results as ResponseItemRow[]));
		for (const feed of feedResult.results as ResponseFeedRow[]) {
			feedMap.set(feed.feed_key, feed);
		}
		for (const [feedKey, labels] of page.labelsByFeedKey) {
			labelsByFeedKey.set(feedKey, labels);
		}
	}

	const itemMap = new Map(
		items.map((item) => {
			const feed = feedMap.get(item.feed_key);
			const ts = isoToUnix(item.received_at);
			const categories = ['user/-/state/com.google/reading-list'];
			const body: ResponseItemBody = {
				direction: 'ltr',
				content: createRenderedContent({
					htmlContent: item.html_content,
					textContent: item.text_content,
					originalUrl: item.original_url,
				}),
			};
			if (item.is_read) categories.push('user/-/state/com.google/read');
			if (item.is_starred) categories.push('user/-/state/com.google/starred');
			for (const label of labelsByFeedKey.get(item.feed_key) ?? []) {
				categories.push(`user/-/label/${label}`);
			}

			return [
				item.rowid,
				{
					id: toGoogleItemId(item.rowid),
					categories,
					title: item.subject,
					published: ts,
					updated: ts,
					crawlTimeMsec: (ts * 1000).toString(),
					timestampUsec: (ts * 1_000_000).toString(),
					author: item.from_name || '',
					// Third-party readers expect the body in both fields; Pigeon
					// clients read content only and skip the duplicate bytes.
					...(options.singleBody ? {} : { summary: body }),
					content: body,
					contentVersion: String(item.content_version),
					isBodyPruned: item.content_pruned_at != null,
					...(item.original_url
						? {
								alternate: [{ href: item.original_url }],
							}
						: {}),
					origin: {
						streamId: feed ? `feed/${feed.rowid}` : `feed/0`,
						title: feed ? (feed.custom_title || feed.display_name) : '',
						htmlUrl: feed?.site_url || feed?.source_url || env.BASE_URL,
					},
				},
			];
		}),
	);

	return rowids.map((rowid) => itemMap.get(rowid)).filter((item): item is NonNullable<typeof item> => Boolean(item));
}

function createItemsEnvelope(items: Awaited<ReturnType<typeof loadResponseItems>>, streamId: string): {
	id: string;
	updated: number;
	items: Awaited<ReturnType<typeof loadResponseItems>>;
} {
	return {
		id: streamId,
		updated: Math.floor(Date.now() / 1000),
		items,
	};
}

async function handleStreamItemIds(request: Request, url: URL, env: Env): Promise<Response> {
	const params = await parseRequestParams(request, url);
	const streamId = params.get('s') || '';
	const n = parsePageSize(params.get('n'), 1000, 10000);
	const xt = params.get('xt') || '';
	const ot = params.get('ot') || '';
	const c = params.get('c') || '';
	const page = await selectStreamRowIds({
		streamId,
		limit: n,
		excludeTag: xt,
		olderThanUnix: ot,
		continuation: c,
		env,
	});
	// Pigeon clients use the read, starred, and contentVersion extensions to
	// apply state locally and fetch only bodies that changed.
	const itemRefs = page.rows.map((row) => ({
		id: String(row.rowid),
		timestampUsec: String(isoToUnix(row.received_at) * 1_000_000),
		read: Boolean(row.is_read),
		starred: Boolean(row.is_starred),
		contentVersion: String(row.content_version),
	}));
	return Response.json({
		itemRefs,
		...(page.continuation ? { continuation: page.continuation } : {}),
	});
}

async function extractItemContentIds(request: Request): Promise<string[]> {
	const ids = [...new URL(request.url).searchParams.getAll('i')];

	if (request.method === 'GET' || request.method === 'HEAD') {
		return ids.filter(Boolean);
	}

	const contentType = (request.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();

	if (contentType === 'application/x-www-form-urlencoded' || contentType === 'multipart/form-data') {
		const body = await request.formData();
		ids.push(...body.getAll('i').filter((value): value is string => typeof value === 'string'));
		return ids.filter(Boolean);
	}

	const rawBody = await request.text();
	if (!rawBody.trim()) {
		return ids.filter(Boolean);
	}

	if (rawBody.includes('=')) {
		ids.push(...new URLSearchParams(rawBody).getAll('i'));
	}

	return ids.filter(Boolean);
}

async function handleStreamItemContents(request: Request, env: Env): Promise<Response> {
	const ids = await extractItemContentIds(request);

	if (ids.length === 0) {
		return Response.json(createItemsEnvelope([], 'user/-/state/com.google/reading-list'));
	}

	const rowids = ids
		.map(parseGoogleReaderItemRowid)
		.filter((rowid): rowid is number => rowid !== null);
	if (rowids.length === 0) {
		return Response.json(createItemsEnvelope([], 'user/-/state/com.google/reading-list'));
	}
	const responseItems = await loadResponseItems(rowids, env, { singleBody: isPigeonClient(request) });
	return Response.json(createItemsEnvelope(responseItems, 'user/-/state/com.google/reading-list'));
}

function resolveContentsStreamId(path: string, params: URLSearchParams): string {
	const prefix = '/reader/api/0/stream/contents';
	if (path === prefix) {
		return params.get('s') || 'user/-/state/com.google/reading-list';
	}

	const suffix = path.slice(prefix.length + 1);
	if (!suffix || suffix === 'reading-list') {
		return 'user/-/state/com.google/reading-list';
	}
	if (suffix === 'starred') {
		return 'user/-/state/com.google/starred';
	}
	if (suffix.startsWith('feed/')) {
		return `feed/${decodeURIComponent(suffix.slice('feed/'.length))}`;
	}
	if (suffix.startsWith('user/-/')) {
		return decodeURIComponent(suffix);
	}

	return decodeURIComponent(suffix);
}

async function handleStreamContents(request: Request, url: URL, env: Env): Promise<Response> {
	const params = await parseRequestParams(request, url);
	let streamId: string;
	try {
		streamId = resolveContentsStreamId(url.pathname, params);
	} catch {
		return new Response('Bad request: invalid stream ID', { status: 400 });
	}
	const n = parsePageSize(params.get('n'), 20, 1000);
	const xt = params.get('xt') || '';
	const ot = params.get('ot') || '';
	const c = params.get('c') || '';
	const page = await selectStreamRowIds({
		streamId,
		limit: n,
		excludeTag: xt,
		olderThanUnix: ot,
		continuation: c,
		env,
	});
	const items = await loadResponseItems(
		page.rows.map((row) => row.rowid),
		env,
		{ singleBody: isPigeonClient(request) },
	);

	return Response.json({
		...createItemsEnvelope(items, streamId),
		...(page.continuation ? { continuation: page.continuation } : {}),
	});
}

async function feedKeyForRowid(env: Env, rowid: number): Promise<string | null> {
	const feed = await env.DB.prepare('SELECT feed_key FROM feeds WHERE rowid = ?')
		.bind(rowid)
		.first<{ feed_key: string }>();
	return feed?.feed_key ?? null;
}

async function addLabelsToFeed(env: Env, rowid: number, feedKey: string, labels: string[]): Promise<void> {
	const uniqueLabels = [...new Set(labels.filter(Boolean))];
	if (uniqueLabels.length === 0) {
		return;
	}

	try {
		// A legacy primary category may have no feed_tags row; keep it as a tag so
		// syncPrimaryFeedCategory does not replace it with the new label.
		await env.DB.prepare(`INSERT OR IGNORE INTO feed_tags (feed_key, label)
		 SELECT feed_key, category FROM feeds
		  WHERE rowid = ? AND feed_key = ? AND category IS NOT NULL AND category <> ''`)
			.bind(rowid, feedKey)
			.run();
		await env.DB.prepare(`INSERT OR IGNORE INTO feed_tags (feed_key, label)
		 SELECT ?, value FROM json_each(?)`)
			.bind(feedKey, JSON.stringify(uniqueLabels))
			.run();
	} catch (error) {
		if (!isMissingTableError(error, 'feed_tags')) throw error;
	}

	await env.DB.prepare('UPDATE feeds SET category = COALESCE(category, ?) WHERE rowid = ?')
		.bind(uniqueLabels[0], rowid)
		.run();
	await syncPrimaryFeedCategory(env, rowid, feedKey);
}

async function removeLabelsFromFeed(env: Env, rowid: number, feedKey: string, labels: string[]): Promise<void> {
	const uniqueLabels = [...new Set(labels.filter(Boolean))];
	if (uniqueLabels.length === 0) {
		return;
	}

	try {
		await env.DB.prepare(`DELETE FROM feed_tags WHERE feed_key = ?
		 AND label IN (SELECT value FROM json_each(?))`)
			.bind(feedKey, JSON.stringify(uniqueLabels))
			.run();
	} catch (error) {
		if (!isMissingTableError(error, 'feed_tags')) throw error;
	}

	await env.DB.prepare(`UPDATE feeds SET category = NULL WHERE rowid = ?
	 AND category IN (SELECT value FROM json_each(?))`)
		.bind(rowid, JSON.stringify(uniqueLabels))
		.run();
	await syncPrimaryFeedCategory(env, rowid, feedKey);
}

async function handleSubscriptionEdit(request: Request, env: Env): Promise<Response> {
	const body = await parseRequestParams(request, new URL(request.url));
	const ac = body.get('ac');
	const streamId = body.get('s');
	const addLabels = labelsFromForm(body, 'a');
	const removeLabels = labelsFromForm(body, 'r');
	const title = body.get('t');

	// Log ALL subscription/edit requests
	console.log('[GReader] subscription/edit called:', {
		ac,
		streamId,
		addLabels,
		removeLabels,
		title,
		allParams: Array.from(body.entries())
	});

	if (!ac || !streamId) {
		console.log('[GReader] Bad request - missing ac or streamId');
		return new Response('Bad request', { status: 400 });
	}

	// Handle subscribe action
	if (ac === 'subscribe') {
		console.log('[GReader] Subscribe request received:', { streamId, addLabels });
		// Extract feed URL from streamId
		// Format can be: "feed/http://example.com/feed.xml" or just "http://example.com/feed.xml"
		let feedUrl = streamId;
		if (streamId.startsWith('feed/')) {
			feedUrl = streamId.slice(5); // Remove "feed/" prefix
		}

		console.log('[GReader] Extracted feed URL:', feedUrl);

		try {
			const category = addLabels[0] ?? null;

			console.log('[GReader] Calling subscribeToFeed with category:', category);
			const result = await subscribeToFeed(env, feedUrl, category);
			await addLabelsToFeed(env, result.rowid, result.feed_key, addLabels);
			console.log('[GReader] Subscribe successful:', result);
			return new Response('OK', { headers: { 'Content-Type': 'text/plain' } });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error('[GReader] Subscribe failed:', message);
			return new Response(`Failed to subscribe: ${message}`, { status: 400 });
		}
	}

	// Handle unsubscribe action
	if (ac === 'unsubscribe') {
		const feedMatch = streamId.match(/^feed\/(\d+)$/);
		if (!feedMatch) {
			return new Response('Bad request: invalid feed ID', { status: 400 });
		}
		const rowid = parseInt(feedMatch[1], 10);

		await env.DB.prepare('UPDATE feeds SET is_active = 0 WHERE rowid = ?')
			.bind(rowid)
			.run();

		return new Response('OK', { headers: { 'Content-Type': 'text/plain' } });
	}

	// Handle edit action (existing functionality)
	if (ac === 'edit') {
		const feedMatch = streamId.match(/^feed\/(\d+)$/);
		if (!feedMatch) {
			return new Response('Bad request: invalid feed ID', { status: 400 });
		}
		const rowid = parseInt(feedMatch[1], 10);
		const feedKey = await feedKeyForRowid(env, rowid);
		if (!feedKey) {
			return new Response('Bad request: unknown feed ID', { status: 400 });
		}

		const stmts: D1PreparedStatement[] = [];

		await addLabelsToFeed(env, rowid, feedKey, addLabels);
		await removeLabelsFromFeed(env, rowid, feedKey, removeLabels);

		if (title) {
			stmts.push(env.DB.prepare('UPDATE feeds SET custom_title = ? WHERE rowid = ?').bind(title, rowid));
		}

		if (stmts.length > 0) {
			await env.DB.batch(stmts);
		}

		return new Response('OK', { headers: { 'Content-Type': 'text/plain' } });
	}

	return new Response('Bad request: unsupported action', { status: 400 });
}

async function handleEditTag(request: Request, env: Env): Promise<Response> {
	const body = await parseRequestParams(request, new URL(request.url));
	const ids = body.getAll('i');
	const addTags = new Set(body.getAll('a'));
	const removeTags = new Set(body.getAll('r'));

	const rowids = [...new Set(ids.map(parseGoogleReaderItemRowid).filter((rowid): rowid is number => rowid !== null))];
	if (rowids.length === 0) {
		return new Response('OK', { headers: { 'Content-Type': 'text/plain' } });
	}

	const stmts: D1PreparedStatement[] = [];
	const eventStmts: D1PreparedStatement[] = [];
	const clientFamily = classifyClientFamily(request);

	function addBulkUpdate(column: 'is_read' | 'is_starred', value: 0 | 1) {
		stmts.push(env.DB.prepare(`UPDATE items SET ${column} = ${value}
		 WHERE rowid IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(rowids)));
	}

	if (addTags.has('user/-/state/com.google/read')) {
		eventStmts.push(
			...(await buildTransitionEventsBestEffort(env, rowids, {
				kind: 'read',
				target: true,
				eventType: 'read',
				clientFamily,
			})),
		);
		addBulkUpdate('is_read', 1);
	}
	if (removeTags.has('user/-/state/com.google/read')) {
		eventStmts.push(
			...(await buildTransitionEventsBestEffort(env, rowids, {
				kind: 'read',
				target: false,
				eventType: 'unread',
				clientFamily,
			})),
		);
		addBulkUpdate('is_read', 0);
	}
	if (addTags.has('user/-/state/com.google/starred')) {
		eventStmts.push(
			...(await buildTransitionEventsBestEffort(env, rowids, {
				kind: 'star',
				target: true,
				eventType: 'star',
				clientFamily,
			})),
		);
		addBulkUpdate('is_starred', 1);
	}
	if (removeTags.has('user/-/state/com.google/starred')) {
		eventStmts.push(
			...(await buildTransitionEventsBestEffort(env, rowids, {
				kind: 'star',
				target: false,
				eventType: 'unstar',
				clientFamily,
			})),
		);
		addBulkUpdate('is_starred', 0);
	}

	if (stmts.length > 0) {
		await runStatementChunks(env, stmts);
		await recordEngagementBestEffort(env, eventStmts);
	}

	return new Response('OK', { headers: { 'Content-Type': 'text/plain' } });
}

async function loadMarkAllRowIds(
	env: Env,
	options: { streamId: string; feedKey: string | null; cutoff: MarkAllTimestampCutoff },
): Promise<number[]> {
	const cutoffClause = options.cutoff.kind === 'cutoff' ? ` AND ${MARK_ALL_CUTOFF_CLAUSE}` : '';
	const cutoffBind = options.cutoff.kind === 'cutoff' ? [options.cutoff.seconds] : [];

	if (options.feedKey) {
		const result = await env.DB.prepare(
			`SELECT i.rowid
			   FROM items i
			   JOIN feeds f ON f.feed_key = i.feed_key
			  WHERE f.is_active = 1 AND i.feed_key = ?${cutoffClause}`,
		)
			.bind(options.feedKey, ...cutoffBind)
			.all<{ rowid: number }>();
		return result.results.map((row) => row.rowid);
	}

	const label = labelFromStreamId(options.streamId);
	if (label) {
		try {
			const result = await env.DB.prepare(
				`SELECT i.rowid
				   FROM items i
				   JOIN feeds f ON f.feed_key = i.feed_key
				  WHERE f.is_active = 1
				    AND (f.category = ? OR EXISTS (SELECT 1 FROM feed_tags ft WHERE ft.feed_key = f.feed_key AND ft.label = ?))${cutoffClause}`,
			)
				.bind(label, label, ...cutoffBind)
				.all<{ rowid: number }>();
			return result.results.map((row) => row.rowid);
		} catch (error) {
			if (!isMissingTableError(error, 'feed_tags')) {
				throw error;
			}
			const result = await env.DB.prepare(
				`SELECT i.rowid
				   FROM items i
				   JOIN feeds f ON f.feed_key = i.feed_key
				  WHERE f.is_active = 1 AND f.category = ?${cutoffClause}`,
			)
				.bind(label, ...cutoffBind)
				.all<{ rowid: number }>();
			return result.results.map((row) => row.rowid);
		}
	}

	if (options.streamId === 'user/-/state/com.google/reading-list') {
		const result = await env.DB.prepare(
			`SELECT i.rowid
			   FROM items i
			   JOIN feeds f ON f.feed_key = i.feed_key
			  WHERE f.is_active = 1${cutoffClause}`,
		)
			.bind(...cutoffBind)
			.all<{ rowid: number }>();
		return result.results.map((row) => row.rowid);
	}

	return [];
}

async function runMarkAllUpdate(
	env: Env,
	rowids: number[],
	update: { sql: string; binds: (string | number)[] },
	clientFamily: ClientFamily,
): Promise<void> {
	const eventStmts = await buildTransitionEventsBestEffort(env, rowids, {
		kind: 'read',
		target: true,
		eventType: 'bulk_mark_all_read',
		clientFamily,
	});
	const updateStmt = env.DB.prepare(update.sql).bind(...update.binds);
	await updateStmt.run();
	await recordEngagementBestEffort(env, eventStmts);
}

async function handleQuickAdd(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const params = await parseRequestParams(request, url);
	const quickaddUrl = params.get('quickadd') || url.searchParams.get('quickadd');

	console.log('[GReader] quickadd called with URL:', quickaddUrl);

	if (!quickaddUrl) {
		return Response.json({ error: 'Missing quickadd parameter' }, { status: 400 });
	}

	try {
		const result = await subscribeToFeed(env, quickaddUrl, null);
		console.log('[GReader] quickadd successful:', result);

		// Return GReader-compatible response
		return Response.json({
			query: quickaddUrl,
			numResults: 1,
			streamId: `feed/${result.rowid}`,
			streamName: result.display_name,
			isNew: result.wasCreated,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error('[GReader] quickadd failed:', message);
		return Response.json({ error: message }, { status: 400 });
	}
}

async function handleMarkAllAsRead(request: Request, env: Env): Promise<Response> {
	const body = await parseRequestParams(request, new URL(request.url));
	const streamId = body.get('s');
	const parsedTs = parseMarkAllTimestamp(body.get('ts'));

	if (!streamId) {
		return new Response('Missing stream ID', { status: 400 });
	}
	if (parsedTs.kind === 'invalid') {
		return new Response('Invalid timestamp', { status: 400 });
	}

	const feedKey = await resolveStreamFeedKey(streamId, env);
	const clientFamily = classifyClientFamily(request);

	if (feedKey) {
		if (parsedTs.kind === 'cutoff') {
			const rowids = await loadMarkAllRowIds(env, { streamId, feedKey, cutoff: parsedTs });
			await runMarkAllUpdate(
				env,
				rowids,
				{
					sql: `UPDATE items SET is_read = 1 WHERE feed_key = ? AND feed_key IN (SELECT feed_key FROM feeds WHERE is_active = 1) AND ${MARK_ALL_CUTOFF_CLAUSE}`,
					binds: [feedKey, parsedTs.seconds],
				},
				clientFamily,
			);
		} else {
			const rowids = await loadMarkAllRowIds(env, { streamId, feedKey, cutoff: parsedTs });
			await runMarkAllUpdate(
				env,
				rowids,
				{ sql: 'UPDATE items SET is_read = 1 WHERE feed_key = ? AND feed_key IN (SELECT feed_key FROM feeds WHERE is_active = 1)', binds: [feedKey] },
				clientFamily,
			);
		}
	} else if (labelFromStreamId(streamId)) {
		const label = labelFromStreamId(streamId) as string;
		const tsClause = parsedTs.kind === 'cutoff' ? ` AND ${MARK_ALL_CUTOFF_CLAUSE}` : '';
		const sql = `UPDATE items
		    SET is_read = 1
		  WHERE feed_key IN (
		    SELECT f.feed_key
		      FROM feeds f
		     WHERE f.is_active = 1
		       AND (f.category = ? OR EXISTS (SELECT 1 FROM feed_tags ft WHERE ft.feed_key = f.feed_key AND ft.label = ?))
		  )${tsClause}`;
		const binds = parsedTs.kind === 'cutoff' ? [label, label, parsedTs.seconds] : [label, label];
		try {
			const rowids = await loadMarkAllRowIds(env, { streamId, feedKey: null, cutoff: parsedTs });
			await runMarkAllUpdate(env, rowids, { sql, binds }, clientFamily);
		} catch (error) {
			if (!isMissingTableError(error, 'feed_tags')) {
				throw error;
			}
			const fallbackSql = `UPDATE items
			    SET is_read = 1
			  WHERE feed_key IN (SELECT feed_key FROM feeds WHERE category = ? AND is_active = 1)${tsClause}`;
			const fallbackBinds = parsedTs.kind === 'cutoff' ? [label, parsedTs.seconds] : [label];
			const rowids = await loadMarkAllRowIds(env, { streamId, feedKey: null, cutoff: parsedTs });
			await runMarkAllUpdate(env, rowids, { sql: fallbackSql, binds: fallbackBinds }, clientFamily);
		}
	} else if (streamId === 'user/-/state/com.google/reading-list') {
		const rowids = await loadMarkAllRowIds(env, { streamId, feedKey: null, cutoff: parsedTs });
		const activeFeedClause = 'feed_key IN (SELECT feed_key FROM feeds WHERE is_active = 1)';
		if (parsedTs.kind === 'cutoff') {
			await runMarkAllUpdate(
				env,
				rowids,
				{
					sql: `UPDATE items SET is_read = 1 WHERE ${activeFeedClause} AND ${MARK_ALL_CUTOFF_CLAUSE}`,
					binds: [parsedTs.seconds],
				},
				clientFamily,
			);
		} else {
			await runMarkAllUpdate(
				env,
				rowids,
				{ sql: `UPDATE items SET is_read = 1 WHERE ${activeFeedClause}`, binds: [] },
				clientFamily,
			);
		}
	}

	return new Response('OK', { headers: { 'Content-Type': 'text/plain' } });
}
