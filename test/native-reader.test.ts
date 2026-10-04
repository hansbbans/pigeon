import * as assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { generateApiToken } from '../src/api-auth';
import { handleGreaderRequest } from '../src/greader';
import { ensureDatabaseSchema } from '../src/migrations';
import { handleNativeApiRequest } from '../src/native-api';
import { handleRecommendations, RecommendationSessions } from '../src/recommendations';
import { buildRssItemStatements } from '../src/rss-fetcher';
import app from '../src/index';

const PASSWORD = 'secret-password';
const BASE_URL = 'https://pigeon.example';

function minutesAgo(minutes: number): string {
	return new Date(Date.now() - minutes * 60_000).toISOString();
}

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

function createFixture(items: FixtureItem[], options: {
	failEngagementWrites?: boolean;
	failRecommendationRequests?: boolean;
} = {}) {
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
	const recommendationLog = {
		calls: 0,
		names: [] as string[],
		urls: [] as string[],
		authorization: [] as (string | null)[],
		cookies: [] as (string | null)[],
	};
	const recommendationStub = {
		fetch: async (request: Request): Promise<Response> => {
			recommendationLog.calls += 1;
			recommendationLog.urls.push(request.url);
			recommendationLog.authorization.push(request.headers.get('authorization'));
			recommendationLog.cookies.push(request.headers.get('cookie'));
			if (options.failRecommendationRequests) {
				throw new Error('simulated recommendation service failure');
			}
			await ensureDatabaseSchema(env as never);
			return handleRecommendations(request, env as never);
		},
	};
	(env as { RECOMMENDATIONS: { getByName(name: string): typeof recommendationStub } }).RECOMMENDATIONS = {
		getByName(name: string) {
			recommendationLog.names.push(name);
			return recommendationStub;
		},
	};
	return { db, database, env: env as never, recommendationLog };
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

test('RSS imports store bylines in the author field consumed by reader APIs', async () => {
	const state = createFixture([{ id: 'seed-author', feedKey: 'author-feed', title: 'Seed', receivedAt: '2026-10-02T12:00:00.000Z' }]);
	try {
		await ensureDatabaseSchema(state.env);
		state.db.prepare("UPDATE feeds SET source_type = 'rss' WHERE feed_key = 'author-feed'").run();
		const statements = await buildRssItemStatements(state.database as never, 'author-feed',
			{ sourceUrl: 'https://example.com/feed.xml' },
			[{ guid: 'new-author-item', title: 'Bylined story', author: 'Alice Writer', content: '<p>Body</p>', attachments: [] }],
			'2026-10-02T12:00:00.000Z');
		await state.database.batch(statements as unknown as SqliteD1Statement[]);
		assert.equal((state.db.prepare("SELECT from_name FROM items WHERE subject = 'Bylined story'").get() as { from_name: string | null }).from_name, 'Alice Writer');
		state.db.prepare("UPDATE items SET from_email = 'Old author', is_read = 1, is_starred = 1 WHERE subject = 'Bylined story'").run();
		const refreshStatements = await buildRssItemStatements(state.database as never, 'author-feed',
			{ sourceUrl: 'https://example.com/feed.xml' },
			[{ guid: 'new-author-item', title: 'Bylined story', content: '<p>Revised body</p>', attachments: [] }],
			'2026-10-02T12:00:00.000Z', { updateExisting: true });
		await state.database.batch(refreshStatements as unknown as SqliteD1Statement[]);
		const updated = state.db.prepare("SELECT from_name, from_email, is_read, is_starred FROM items WHERE subject = 'Bylined story'").get();
		assert.deepEqual({ ...updated }, { from_name: null, from_email: null, is_read: 1, is_starred: 1 });
	} finally { state.db.close(); }
});

test('legacy RSS bylines remain visible across Atom, GReader, recommendations, and sync without using email sender addresses', async () => {
	const state = createFixture([
		{ id: 'legacy-author', feedKey: 'rss-author', title: 'RSS byline', receivedAt: '2026-10-02T12:00:00.000Z' },
		{ id: 'email-no-author', feedKey: 'email-author', title: 'Email without name', receivedAt: '2026-10-02T12:00:00.000Z' },
	]);
	try {
		state.db.prepare("UPDATE feeds SET source_type = 'rss' WHERE feed_key = 'rss-author'").run();
		state.db.prepare("UPDATE items SET from_email = 'Alice Writer' WHERE id = 'legacy-author'").run();
		state.db.prepare("UPDATE items SET from_email = 'news@example.com' WHERE id = 'email-no-author'").run();
		await ensureDatabaseSchema(state.env);
		const recommendations = await nativeRequest(state.env, '/api/v1/recommendations?view=unread');
		const recommendationItems = (await recommendations.json() as { items: { id: string; author: string | null }[] }).items;
		const contents = await greaderRequest(state.env, '/reader/api/0/stream/items/contents', new URLSearchParams([['i', '1'], ['i', '2']]), 'pigeon');
		const readerItems = (await contents.json() as { items: { author: string }[] }).items;
		const synced = await nativeRequest(state.env, '/api/v1/sync?limit=200');
		const articleChanges = (await synced.json() as { changes: { entityType: string; entityId: string; payload: { author?: string | null } }[] }).changes
			.filter((change) => change.entityType === 'article');
		const atom = await app.fetch(new Request(`${BASE_URL}/feed/rss-author`), state.env);
		assert.deepEqual({
			recommendationRss: recommendationItems.find((item) => item.id === 'legacy-author')?.author,
			recommendationEmail: recommendationItems.find((item) => item.id === 'email-no-author')?.author,
			readerRss: readerItems[0].author,
			readerEmail: readerItems[1].author,
			syncRss: articleChanges.find((change) => change.entityId === 'legacy-author')?.payload.author,
			syncEmail: articleChanges.find((change) => change.entityId === 'email-no-author')?.payload.author,
			atomByline: (await atom.text()).includes('<name>Alice Writer</name>'),
		}, {
			recommendationRss: 'Alice Writer', recommendationEmail: null,
			readerRss: 'Alice Writer', readerEmail: '',
			syncRss: 'Alice Writer', syncEmail: null, atomByline: true,
		});
	} finally { state.db.close(); }
});

test('recommendations authenticate before the Durable Object proxy and preserve the original query', async () => {
	const { env, recommendationLog } = createFixture([
		{
			id: 'item-1',
			feedKey: 'daily-feed',
			title: 'Daily story',
			receivedAt: '2026-08-09T11:00:00.000Z',
		},
	]);

	const unauthorized = await handleNativeApiRequest(
		new Request(`${BASE_URL}/api/v1/recommendations?view=unread&limit=1`),
		env,
	);
	assert.equal(unauthorized.status, 401);
	assert.equal(recommendationLog.calls, 0);

	const wrongMethod = await nativeRequest(env, '/api/v1/recommendations?view=unread&limit=1', { method: 'POST' });
	assert.equal(wrongMethod.status, 404);
	assert.equal(recommendationLog.calls, 0);

	const wrongPath = await nativeRequest(env, '/api/v1/recommendations/extra?view=unread&limit=1');
	assert.equal(wrongPath.status, 404);
	assert.equal(recommendationLog.calls, 0);

	const forwarded = await nativeRequest(env, '/api/v1/recommendations?view=unread&limit=1', {
		headers: { Cookie: 'session=caller-only' },
	});
	assert.equal(forwarded.status, 200);
	assert.equal(recommendationLog.calls, 1);
	assert.deepEqual(recommendationLog.names, ['default']);
	assert.equal(recommendationLog.urls[0], `${BASE_URL}/api/v1/recommendations?view=unread&limit=1`);
	assert.deepEqual(recommendationLog.authorization, [null]);
	assert.deepEqual(recommendationLog.cookies, [null]);
});

test('recommendation proxy fails closed when the helper Durable Object is unavailable', async () => {
	const failed = createFixture(
		[
			{
				id: 'item-1',
				feedKey: 'daily-feed',
				title: 'Daily story',
				receivedAt: '2026-08-09T11:00:00.000Z',
			},
		],
		{ failRecommendationRequests: true },
	);
	const helperFailure = await nativeRequest(failed.env, '/api/v1/recommendations?limit=1');
	assert.equal(helperFailure.status, 503);

	const missingBinding = createFixture([
		{
			id: 'item-2',
			feedKey: 'daily-feed',
			title: 'Another story',
			receivedAt: '2026-08-09T11:00:00.000Z',
		},
	]);
	delete (missingBinding.env as { RECOMMENDATIONS?: unknown }).RECOMMENDATIONS;
	const missing = await nativeRequest(missingBinding.env, '/api/v1/recommendations?limit=1');
	assert.equal(missing.status, 503);
});

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
	assert.equal(unrelated, undefined, 'weak unseen stories are not exploration filler');
});

test('saving a monitored phrase immediately changes ranking across sources and clearing it removes the boost', async () => {
	const { env } = createFixture([
		{
			id: 'fresh-unrelated',
			feedKey: 'favorite-source',
			title: 'Paid newsletter operations',
			receivedAt: minutesAgo(5),
		},
		{
			id: 'older-monitored',
			feedKey: 'quiet-source',
			title: 'A guide to choosing a home gym',
			receivedAt: minutesAgo(60),
		},
	]);
	const before = await nativeRequest(env, '/api/v1/recommendations?view=for-you&limit=2');
	assert.deepEqual((await before.json() as { items: Array<{ id: string }> }).items, []);

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
	assert.deepEqual((await afterClear.json() as { items: Array<{ id: string }> }).items, []);
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
			receivedAt: minutesAgo(5),
		},
		{
			id: 'item-bad',
			feedKey: 'noisy-feed',
			title: 'A source you skipped',
			receivedAt: minutesAgo(5),
		},
		{
			id: 'item-related',
			feedKey: 'noisy-feed',
			title: 'Another story from that source',
			receivedAt: minutesAgo(35),
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
	assert.equal(payload.items.some((item) => item.id === 'item-related'), false, 'weak source feedback must not fill the list');

	const unreadResponse = await nativeRequest(env, '/api/v1/recommendations?view=unread&limit=3');
	const unreadPayload = (await unreadResponse.json()) as typeof payload;
	const rejectedStory = unreadPayload.items.find((item) => item.id === 'item-bad');
	assert.ok(rejectedStory);
	assert.match(rejectedStory.explanation, /this story/i);
});

test('For You uses a strict score cutoff with no cold-start, exploration, or page filler', async () => {
	for (const qualifyingCount of [0, 4]) {
		const receivedAt = new Date(Date.now() + 60_000).toISOString();
		const { env, database } = createFixture([
			...Array.from({ length: qualifyingCount }, (_, index) => ({
				id: `strong-${index}`, feedKey: 'strong', title: `Saved story ${index}`, receivedAt, isStarred: 1,
			})),
			...Array.from({ length: 35 }, (_, index) => ({
				id: `weak-${index}`, feedKey: 'unseen', title: `Exploration ${index}`, receivedAt,
			})),
			{ id: 'already-read', feedKey: 'strong', title: 'Read saved story', receivedAt, isStarred: 1, isRead: 1 },
		]);
		const response = await nativeRequest(env, '/api/v1/recommendations?view=for-you');
		const body = await response.json() as { items: { id: string; score: number }[]; totalCount: number; continuation: string | null };
		assert.equal(body.items.length, qualifyingCount);
		assert.equal(body.totalCount, qualifyingCount);
		assert.equal(body.continuation, null);
		assert.ok(body.items.every((item) => item.score > 50 && item.id.startsWith('strong-')));
		if (qualifyingCount === 0) {
			assert.equal(database.executedSql.some((query) => /SELECT id, html_content, text_content|i\.html_content, i\.text_content/.test(query.sql)), false);
		}
		const unread = await nativeRequest(env, '/api/v1/recommendations?view=unread&limit=50');
		const unreadItems = (await unread.json() as typeof body).items;
		assert.equal(unreadItems.filter((item) => item.score === 50).length, 35, 'score 50 is excluded only from For You');
		const starred = await nativeRequest(env, '/api/v1/recommendations?view=starred');
		assert.equal((await starred.json() as typeof body).items.length, qualifyingCount + 1, 'starred retains read stories');
	}
});

test('For You includes a score of 51 and excludes an exact score of 50', async () => {
	const receivedAt = new Date(Date.now() + 60_000).toISOString();
	const { env } = createFixture([
		{ id: 'score-51', feedKey: 'source', title: 'Opened story', receivedAt },
		{ id: 'score-50', feedKey: 'source', title: 'Fresh story', receivedAt },
	]);
	await nativeRequest(env, '/api/v1/engagement', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ events: [{ id: 'open-boundary', itemId: 'score-51', type: 'explicit_open' }] }),
	});
	const response = await nativeRequest(env, '/api/v1/recommendations?view=for-you');
	const body = await response.json() as { items: { id: string; score: number }[] };
	assert.deepEqual(body.items.map(({ id, score }) => ({ id, score })), [{ id: 'score-51', score: 51 }]);
});

test('For You returns every qualifying story across bounded full-body pages, including past 30 and 50', async () => {
	const { env, database } = createFixture(Array.from({ length: 73 }, (_, index) => ({
		id: `strong-${String(index).padStart(3, '0')}`, feedKey: 'saved', title: `Saved story ${index}`,
		receivedAt: minutesAgo(index), isStarred: 1,
	})));
	for (const pageLimit of [undefined, 30]) {
		const ids: string[] = [];
		let continuation: string | null = null;
		let generatedAt: string | undefined;
		do {
			const params = new URLSearchParams({ view: 'for-you' });
			if (pageLimit) params.set('limit', String(pageLimit));
			if (continuation) params.set('continuation', continuation);
			const response = await nativeRequest(env, `/api/v1/recommendations?${params}`);
			const page = await response.json() as { generatedAt: string; items: { id: string; score: number; html: string }[]; totalCount: number; continuation: string | null };
			assert.equal(page.totalCount, 73);
			assert.ok(page.items.length <= (pageLimit ?? 50));
			assert.ok(page.items.every((item) => item.score > 50 && item.html === '<p>Article body</p>'));
			generatedAt ??= page.generatedAt;
			assert.equal(page.generatedAt, generatedAt, 'all pages share the scoring timestamp');
			ids.push(...page.items.map((item) => item.id));
			continuation = page.continuation;
		} while (continuation);
		assert.equal(ids.length, 73);
		assert.equal(new Set(ids).size, 73);
	}
	const bodyQueries = database.executedSql.filter((query) => /SELECT id, html_content, text_content|i\.html_content, i\.text_content/.test(query.sql));
	assert.ok(bodyQueries.length > 0);
	assert.ok(bodyQueries.every((query) => query.sql.includes('FROM json_each(?) snapshot_item')
		? Number(query.values[1]) <= 50 && query.sql.includes('LIMIT ?')
		: query.values.length <= 50));
	for (const cursor of ['bad', 'v1:0:2026-10-04T12:00:00Z', 'v1:1101:2026-10-04T12:00:00Z', 'v1:1:no-date']) {
		const response = await nativeRequest(env, `/api/v1/recommendations?continuation=${encodeURIComponent(cursor)}`);
		assert.equal(response.status, 400);
	}
});

test('For You qualifies dotted AI headlines and preferences while excluding ordinary initials', async () => {
	const { env } = createFixture([
		{ id: 'dotted-ai', feedKey: 'dotted', title: 'A.I. reshapes healthcare', receivedAt: minutesAgo(1) },
		{ id: 'plain-ai', feedKey: 'plain', title: 'Artificial intelligence reshapes healthcare', receivedAt: minutesAgo(1) },
		{ id: 'initials', feedKey: 'initials', title: 'A. I. Smith discusses healthcare', receivedAt: minutesAgo(1) },
		{ id: 'email-plus', feedKey: 'email-plus', title: 'Contact a.i+garden@example.com about plumbing', receivedAt: minutesAgo(1) },
		{ id: 'email-hyphen', feedKey: 'email-hyphen', title: 'Contact a.i-garden@example.com about plumbing', receivedAt: minutesAgo(1) },
	]);
	for (const topic of ['AI', 'A.I.']) {
		const save = await nativeRequest(env, '/api/v1/personalization', {
			method: 'PUT', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ monitoredTopics: [topic] }),
		});
		assert.equal(save.status, 200);
		const response = await nativeRequest(env, '/api/v1/recommendations');
		const page = await response.json() as { items: { id: string; score: number; matchedTopics: string[] }[] };
		assert.deepEqual(page.items.map((item) => item.id).sort(), ['dotted-ai', 'plain-ai']);
		assert.ok(page.items.every((item) => item.score > 50 && item.matchedTopics.includes(topic)));
	}
});

test('For You continuation does not skip unseen stories when an earlier result becomes read', async () => {
	const { env, db } = createFixture(Array.from({ length: 6 }, (_, index) => ({
		id: `stable-${index}`, feedKey: 'saved', title: `Saved story ${index}`,
		receivedAt: minutesAgo(index), isStarred: 1,
	})));
	const first = await nativeRequest(env, '/api/v1/recommendations?view=for-you&limit=2');
	const page = await first.json() as { items: { id: string }[]; continuation: string };
	assert.deepEqual(page.items.map((item) => item.id), ['stable-0', 'stable-1']);
	db.prepare('UPDATE items SET is_read = 1 WHERE id = ?').run('stable-0');
	const second = await nativeRequest(env, `/api/v1/recommendations?view=for-you&limit=2&continuation=${encodeURIComponent(page.continuation)}`);
	const next = await second.json() as { items: { id: string }[] };
	assert.deepEqual(next.items.map((item) => item.id), ['stable-2', 'stable-3']);
});

test('For You snapshots keep unseen story order through additions, score changes, and removals', async () => {
	const { env, db } = createFixture(Array.from({ length: 10 }, (_, index) => ({
		id: `snapshot-${index}`, feedKey: `publisher-${index}`, title: `Saved story ${index}`,
		receivedAt: minutesAgo(index), isStarred: 1,
	})));
	const first = await nativeRequest(env, '/api/v1/recommendations?limit=2');
	const page = await first.json() as { items: { id: string; score: number }[]; continuation: string };
	assert.deepEqual(page.items.map((item) => item.id), ['snapshot-0', 'snapshot-1']);
	const originalScore = page.items[0].score;
	db.prepare("INSERT INTO items (id, feed_key, subject, html_content, received_at, is_starred) VALUES ('new-arrival', 'publisher-0', 'Fresh story', '<p>New</p>', ?, 1)").run(new Date(Date.now() + 60_000).toISOString());
	db.prepare("UPDATE items SET is_starred = 0 WHERE id = 'snapshot-2'").run();
	db.prepare("UPDATE items SET is_read = 1 WHERE id = 'snapshot-3'").run();
	db.prepare("DELETE FROM items WHERE id = 'snapshot-4'").run();
	db.prepare("UPDATE feeds SET is_active = 0 WHERE feed_key = 'publisher-5'").run();
	await nativeRequest(env, '/api/v1/engagement', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ events: [{ id: 'exclude-snapshot', itemId: 'snapshot-6', type: 'not_interested' }, { id: 'promote-snapshot', itemId: 'snapshot-9', type: 'more_like_this' }] }),
	});
	const nextResponse = await nativeRequest(env, `/api/v1/recommendations?limit=2&continuation=${encodeURIComponent(page.continuation)}`);
	const next = await nextResponse.json() as { items: { id: string; isStarred: boolean; score: number }[]; continuation: string };
	assert.deepEqual(next.items.map((item) => item.id), ['snapshot-2', 'snapshot-7']);
	assert.equal(next.items[0].isStarred, false, 'metadata follows current star state');
	assert.ok(next.items.every((item) => item.score === originalScore), 'scores retain the original snapshot');
	const lastResponse = await nativeRequest(env, `/api/v1/recommendations?limit=2&continuation=${encodeURIComponent(next.continuation)}`);
	const last = await lastResponse.json() as { items: { id: string }[]; continuation: string | null };
	assert.deepEqual(last.items.map((item) => item.id), ['snapshot-8', 'snapshot-9']);
	assert.equal(last.continuation, null);
	const refreshedResponse = await nativeRequest(env, '/api/v1/recommendations?limit=50');
	const refreshed = await refreshedResponse.json() as { items: { id: string }[] };
	assert.equal(refreshed.items[0].id, 'snapshot-9', 'fresh requests apply new feedback');
	assert.ok(refreshed.items.some((item) => item.id === 'new-arrival'), 'new arrivals participate in fresh loads');
	assert.ok(!refreshed.items.some((item) => item.id === 'snapshot-2'), 'fresh requests apply lost relevance');
});

test('For You continuation terminates cleanly when every remaining story becomes ineligible', async () => {
	const { env, db } = createFixture(Array.from({ length: 4 }, (_, index) => ({
		id: `removed-${index}`, feedKey: 'saved', title: `Saved ${index}`, receivedAt: minutesAgo(index), isStarred: 1,
	})));
	const first = await nativeRequest(env, '/api/v1/recommendations?limit=2');
	const page = await first.json() as { continuation: string };
	db.prepare("UPDATE items SET is_read = 1").run();
	const response = await nativeRequest(env, `/api/v1/recommendations?continuation=${encodeURIComponent(page.continuation)}`);
	assert.equal(response.status, 200);
	const next = await response.json() as { items: unknown[]; continuation: string | null; totalCount: number };
	assert.deepEqual(next.items, []);
	assert.equal(next.continuation, null);
	assert.equal(next.totalCount, 0);
});

test('For You fills the continuation when page candidates become ineligible between database reads', async () => {
	const { env, db, database } = createFixture(Array.from({ length: 105 }, (_, index) => ({
		id: `race-${String(index).padStart(3, '0')}`, feedKey: `source-${index}`, title: `Saved ${index}`,
		receivedAt: minutesAgo(index), isStarred: 1,
	})));
	const first = await nativeRequest(env, '/api/v1/recommendations?limit=2');
	const page = await first.json() as { continuation: string };
	const prepare = database.prepare.bind(database);
	let changed = false;
	database.prepare = (sql) => {
		const statement = prepare(sql);
		if (sql.startsWith('SELECT i.id FROM items')) {
			const all = statement.all.bind(statement);
			statement.all = async <T>() => {
				const result = await all<T>();
				if (!changed) {
					changed = true;
					db.prepare("UPDATE items SET is_read = 1 WHERE id >= 'race-002' AND id <= 'race-101'").run();
				}
				return result;
			};
		}
		return statement;
	};
	const second = await nativeRequest(env, `/api/v1/recommendations?limit=2&continuation=${encodeURIComponent(page.continuation)}`);
	const next = await second.json() as { items: { id: string; isRead: boolean }[]; continuation: string | null };
	assert.deepEqual(next.items.map((item) => item.id), ['race-102', 'race-103']);
	assert.ok(next.items.every((item) => !item.isRead));
	assert.ok(next.continuation);
});

test('For You reads current bodies and eligibility atomically when stories are deleted before the body read', async () => {
	for (const continuationRequest of [false, true]) {
		const { env, db, database } = createFixture(Array.from({ length: 6 }, (_, index) => ({
			id: `atomic-${index}`, feedKey: 'saved', title: `Saved ${index}`, receivedAt: minutesAgo(index), isStarred: 1,
		})));
		await ensureDatabaseSchema(env);
		let continuation: string | undefined;
		if (continuationRequest) {
			const first = await nativeRequest(env, '/api/v1/recommendations?limit=2');
			continuation = (await first.json() as { continuation: string }).continuation;
		}
		const prepare = database.prepare.bind(database);
		let deleted = false;
		database.prepare = (sql) => {
			const statement = prepare(sql);
			if (sql.startsWith('SELECT id, html_content, text_content') || sql.includes('FROM json_each(?) snapshot_item')) {
				const all = statement.all.bind(statement);
				statement.all = async <T>() => {
					if (!deleted) {
						deleted = true;
						const start = continuationRequest ? 2 : 0;
						db.prepare('DELETE FROM items WHERE id IN (?, ?)').run(`atomic-${start}`, `atomic-${start + 1}`);
					}
					return all<T>();
				};
			}
			return statement;
		};
		const params = new URLSearchParams({ limit: '2' });
		if (continuation) params.set('continuation', continuation);
		const response = await nativeRequest(env, `/api/v1/recommendations?${params}`);
		const page = await response.json() as { items: { id: string; html: string }[]; continuation: string | null };
		assert.deepEqual(page.items.map((item) => item.id), continuationRequest ? ['atomic-4', 'atomic-5'] : ['atomic-2', 'atomic-3']);
		assert.ok(page.items.every((item) => item.html === '<p>Article body</p>'));
		assert.equal(page.continuation === null, continuationRequest);
	}
});

test('For You continuation sees unread undo performed between its count and atomic page read', async () => {
	const { env, db, database } = createFixture(Array.from({ length: 6 }, (_, index) => ({
		id: `undo-${index}`, feedKey: 'saved', title: `Saved ${index}`, receivedAt: minutesAgo(index), isStarred: 1,
	})));
	const first = await nativeRequest(env, '/api/v1/recommendations?limit=2');
	const firstPage = await first.json() as { continuation: string };
	db.prepare("UPDATE items SET is_read = 1 WHERE id IN ('undo-4', 'undo-5')").run();
	const prepare = database.prepare.bind(database);
	let undone = false;
	database.prepare = (sql) => {
		const statement = prepare(sql);
		if (sql.includes('FROM json_each(?) snapshot_item')) {
			const all = statement.all.bind(statement);
			statement.all = async <T>() => {
				if (!undone) { undone = true; db.prepare("UPDATE items SET is_read = 0 WHERE id IN ('undo-4', 'undo-5')").run(); }
				return all<T>();
			};
		}
		return statement;
	};
	const second = await nativeRequest(env, `/api/v1/recommendations?limit=2&continuation=${encodeURIComponent(firstPage.continuation)}`);
	const secondPage = await second.json() as { items: { id: string }[]; continuation: string };
	assert.deepEqual(secondPage.items.map((item) => item.id), ['undo-2', 'undo-3']);
	assert.ok(secondPage.continuation, 'newly unread tail membership participates in the atomic continuation decision');
	const last = await nativeRequest(env, `/api/v1/recommendations?limit=2&continuation=${encodeURIComponent(secondPage.continuation)}`);
	const lastPage = await last.json() as { items: { id: string }[]; continuation: string | null };
	assert.deepEqual(lastPage.items.map((item) => item.id), ['undo-4', 'undo-5']);
	assert.equal(lastPage.continuation, null);
});

test('recommendation and GReader bodies expose true and false server-pruned metadata without removing the notice', async () => {
	const { env, db } = createFixture([
		{ id: 'pruned-ai', feedKey: 'pruned', title: 'AI research', receivedAt: '2025-01-01T12:00:00.000Z', isStarred: 1 },
		{ id: 'full-ai', feedKey: 'complete', title: 'AI healthcare', receivedAt: minutesAgo(1), isStarred: 1 },
	]);
	await nativeRequest(env, '/api/v1/personalization', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ monitoredTopics: ['AI'] }) });
	const notice = '<p>This older read article is no longer stored offline.</p>';
	db.prepare("UPDATE items SET html_content = ?, text_content = NULL, content_pruned_at = '2026-10-04T12:00:00.000Z' WHERE id = 'pruned-ai'").run(notice);
	const first = await nativeRequest(env, '/api/v1/recommendations?limit=1');
	const page = await first.json() as { items: { id: string; readerId: string; isBodyPruned: boolean }[]; continuation: string };
	assert.equal(page.items[0].id, 'full-ai');
	assert.equal(page.items[0].isBodyPruned, false);
	const second = await nativeRequest(env, `/api/v1/recommendations?limit=1&continuation=${encodeURIComponent(page.continuation)}`);
	const prunedPage = await second.json() as { items: { id: string; readerId: string; isBodyPruned: boolean; html: string }[] };
	assert.equal(prunedPage.items[0].id, 'pruned-ai');
	assert.equal(prunedPage.items[0].isBodyPruned, true);
	assert.equal(prunedPage.items[0].html, notice);
	for (const view of ['for-you', 'unread', 'starred']) {
		const response = await nativeRequest(env, `/api/v1/recommendations?view=${view}`);
		const body = await response.json() as typeof prunedPage;
		assert.equal(body.items.find((item) => item.id === 'pruned-ai')?.isBodyPruned, true, view);
		assert.equal(body.items.find((item) => item.id === 'full-ai')?.isBodyPruned, false, view);
	}
	const bodyRequest = new URLSearchParams();
	for (const item of [...page.items, ...prunedPage.items]) bodyRequest.append('i', item.readerId);
	const reader = await greaderRequest(env, '/reader/api/0/stream/items/contents', bodyRequest, 'Pigeon');
	const items = (await reader.json() as { items: { id: string; isBodyPruned: boolean; content: { content: string } }[] }).items;
	assert.equal(items.find((item) => item.id === page.items[0].readerId)?.isBodyPruned, false);
	assert.equal(items.find((item) => item.id === prunedPage.items[0].readerId)?.isBodyPruned, true);
	assert.equal(items.find((item) => item.id === prunedPage.items[0].readerId)?.content.content, notice);
});

test('For You bounds JSON membership and total body rows while refilling after adversarial removals', async () => {
	const items = Array.from({ length: 140 }, (_, index) => ({
		id: `long-${String(index).padStart(3, '0')}-${'x'.repeat(7_991)}`,
		feedKey: `${index < 100 ? 'b-recent' : 'a-quiet'}-${String(index).padStart(3, '0')}`,
		title: `Saved ${index}`, receivedAt: minutesAgo(index), isStarred: 1,
	}));
	const { env, db, database } = createFixture(items);
	await ensureDatabaseSchema(env);
	database.clearExecutedSql();
	const prepare = database.prepare.bind(database);
	const bodyRows: number[] = [];
	const bodyParameterBytes: number[] = [];
	let removed = false;
	database.prepare = (sql) => {
		const statement = prepare(sql);
		if (sql.includes('FROM json_each(?) snapshot_item')) {
			const bind = statement.bind.bind(statement);
			statement.bind = (...values) => {
				bodyParameterBytes.push(new TextEncoder().encode(values[0] as string).byteLength);
				return bind(...values);
			};
			const all = statement.all.bind(statement);
			statement.all = async <T>() => {
				if (!removed) {
					removed = true;
					const markRead = db.prepare('UPDATE items SET is_read = 1 WHERE id = ?');
					for (const item of items.slice(49, 112)) markRead.run(item.id);
				}
				const result = await all<T>();
				bodyRows.push(result.results.length);
				return result;
			};
		}
		return statement;
	};
	const first = await nativeRequest(env, '/api/v1/recommendations?limit=50');
	const firstPage = await first.json() as { items: { id: string; html: string }[]; continuation: string };
	assert.equal(first.status, 200);
	assert.deepEqual(firstPage.items.map((item) => item.id), [...items.slice(0, 49), items[112]].map((item) => item.id));
	assert.deepEqual(bodyRows, [49, 1], 'the whole request reads fifty full bodies, even across membership chunks');
	assert.ok(bodyParameterBytes.every((bytes) => bytes <= 900_000));
	assert.ok(database.executedSql.length <= 50);
	bodyRows.length = 0;
	database.clearExecutedSql();
	const last = await nativeRequest(env, `/api/v1/recommendations?limit=50&continuation=${encodeURIComponent(firstPage.continuation)}`);
	const lastPage = await last.json() as { items: { id: string; html: string }[]; continuation: string | null };
	assert.deepEqual(lastPage.items.map((item) => item.id), items.slice(113).map((item) => item.id));
	assert.ok(lastPage.items.every((item) => item.html === '<p>Article body</p>'));
	assert.equal(lastPage.continuation, null);
	assert.equal(bodyRows.reduce((sum, count) => sum + count, 0), 27);
	assert.ok(database.executedSql.length <= 50);
});

test('For You snapshot expiry, restart, and legacy cursors report a recoverable 410', async () => {
	const { env } = createFixture(Array.from({ length: 4 }, (_, index) => ({
		id: `expired-${index}`, feedKey: 'saved', title: `Saved ${index}`, receivedAt: minutesAgo(index), isStarred: 1,
	})));
	await ensureDatabaseSchema(env);
	let clock = Date.now();
	const sessions = new RecommendationSessions({ clock: () => clock, ttlMs: 100 });
	const first = await handleRecommendations(new Request(`${BASE_URL}/api/v1/recommendations?limit=2`), env, sessions);
	const page = await first.json() as { continuation: string };
	for (const store of [new RecommendationSessions(), sessions]) {
		clock += 100;
		const response = await handleRecommendations(new Request(`${BASE_URL}/api/v1/recommendations?continuation=${encodeURIComponent(page.continuation)}`), env, store);
		assert.equal(response.status, 410);
		assert.equal((await response.json() as { code: string }).code, 'recommendation_continuation_expired');
	}
	const legacy = await handleRecommendations(new Request(`${BASE_URL}/api/v1/recommendations?continuation=v1:2:2026-10-04T12:00:00.000Z`), env, sessions);
	assert.equal(legacy.status, 410);
	for (const malformed of ['v1:2:2026-02-30T12:00:00Z', 'v1:2:10', 'v2:bad:2', 'v2:00000000-0000-4000-8000-000000000000:1100']) {
		const response = await handleRecommendations(new Request(`${BASE_URL}/api/v1/recommendations?continuation=${encodeURIComponent(malformed)}`), env, sessions);
		assert.equal(response.status, 400, malformed);
	}
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
		receivedAt: minutesAgo(index),
		isStarred: 1,
	}));
	const { database, env, db } = createFixture(items);

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
		(entry) => /\b(?:FROM|JOIN) items\b/i.test(entry.sql) && /\bSELECT\b/i.test(entry.sql),
	);
	const candidateSelect = itemSelects.find((entry) => /LIMIT \?/i.test(entry.sql) && entry.sql.includes('i.subject AS title'));
	assert.ok(candidateSelect, 'expected a metadata-only ranking query');
	assert.equal(candidateSelect.sql.includes('html_content'), false);
	assert.equal(candidateSelect.sql.includes('text_content'), false);
	assert.deepEqual(candidateSelect.values, [100]);

	const bodySelects = itemSelects.filter(
		(entry) =>
			entry.sql.includes('html_content') &&
			entry.sql.includes('FROM json_each(?) snapshot_item') &&
			!entry.sql.includes('substr('),
	);
	assert.equal(bodySelects.length, 1);
	assert.equal(bodySelects[0].values.length, 2);
	assert.equal(bodySelects[0].values[1], 3, 'only three full-body rows are read');
	assert.ok((JSON.parse(bodySelects[0].values[0] as string) as string[]).length > 3, 'the query filters the ranked membership before limiting full bodies');
	const plan = db.prepare(`EXPLAIN QUERY PLAN ${bodySelects[0].sql}`).all(...bodySelects[0].values) as { detail: string }[];
	assert.ok(plan.some((step) => /SEARCH i USING INDEX/.test(step.detail)), 'snapshot item IDs retain indexed lookups');
	assert.ok(!plan.some((step) => /SCAN i(?:$| )/.test(step.detail)));
	const boundedExcerptSelects = itemSelects.filter(
		(entry) => entry.sql.includes('substr(') && /WHERE id IN/i.test(entry.sql),
	);
	assert.equal(boundedExcerptSelects.length, 0);

	const engagementSelects = database.executedSql.filter(
		(entry) => entry.sql.includes('FROM engagement_events') && entry.sql.includes('GROUP BY'),
	);
	assert.equal(engagementSelects.length, 1);
	assert.match(engagementSelects[0].sql, /feed_key IN \(/i);
	assert.ok(engagementSelects[0].values.every((value) => value === 'saved-feed' || value === 'other-feed'));
	assert.equal(new Set(engagementSelects[0].values).size, 2);
});

test('non-For You topic excerpts follow the final timestamp and id order on ties', async () => {
	const { env } = createFixture([
		{
			id: 'z-item',
			feedKey: 'daily-feed',
			title: 'A general report',
			receivedAt: '2026-08-09T11:00:00.000Z',
		},
		{
			id: 'a-item',
			feedKey: 'daily-feed',
			title: 'Another general report',
			htmlContent: '<p>Detailed notes about home gyms.</p>',
			textContent: null,
			receivedAt: '2026-08-09T11:00:00.000Z',
		},
	]);
	const save = await nativeRequest(env, '/api/v1/personalization', {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ monitoredTopics: ['home gyms'] }),
	});
	assert.equal(save.status, 200);

	const response = await nativeRequest(env, '/api/v1/recommendations?view=unread&limit=1');
	assert.equal(response.status, 200);
	const payload = await response.json() as { items: Array<{ id: string; matchedTopics: string[] }> };
	assert.equal(payload.items[0]?.id, 'a-item');
	assert.deepEqual(payload.items[0]?.matchedTopics, ['home gyms']);
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

test('personalization export includes retained history beyond the screen limit', async () => {
	const { db, database, env } = createFixture([
		{ id: 'export-item', feedKey: 'daily-feed', title: 'Retained story', receivedAt: '2026-08-15T11:00:00.000Z' },
	]);
	await nativeRequest(env, '/api/v1/personalization');
	const insert = db.prepare(`INSERT INTO engagement_events
	 (id, event_key, item_id, feed_key, event_type, client_family, occurred_at)
	 VALUES (?, ?, 'export-item', 'daily-feed', 'star', 'pigeon', '2026-08-15T12:00:00.000Z')`);
	for (let index = 0; index < 1001; index += 1) {
		const id = `history-${String(index).padStart(4, '0')}`;
		insert.run(id, `client:pigeon:${id}`);
	}
	const screen = await nativeRequest(env, '/api/v1/personalization');
	assert.equal((await screen.json() as { history: unknown[] }).history.length, 500);
	database.clearExecutedSql();
	const exported = await nativeRequest(env, '/api/v1/personalization?download=1');
	assert.equal(exported.headers.get('Content-Disposition'), 'attachment; filename="pigeon-personalization.json"');
	const history = (await exported.json() as { history: { id: string }[] }).history;
	assert.equal(history.length, 1001);
	assert.equal(history.at(-1)?.id, 'history-0000');
	assert.equal(new Set(history.map((entry) => entry.id)).size, 1001);
	assert.equal(database.executedSql.filter((entry) => entry.sql.includes('FROM engagement_events e')).length, 5);

	database.clearExecutedSql();
	const cancelled = await nativeRequest(env, '/api/v1/personalization?download=1');
	await cancelled.body?.cancel();
	assert.equal(database.executedSql.filter((entry) => entry.sql.includes('FROM engagement_events e')).length, 1);

	const failed = await nativeRequest(env, '/api/v1/personalization?download=1');
	const prepare = database.prepare.bind(database);
	database.prepare = (sql) => {
		if (sql.includes('AND (e.occurred_at, e.id)')) throw new Error('history storage unavailable');
		return prepare(sql);
	};
	await assert.rejects(failed.text(), /history storage unavailable/);
	database.prepare = prepare;

	db.prepare('DELETE FROM engagement_events').run();
	const empty = await nativeRequest(env, '/api/v1/personalization?download=1');
	assert.deepEqual((await empty.json() as { history: unknown[] }).history, []);
	for (let index = 0; index < 500; index += 1) insert.run(`exact-${index}`, `client:pigeon:exact-${index}`);
	database.clearExecutedSql();
	const exactPage = await nativeRequest(env, '/api/v1/personalization?download=1');
	assert.equal((await exactPage.json() as { history: unknown[] }).history.length, 500);
	assert.equal(database.executedSql.filter((entry) => entry.sql.includes('FROM engagement_events e')).length, 3);

	db.prepare('DELETE FROM engagement_events').run();
	for (let index = 0; index < 9001; index += 1) insert.run(`scale-${index}`, `client:pigeon:scale-${index}`);
	database.clearExecutedSql();
	const scaled = await nativeRequest(env, '/api/v1/personalization?download=1');
	const scaledHistory = (await scaled.json() as { history: { id: string }[] }).history;
	assert.equal(scaledHistory.length, 9001);
	assert.equal(new Set(scaledHistory.map((entry) => entry.id)).size, 9001);
	assert.equal(database.executedSql.filter((entry) => entry.sql.includes('FROM engagement_events e')).length, 37);
	assert.ok(database.executedSql.length <= 50);
});

test('recommendations match monitored topics in bounded HTML when text content is absent', async () => {
	const { db, database, env } = createFixture([
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
	database.clearExecutedSql();

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
	const boundedExcerptSelect = database.executedSql.find(
		(entry) => entry.sql.includes('substr(') && /WHERE id IN/i.test(entry.sql),
	);
	assert.ok(boundedExcerptSelect);
	assert.match(boundedExcerptSelect.sql, /1, 8000/);
});
