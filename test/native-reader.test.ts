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
	isRead?: number;
	isStarred?: number;
}

class SqliteD1Statement {
	private values: unknown[] = [];

	constructor(
		private readonly db: DatabaseSync,
		private readonly sql: string,
	) {}

	bind(...values: unknown[]): this {
		this.values = values;
		return this;
	}

	async all<T>(): Promise<{ results: T[] }> {
		return { results: this.db.prepare(this.sql).all(...this.values) as T[] };
	}

	async first<T>(): Promise<T | null> {
		return (this.db.prepare(this.sql).get(...this.values) as T | undefined) ?? null;
	}

	async run(): Promise<void> {
		this.db.prepare(this.sql).run(...this.values);
	}

	isEngagementInsert(): boolean {
		return this.sql.startsWith('INSERT OR IGNORE INTO engagement_events');
	}
}

class SqliteD1Database {
	readonly batchSizes: number[] = [];

	constructor(
		private readonly db: DatabaseSync,
		private readonly failEngagementWrites = false,
	) {}

	prepare(sql: string): SqliteD1Statement {
		return new SqliteD1Statement(this.db, sql);
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
		) VALUES (?, ?, ?, '<p>Article body</p>', 'Article body', ?, ?, ?, ?)`,
	);
	for (const item of items) {
		insertItem.run(
			item.id,
			item.feedKey,
			item.title,
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
		'8',
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
