import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { generateApiToken } from '../src/api-auth';
import app from '../src/index';
import { handleStaleFeeds } from '../src/stale-feeds-api';

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
