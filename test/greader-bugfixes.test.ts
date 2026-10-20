import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, test } from 'node:test';

import { generateApiToken } from '../src/api-auth';
import { handleGreaderRequest } from '../src/greader';
import { handleSubscribe } from '../src/subscribe';
import { handleIncrementalSync } from '../src/sync-api';

class SqliteStatement {
	private values: unknown[] = [];

	constructor(private readonly database: DatabaseSync, private readonly sql: string) {}

	bind(...values: unknown[]): this {
		this.values = values;
		return this;
	}

	async all<T>(): Promise<{ results: T[] }> {
		return { results: this.database.prepare(this.sql).all(...(this.values as never[])) as T[] };
	}

	async first<T>(): Promise<T | null> {
		return (this.database.prepare(this.sql).get(...(this.values as never[])) as T | undefined) ?? null;
	}

	async run(): Promise<{ meta: { changes: number } }> {
		const result = this.database.prepare(this.sql).run(...(this.values as never[]));
		return { meta: { changes: Number(result.changes) } };
	}
}

class SqliteD1 {
	constructor(readonly database: DatabaseSync) {}

	prepare(sql: string): SqliteStatement {
		return new SqliteStatement(this.database, sql);
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

const PASSWORD = 'greader-bugfix-password';
const FEED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Bugfix Feed</title>
    <link>https://example.com/</link>
    <item>
      <guid>bugfix-1</guid>
      <title>First story</title>
      <link>https://example.com/first</link>
      <description><![CDATA[<p>Body</p>]]></description>
      <pubDate>Fri, 20 Mar 2026 12:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

function installFeedFetch(): void {
	globalThis.fetch = (async () =>
		new Response(FEED_XML, { status: 200, headers: { 'Content-Type': 'application/rss+xml' } })) as typeof fetch;
}

function fixture() {
	const database = new DatabaseSync(':memory:');
	database.exec('PRAGMA foreign_keys = ON');
	database.exec(readFileSync(new URL('../04-storage/SCHEMA.sql', import.meta.url), 'utf8'));
	const env = { DB: new SqliteD1(database), BASE_URL: 'https://pigeon.example', API_PASSWORD: PASSWORD } as never;
	return { database, env };
}

async function auth(): Promise<string> {
	return `GoogleLogin auth=pigeon/${await generateApiToken(PASSWORD)}`;
}

function insertFeed(database: DatabaseSync, rowid = 7, feedKey = 'design-weekly'): void {
	database.prepare(
		`INSERT INTO feeds (rowid, feed_key, display_name, source_type, source_url, site_url)
		 VALUES (?, ?, 'Design Weekly', 'rss', 'https://feeds.example.com/design.xml', 'https://example.com')`,
	).run(rowid, feedKey);
}

function insertItem(database: DatabaseSync, rowid: number, receivedAt: string, feedKey = 'design-weekly'): void {
	database.prepare(
		`INSERT INTO items (rowid, id, feed_key, subject, html_content, message_id, received_at, is_read)
		 VALUES (?, ?, ?, 'Story', '<p>Body</p>', ?, ?, 0)`,
	).run(rowid, `item-${rowid}`, feedKey, `message-${rowid}`, receivedAt);
}

function isRead(database: DatabaseSync, rowid: number): number {
	return (database.prepare('SELECT is_read FROM items WHERE rowid = ?').get(rowid) as { is_read: number }).is_read;
}

async function greaderPost(env: never, path: string, body: string, contentType: string | null): Promise<Response> {
	const headers: Record<string, string> = { Authorization: await auth() };
	if (contentType) headers['Content-Type'] = contentType;
	return handleGreaderRequest(new Request(`https://pigeon.example/reader/api/0/${path}`, { method: 'POST', headers, body }), env);
}

// --- Bug 1: quickadd via POST form body ---

test('GReader quickadd accepts the feed URL from a POST form body', async () => {
	installFeedFetch();
	const state = fixture();
	try {
		const response = await greaderPost(
			state.env,
			'subscription/quickadd',
			new URLSearchParams({ quickadd: 'https://example.com/feed.xml' }).toString(),
			'application/x-www-form-urlencoded',
		);
		assert.equal(response.status, 200, await response.clone().text());
		const body = await response.json() as { numResults: number; streamId: string };
		assert.equal(body.numResults, 1);
		assert.match(body.streamId, /^feed\/\d+$/);
	} finally {
		state.database.close();
	}
});

test('GReader quickadd still accepts the feed URL from the query string', async () => {
	installFeedFetch();
	const state = fixture();
	try {
		const response = await handleGreaderRequest(new Request(
			'https://pigeon.example/reader/api/0/subscription/quickadd?quickadd=https%3A%2F%2Fexample.com%2Ffeed.xml',
			{ method: 'POST', headers: { Authorization: await auth() } },
		), state.env);
		assert.equal(response.status, 200);
	} finally {
		state.database.close();
	}
});

// --- Bug 2: raw urlencoded bodies without a form content type ---

for (const contentType of ['text/plain', null]) {
	test(`GReader edit-tag accepts repeated ids from a raw body (${contentType ?? 'no content type'})`, async () => {
		const state = fixture();
		try {
			insertFeed(state.database);
			insertItem(state.database, 11, '2026-08-15T12:00:00.000Z');
			insertItem(state.database, 12, '2026-08-15T12:00:01.000Z');
			insertItem(state.database, 13, '2026-08-15T12:00:02.000Z');
			const response = await greaderPost(state.env, 'edit-tag', 'i=11&i=12&a=user/-/state/com.google/read', contentType);
			assert.equal(response.status, 200);
			assert.equal(isRead(state.database, 11), 1);
			assert.equal(isRead(state.database, 12), 1);
			assert.equal(isRead(state.database, 13), 0);
		} finally {
			state.database.close();
		}
	});
}

test('GReader mark-all-as-read accepts a raw text/plain urlencoded body', async () => {
	const state = fixture();
	try {
		insertFeed(state.database);
		insertItem(state.database, 11, '2026-08-15T12:00:00.000Z');
		const response = await greaderPost(state.env, 'mark-all-as-read', 's=feed/7', 'text/plain');
		assert.equal(response.status, 200);
		assert.equal(isRead(state.database, 11), 1);
	} finally {
		state.database.close();
	}
});

test('GReader subscription/edit accepts repeated labels from a raw text/plain body', async () => {
	const state = fixture();
	try {
		insertFeed(state.database);
		state.database.prepare("INSERT INTO feed_tags (feed_key, label) VALUES ('design-weekly', 'Old')").run();
		const response = await greaderPost(
			state.env,
			'subscription/edit',
			'ac=edit&s=feed/7&a=user/-/label/One&a=user/-/label/Two&r=user/-/label/Old&t=Renamed',
			'text/plain',
		);
		assert.equal(response.status, 200);
		const labels = (state.database.prepare("SELECT label FROM feed_tags WHERE feed_key = 'design-weekly' ORDER BY label").all() as Array<{ label: string }>)
			.map((row) => row.label);
		assert.deepEqual(labels, ['One', 'Two']);
		const feed = state.database.prepare('SELECT custom_title FROM feeds WHERE rowid = 7').get() as { custom_title: string };
		assert.equal(feed.custom_title, 'Renamed');
	} finally {
		state.database.close();
	}
});

test('GReader edit-tag still accepts multipart form bodies', async () => {
	const state = fixture();
	try {
		insertFeed(state.database);
		insertItem(state.database, 11, '2026-08-15T12:00:00.000Z');
		insertItem(state.database, 12, '2026-08-15T12:00:01.000Z');
		const form = new FormData();
		form.append('i', '11');
		form.append('i', '12');
		form.append('a', 'user/-/state/com.google/starred');
		const response = await handleGreaderRequest(new Request('https://pigeon.example/reader/api/0/edit-tag', {
			method: 'POST', headers: { Authorization: await auth() }, body: form,
		}), state.env);
		assert.equal(response.status, 200);
		const starred = state.database.prepare('SELECT COUNT(*) AS count FROM items WHERE is_starred = 1').get() as { count: number };
		assert.equal(starred.count, 2);
	} finally {
		state.database.close();
	}
});

// --- Bug 3: subscribe category must survive later label edits ---

async function subscriptionCategories(env: never): Promise<string[]> {
	const response = await handleGreaderRequest(new Request('https://pigeon.example/reader/api/0/subscription/list', {
		headers: { Authorization: await auth() },
	}), env);
	const body = await response.json() as { subscriptions: Array<{ categories: Array<{ label: string }> }> };
	assert.equal(body.subscriptions.length, 1);
	return body.subscriptions[0].categories.map((category) => category.label);
}

test('subscribe category is kept as a folder after GReader adds another label', async () => {
	installFeedFetch();
	const state = fixture();
	try {
		const subscribeResponse = await handleSubscribe(new Request('https://pigeon.example/feeds/subscribe', {
			method: 'POST',
			headers: { Authorization: await auth(), 'Content-Type': 'application/json' },
			body: JSON.stringify({ url: 'https://example.com/feed.xml', category: 'Tech' }),
		}), state.env);
		assert.equal(subscribeResponse.status, 200, await subscribeResponse.clone().text());
		const feed = state.database.prepare('SELECT rowid, feed_key FROM feeds').get() as { rowid: number; feed_key: string };

		const syncResponse = await handleIncrementalSync(new Request('https://pigeon.example/api/v1/sync?limit=100'), state.env);
		const syncBody = await syncResponse.json() as { changes: Array<{ entityType: string; operation: string; payload: { folders?: string[] } }> };
		const feedChange = syncBody.changes.find((change) => change.entityType === 'feed' && change.operation === 'upsert');
		assert.deepEqual(feedChange?.payload.folders, ['Tech']);

		const response = await greaderPost(
			state.env,
			'subscription/edit',
			new URLSearchParams({ ac: 'edit', s: `feed/${feed.rowid}`, a: 'user/-/label/News' }).toString(),
			'application/x-www-form-urlencoded',
		);
		assert.equal(response.status, 200);
		assert.deepEqual(await subscriptionCategories(state.env), ['News', 'Tech']);
	} finally {
		state.database.close();
	}
});

test('GReader label add preserves a legacy category that has no feed_tags row', async () => {
	const state = fixture();
	try {
		insertFeed(state.database);
		state.database.prepare("UPDATE feeds SET category = 'Tech' WHERE rowid = 7").run();
		const response = await greaderPost(
			state.env,
			'subscription/edit',
			'ac=edit&s=feed/7&a=user/-/label/News',
			'application/x-www-form-urlencoded',
		);
		assert.equal(response.status, 200);
		assert.deepEqual(await subscriptionCategories(state.env), ['News', 'Tech']);
		const labels = (state.database.prepare("SELECT label FROM feed_tags WHERE feed_key = 'design-weekly' ORDER BY label").all() as Array<{ label: string }>)
			.map((row) => row.label);
		assert.deepEqual(labels, ['News', 'Tech']);
	} finally {
		state.database.close();
	}
});

// --- Bug 4: mark-all-as-read cutoff precision ---

for (const streamId of ['feed/7', 'user/-/label/Design', 'user/-/state/com.google/reading-list']) {
	test(`GReader mark-all-as-read compares the ts cutoff at millisecond precision (${streamId})`, async () => {
		const state = fixture();
		try {
			insertFeed(state.database);
			state.database.prepare("INSERT INTO feed_tags (feed_key, label) VALUES ('design-weekly', 'Design')").run();
			insertItem(state.database, 11, '2026-01-01T00:00:00.100Z');
			insertItem(state.database, 12, '2026-01-01T00:00:00.900Z');
			const response = await greaderPost(
				state.env,
				'mark-all-as-read',
				new URLSearchParams({ s: streamId, ts: '1767225600100000' }).toString(),
				'application/x-www-form-urlencoded',
			);
			assert.equal(response.status, 200);
			assert.equal(isRead(state.database, 11), 1);
			assert.equal(isRead(state.database, 12), 0);
			const events = state.database.prepare(
				"SELECT COUNT(*) AS count FROM engagement_events WHERE event_type = 'bulk_mark_all_read'",
			).get() as { count: number };
			assert.equal(events.count, 1);
		} finally {
			state.database.close();
		}
	});
}

test('GReader mark-all-as-read keeps whole-second ts cutoffs inclusive of that second', async () => {
	const state = fixture();
	try {
		insertFeed(state.database);
		insertItem(state.database, 11, '2026-01-01T00:00:00.900Z');
		insertItem(state.database, 12, '2026-01-01T00:00:01.000Z');
		const response = await greaderPost(state.env, 'mark-all-as-read', 's=feed/7&ts=1767225600', 'application/x-www-form-urlencoded');
		assert.equal(response.status, 200);
		assert.equal(isRead(state.database, 11), 1);
		assert.equal(isRead(state.database, 12), 0);
	} finally {
		state.database.close();
	}
});

test('GReader mark-all-as-read without ts marks every item in the stream', async () => {
	const state = fixture();
	try {
		insertFeed(state.database);
		insertItem(state.database, 11, '2026-01-01T00:00:00.100Z');
		insertItem(state.database, 12, '2030-01-01T00:00:00.900Z');
		const response = await greaderPost(state.env, 'mark-all-as-read', 's=feed/7', 'application/x-www-form-urlencoded');
		assert.equal(response.status, 200);
		assert.equal(isRead(state.database, 11), 1);
		assert.equal(isRead(state.database, 12), 1);
	} finally {
		state.database.close();
	}
});

// --- Query-string params on POST, ot precision, repeated edit-tag tags ---

function isStarred(database: DatabaseSync, rowid: number): number {
	return (database.prepare('SELECT is_starred FROM items WHERE rowid = ?').get(rowid) as { is_starred: number }).is_starred;
}

test('GReader POST handlers merge query-string params with the form body', async () => {
	const state = fixture();
	try {
		insertFeed(state.database);
		insertItem(state.database, 11, '2026-08-15T12:00:00.000Z');
		insertItem(state.database, 12, '2026-08-15T12:00:01.000Z');
		const editTag = await greaderPost(state.env, 'edit-tag?i=11&a=user/-/state/com.google/read', 'T=token', 'application/x-www-form-urlencoded');
		assert.equal(editTag.status, 200);
		assert.equal(isRead(state.database, 11), 1);
		assert.equal(isRead(state.database, 12), 0);

		const markAll = await greaderPost(state.env, 'mark-all-as-read?s=feed/7', 'T=token', 'application/x-www-form-urlencoded');
		assert.equal(markAll.status, 200, await markAll.clone().text());
		assert.equal(isRead(state.database, 12), 1);
	} finally {
		state.database.close();
	}
});

test('GReader POST body params take precedence over query-string params', async () => {
	const state = fixture();
	try {
		insertFeed(state.database);
		insertItem(state.database, 11, '2026-08-15T12:00:00.000Z');
		insertItem(state.database, 12, '2026-08-15T12:00:01.000Z');
		const response = await greaderPost(state.env, 'edit-tag?i=12&a=user/-/state/com.google/read', 'i=11', 'application/x-www-form-urlencoded');
		assert.equal(response.status, 200);
		assert.equal(isRead(state.database, 11), 1);
		assert.equal(isRead(state.database, 12), 0);
	} finally {
		state.database.close();
	}
});

test('GReader ot filter keeps items later in the same second as the cutoff', async () => {
	const state = fixture();
	try {
		insertFeed(state.database);
		insertItem(state.database, 11, '2026-03-20T12:00:00.500Z');
		insertItem(state.database, 12, '2026-03-20T12:00:01.900Z');
		const ot = Math.floor(Date.parse('2026-03-20T12:00:01.000Z') / 1000);
		const response = await handleGreaderRequest(new Request(
			`https://pigeon.example/reader/api/0/stream/items/ids?s=feed/7&n=10&ot=${ot}`,
			{ headers: { Authorization: await auth() } },
		), state.env);
		assert.equal(response.status, 200);
		const body = await response.json() as { itemRefs?: Array<{ id: string }> };
		assert.deepEqual((body.itemRefs ?? []).map((ref) => Number(ref.id)), [12]);
	} finally {
		state.database.close();
	}
});

test('GReader edit-tag applies every repeated a and r tag', async () => {
	const state = fixture();
	try {
		insertFeed(state.database);
		insertItem(state.database, 11, '2026-08-15T12:00:00.000Z');
		const add = await greaderPost(
			state.env,
			'edit-tag',
			'i=11&a=user/-/state/com.google/starred&a=user/-/state/com.google/read',
			'application/x-www-form-urlencoded',
		);
		assert.equal(add.status, 200);
		assert.equal(isStarred(state.database, 11), 1);
		assert.equal(isRead(state.database, 11), 1);

		const remove = await greaderPost(
			state.env,
			'edit-tag',
			'i=11&r=user/-/state/com.google/kept-unread&r=user/-/state/com.google/read&r=user/-/state/com.google/starred',
			'application/x-www-form-urlencoded',
		);
		assert.equal(remove.status, 200);
		assert.equal(isStarred(state.database, 11), 0);
		assert.equal(isRead(state.database, 11), 0);
	} finally {
		state.database.close();
	}
});
