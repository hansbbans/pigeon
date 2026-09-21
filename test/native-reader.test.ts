import * as assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { generateApiToken } from '../src/api-auth';
import { handleGreaderRequest } from '../src/greader';
import { handleNativeApiRequest } from '../src/native-api';

const PASSWORD = 'secret-password';
const BASE_URL = 'https://pigeon.example';

interface FixtureItem {
	id: string;
	feedKey: string;
	title: string;
	receivedAt: string;
	textContent?: string | null;
	htmlContent?: string;
	isRead?: number;
	isStarred?: number;
}

class SqliteD1Statement {
	private values: unknown[] = [];

	constructor(
		private readonly db: DatabaseSync,
		private readonly sql: string,
		private readonly executedSql?: Array<{ sql: string; values: unknown[] }>,
	) {}

	bind(...values: unknown[]): this {
		this.values = values;
		return this;
	}

	async all<T>(): Promise<{ results: T[] }> {
		this.record();
		return { results: this.db.prepare(this.sql).all(...this.values) as T[] };
	}

	async first<T>(): Promise<T | null> {
		this.record();
		return (this.db.prepare(this.sql).get(...this.values) as T | undefined) ?? null;
	}

	async run(): Promise<void> {
		this.record();
		this.db.prepare(this.sql).run(...this.values);
	}

	isEngagementInsert(): boolean {
		return this.sql.startsWith('INSERT OR IGNORE INTO engagement_events');
	}

	private record(): void {
		this.executedSql?.push({ sql: this.sql, values: [...this.values] });
	}
}

class SqliteD1Database {
	readonly batchSizes: number[] = [];
	readonly executedSql: Array<{ sql: string; values: unknown[] }> = [];

	constructor(
		private readonly db: DatabaseSync,
		private readonly failEngagementWrites = false,
	) {}

	prepare(sql: string): SqliteD1Statement {
		return new SqliteD1Statement(this.db, sql, this.executedSql);
	}

	clearExecutedSql(): void {
		this.executedSql.length = 0;
	}

	async batch(statements: SqliteD1Statement[]): Promise<void> {
		this.batchSizes.push(statements.length);
		if (this.failEngagementWrites && statements.some((statement) => statement.isEngagementInsert())) {
			throw new Error('simulated engagement write failure');
		}
		for (const statement of statements) {
			await statement.run();
		}
	}
}

function createFixture(items: FixtureItem[], options: { failEngagementWrites?: boolean } = {}) {
	const db = new DatabaseSync(':memory:');
	db.exec(`
		PRAGMA foreign_keys = ON;
		CREATE TABLE _meta (key TEXT PRIMARY KEY, value TEXT);
		INSERT INTO _meta (key, value) VALUES ('schema_version', '6');
		CREATE TABLE feeds (
			feed_key TEXT PRIMARY KEY,
			display_name TEXT NOT NULL,
			from_email TEXT,
			source_type TEXT NOT NULL DEFAULT 'email',
			source_url TEXT,
			site_url TEXT,
			fetch_interval_minutes INTEGER DEFAULT 60,
			last_fetched_at TEXT,
			fetch_error TEXT,
			etag TEXT,
			last_modified TEXT,
			first_seen_at TEXT,
			last_item_at TEXT,
			item_count INTEGER DEFAULT 0,
			is_active INTEGER DEFAULT 1,
			custom_title TEXT,
			category TEXT,
			icon_url TEXT
		);
		CREATE TABLE items (
			id TEXT PRIMARY KEY,
			feed_key TEXT NOT NULL,
			from_name TEXT,
			from_email TEXT,
			subject TEXT NOT NULL,
			html_content TEXT NOT NULL,
			text_content TEXT,
			original_url TEXT,
			message_id TEXT UNIQUE,
			received_at TEXT NOT NULL,
			created_at TEXT,
			content_size INTEGER DEFAULT 0,
			is_read INTEGER DEFAULT 0,
			is_starred INTEGER DEFAULT 0,
			FOREIGN KEY (feed_key) REFERENCES feeds(feed_key)
		);
	`);

	const feedKeys = [...new Set(items.map((item) => item.feedKey))];
	const insertFeed = db.prepare(
		`INSERT INTO feeds (feed_key, display_name, source_type, is_active)
		 VALUES (?, ?, 'email', 1)`,
	);
	for (const feedKey of feedKeys) {
		insertFeed.run(feedKey, feedKey.replaceAll('-', ' '));
	}

	const insertItem = db.prepare(
		`INSERT INTO items (
			id, feed_key, subject, html_content, text_content, original_url, received_at, is_read, is_starred
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	for (const item of items) {
		insertItem.run(
			item.id,
			item.feedKey,
			item.title,
			item.htmlContent ?? '<p>Article body</p>',
			item.textContent === undefined ? 'Article body' : item.textContent,
			`https://example.com/${item.id}`,
			item.receivedAt,
			item.isRead ?? 0,
			item.isStarred ?? 0,
		);
	}

	const database = new SqliteD1Database(db, options.failEngagementWrites ?? false);
	const env = {
		API_PASSWORD: PASSWORD,
		BASE_URL,
		DB: database,
	};
	return { db, database, env: env as never };
}

async function authorization(): Promise<string> {
	return `GoogleLogin auth=pigeon/${await generateApiToken(PASSWORD)}`;
}

async function nativeRequest(
	env: never,
	path: string,
	init: RequestInit = {},
): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set('Authorization', await authorization());
	return handleNativeApiRequest(new Request(`${BASE_URL}${path}`, { ...init, headers }), env);
}

async function greaderRequest(
	env: never,
	path: string,
	body: URLSearchParams,
	client: string,
): Promise<Response> {
	return handleGreaderRequest(
		new Request(`${BASE_URL}${path}`, {
			method: 'POST',
			headers: {
				Authorization: await authorization(),
				'Content-Type': 'application/x-www-form-urlencoded',
				'User-Agent': client,
			},
			body,
		}),
		env,
	);
}

test('native engagement is authenticated, validated, migrated, and idempotent', async () => {
	const { db, env } = createFixture([
		{
			id: 'item-1',
			feedKey: 'daily-feed',
			title: 'Daily story',
			receivedAt: '2026-08-09T11:00:00.000Z',
		},
	]);

	const unauthorized = await handleNativeApiRequest(
		new Request(`${BASE_URL}/api/v1/recommendations`),
		env,
	);
	assert.equal(unauthorized.status, 401);

	const body = JSON.stringify({
		events: [
			{
				id: 'open-1',
				itemId: 'item-1',
				type: 'explicit_open',
				occurredAt: '2026-08-09T12:00:00.000Z',
			},
			{
				id: 'outbound-1',
				itemId: 'item-1',
				type: 'outbound_link',
				destinationHost: 'News.Example.com.',
				occurredAt: '2026-08-09T12:01:00.000Z',
			},
		],
	});
	const first = await nativeRequest(env, '/api/v1/engagement', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-Pigeon-Client': 'pigeon-reader/1' },
		body,
	});
	assert.equal(first.status, 200);
	assert.deepEqual(await first.json(), { accepted: 2, clientFamily: 'pigeon' });

	const repeated = await nativeRequest(env, '/api/v1/engagement', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-Pigeon-Client': 'pigeon-reader/1' },
		body,
	});
	assert.equal(repeated.status, 200);
	assert.equal(
		(db.prepare('SELECT COUNT(*) AS count FROM engagement_events').get() as { count: number }).count,
		2,
	);
	assert.equal(
		(db.prepare("SELECT destination_host FROM engagement_events WHERE event_type = 'outbound_link'").get() as { destination_host: string }).destination_host,
		'news.example.com',
	);
	assert.equal(
		(db.prepare("SELECT value FROM _meta WHERE key = 'schema_version'").get() as { value: string }).value,
		'13',
	);
	const eventColumns = db
		.prepare('PRAGMA table_info(engagement_events)')
		.all() as Array<{ name: string }>;
	assert.equal(eventColumns.some((column) => column.name === 'user_agent' || column.name === 'ip'), false);
	assert.equal(eventColumns.some((column) => column.name === 'destination_host'), true);

	const invalid = await nativeRequest(env, '/api/v1/engagement', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			events: [{ id: 'bad-scroll', itemId: 'item-1', type: 'scroll_depth', scrollDepth: 1.5 }],
		}),
	});
	assert.equal(invalid.status, 400);

	for (const destinationHost of ['https://news.example.com/story?secret=1', `${'a'.repeat(254)}.com`]) {
		const invalidHost = await nativeRequest(env, '/api/v1/engagement', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				events: [{ id: crypto.randomUUID(), itemId: 'item-1', type: 'outbound_link', destinationHost }],
			}),
		});
		assert.equal(invalidHost.status, 400);
	}
});
test('monitored topics normalize, reload, reject invalid writes without changes, and reset with history', async () => {
	const { db, env } = createFixture([
		{ id: 'item-1', feedKey: 'daily-feed', title: 'A useful story', receivedAt: '2026-09-15T11:00:00.000Z' },
	]);

	const initial = await nativeRequest(env, '/api/v1/personalization');
	assert.equal(initial.status, 200);
	assert.deepEqual((await initial.json() as { monitoredTopics: string[] }).monitoredTopics, []);

	const saved = await nativeRequest(env, '/api/v1/personalization', {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ monitoredTopics: ['  AI  ', 'ai', 'home   gyms'] }),
	});
	assert.equal(saved.status, 200);
	assert.deepEqual((await saved.json() as { monitoredTopics: string[] }).monitoredTopics, ['AI', 'home gyms']);

	for (const body of [
		JSON.stringify({ monitoredTopics: 'AI' }),
		JSON.stringify({ monitoredTopics: ['a'] }),
		JSON.stringify({ monitoredTopics: ['!!'] }),
		JSON.stringify({ monitoredTopics: Array.from({ length: 21 }, () => 'AI') }),
		'a'.repeat(17_000),
	]) {
		const invalid = await nativeRequest(env, '/api/v1/personalization', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body,
		});
		assert.equal(invalid.status, 400);
	}
	const afterInvalid = await nativeRequest(env, '/api/v1/personalization');
	assert.deepEqual((await afterInvalid.json() as { monitoredTopics: string[] }).monitoredTopics, ['AI', 'home gyms']);

	await nativeRequest(env, '/api/v1/engagement', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ events: [{ id: 'history-1', itemId: 'item-1', type: 'star' }] }),
	});
	const history = await nativeRequest(env, '/api/v1/personalization');
	const historyPayload = await history.json() as { history: Array<{ id: string }>; monitoredTopics: string[] };
	assert.equal(historyPayload.history.length, 1);
	const deletedEntry = await nativeRequest(
		env,
		`/api/v1/personalization?id=${encodeURIComponent(historyPayload.history[0].id)}`,
		{ method: 'DELETE' },
	);
	assert.equal(deletedEntry.status, 200);
	const afterEntryDelete = await nativeRequest(env, '/api/v1/personalization');
	assert.deepEqual((await afterEntryDelete.json() as { monitoredTopics: string[] }).monitoredTopics, ['AI', 'home gyms']);

	await nativeRequest(env, '/api/v1/engagement', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ events: [{ id: 'history-2', itemId: 'item-1', type: 'more_like_this' }] }),
	});
	const reset = await nativeRequest(env, '/api/v1/personalization?all=1', { method: 'DELETE' });
	assert.equal(reset.status, 200);
	assert.equal((db.prepare('SELECT COUNT(*) AS count FROM engagement_events').get() as { count: number }).count, 0);
	const afterReset = await nativeRequest(env, '/api/v1/personalization');
	const resetPayload = await afterReset.json() as { monitoredTopics: string[]; history: unknown[] };
	assert.deepEqual(resetPayload.monitoredTopics, []);
	assert.deepEqual(resetPayload.history, []);
});

test('topic preference transfers across publishers and beats a favorite source with an unrelated story', async () => {
	const now = Date.now();
	const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
	const { env } = createFixture([
		{
			id: 'liked-history',
			feedKey: 'liked-source',
			title: 'AI research breakthroughs',
			textContent: 'AI research helps engineers understand new systems.',
			receivedAt: minutesAgo(1_500),
			isRead: 1,
		},
		{
			id: 'favorite-history',
			feedKey: 'favorite-source',
			title: 'Restaurant opening guide',
			receivedAt: minutesAgo(1_500),
			isRead: 1,
		},
		{
			id: 'favorite-irrelevant',
			feedKey: 'favorite-source',
			title: 'Paid newsletter operations',
			receivedAt: minutesAgo(5),
		},
		{
			id: 'other-relevant',
			feedKey: 'quiet-source',
			title: 'Fresh AI chip benchmarks',
			textContent: 'New AI processor results and hardware measurements.',
			receivedAt: minutesAgo(10),
		},
		{
			id: 'unrelated-unseen',
			feedKey: 'new-source',
			title: 'Weekend gardening tools',
			receivedAt: minutesAgo(20),
		},
	]);
	const feedback = await nativeRequest(env, '/api/v1/engagement', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			events: [
				{ id: 'liked-ai', itemId: 'liked-history', type: 'star', occurredAt: minutesAgo(15) },
				{ id: 'favorite-source', itemId: 'favorite-history', type: 'star', occurredAt: minutesAgo(15) },
			],
		}),
	});
	assert.equal(feedback.status, 200);

	const response = await nativeRequest(env, '/api/v1/recommendations?view=for-you&limit=4');
	assert.equal(response.status, 200);
	const payload = await response.json() as {
		items: Array<{ id: string; explanation: string; matchedTopics: string[]; score: number; sampleCount: number; learningState: string }>;
	};
	assert.equal(payload.items[0].id, 'other-relevant');
	assert.ok(payload.items[0].matchedTopics.some((topic) => /AI/i.test(topic)));
	assert.match(payload.items[0].explanation, /AI|engaged/i);
	assert.ok(payload.items[0].score > (payload.items.find((item) => item.id === 'favorite-irrelevant')?.score ?? 0));
	const unrelated = payload.items.find((item) => item.id === 'unrelated-unseen');
	assert.equal(unrelated?.sampleCount, 0);
	assert.equal(unrelated?.learningState, 'Starting with recency');
});

test('saving a monitored phrase immediately changes ranking across sources and clearing it removes the boost', async () => {
	const { env } = createFixture([
		{
			id: 'fresh-unrelated',
			feedKey: 'favorite-source',
			title: 'Paid newsletter operations',
			receivedAt: '2026-09-15T11:00:00.000Z',
		},
		{
			id: 'older-monitored',
			feedKey: 'quiet-source',
			title: 'A guide to choosing a home gym',
			receivedAt: '2026-09-15T10:00:00.000Z',
		},
	]);
	const before = await nativeRequest(env, '/api/v1/recommendations?view=for-you&limit=2');
	assert.equal((await before.json() as { items: Array<{ id: string }> }).items[0].id, 'fresh-unrelated');

	const save = await nativeRequest(env, '/api/v1/personalization', {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ monitoredTopics: ['home gyms'] }),
	});
	assert.equal(save.status, 200);
	const afterSave = await nativeRequest(env, '/api/v1/recommendations?view=for-you&limit=2');
	const savedPayload = await afterSave.json() as { items: Array<{ id: string; matchedTopics: string[]; explanation: string }> };
	assert.equal(savedPayload.items[0].id, 'older-monitored');
	assert.deepEqual(savedPayload.items[0].matchedTopics, ['home gyms']);
	assert.match(savedPayload.items[0].explanation, /monitored/i);

	const clear = await nativeRequest(env, '/api/v1/personalization', {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ monitoredTopics: [] }),
	});
	assert.equal(clear.status, 200);
	const afterClear = await nativeRequest(env, '/api/v1/recommendations?view=for-you&limit=2');
	assert.equal((await afterClear.json() as { items: Array<{ id: string }> }).items[0].id, 'fresh-unrelated');
});

test('balanced candidate slices keep an older relevant feed from behind one prolific source', async () => {
	const dominant = Array.from({ length: 110 }, (_, index) => ({
		id: `dominant-${index}`,
		feedKey: 'dominant-source',
		title: `Routine update ${index}`,
		receivedAt: new Date(Date.parse('2026-09-15T11:00:00.000Z') - index * 60_000).toISOString(),
	}));
	const { env } = createFixture([
		...dominant,
		{
			id: 'quiet-old-topic',
			feedKey: 'quiet-source',
			title: 'A guide to choosing a home gym',
			receivedAt: '2026-09-14T10:00:00.000Z',
		},
	]);
	const save = await nativeRequest(env, '/api/v1/personalization', {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ monitoredTopics: ['home gyms'] }),
	});
	assert.equal(save.status, 200);
	const response = await nativeRequest(env, '/api/v1/recommendations?view=for-you&limit=1');
	const payload = await response.json() as { items: Array<{ id: string; matchedTopics: string[] }> };
	assert.equal(payload.items[0].id, 'quiet-old-topic');
	assert.deepEqual(payload.items[0].matchedTopics, ['home gyms']);
});

test('native engagement accepts Google Reader item IDs used by the iOS stream API', async () => {
	const { db, env } = createFixture([
		{
			id: 'item-1',
			feedKey: 'daily-feed',
			title: 'Daily story',
			receivedAt: '2026-08-09T11:00:00.000Z',
		},
	]);
	const row = db.prepare('SELECT rowid FROM items WHERE id = ?').get('item-1') as { rowid: number };
	const googleItemId = `tag:google.com,2005:reader/item/${row.rowid.toString(16).padStart(16, '0')}`;

	const accepted = await nativeRequest(env, '/api/v1/engagement', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-Pigeon-Client': 'pigeon-reader/1' },
		body: JSON.stringify({
			events: [
				{
					id: 'open-greader',
					itemId: googleItemId,
					type: 'explicit_open',
					occurredAt: '2026-08-09T12:00:00.000Z',
				},
			],
		}),
	});
	assert.equal(accepted.status, 200);
	assert.deepEqual(await accepted.json(), { accepted: 1, clientFamily: 'pigeon' });
	assert.equal(
		(db.prepare("SELECT item_id FROM engagement_events WHERE id = 'open-greader'").get() as { item_id: string }).item_id,
		'item-1',
	);

	const numeric = await nativeRequest(env, '/api/v1/engagement', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-Pigeon-Client': 'pigeon-reader/1' },
		body: JSON.stringify({
			events: [{ id: 'open-numeric', itemId: String(row.rowid), type: 'explicit_open' }],
		}),
	});
	assert.equal(numeric.status, 200);

	const missing = await nativeRequest(env, '/api/v1/engagement', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'X-Pigeon-Client': 'pigeon-reader/1' },
		body: JSON.stringify({
			events: [{ id: 'open-missing', itemId: 'tag:google.com,2005:reader/item/0000000000000099', type: 'explicit_open' }],
		}),
	});
	assert.equal(missing.status, 404);
	assert.deepEqual(await missing.json(), { error: 'Unknown item tag:google.com,2005:reader/item/0000000000000099' });
});

test('GReader state transitions record client family, bulk intent, and no duplicate sync events', async () => {
	const { db, env } = createFixture([
		{
			id: 'item-1',
			feedKey: 'daily-feed',
			title: 'Already interesting',
			receivedAt: '2026-08-09T11:00:00.000Z',
		},
		{
			id: 'item-2',
			feedKey: 'daily-feed',
			title: 'Unread story',
			receivedAt: '2026-08-09T10:00:00.000Z',
		},
	]);

	const readBody = new URLSearchParams({ i: '1', a: 'user/-/state/com.google/read' });
	assert.equal(
		(await greaderRequest(env, '/reader/api/0/edit-tag', readBody, 'NetNewsWire/6.0')).status,
		200,
	);
	assert.equal(
		(await greaderRequest(env, '/reader/api/0/edit-tag', new URLSearchParams(readBody), 'NetNewsWire/6.0')).status,
		200,
	);
	assert.equal(
		(
			await greaderRequest(
				env,
				'/reader/api/0/edit-tag',
				new URLSearchParams({ i: '1', r: 'user/-/state/com.google/read' }),
				'NetNewsWire/6.0',
			)
		).status,
		200,
	);
	assert.equal(
		(
			await greaderRequest(
				env,
				'/reader/api/0/edit-tag',
				new URLSearchParams(readBody),
				'NetNewsWire/6.0',
			)
		).status,
		200,
	);

	assert.equal(
		(await greaderRequest(
			env,
			'/reader/api/0/edit-tag',
			new URLSearchParams({ i: '1', a: 'user/-/state/com.google/starred' }),
			'ReederClassic/5.0',
		)).status,
		200,
	);

	const bulkBody = new URLSearchParams({ s: 'user/-/state/com.google/reading-list' });
	assert.equal(
		(await greaderRequest(env, '/reader/api/0/mark-all-as-read', bulkBody, 'ReederClassic/5.0')).status,
		200,
	);
	assert.equal(
		(
			await greaderRequest(
				env,
				'/reader/api/0/mark-all-as-read',
				new URLSearchParams(bulkBody),
				'ReederClassic/5.0',
			)
		).status,
		200,
	);

	const events = db
		.prepare(
			`SELECT event_type, client_family, COUNT(*) AS count
			   FROM engagement_events
			  GROUP BY event_type, client_family
			  ORDER BY event_type`,
		)
		.all() as Array<{ event_type: string; client_family: string; count: number }>;
	assert.deepEqual(events.map((event) => ({ ...event })), [
		{ event_type: 'bulk_mark_all_read', client_family: 'reeder_classic', count: 1 },
		{ event_type: 'read', client_family: 'netnewswire', count: 2 },
		{ event_type: 'star', client_family: 'reeder_classic', count: 1 },
		{ event_type: 'unread', client_family: 'netnewswire', count: 1 },
	]);
	assert.deepEqual(
		(db.prepare('SELECT id, is_read, is_starred FROM items ORDER BY id').all() as Array<{
			id: string;
			is_read: number;
			is_starred: number;
		}>).map((item) => ({ ...item })),
		[
			{ id: 'item-1', is_read: 1, is_starred: 1 },
			{ id: 'item-2', is_read: 1, is_starred: 0 },
		],
	);
});

test('large edit-tag synchronization succeeds when chunked engagement writes fail', async () => {
	const items = Array.from({ length: 120 }, (_, index) => ({
		id: `item-${index + 1}`,
		feedKey: 'daily-feed',
		title: `Story ${index + 1}`,
		receivedAt: '2026-08-09T11:00:00.000Z',
	}));
	const { db, database, env } = createFixture(items, { failEngagementWrites: true });
	const body = new URLSearchParams({ a: 'user/-/state/com.google/read' });
	for (let rowid = 1; rowid <= items.length; rowid += 1) {
		body.append('i', String(rowid));
	}

	const response = await greaderRequest(env, '/reader/api/0/edit-tag', body, 'NetNewsWire/6.0');

	assert.equal(response.status, 200);
	assert.equal((db.prepare('SELECT COUNT(*) AS count FROM items WHERE is_read = 1').get() as { count: number }).count, 120);
	assert.equal((db.prepare('SELECT COUNT(*) AS count FROM engagement_events').get() as { count: number }).count, 0);
	assert.ok(database.batchSizes.every((size) => size <= 50));
});

test('recommendations expose deterministic scores and plain-English feedback explanations', async () => {
	const { env } = createFixture([
		{
			id: 'item-good',
			feedKey: 'saved-feed',
			title: 'A source you like',
			receivedAt: '2026-08-09T11:00:00.000Z',
		},
		{
			id: 'item-bad',
			feedKey: 'noisy-feed',
			title: 'A source you skipped',
			receivedAt: '2026-08-09T11:00:00.000Z',
		},
		{
			id: 'item-related',
			feedKey: 'noisy-feed',
			title: 'Another story from that source',
			receivedAt: '2026-08-09T10:30:00.000Z',
		},
	]);

	const feedback = await nativeRequest(env, '/api/v1/engagement', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			events: [
				{ id: 'star-good', itemId: 'item-good', type: 'star' },
				{ id: 'reject-bad', itemId: 'item-bad', type: 'not_interested' },
			],
		}),
	});
	assert.equal(feedback.status, 200);

	const response = await nativeRequest(env, '/api/v1/recommendations?view=for-you&limit=3');
	assert.equal(response.status, 200);
	const payload = (await response.json()) as {
		view: string;
		items: Array<{
			id: string;
			score: number;
			confidence: number;
			sampleCount: number;
			explanation: string;
		}>;
	};
	assert.equal(payload.view, 'for-you');
	assert.equal(payload.items[0].id, 'item-good');
	assert.ok(payload.items.every((item) => item.score >= 0 && item.score <= 100));
	assert.equal(payload.items[0].sampleCount, 1);
	assert.match(payload.items[0].explanation, /starred/i);
	assert.equal(payload.items.some((item) => item.id === 'item-bad'), false);
	assert.match(payload.items.find((item) => item.id === 'item-related')?.explanation ?? '', /other stories from this source/i);

	const unreadResponse = await nativeRequest(env, '/api/v1/recommendations?view=unread&limit=3');
	const unreadPayload = (await unreadResponse.json()) as typeof payload;
	const rejectedStory = unreadPayload.items.find((item) => item.id === 'item-bad');
	assert.ok(rejectedStory);
	assert.match(rejectedStory.explanation, /this story/i);
});

test('active-reading heartbeats aggregate as capped duration and one confidence sample per item', async () => {
	async function rankedItem(events: Array<Record<string, unknown>>) {
		const { env } = createFixture([
			{
				id: 'item-1',
				feedKey: 'daily-feed',
				title: 'Long read',
				receivedAt: '2026-08-09T11:00:00.000Z',
			},
		]);
		const ingestion = await nativeRequest(env, '/api/v1/engagement', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ events }),
		});
		assert.equal(ingestion.status, 200);
		const response = await nativeRequest(env, '/api/v1/recommendations?view=unread&limit=1');
		const payload = (await response.json()) as { items: Array<{ score: number; confidence: number; sampleCount: number }> };
		return payload.items[0];
	}

	const heartbeats = Array.from({ length: 40 }, (_, index) => ({
		id: `heartbeat-${index}`,
		itemId: 'item-1',
		type: 'active_reading',
		durationSeconds: 15,
	}));
	const many = await rankedItem(heartbeats);
	const one = await rankedItem([{ id: 'duration-1', itemId: 'item-1', type: 'active_reading', durationSeconds: 300 }]);

	assert.equal(many.score, one.score);
	assert.equal(many.sampleCount, 1);
	assert.equal(many.confidence, one.confidence);
});

test('recommendations rank a candidate pool without loading ranking-pool article bodies', async () => {
	const items = Array.from({ length: 40 }, (_, index) => ({
		id: `item-${String(index).padStart(2, '0')}`,
		feedKey: index % 2 === 0 ? 'saved-feed' : 'other-feed',
		title: `Story ${index}`,
		receivedAt: new Date(Date.parse('2026-08-09T11:00:00.000Z') - index * 60_000).toISOString(),
	}));
	const { database, env } = createFixture(items);

	const warmup = await nativeRequest(env, '/api/v1/recommendations?view=for-you&limit=1');
	assert.equal(warmup.status, 200);
	database.clearExecutedSql();

	const response = await nativeRequest(env, '/api/v1/recommendations?view=for-you&limit=3');
	assert.equal(response.status, 200);
	const payload = (await response.json()) as { items: Array<{ id: string; html: string; text: string | null }> };
	assert.equal(payload.items.length, 3);
	assert.ok(payload.items.every((item) => item.html === '<p>Article body</p>'));
	assert.ok(payload.items.every((item) => item.text === 'Article body'));

	const itemSelects = database.executedSql.filter(
		(entry) => /\bFROM items\b/i.test(entry.sql) && /\bSELECT\b/i.test(entry.sql),
	);
	const candidateSelect = itemSelects.find((entry) => /LIMIT \?/i.test(entry.sql) && entry.sql.includes('i.subject AS title'));
	assert.ok(candidateSelect, 'expected a metadata-only ranking query');
	assert.equal(candidateSelect.sql.includes('html_content'), false);
	assert.equal(candidateSelect.sql.includes('text_content'), false);
	assert.deepEqual(candidateSelect.values, [100]);

	const bodySelects = itemSelects.filter(
		(entry) =>
			entry.sql.includes('html_content') &&
			/WHERE id IN/i.test(entry.sql) &&
			!entry.sql.includes('substr('),
	);
	assert.equal(bodySelects.length, 1);
	assert.equal(bodySelects[0].values.length, 3);
	assert.deepEqual(bodySelects[0].values, payload.items.map((item) => item.id));
	const boundedExcerptSelects = itemSelects.filter(
		(entry) => entry.sql.includes('substr(') && /WHERE id IN/i.test(entry.sql),
	);
	assert.equal(boundedExcerptSelects.length, 1);
	assert.match(boundedExcerptSelects[0].sql, /1, 32000/);

	const engagementSelects = database.executedSql.filter(
		(entry) => entry.sql.includes('FROM engagement_events') && entry.sql.includes('GROUP BY'),
	);
	assert.equal(engagementSelects.length, 1);
	assert.match(engagementSelects[0].sql, /feed_key IN \(/i);
	assert.ok(engagementSelects[0].values.every((value) => value === 'saved-feed' || value === 'other-feed'));
	assert.equal(new Set(engagementSelects[0].values).size, 2);
});

test('personalization history is transparent, individually deletable, exportable, and resettable', async () => {
	const { db, env } = createFixture([
		{ id: 'item-1', feedKey: 'daily-feed', title: 'A useful story', receivedAt: '2026-08-15T11:00:00.000Z' },
	]);
	const ingestion = await nativeRequest(env, '/api/v1/engagement', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			events: [{ id: 'preference-1', itemId: 'item-1', type: 'more_like_this', occurredAt: '2026-08-15T12:00:00.000Z' }],
		}),
	});
	assert.equal(ingestion.status, 200);

	const historyResponse = await nativeRequest(env, '/api/v1/personalization');
	assert.equal(historyResponse.status, 200);
	const history = (await historyResponse.json()) as {
		policy: { confirmationRule: string; retention: string; confirmedSignals: Array<{ name: string; effect: string }> };
		history: Array<{ id: string; type: string; title: string }>;
	};
	assert.match(history.policy.confirmationRule, /pending.*failed/i);
	assert.match(history.policy.retention, /delete.*reset/i);
	assert.ok(history.policy.confirmedSignals.some((signal) => signal.name === 'Bulk read actions' && signal.effect === 'Neutral'));
	assert.equal(history.history[0].type, 'more_like_this');
	assert.equal(history.history[0].title, 'A useful story');

	const exported = await nativeRequest(env, '/api/v1/personalization?download=1');
	assert.equal(exported.headers.get('Content-Disposition'), 'attachment; filename="pigeon-personalization.json"');
	assert.match(await exported.text(), /more_like_this/);

	const deleted = await nativeRequest(env, `/api/v1/personalization?id=${encodeURIComponent(history.history[0].id)}`, { method: 'DELETE' });
	assert.equal(deleted.status, 200);
	assert.equal((db.prepare('SELECT COUNT(*) AS count FROM engagement_events').get() as { count: number }).count, 0);

	await nativeRequest(env, '/api/v1/engagement', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ events: [{ id: 'preference-2', itemId: 'item-1', type: 'not_interested' }] }),
	});
	const reset = await nativeRequest(env, '/api/v1/personalization?all=1', { method: 'DELETE' });
	assert.equal(reset.status, 200);
	assert.equal((db.prepare('SELECT COUNT(*) AS count FROM engagement_events').get() as { count: number }).count, 0);
});

test('recommendations match monitored topics in bounded HTML when text content is absent', async () => {
	const { db, env } = createFixture([
		{
			id: 'rss-body',
			feedKey: 'rss-source',
			title: 'A general report',
			htmlContent: '<head><style>home gyms</style></head><!-- home gyms --><p>Deep notes about home gyms and progressive training.</p><script>home gyms</script>',
			textContent: null,
			receivedAt: '2026-09-18T11:00:00.000Z',
		},
		{
			id: 'fresh-unrelated',
			feedKey: 'other-source',
			title: 'Daily market report',
			htmlContent: '<p>Market news and business updates.</p>',
			receivedAt: '2026-09-19T11:00:00.000Z',
		},
	]);

	const save = await nativeRequest(env, '/api/v1/personalization', {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ monitoredTopics: ['home gyms'] }),
	});
	assert.equal(save.status, 200);

	const response = await nativeRequest(env, '/api/v1/recommendations?view=for-you&limit=2');
	assert.equal(response.status, 200);
	const payload = await response.json() as {
		items: Array<{ id: string; matchedTopics: string[]; explanation: string }>;
	};
	assert.equal(payload.items[0]?.id, 'rss-body');
	assert.deepEqual(payload.items[0]?.matchedTopics, ['home gyms']);
	assert.match(payload.items[0]?.explanation ?? '', /monitored topic/i);
	assert.equal(
		(db.prepare("SELECT text_content FROM items WHERE id = 'rss-body'").get() as { text_content: string | null }).text_content,
		null,
	);
});
