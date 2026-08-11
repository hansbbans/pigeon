import type { Env } from './types';
import { subscribeToFeed } from './subscribe';
import { createRenderedContent } from './rendered-content';
import { generateApiToken, requireApiAuth } from './api-auth';
import {
	buildStateTransitionEventStatements,
	classifyClientFamily,
	type ClientFamily,
} from './engagement';
import { ensureDatabaseSchema } from './migrations';

// --- ID conversion utilities ---

function parseItemId(id: string): number {
	if (id.startsWith('tag:google.com,2005:reader/item/')) {
		return parseInt(id.slice('tag:google.com,2005:reader/item/'.length), 16);
	}
	if (/^[0-9a-fA-F]{16}$/.test(id)) {
		return parseInt(id, 16);
	}
	return parseInt(id, 10);
}

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

function labelFromStreamId(streamId: string | null): string | null {
	if (!streamId || !streamId.startsWith('user/-/label/')) {
		return null;
	}
	const rawLabel = streamId.slice('user/-/label/'.length);
	try {
		return decodeURIComponent(rawLabel);
	} catch {
		return rawLabel;
	}
}

function labelsFromForm(body: FormData, key: string): string[] {
	const labels = body
		.getAll(key)
		.filter((value): value is string => typeof value === 'string')
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

	if (normalized.length <= 10) {
		return { kind: 'cutoff', seconds: normalized };
	}
	if (normalized.length <= 13) {
		return { kind: 'cutoff', seconds: (value / 1_000n).toString() };
	}
	if (normalized.length <= 16) {
		return { kind: 'cutoff', seconds: (value / 1_000_000n).toString() };
	}
	if (normalized.length <= 19) {
		return { kind: 'cutoff', seconds: (value / 1_000_000_000n).toString() };
	}
	return { kind: 'invalid' };
}

const MAX_IN_QUERY_BIND_PARAMS = 100;
const MAX_D1_BATCH_STATEMENTS = 50;

const STREAM_CONTINUATION_VERSION = 1;

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
}

function chunkValues<T>(values: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < values.length; i += size) {
		chunks.push(values.slice(i, i + size));
	}
	return chunks;
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

async function loadFeedTags(env: Env, feedKeys?: string[]): Promise<Map<string, string[]>> {
	const tagsByFeedKey = new Map<string, string[]>();
	const addTag = (feedKey: string, label: string | null) => {
		if (!label) {
			return;
		}
		const existing = tagsByFeedKey.get(feedKey) ?? [];
		if (!existing.includes(label)) {
			existing.push(label);
			tagsByFeedKey.set(feedKey, existing);
		}
	};

	const hasFeedKeyFilter = feedKeys !== undefined;
	const filteredFeedKeys = [...new Set(feedKeys ?? [])];
	if (hasFeedKeyFilter && filteredFeedKeys.length === 0) {
		return tagsByFeedKey;
	}

	const feedKeyCondition = hasFeedKeyFilter
		? ` AND f.feed_key IN (${filteredFeedKeys.map(() => '?').join(',')})`
		: '';

	try {
		const { results } = await env.DB.prepare(
			`SELECT f.feed_key, ft.label
			   FROM feeds f
			   JOIN feed_tags ft ON ft.feed_key = f.feed_key
			  WHERE f.is_active = 1${feedKeyCondition}
			  ORDER BY ft.label COLLATE NOCASE`,
		)
			.bind(...filteredFeedKeys)
			.all<{ feed_key: string; label: string }>();
		for (const row of results) {
			addTag(row.feed_key, row.label);
		}
	} catch (error) {
		if (!isMissingTableError(error, 'feed_tags')) {
			throw error;
		}
	}

	const categoryFeedKeyCondition = hasFeedKeyFilter
		? ` AND feed_key IN (${filteredFeedKeys.map(() => '?').join(',')})`
		: '';
	const { results: categoryResults } = await env.DB.prepare(
		`SELECT feed_key, category
		   FROM feeds
		  WHERE is_active = 1 AND category IS NOT NULL AND category <> ''${categoryFeedKeyCondition}
		  ORDER BY category COLLATE NOCASE`,
	)
		.bind(...filteredFeedKeys)
		.all<{ feed_key: string; category: string | null }>();
	for (const row of categoryResults) {
		addTag(row.feed_key, row.category);
	}

	return tagsByFeedKey;
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

	if (!passwd || passwd !== env.API_PASSWORD) {
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

	const labels = [...new Set([...((await loadFeedTags(env)).values())].flat())].sort((left, right) =>
		left.localeCompare(right, undefined, { sensitivity: 'base', numeric: true }),
	);
	for (const label of labels) {
		tags.push({ id: `user/-/label/${label}` });
	}

	return Response.json({ tags });
}

async function handleSubscriptionList(env: Env): Promise<Response> {
	const { results } = await env.DB.prepare(
		'SELECT rowid, feed_key, display_name, from_email, custom_title, category, icon_url, source_url, site_url FROM feeds WHERE is_active = 1',
	).all<{
		rowid: number;
		feed_key: string;
		display_name: string;
		from_email: string | null;
		custom_title: string | null;
		category: string | null;
		icon_url: string | null;
		source_url: string | null;
		site_url: string | null;
	}>();

	const tagsByFeedKey = await loadFeedTags(env, results.map((f) => f.feed_key));
	const subscriptions = results.map((f) => ({
		id: `feed/${f.rowid}`,
		title: f.custom_title || f.display_name,
		categories: (tagsByFeedKey.get(f.feed_key) ?? []).map((label) => ({ id: `user/-/label/${label}`, label })),
		url: `${env.BASE_URL}/feed/${f.feed_key}`,
		htmlUrl: f.site_url || f.source_url || env.BASE_URL,
		iconUrl: f.icon_url || '',
	}));

	return Response.json({ subscriptions });
}

async function handleUnreadCount(env: Env): Promise<Response> {
	const { results } = await env.DB.prepare(
		`SELECT f.rowid, i.feed_key, COUNT(*) as count, MAX(i.received_at) as newest
		 FROM items i JOIN feeds f ON i.feed_key = f.feed_key
		 WHERE f.is_active = 1 AND i.is_read = 0 GROUP BY i.feed_key`,
	).all<{
		rowid: number;
		feed_key: string;
		count: number;
		newest: string;
	}>();
	const tagsByFeedKey = await loadFeedTags(env, results.map((row) => row.feed_key));

	let totalUnreadCount = 0;
	let newestUnreadUsec = '0';
	const unreadcounts = results.map((r) => ({
		id: `feed/${r.rowid}`,
		count: r.count,
		newestItemTimestampUsec: (isoToUnix(r.newest) * 1_000_000).toString(),
	}));
	const labelCounts = new Map<string, { count: number; newestItemTimestampUsec: string }>();
	for (const unread of unreadcounts) {
		totalUnreadCount += unread.count;
		if (unread.newestItemTimestampUsec > newestUnreadUsec) {
			newestUnreadUsec = unread.newestItemTimestampUsec;
		}
	}
	for (const row of results) {
		const newestItemTimestampUsec = (isoToUnix(row.newest) * 1_000_000).toString();
		for (const label of tagsByFeedKey.get(row.feed_key) ?? []) {
			const streamId = `user/-/label/${label}`;
			const existing = labelCounts.get(streamId) ?? { count: 0, newestItemTimestampUsec: '0' };
			existing.count += row.count;
			if (newestItemTimestampUsec > existing.newestItemTimestampUsec) {
				existing.newestItemTimestampUsec = newestItemTimestampUsec;
			}
			labelCounts.set(streamId, existing);
		}
	}
	for (const [id, value] of [...labelCounts.entries()].sort(([leftId], [rightId]) =>
		leftId.localeCompare(rightId, undefined, { sensitivity: 'base', numeric: true }),
	)) {
		unreadcounts.push({
			id,
			count: value.count,
			newestItemTimestampUsec: value.newestItemTimestampUsec,
		});
	}
	unreadcounts.push({
		id: 'user/-/state/com.google/reading-list',
		count: totalUnreadCount,
		newestItemTimestampUsec: newestUnreadUsec,
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

	if (contentType === 'application/x-www-form-urlencoded') {
		return new URLSearchParams(await request.text());
	}

	if (contentType === 'multipart/form-data') {
		const formData = await request.formData();
		const params = new URLSearchParams();
		for (const [key, value] of formData.entries()) {
			if (typeof value === 'string') {
				params.append(key, value);
			}
		}
		return params;
	}

	const rawBody = await request.text();
	if (rawBody.trim()) {
		return new URLSearchParams(rawBody);
	}

	return new URLSearchParams(url.searchParams);
}

async function selectStreamRowIds(options: {
	streamId: string;
	limit: number;
	excludeTag: string;
	olderThanUnix: string;
	continuation: string;
	env: Env;
}): Promise<{ rowids: number[]; continuation?: string }> {
	let sql =
		'SELECT i.rowid, i.received_at FROM items i JOIN feeds f ON f.feed_key = i.feed_key WHERE f.is_active = 1';
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
			return { rowids: [] };
		}
		sql += ' AND i.feed_key = ?';
		binds.push(feedKey);
	}

	if (options.excludeTag === 'user/-/state/com.google/read') {
		sql += ' AND i.is_read = 0';
	}
	if (options.olderThanUnix) {
		sql += " AND datetime(i.received_at) > datetime(?, 'unixepoch')";
		binds.push(parseInt(options.olderThanUnix, 10));
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
		rowids: page.map((row) => row.rowid),
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

async function loadResponseItems(rowids: number[], env: Env): Promise<
	Array<{
		id: string;
		categories: string[];
		title: string;
		published: number;
		updated: number;
		crawlTimeMsec: string;
		timestampUsec: string;
		author: string;
		summary: { direction: string; content: string };
		content: { direction: string; content: string };
		alternate?: Array<{ href: string }>;
		origin: { streamId: string; title: string; htmlUrl: string };
	}>
> {
	if (rowids.length === 0) {
		return [];
	}

	type ResponseItemRow = {
		rowid: number;
		id: string;
		feed_key: string;
		from_name: string | null;
		subject: string;
		html_content: string;
		text_content: string | null;
		original_url: string | null;
		received_at: string;
		is_read: number;
		is_starred: number;
	};
	const itemResults = await Promise.all(
		chunkValues(rowids, MAX_IN_QUERY_BIND_PARAMS).map(async (rowidChunk) => {
			const placeholders = rowidChunk.map(() => '?').join(',');
			const selectRows = (originalUrlExpression: string) =>
				env.DB.prepare(
					`SELECT i.rowid, i.id, i.feed_key, i.from_name, i.subject, i.html_content, i.text_content, ${originalUrlExpression} AS original_url, i.received_at, i.is_read, i.is_starred
					 FROM items i WHERE i.rowid IN (${placeholders})`,
				)
					.bind(...rowidChunk)
					.all<ResponseItemRow>();

			try {
				return await selectRows('i.original_url');
			} catch (error) {
				if (!isMissingColumnError(error, 'original_url')) {
					throw error;
				}
				return selectRows('NULL');
			}
		}),
	);
	const items = itemResults.flatMap((result) => result.results);

	const feedKeys = [...new Set(items.map((i) => i.feed_key))];
	const feedTagsByKey = await loadFeedTags(env, feedKeys);
	const feedMap = new Map<
		string,
		{
			rowid: number;
			display_name: string;
			custom_title: string | null;
			category: string | null;
			source_url: string | null;
			site_url: string | null;
		}
	>();

	if (feedKeys.length > 0) {
		const feedResults = await Promise.all(
			chunkValues(feedKeys, MAX_IN_QUERY_BIND_PARAMS).map((feedKeyChunk) => {
				const feedPlaceholders = feedKeyChunk.map(() => '?').join(',');
				return env.DB.prepare(
					`SELECT rowid, feed_key, display_name, custom_title, category, source_url, site_url FROM feeds WHERE feed_key IN (${feedPlaceholders})`,
				)
					.bind(...feedKeyChunk)
					.all<{
						rowid: number;
						feed_key: string;
						display_name: string;
						custom_title: string | null;
						category: string | null;
						source_url: string | null;
						site_url: string | null;
					}>();
			}),
		);
		for (const result of feedResults) {
			for (const f of result.results) {
				feedMap.set(f.feed_key, f);
			}
		}
	}

	const itemMap = new Map(
		items.map((item) => {
			const feed = feedMap.get(item.feed_key);
			const ts = isoToUnix(item.received_at);
			const categories = ['user/-/state/com.google/reading-list'];
			const renderedContent = createRenderedContent({
				htmlContent: item.html_content,
				textContent: item.text_content,
				originalUrl: item.original_url,
			});
			if (item.is_read) categories.push('user/-/state/com.google/read');
			if (item.is_starred) categories.push('user/-/state/com.google/starred');
			for (const label of feedTagsByKey.get(item.feed_key) ?? []) {
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
					summary: { direction: 'ltr', content: renderedContent },
					content: { direction: 'ltr', content: renderedContent },
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
	const n = Math.min(parseInt(params.get('n') || '1000', 10), 10000);
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
	const itemRefs = page.rowids.map((rowid) => ({ id: String(rowid) }));
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
		.map(parseItemId)
		.filter((rowid) => Number.isFinite(rowid));
	if (rowids.length === 0) {
		return Response.json(createItemsEnvelope([], 'user/-/state/com.google/reading-list'));
	}
	const responseItems = await loadResponseItems(rowids, env);
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
	const streamId = resolveContentsStreamId(url.pathname, params);
	const n = Math.min(parseInt(params.get('n') || '20', 10), 1000);
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
	const items = await loadResponseItems(page.rowids, env);

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

	let feedTagsAvailable = true;
	for (const label of uniqueLabels) {
		if (!feedTagsAvailable) {
			break;
		}
		try {
			await env.DB.prepare('INSERT OR IGNORE INTO feed_tags (feed_key, label) VALUES (?, ?)')
				.bind(feedKey, label)
				.run();
		} catch (error) {
			if (!isMissingTableError(error, 'feed_tags')) {
				throw error;
			}
			feedTagsAvailable = false;
		}
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

	let feedTagsAvailable = true;
	for (const label of uniqueLabels) {
		if (!feedTagsAvailable) {
			break;
		}
		try {
			await env.DB.prepare('DELETE FROM feed_tags WHERE feed_key = ? AND label = ?')
				.bind(feedKey, label)
				.run();
		} catch (error) {
			if (!isMissingTableError(error, 'feed_tags')) {
				throw error;
			}
			feedTagsAvailable = false;
		}
	}

	for (const label of uniqueLabels) {
		await env.DB.prepare('UPDATE feeds SET category = NULL WHERE rowid = ? AND category = ?')
			.bind(rowid, label)
			.run();
	}
	await syncPrimaryFeedCategory(env, rowid, feedKey);
}

async function handleSubscriptionEdit(request: Request, env: Env): Promise<Response> {
	const body = await request.formData();
	const ac = body.get('ac') as string | null;
	const streamId = body.get('s') as string | null;
	const addLabels = labelsFromForm(body, 'a');
	const removeLabels = labelsFromForm(body, 'r');
	const title = body.get('t') as string | null;

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
	const body = await request.formData();
	const ids = body.getAll('i') as string[];
	const addTag = body.get('a') as string | null;
	const removeTag = body.get('r') as string | null;

	const rowids = [...new Set(ids.map(parseItemId).filter((rowid) => Number.isFinite(rowid)))];
	if (rowids.length === 0) {
		return new Response('OK', { headers: { 'Content-Type': 'text/plain' } });
	}

	const stmts: D1PreparedStatement[] = [];
	const eventStmts: D1PreparedStatement[] = [];
	const clientFamily = classifyClientFamily(request);

	function addChunkedUpdate(column: 'is_read' | 'is_starred', value: 0 | 1) {
		for (const rowidChunk of chunkValues(rowids, MAX_IN_QUERY_BIND_PARAMS)) {
			const placeholders = rowidChunk.map(() => '?').join(',');
			stmts.push(env.DB.prepare(`UPDATE items SET ${column} = ${value} WHERE rowid IN (${placeholders})`).bind(...rowidChunk));
		}
	}

	if (addTag === 'user/-/state/com.google/read') {
		eventStmts.push(
			...(await buildTransitionEventsBestEffort(env, rowids, {
				kind: 'read',
				target: true,
				eventType: 'read',
				clientFamily,
			})),
		);
		addChunkedUpdate('is_read', 1);
	}
	if (removeTag === 'user/-/state/com.google/read') {
		eventStmts.push(
			...(await buildTransitionEventsBestEffort(env, rowids, {
				kind: 'read',
				target: false,
				eventType: 'unread',
				clientFamily,
			})),
		);
		addChunkedUpdate('is_read', 0);
	}
	if (addTag === 'user/-/state/com.google/starred') {
		eventStmts.push(
			...(await buildTransitionEventsBestEffort(env, rowids, {
				kind: 'star',
				target: true,
				eventType: 'star',
				clientFamily,
			})),
		);
		addChunkedUpdate('is_starred', 1);
	}
	if (removeTag === 'user/-/state/com.google/starred') {
		eventStmts.push(
			...(await buildTransitionEventsBestEffort(env, rowids, {
				kind: 'star',
				target: false,
				eventType: 'unstar',
				clientFamily,
			})),
		);
		addChunkedUpdate('is_starred', 0);
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
	const cutoffClause = options.cutoff.kind === 'cutoff' ? " AND datetime(received_at) <= datetime(?, 'unixepoch')" : '';
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
	const quickaddUrl = url.searchParams.get('quickadd');

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
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error('[GReader] quickadd failed:', message);
		return Response.json({ error: message }, { status: 400 });
	}
}

async function handleMarkAllAsRead(request: Request, env: Env): Promise<Response> {
	const body = await request.formData();
	const streamId = body.get('s') as string | null;
	const parsedTs = parseMarkAllTimestamp(body.get('ts') as string | null);

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
					sql: "UPDATE items SET is_read = 1 WHERE feed_key = ? AND feed_key IN (SELECT feed_key FROM feeds WHERE is_active = 1) AND datetime(received_at) <= datetime(?, 'unixepoch')",
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
		const tsClause = parsedTs.kind === 'cutoff' ? " AND datetime(received_at) <= datetime(?, 'unixepoch')" : '';
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
					sql: `UPDATE items SET is_read = 1 WHERE ${activeFeedClause} AND datetime(received_at) <= datetime(?, 'unixepoch')`,
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
