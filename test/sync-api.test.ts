import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { handleMutationBatch } from '../src/mutation-api';
import { handleEngagementIngestion } from '../src/engagement';
import { handleIncrementalSync } from '../src/sync-api';

class SqliteStatement {
	private values: unknown[] = [];

	constructor(
		private readonly database: DatabaseSync,
		private readonly sql: string,
		private readonly limits?: { maxQueries: number; queries: number },
	) {}

	bind(...values: unknown[]): this {
		this.values = values;
		if (values.length > 100) throw new Error('D1 maximum bound parameters exceeded');
		return this;
	}

	async all<T>(): Promise<{ results: T[] }> {
		this.recordQuery();
		return { results: this.database.prepare(this.sql).all(...this.values) as T[] };
	}

	async first<T>(): Promise<T | null> {
		this.recordQuery();
		return (this.database.prepare(this.sql).get(...this.values) as T | undefined) ?? null;
	}

	async run(): Promise<{ meta: { changes: number } }> {
		this.recordQuery();
		const result = this.database.prepare(this.sql).run(...this.values);
		return { meta: { changes: Number(result.changes) } };
	}

	private recordQuery(): void {
		if (this.limits && ++this.limits.queries > this.limits.maxQueries) {
			throw new Error('D1 query budget exceeded');
		}
	}
}

class SqliteD1 {
	constructor(readonly database: DatabaseSync, readonly limits?: { maxQueries: number; queries: number }) {}

	prepare(sql: string): SqliteStatement {
		return new SqliteStatement(this.database, sql, this.limits);
	}

	async batch(statements: SqliteStatement[]): Promise<Array<{ meta: { changes: number } }>> {
		this.database.exec('BEGIN IMMEDIATE');
		try {
			const results = [];
			for (const statement of statements) results.push(await statement.run());
			this.database.exec('COMMIT');
			return results;
		} catch (error) {
			this.database.exec('ROLLBACK');
			throw error;
		}
	}
}

function fixture() {
	const database = new DatabaseSync(':memory:');
	database.exec('PRAGMA foreign_keys = ON');
	database.exec(readFileSync(new URL('../04-storage/SCHEMA.sql', import.meta.url), 'utf8'));
	const db = new SqliteD1(database);
	const env = { DB: db } as never;
	return { database, db, env };
}

function insertLibrary(database: DatabaseSync): void {
	database.prepare(
		`INSERT INTO feeds (rowid, feed_key, display_name, source_type, source_url, site_url)
		 VALUES (7, 'design-weekly', 'Design Weekly', 'rss', 'https://feeds.example.com/design.xml', 'https://example.com')`,
	).run();
	database.prepare("INSERT INTO feed_tags (feed_key, label) VALUES ('design-weekly', 'Design')").run();
	database.prepare(
		`INSERT INTO items (
		 rowid, id, feed_key, from_name, subject, html_content, text_content,
		 original_url, message_id, received_at, is_read, is_starred
		) VALUES (11, '11111111-1111-4111-8111-111111111111', 'design-weekly', 'Ada',
		 'A durable reader', '<p>Cached body</p>', 'Cached body', 'https://example.com/article',
		 'message-1', '2026-08-15T12:00:00.000Z', 0, 0)`,
	).run();
}

async function sync(env: never, cursor?: string, limit = 2) {
	const url = new URL('https://pigeon.example/api/v1/sync');
	url.searchParams.set('limit', String(limit));
	if (cursor) url.searchParams.set('cursor', cursor);
	return handleIncrementalSync(new Request(url), env);
}

test('incremental sync uses bounded opaque cursors without overlap', async () => {
	const state = fixture();
	insertLibrary(state.database);

	let cursor: string | undefined;
	let previousSequence = 0;
	const changes: Array<Record<string, unknown>> = [];
	for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
		const response = await sync(state.env, cursor, 2);
		assert.equal(response.status, 200);
		const body = await response.json() as {
			cursor: string;
			hasMore: boolean;
			changes: Array<Record<string, unknown> & { sequence: number }>;
		};
		assert.ok(body.changes.length <= 2);
		for (const change of body.changes) {
			assert.ok(change.sequence > previousSequence);
			previousSequence = change.sequence;
			changes.push(change);
		}
		cursor = body.cursor;
		if (!body.hasMore) break;
	}

	assert.match(cursor ?? '', /^v1:\d+$/);
	const feed = changes.find((change) => change.entityType === 'feed' && change.operation === 'upsert');
	const article = changes.find((change) => change.entityType === 'article' && change.operation === 'upsert');
	const status = changes.find((change) => change.entityType === 'status' && change.operation === 'upsert');
	assert.deepEqual((feed?.payload as { folders: string[] }).folders, ['Design']);
	assert.equal((article?.payload as { html: string }).html, '<p>Cached body</p>');
	assert.equal((status?.payload as { isRead: boolean }).isRead, false);
	assert.match(feed?.changedAt as string, /^\d{4}-\d{2}-\d{2}T.*Z$/);
	assert.match((article?.payload as { receivedAt: string }).receivedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
	assert.match((status?.payload as { updatedAt: string }).updatedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);

	const emptyPage = await sync(state.env, cursor, 2);
	assert.deepEqual((await emptyPage.json() as { changes: unknown[] }).changes, []);
	state.database.close();
});

test('incremental sync rejects malformed cursors', async () => {
	const state = fixture();
	const response = await sync(state.env, '12-not-opaque');
	assert.equal(response.status, 400);
	state.database.close();
});

test('durable mutations are exactly-once and surface their idempotency key in status sync', async () => {
	const state = fixture();
	insertLibrary(state.database);
	const before = state.database.prepare('SELECT MAX(sequence) AS sequence FROM sync_changes').get() as { sequence: number };
	const mutation = {
		id: 'mutation-read-1',
		kind: 'set_read',
		itemIds: ['tag:google.com,2005:reader/item/000000000000000b'],
		value: true,
		scope: 'single',
	};
	const makeRequest = () => new Request('https://pigeon.example/api/v1/mutations', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ mutations: [mutation] }),
	});

	const first = await handleMutationBatch(makeRequest(), state.env);
	const second = await handleMutationBatch(makeRequest(), state.env);
	assert.deepEqual(
		[(await first.json() as { results: Array<{ status: string }> }).results[0].status,
		 (await second.json() as { results: Array<{ status: string }> }).results[0].status],
		['applied', 'already_applied'],
	);
	assert.equal(
		(state.database.prepare('SELECT is_read FROM items WHERE rowid = 11').get() as { is_read: number }).is_read,
		1,
	);
	assert.equal(
		(state.database.prepare("SELECT COUNT(*) AS count FROM mutation_receipts WHERE mutation_id = 'mutation-read-1'").get() as { count: number }).count,
		1,
	);
	assert.equal(
		(state.database.prepare("SELECT COUNT(*) AS count FROM engagement_events WHERE event_key LIKE 'mutation:mutation-read-1:%'").get() as { count: number }).count,
		1,
	);

	const response = await sync(state.env, `v1:${before.sequence}`, 20);
	const changes = (await response.json() as { changes: Array<Record<string, unknown>> }).changes;
	const status = changes.find((change) =>
		change.entityType === 'status' &&
		(change.payload as { mutationId?: string } | null)?.mutationId === 'mutation-read-1'
	);
	assert.ok(status);
	state.database.close();
});

test('feed rename, move, and unsubscribe mutations are durable and idempotent', async () => {
	const state = fixture();
	insertLibrary(state.database);
	const mutations = [
		{ id: 'rename-1', kind: 'rename_feed', itemIds: [], feedId: 'feed/7', title: 'Calmer Design' },
		{ id: 'move-1', kind: 'move_feed', itemIds: [], feedId: 'feed/7', folders: ['Reading'] },
		{ id: 'unsubscribe-1', kind: 'unsubscribe_feed', itemIds: [], feedId: 'feed/7' },
	];
	const request = () => new Request('https://pigeon.example/api/v1/mutations', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ mutations }),
	});
	assert.equal((await handleMutationBatch(request(), state.env)).status, 200);
	assert.equal((await handleMutationBatch(request(), state.env)).status, 200);

	const feed = state.database.prepare(
		"SELECT custom_title, is_active FROM feeds WHERE feed_key = 'design-weekly'",
	).get() as { custom_title: string; is_active: number };
	assert.equal(feed.custom_title, 'Calmer Design');
	assert.equal(feed.is_active, 0);
	assert.deepEqual(
		state.database.prepare("SELECT label FROM feed_tags WHERE feed_key = 'design-weekly'").all()
			.map((row) => (row as { label: string }).label),
		['Reading'],
	);
	assert.equal(
		(state.database.prepare('SELECT COUNT(*) AS count FROM mutation_receipts').get() as { count: number }).count,
		3,
	);
	state.database.close();
});

test('a durable restore mutation reverses an unsubscribe exactly once', async () => {
	const state = fixture();
	insertLibrary(state.database);
	const request = (id: string, kind: string) => new Request('https://pigeon.example/api/v1/mutations', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ mutations: [{ id, kind, itemIds: [], feedId: 'feed/7' }] }),
	});
	await handleMutationBatch(request('unsubscribe-once', 'unsubscribe_feed'), state.env);
	await handleMutationBatch(request('restore-once', 'restore_feed'), state.env);
	await handleMutationBatch(request('restore-once', 'restore_feed'), state.env);
	assert.equal(
		(state.database.prepare("SELECT is_active FROM feeds WHERE feed_key = 'design-weekly'").get() as { is_active: number }).is_active,
		1,
	);
	assert.equal(
		(state.database.prepare("SELECT COUNT(*) AS count FROM mutation_receipts WHERE mutation_id = 'restore-once'").get() as { count: number }).count,
		1,
	);
	state.database.close();
});

test('mutation batches reject requests beyond their action and item bounds', async () => {
	const state = fixture();
	const request = (mutations: unknown[]) => new Request('https://pigeon.example/api/v1/mutations', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ mutations }),
	});
	const tooManyActions = Array.from({ length: 101 }, (_, index) => ({
		id: `action-${index}`,
		kind: 'set_read',
		itemIds: [`item-${index}`],
		value: true,
	}));
	const tooManyItems = [{
		id: 'bulk-1',
		kind: 'set_read_batch',
		itemIds: Array.from({ length: 201 }, (_, index) => `item-${index}`),
		value: true,
		scope: 'all',
	}];

	assert.equal((await handleMutationBatch(request(tooManyActions), state.env)).status, 400);
	assert.equal((await handleMutationBatch(request(tooManyItems), state.env)).status, 400);
	assert.equal(
		(state.database.prepare('SELECT COUNT(*) AS count FROM mutation_receipts').get() as { count: number }).count,
		0,
	);
	state.database.close();
});

test('a rejected mutation has no receipt and can succeed later with the same idempotency key', async () => {
	const state = fixture();
	const mutation = {
		id: 'recoverable-1',
		kind: 'set_read',
		itemIds: ['tag:google.com,2005:reader/item/000000000000000b'],
		value: true,
		scope: 'single',
	};
	const request = () => new Request('https://pigeon.example/api/v1/mutations', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ mutations: [mutation] }),
	});

	const rejected = await handleMutationBatch(request(), state.env);
	assert.equal((await rejected.json() as { results: Array<{ status: string }> }).results[0].status, 'failed');
	assert.equal(
		(state.database.prepare("SELECT COUNT(*) AS count FROM mutation_receipts WHERE mutation_id = 'recoverable-1'").get() as { count: number }).count,
		0,
	);

	insertLibrary(state.database);
	const recovered = await handleMutationBatch(request(), state.env);
	assert.equal((await recovered.json() as { results: Array<{ status: string }> }).results[0].status, 'applied');
	assert.equal(
		(state.database.prepare("SELECT COUNT(*) AS count FROM mutation_receipts WHERE mutation_id = 'recoverable-1'").get() as { count: number }).count,
		1,
	);
	state.database.close();
});

for (const maxQueries of [50, 1000]) {
	test(`200-item mark-read batches fit D1 bindings and the ${maxQueries}-query budget atomically`, async () => {
		const state = fixture();
		try {
			insertLibrary(state.database);
			const insert = state.database.prepare(`INSERT INTO items
			 (id, feed_key, subject, html_content, message_id, received_at)
			 VALUES (?, 'design-weekly', 'Bulk article', '<p>Body</p>', ?, '2026-10-02T12:00:00.000Z')`);
			for (let index = 0; index < 199; index++) insert.run(`bulk-${index}`, `bulk-message-${index}`);
			const items = state.database.prepare('SELECT rowid, id FROM items ORDER BY rowid').all() as { rowid: number; id: string }[];
			// Exercise both the native rowid format and canonical UUID/string identities.
			const itemIds = items.map((item, index) => index % 2 === 0 ? String(item.rowid) : item.id);
			const limits = { maxQueries, queries: 0 };
			const env = { DB: new SqliteD1(state.database, limits) } as never;
			const request = () => new Request('https://pigeon.example/api/v1/mutations', {
				method: 'POST',
				body: JSON.stringify({ mutations: [{ id: 'bulk-200', kind: 'set_read_batch', itemIds, value: true, scope: 'all' }] }),
			});
			const response = await handleMutationBatch(request(), env);
			assert.equal((await response.json() as { results: { status: string }[] }).results[0].status, 'applied');
			assert.ok(limits.queries <= 10, `used ${limits.queries} database queries`);
			assert.equal((state.database.prepare('SELECT COUNT(*) AS count FROM items WHERE is_read = 1').get() as { count: number }).count, 200);
			assert.equal((state.database.prepare('SELECT COUNT(*) AS count FROM engagement_events').get() as { count: number }).count, 200);
			assert.equal((state.database.prepare("SELECT COUNT(*) AS count FROM item_statuses WHERE mutation_id = 'bulk-200'").get() as { count: number }).count, 200);
			limits.queries = 0;
			assert.equal((await (await handleMutationBatch(request(), env)).json() as { results: { status: string }[] }).results[0].status, 'already_applied');
			assert.equal((state.database.prepare('SELECT COUNT(*) AS count FROM engagement_events').get() as { count: number }).count, 200);
		} finally {
			state.database.close();
		}
	});
}

test('mixed known and unknown bulk identities leave no partial status or receipt', async () => {
	const state = fixture();
	try {
		insertLibrary(state.database);
		for (const itemIds of [['11', 'missing-id'], ['missing-id', '11']]) {
			const response = await handleMutationBatch(new Request('https://pigeon.example/api/v1/mutations', {
				method: 'POST',
				body: JSON.stringify({ mutations: [{ id: 'mixed-invalid', kind: 'set_read_batch', itemIds, value: true }] }),
			}), state.env);
			const body = await response.json() as { results: { status: string; error: string }[] };
			assert.equal(body.results[0].status, 'failed');
			assert.equal(body.results[0].error, 'Unknown item missing-id');
		}
		assert.equal((state.database.prepare('SELECT is_read FROM items WHERE rowid = 11').get() as { is_read: number }).is_read, 0);
		assert.equal((state.database.prepare('SELECT COUNT(*) AS count FROM mutation_receipts').get() as { count: number }).count, 0);
		assert.equal((state.database.prepare('SELECT COUNT(*) AS count FROM engagement_events').get() as { count: number }).count, 0);
	} finally {
		state.database.close();
	}
});

test('a failed bulk transaction rolls back its receipt, status, and events', async () => {
	const state = fixture();
	try {
		insertLibrary(state.database);
		state.database.exec(`CREATE TRIGGER reject_engagement BEFORE INSERT ON engagement_events
		 BEGIN SELECT RAISE(ABORT, 'simulated engagement failure'); END`);
		const response = await handleMutationBatch(new Request('https://pigeon.example/api/v1/mutations', {
			method: 'POST',
			body: JSON.stringify({ mutations: [{ id: 'bulk-rollback', kind: 'set_read_batch', itemIds: ['11'], value: true }] }),
		}), state.env);
		assert.equal((await response.json() as { results: { status: string }[] }).results[0].status, 'failed');
		assert.equal((state.database.prepare('SELECT is_read FROM items WHERE rowid = 11').get() as { is_read: number }).is_read, 0);
		assert.equal((state.database.prepare('SELECT COUNT(*) AS count FROM mutation_receipts').get() as { count: number }).count, 0);
		assert.equal((state.database.prepare('SELECT COUNT(*) AS count FROM engagement_events').get() as { count: number }).count, 0);
	} finally {
		state.database.close();
	}
});

test('100-action retries return ordered receipts and keep making progress inside the query budget', async () => {
	const state = fixture();
	try {
		insertLibrary(state.database);
		const limits = { maxQueries: 50, queries: 0 };
		const env = { DB: new SqliteD1(state.database, limits) } as never;
		const mutations = Array.from({ length: 100 }, (_, index) => ({
			id: `queued-${index}`, kind: 'set_read', itemIds: ['11'], value: index % 2 === 0,
		}));
		let completed = false;
		let previousCount = 0;
		for (let attempt = 0; attempt < 25; attempt++) {
			limits.queries = 0;
			// Replaying the entire original page also models a lost HTTP response.
			const response = await handleMutationBatch(new Request('https://pigeon.example/api/v1/mutations', {
				method: 'POST', body: JSON.stringify({ mutations }),
			}), env);
			assert.equal(response.status, 200);
			const body = await response.json() as { results: { mutationId: string; status: string }[] };
			assert.deepEqual(body.results.map((result) => result.mutationId), mutations.map((mutation) => mutation.id));
			assert.ok(limits.queries <= 40, `used ${limits.queries} queries`);
			const count = (state.database.prepare('SELECT COUNT(*) AS count FROM mutation_receipts').get() as { count: number }).count;
			assert.ok(count > previousCount || count === 100, `receipt count stalled at ${count}`);
			previousCount = count;
			if (body.results.every((result) => result.status !== 'failed')) {
				completed = true;
				break;
			}
			const firstDeferred = body.results.findIndex((result) => result.status === 'failed');
			assert.ok(body.results.slice(firstDeferred).every((result) => result.status === 'failed'));
		}
		assert.equal(completed, true);
		assert.equal(previousCount, 100);
		assert.equal((state.database.prepare('SELECT COUNT(*) AS count FROM engagement_events').get() as { count: number }).count, 100);
		assert.equal((state.database.prepare('SELECT is_read FROM items WHERE rowid = 11').get() as { is_read: number }).is_read, 0);
	} finally {
		state.database.close();
	}
});

test('a large folder move keeps atomic feed updates inside the query budget', async () => {
	const state = fixture();
	try {
		insertLibrary(state.database);
		const limits = { maxQueries: 50, queries: 0 };
		const folders = Array.from({ length: 120 }, (_, index) => `Folder ${index}`);
		const response = await handleMutationBatch(new Request('https://pigeon.example/api/v1/mutations', {
			method: 'POST', body: JSON.stringify({ mutations: [{ id: 'large-move', kind: 'move_feed', feedId: 'feed/7', folders }] }),
		}), { DB: new SqliteD1(state.database, limits) } as never);
		assert.equal((await response.json() as { results: { status: string }[] }).results[0].status, 'applied');
		assert.ok(limits.queries <= 10);
		assert.equal((state.database.prepare('SELECT COUNT(*) AS count FROM feed_tags').get() as { count: number }).count, 120);
		assert.equal((state.database.prepare('SELECT category FROM feeds WHERE rowid = 7').get() as { category: string }).category, folders[0]);
	} finally {
		state.database.close();
	}
});

test('budget deferral preserves FIFO even when a later cheaper mutation would fit', async () => {
	const state = fixture();
	try {
		insertLibrary(state.database);
		const mutations: unknown[] = Array.from({ length: 8 }, (_, index) => ({ id: `ordered-${index}`, kind: 'set_read', itemIds: ['11'], value: true }));
		mutations.push({ id: 'later-feedback', kind: 'feedback', itemIds: ['11'], feedback: 'more_like_this' });
		const response = await handleMutationBatch(new Request('https://pigeon.example/api/v1/mutations', {
			method: 'POST', body: JSON.stringify({ mutations }),
		}), state.env);
		const results = (await response.json() as { results: { status: string }[] }).results;
		assert.deepEqual(results.map((result) => result.status), [...Array(7).fill('applied'), 'failed', 'failed']);
		assert.equal((state.database.prepare("SELECT COUNT(*) AS count FROM engagement_events WHERE event_type = 'more_like_this'").get() as { count: number }).count, 0);
	} finally {
		state.database.close();
	}
});

test('concurrent receipts discovered after prefetch still prevent a duplicate commit', async () => {
	const state = fixture();
	try {
		insertLibrary(state.database);
		const db = new SqliteD1(state.database);
		const batch = db.batch.bind(db);
		db.batch = async (statements) => {
			state.database.prepare(`INSERT INTO mutation_receipts
			 (account_id, mutation_id, mutation_kind, applied_at, result_json)
			 VALUES ('default', 'raced-rename', 'rename_feed', '2026-10-02T12:00:00.000Z', ?)`)
				.run(JSON.stringify({ appliedAt: '2026-10-02T12:00:00.000Z' }));
			state.database.prepare("UPDATE feeds SET custom_title = 'Committed elsewhere' WHERE rowid = 7").run();
			return batch(statements);
		};
		const response = await handleMutationBatch(new Request('https://pigeon.example/api/v1/mutations', {
			method: 'POST', body: JSON.stringify({ mutations: [{ id: 'raced-rename', kind: 'rename_feed', feedId: 'feed/7', title: 'Duplicate write' }] }),
		}), { DB: db } as never);
		assert.equal((await response.json() as { results: { status: string }[] }).results[0].status, 'already_applied');
		assert.equal((state.database.prepare('SELECT custom_title FROM feeds WHERE rowid = 7').get() as { custom_title: string }).custom_title, 'Committed elsewhere');
	} finally {
		state.database.close();
	}
});

test('unavailable receipt storage returns a retryable HTTP response', async () => {
	const response = await handleMutationBatch(new Request('https://pigeon.example/api/v1/mutations', {
		method: 'POST', body: JSON.stringify({ mutations: [{ id: 'unavailable', kind: 'set_read', itemIds: ['11'], value: true }] }),
	}), { DB: { prepare() { throw new Error('storage offline'); } } } as never);
	assert.equal(response.status, 503);
	assert.deepEqual(await response.json(), { error: 'Database unavailable' });
});

test('a maximum engagement batch is atomic and idempotent within the request query budget', async () => {
	const state = fixture();
	try {
		insertLibrary(state.database);
		const events = Array.from({ length: 100 }, (_, index) => ({
			id: `client-event-${index}`,
			itemId: index % 2 === 0 ? '11111111-1111-4111-8111-111111111111' : '11',
			type: index % 2 === 0 ? 'active_reading' : 'outbound_link',
			durationSeconds: index % 2 === 0 ? 42 : null,
			destinationHost: index % 2 === 0 ? null : 'News.Example.com.',
			occurredAt: '2026-10-02T12:00:00-04:00',
		}));
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const limits = { maxQueries: 50, queries: 0 };
			const response = await handleEngagementIngestion(new Request('https://pigeon.example/api/v1/engagement', {
				method: 'POST', headers: { 'X-Pigeon-Client': 'pigeon-reader/1' }, body: JSON.stringify({ events }),
			}), { DB: new SqliteD1(state.database, limits) } as never);
			assert.equal(response.status, 200);
			assert.deepEqual(await response.json(), { accepted: 100, clientFamily: 'pigeon' });
			assert.ok(limits.queries <= 5);
			assert.equal((state.database.prepare('SELECT COUNT(*) AS count FROM engagement_events').get() as { count: number }).count, 100);
		}
		assert.deepEqual({ ...state.database.prepare('SELECT item_id, duration_seconds, destination_host, occurred_at FROM engagement_events WHERE id = ?').get('client-event-0') }, {
			item_id: '11111111-1111-4111-8111-111111111111', duration_seconds: 42, destination_host: null, occurred_at: '2026-10-02T16:00:00.000Z',
		});
		assert.equal((state.database.prepare('SELECT destination_host FROM engagement_events WHERE id = ?').get('client-event-1') as { destination_host: string }).destination_host, 'news.example.com');
		state.database.exec(`CREATE TRIGGER reject_client_event BEFORE INSERT ON engagement_events
		 WHEN NEW.id = 'failed-50' BEGIN SELECT RAISE(ABORT, 'simulated engagement failure'); END`);
		await assert.rejects(handleEngagementIngestion(new Request('https://pigeon.example/api/v1/engagement', {
			method: 'POST', body: JSON.stringify({ events: events.map((event, index) => ({ ...event, id: `failed-${index}` })) }),
		}), state.env), /simulated engagement failure/);
		assert.equal((state.database.prepare('SELECT COUNT(*) AS count FROM engagement_events').get() as { count: number }).count, 100);
	} finally {
		state.database.close();
	}
});
