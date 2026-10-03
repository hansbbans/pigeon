import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import app from '../src/index';

function createDatabase() {
	const sqlite = new DatabaseSync(':memory:');
	sqlite.exec(readFileSync(new URL('../04-storage/SCHEMA.sql', import.meta.url), 'utf8'));
	sqlite.exec(`INSERT INTO feeds (feed_key, display_name) VALUES ('test-feed', 'Test feed');
		INSERT INTO items (id, feed_key, subject, html_content, received_at)
		VALUES ('item-1', 'test-feed', 'First item', '<p>First body</p>', '2026-10-02T12:00:00.000Z'),
		       ('item-2', 'test-feed', 'Second item', '<p>Second body</p>', '2026-10-02T12:00:00.000Z');`);
	const bodyReads: string[] = [];
	const db = {
		prepare(sql: string) {
			let values: unknown[] = [];
			const statement = {
				bind(...bound: unknown[]) { values = bound; return statement; },
				async first<T>() { return (sqlite.prepare(sql).get(...values) ?? null) as T | null; },
				async all<T>() {
					if (sql.includes('html_content')) bodyReads.push(sql);
					return { results: sqlite.prepare(sql).all(...values) as T[] };
				},
				async run() { return { meta: sqlite.prepare(sql).run(...values) }; },
			};
			return statement;
		},
	};
	const env = { DB: db, BASE_URL: 'https://pigeon.example', ITEMS_PER_FEED: '50', API_PASSWORD: 'password' };
	const fetchFeed = (etag?: string) => app.fetch(new Request('https://pigeon.example/feed/test-feed', {
		headers: etag ? { 'If-None-Match': etag } : {},
	}), env as never);
	return { sqlite, bodyReads, fetchFeed };
}

test('unchanged feed cache checks avoid reading article bodies', async () => {
	const { sqlite, bodyReads, fetchFeed } = createDatabase();
	try {
		const first = await fetchFeed();
		assert.equal(first.status, 200);
		assert.equal(bodyReads.length, 1);
		const cached = await fetchFeed(first.headers.get('ETag')!);
		assert.equal(cached.status, 304);
		assert.equal(bodyReads.length, 1, 'A cache hit must not load or hash article bodies');
	} finally { sqlite.close(); }
});

test('real SQLite article revisions invalidate feed caches after edits, pruning, and deletion', async () => {
	const { sqlite, fetchFeed } = createDatabase();
	try {
		let response = await fetchFeed();
		let etag = response.headers.get('ETag')!;
		for (const update of [
			"UPDATE items SET html_content = '<p>Edited body</p>' WHERE id = 'item-1'",
			"UPDATE items SET text_content = 'Changed excerpt' WHERE id = 'item-1'",
			"UPDATE items SET html_content = '', text_content = NULL, content_pruned_at = '2026-10-02T13:00:00.000Z' WHERE id = 'item-1'",
			"DELETE FROM items WHERE id = 'item-1'",
			"UPDATE feeds SET custom_title = 'Renamed feed' WHERE feed_key = 'test-feed'",
		]) {
			sqlite.exec(update);
			response = await fetchFeed(etag);
			assert.equal(response.status, 200, update);
			assert.notEqual(response.headers.get('ETag'), etag, update);
			etag = response.headers.get('ETag')!;
			assert.equal((await fetchFeed(etag)).status, 304);
		}
	} finally { sqlite.close(); }
});

test('status changes and other feeds do not invalidate an unchanged Atom body', async () => {
	const { sqlite, bodyReads, fetchFeed } = createDatabase();
	try {
		const first = await fetchFeed();
		const etag = first.headers.get('ETag')!;
		sqlite.exec(`UPDATE items SET is_read = 1, is_starred = 1 WHERE id = 'item-1';
			INSERT INTO feeds (feed_key, display_name) VALUES ('unrelated-feed', 'Other feed');
			INSERT INTO items (id, feed_key, subject, html_content, received_at)
			VALUES ('unrelated-item', 'unrelated-feed', 'Other article', '<p>Other body</p>', '2026-10-02T13:00:00.000Z');`);
		assert.equal((await fetchFeed(etag)).status, 304);
		assert.equal(bodyReads.length, 1);
	} finally { sqlite.close(); }
});

test('equal publication dates have the same stable order in cache membership and Atom output', async () => {
	const { sqlite, fetchFeed } = createDatabase();
	try {
		const response = await fetchFeed();
		const xml = await response.text();
		assert.ok(xml.indexOf('<title>Second item</title>') < xml.indexOf('<title>First item</title>'));
		assert.equal((await fetchFeed(response.headers.get('ETag')!)).status, 304);
	} finally { sqlite.close(); }
});
