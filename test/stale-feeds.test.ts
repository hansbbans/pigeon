import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { generateApiToken } from '../src/api-auth';
import app from '../src/index';
import { handleStaleFeeds } from '../src/stale-feeds-api';
import { subscribeToFeed } from '../src/subscribe';

class Statement {
	private values: unknown[] = [];
	constructor(private readonly db: DatabaseSync, private readonly sql: string) {}
	bind(...values: unknown[]): this { this.values = values; return this; }
	async all<T>(): Promise<{ results: T[] }> { return { results: this.db.prepare(this.sql).all(...this.values) as T[] }; }
	async first<T>(): Promise<T | null> { return (this.db.prepare(this.sql).get(...this.values) as T | undefined) ?? null; }
	async run(): Promise<{ meta: { changes: number } }> {
		const result = this.db.prepare(this.sql).run(...this.values);
		return { meta: { changes: Number(result.changes) } };
	}
}

class DB {
	constructor(readonly sqlite: DatabaseSync) {}
	prepare(sql: string): Statement { return new Statement(this.sqlite, sql); }
	async batch(statements: Statement[]): Promise<Array<{ meta: { changes: number } }>> {
		const results = [];
		for (const statement of statements) results.push(await statement.run());
		return results;
	}
}

function fixture() {
	const sqlite = new DatabaseSync(':memory:');
	sqlite.exec(readFileSync(new URL('../04-storage/SCHEMA.sql', import.meta.url), 'utf8'));
	const db = new DB(sqlite);
	return { sqlite, env: { DB: db } as never };
}

test('stale feed inventory reports article, refresh, and HTTP evidence', async () => {
	const state = fixture();
	state.sqlite.prepare(
		`INSERT INTO feeds (rowid, feed_key, display_name, source_type, source_url, first_seen_at, last_success_at, last_http_status)
		 VALUES (7, 'quiet', 'Quiet Feed', 'rss', 'https://example.com/feed', '2020-01-01T00:00:00Z', '2025-01-01T00:00:00Z', 304)`,
	).run();
	state.sqlite.prepare(
		`INSERT INTO items (id, feed_key, subject, html_content, message_id, received_at)
		 VALUES ('old-item', 'quiet', 'Old', '<p>Old</p>', 'old-message', '2025-01-02T00:00:00Z')`,
	).run();
	const token = await generateApiToken('secret-password');
	const response = await app.fetch(
		new Request('https://pigeon.example/api/v1/stale-feeds?days=90', {
			headers: { Authorization: `GoogleLogin auth=pigeon/${token}` },
		}),
		{ ...state.env, API_PASSWORD: 'secret-password', BASE_URL: 'https://pigeon.example' } as never,
	);
	const payload = await response.json() as { feeds: Array<Record<string, unknown>> };
	assert.equal(payload.feeds[0].streamId, 'feed/7');
	assert.equal(payload.feeds[0].lastArticleAt, '2025-01-02T00:00:00Z');
	assert.equal(payload.feeds[0].lastSuccessAt, '2025-01-01T00:00:00Z');
	assert.equal(payload.feeds[0].httpStatus, 304);
	state.sqlite.close();
});

test('archive and unarchive are bounded idempotent bulk operations', async () => {
	const state = fixture();
	state.sqlite.prepare(
		`INSERT INTO feeds (feed_key, display_name, source_type, source_url, first_seen_at)
		 VALUES ('quiet', 'Quiet Feed', 'rss', 'https://example.com/feed', '2020-01-01T00:00:00Z')`,
	).run();
	const update = (action: string) => handleStaleFeeds(new Request('https://pigeon.example/api/v1/stale-feeds', {
		method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, feedKeys: ['quiet'] }),
	}), state.env);
	assert.equal((await update('archive')).status, 200);
	assert.equal((await update('archive')).status, 200);
	assert.equal((state.sqlite.prepare("SELECT stale_archived FROM feeds WHERE feed_key = 'quiet'").get() as { stale_archived: number }).stale_archived, 1);
	assert.equal((await update('unarchive')).status, 200);
	assert.equal((state.sqlite.prepare("SELECT stale_archived FROM feeds WHERE feed_key = 'quiet'").get() as { stale_archived: number }).stale_archived, 0);
	state.sqlite.close();
});


test('stale archive accepts the exact key of a subscription with a long valid source path', async () => {
	const state = fixture();
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = async () => new Response('<rss version="2.0"><channel><title>Long source</title><item><guid>one</guid><title>Old story</title><pubDate>2020-01-01T12:00:00Z</pubDate><description>Body</description></item></channel></rss>', { headers: { 'Content-Type': 'application/rss+xml' } });
		const subscription = await subscribeToFeed(state.env, `https://feeds.example.com/${'archive-path-'.repeat(30)}feed.xml`);
		assert.ok(subscription.feed_key.length > 200);
		const inventory = await handleStaleFeeds(new Request('https://pigeon.example/api/v1/stale-feeds'), state.env);
		assert.equal((await inventory.json() as { feeds: { feedKey: string }[] }).feeds[0].feedKey, subscription.feed_key);
		for (const action of ['archive', 'unarchive']) {
			const response = await handleStaleFeeds(new Request('https://pigeon.example/api/v1/stale-feeds', {
				method: 'POST', body: JSON.stringify({ action, feedKeys: [subscription.feed_key] }),
			}), state.env);
			assert.equal(response.status, 200);
			assert.equal((state.sqlite.prepare('SELECT stale_archived FROM feeds WHERE feed_key = ?').get(subscription.feed_key) as { stale_archived: number }).stale_archived, action === 'archive' ? 1 : 0);
		}
	} finally {
		globalThis.fetch = originalFetch;
		state.sqlite.close();
	}
});

test('stale archive applies the stored identifier UTF8 boundary without truncating keys', async () => {
	const state = fixture();
	try {
		const key = 'a'.repeat(8_000);
		state.sqlite.prepare('INSERT INTO feeds (feed_key, display_name) VALUES (?, ?)').run(key, 'Boundary');
		for (const [feedKey, expectedStatus] of [[key, 200], ['a'.repeat(8_001), 400], ['😀'.repeat(2_001), 400]] as const) {
			const response = await handleStaleFeeds(new Request('https://pigeon.example/api/v1/stale-feeds', {
				method: 'POST', body: JSON.stringify({ action: 'archive', feedKeys: [feedKey] }),
			}), state.env);
			assert.equal(response.status, expectedStatus);
		}
		assert.equal((state.sqlite.prepare('SELECT stale_archived FROM feeds WHERE feed_key = ?').get(key) as { stale_archived: number }).stale_archived, 1);
	} finally {
		state.sqlite.close();
	}
});
