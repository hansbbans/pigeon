import type { Env } from './types';

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

function isoToUnix(iso: string): number {
	return Math.floor(new Date(iso).getTime() / 1000);
}

// --- Auth ---

async function generateToken(password: string): Promise<string> {
	const data = new TextEncoder().encode(password);
	const hash = await crypto.subtle.digest('SHA-256', data);
	return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function validateAuth(request: Request, env: Env): Promise<Response | null> {
	const auth = request.headers.get('Authorization');
	if (!auth) {
		return new Response('Unauthorized', { status: 401 });
	}

	const match = auth.match(/^GoogleLogin auth=pigeon\/(.+)$/);
	if (!match) {
		return new Response('Unauthorized', { status: 401 });
	}

	const token = match[1];
	const expected = await generateToken(env.API_PASSWORD);
	if (token !== expected) {
		return new Response('Unauthorized', { status: 401 });
	}

	return null; // auth OK
}

// --- Route handler ---

export async function handleGreaderRequest(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname;

	// ClientLogin doesn't require auth
	if (path === '/accounts/ClientLogin' && request.method === 'POST') {
		return handleClientLogin(request, env);
	}

	// All /reader/api/0/* routes require auth
	const authErr = await validateAuth(request, env);
	if (authErr) return authErr;

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
	if (path === '/reader/api/0/unread-count') {
		return handleUnreadCount(env);
	}
	if (path === '/reader/api/0/stream/items/ids') {
		return handleStreamItemIds(request, url, env);
	}
	if (path === '/reader/api/0/stream/items/contents') {
		return handleStreamItemContents(request, env);
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
	const body = await request.formData();
	const passwd = body.get('Passwd') as string | null;

	if (!passwd || passwd !== env.API_PASSWORD) {
		return new Response('Error=BadAuthentication', { status: 401, headers: { 'Content-Type': 'text/plain' } });
	}

	const token = await generateToken(env.API_PASSWORD);
	const result = `SID=pigeon/${token}\nLSID=null\nAuth=pigeon/${token}`;
	return new Response(result, { headers: { 'Content-Type': 'text/plain' } });
}

async function handleToken(env: Env): Promise<Response> {
	const token = await generateToken(env.API_PASSWORD);
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
	const { results } = await env.DB.prepare(
		'SELECT DISTINCT category FROM feeds WHERE category IS NOT NULL AND is_active = 1',
	).all<{ category: string }>();

	const tags: { id: string }[] = [
		{ id: 'user/-/state/com.google/starred' },
		{ id: 'user/-/state/com.google/read' },
		{ id: 'user/-/state/com.google/reading-list' },
	];

	for (const r of results) {
		tags.push({ id: `user/-/label/${r.category}` });
	}

	return Response.json({ tags });
}

async function handleSubscriptionList(env: Env): Promise<Response> {
	const { results } = await env.DB.prepare(
		'SELECT rowid, feed_key, display_name, from_email, custom_title, category FROM feeds WHERE is_active = 1',
	).all<{
		rowid: number;
		feed_key: string;
		display_name: string;
		from_email: string | null;
		custom_title: string | null;
		category: string | null;
	}>();

	const subscriptions = results.map((f) => ({
		id: `feed/${f.rowid}`,
		title: f.custom_title || f.display_name,
		categories: f.category
			? [{ id: `user/-/label/${f.category}`, label: f.category }]
			: [],
		url: `${env.BASE_URL}/feed/${f.feed_key}`,
		htmlUrl: env.BASE_URL,
		iconUrl: '',
	}));

	return Response.json({ subscriptions });
}

async function handleUnreadCount(env: Env): Promise<Response> {
	const { results } = await env.DB.prepare(
		`SELECT f.rowid, i.feed_key, COUNT(*) as count, MAX(i.received_at) as newest
		 FROM items i JOIN feeds f ON i.feed_key = f.feed_key
		 WHERE i.is_read = 0 GROUP BY i.feed_key`,
	).all<{
		rowid: number;
		feed_key: string;
		count: number;
		newest: string;
	}>();

	const unreadcounts = results.map((r) => ({
		id: `feed/${r.rowid}`,
		count: r.count,
		newestItemTimestampUsec: (isoToUnix(r.newest) * 1_000_000).toString(),
	}));

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

async function handleStreamItemIds(request: Request, url: URL, env: Env): Promise<Response> {
	const params = request.method === 'POST' ? new URLSearchParams(await request.text()) : url.searchParams;
	const streamId = params.get('s') || '';
	const n = Math.min(parseInt(params.get('n') || '1000', 10), 10000);
	const xt = params.get('xt') || '';
	const ot = params.get('ot') || '';

	let sql = 'SELECT i.rowid FROM items i';
	const binds: (string | number)[] = [];

	if (streamId === 'user/-/state/com.google/starred') {
		sql += ' WHERE i.is_starred = 1';
	} else if (streamId === 'user/-/state/com.google/reading-list' || !streamId) {
		sql += ' WHERE 1=1';
	} else {
		const feedKey = await resolveStreamFeedKey(streamId, env);
		if (!feedKey) return Response.json({ itemRefs: [] });
		sql += ' WHERE i.feed_key = ?';
		binds.push(feedKey);
	}

	if (xt === 'user/-/state/com.google/read') {
		sql += ' AND i.is_read = 0';
	}
	if (ot) {
		sql += " AND i.received_at > datetime(?, 'unixepoch')";
		binds.push(parseInt(ot, 10));
	}

	sql += ' ORDER BY i.received_at DESC LIMIT ?';
	binds.push(n);

	const { results } = await env.DB.prepare(sql).bind(...binds).all<{ rowid: number }>();

	const itemRefs = results.map((r) => ({ id: r.rowid.toString() }));
	return Response.json({ itemRefs });
}

async function handleStreamItemContents(request: Request, env: Env): Promise<Response> {
	const body = await request.formData();
	const ids = body.getAll('i') as string[];

	if (ids.length === 0) {
		return Response.json({ items: [] });
	}

	const rowids = ids.map(parseItemId);
	const placeholders = rowids.map(() => '?').join(',');

	const { results: items } = await env.DB.prepare(
		`SELECT i.rowid, i.id, i.feed_key, i.from_name, i.subject, i.html_content, i.received_at, i.is_read, i.is_starred
		 FROM items i WHERE i.rowid IN (${placeholders})`,
	)
		.bind(...rowids)
		.all<{
			rowid: number;
			id: string;
			feed_key: string;
			from_name: string | null;
			subject: string;
			html_content: string;
			received_at: string;
			is_read: number;
			is_starred: number;
		}>();

	// Gather unique feed_keys and fetch feed metadata
	const feedKeys = [...new Set(items.map((i) => i.feed_key))];
	const feedMap = new Map<string, { rowid: number; display_name: string; custom_title: string | null }>();

	if (feedKeys.length > 0) {
		const feedPlaceholders = feedKeys.map(() => '?').join(',');
		const { results: feeds } = await env.DB.prepare(
			`SELECT rowid, feed_key, display_name, custom_title FROM feeds WHERE feed_key IN (${feedPlaceholders})`,
		)
			.bind(...feedKeys)
			.all<{ rowid: number; feed_key: string; display_name: string; custom_title: string | null }>();
		for (const f of feeds) {
			feedMap.set(f.feed_key, f);
		}
	}

	const responseItems = items.map((item) => {
		const feed = feedMap.get(item.feed_key);
		const ts = isoToUnix(item.received_at);
		const categories = ['user/-/state/com.google/reading-list'];
		if (item.is_read) categories.push('user/-/state/com.google/read');
		if (item.is_starred) categories.push('user/-/state/com.google/starred');

		return {
			id: toGoogleItemId(item.rowid),
			categories,
			title: item.subject,
			published: ts,
			updated: ts,
			crawlTimeMsec: (ts * 1000).toString(),
			timestampUsec: (ts * 1_000_000).toString(),
			author: item.from_name || '',
			summary: { direction: 'ltr', content: item.html_content },
			origin: {
				streamId: feed ? `feed/${feed.rowid}` : `feed/0`,
				title: feed ? (feed.custom_title || feed.display_name) : '',
				htmlUrl: env.BASE_URL,
			},
		};
	});

	return Response.json({ items: responseItems });
}

async function handleSubscriptionEdit(request: Request, env: Env): Promise<Response> {
	const body = await request.formData();
	const ac = body.get('ac') as string | null;
	const streamId = body.get('s') as string | null;
	const addLabel = body.get('a') as string | null;
	const removeLabel = body.get('r') as string | null;
	const title = body.get('t') as string | null;

	if (ac !== 'edit' || !streamId) {
		return new Response('Bad request', { status: 400 });
	}

	const feedMatch = streamId.match(/^feed\/(\d+)$/);
	if (!feedMatch) {
		return new Response('Bad request', { status: 400 });
	}
	const rowid = parseInt(feedMatch[1], 10);

	const stmts: D1PreparedStatement[] = [];

	if (addLabel) {
		const labelMatch = addLabel.match(/^user\/-\/label\/(.+)$/);
		if (labelMatch) {
			stmts.push(env.DB.prepare('UPDATE feeds SET category = ? WHERE rowid = ?').bind(labelMatch[1], rowid));
		}
	}

	if (removeLabel) {
		const labelMatch = removeLabel.match(/^user\/-\/label\/(.+)$/);
		if (labelMatch) {
			stmts.push(
				env.DB.prepare('UPDATE feeds SET category = NULL WHERE rowid = ? AND category = ?').bind(rowid, labelMatch[1]),
			);
		}
	}

	if (title) {
		stmts.push(env.DB.prepare('UPDATE feeds SET custom_title = ? WHERE rowid = ?').bind(title, rowid));
	}

	if (stmts.length > 0) {
		await env.DB.batch(stmts);
	}

	return new Response('OK', { headers: { 'Content-Type': 'text/plain' } });
}

async function handleEditTag(request: Request, env: Env): Promise<Response> {
	const body = await request.formData();
	const ids = body.getAll('i') as string[];
	const addTag = body.get('a') as string | null;
	const removeTag = body.get('r') as string | null;

	const rowids = ids.map(parseItemId);
	if (rowids.length === 0) {
		return new Response('OK', { headers: { 'Content-Type': 'text/plain' } });
	}

	const placeholders = rowids.map(() => '?').join(',');
	const stmts: D1PreparedStatement[] = [];

	if (addTag === 'user/-/state/com.google/read') {
		stmts.push(env.DB.prepare(`UPDATE items SET is_read = 1 WHERE rowid IN (${placeholders})`).bind(...rowids));
	}
	if (removeTag === 'user/-/state/com.google/read') {
		stmts.push(env.DB.prepare(`UPDATE items SET is_read = 0 WHERE rowid IN (${placeholders})`).bind(...rowids));
	}
	if (addTag === 'user/-/state/com.google/starred') {
		stmts.push(env.DB.prepare(`UPDATE items SET is_starred = 1 WHERE rowid IN (${placeholders})`).bind(...rowids));
	}
	if (removeTag === 'user/-/state/com.google/starred') {
		stmts.push(env.DB.prepare(`UPDATE items SET is_starred = 0 WHERE rowid IN (${placeholders})`).bind(...rowids));
	}

	if (stmts.length > 0) {
		await env.DB.batch(stmts);
	}

	return new Response('OK', { headers: { 'Content-Type': 'text/plain' } });
}

async function handleMarkAllAsRead(request: Request, env: Env): Promise<Response> {
	const body = await request.formData();
	const streamId = body.get('s') as string | null;
	const ts = body.get('ts') as string | null;

	if (!streamId) {
		return new Response('Missing stream ID', { status: 400 });
	}

	const feedKey = await resolveStreamFeedKey(streamId, env);

	if (feedKey) {
		if (ts) {
			await env.DB.prepare("UPDATE items SET is_read = 1 WHERE feed_key = ? AND received_at <= datetime(?, 'unixepoch')")
				.bind(feedKey, parseInt(ts, 10))
				.run();
		} else {
			await env.DB.prepare('UPDATE items SET is_read = 1 WHERE feed_key = ?').bind(feedKey).run();
		}
	} else if (streamId === 'user/-/state/com.google/reading-list') {
		// Mark all items as read
		if (ts) {
			await env.DB.prepare("UPDATE items SET is_read = 1 WHERE received_at <= datetime(?, 'unixepoch')")
				.bind(parseInt(ts, 10))
				.run();
		} else {
			await env.DB.prepare('UPDATE items SET is_read = 1').run();
		}
	}

	return new Response('OK', { headers: { 'Content-Type': 'text/plain' } });
}
