import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { generateApiToken } from '../src/api-auth';
import { handleNativeApiRequest } from '../src/native-api';
import worker from '../src/index';
import type { Env } from '../src/types';

class Statement {
	private values: (string | number)[] = [];
	constructor(private database: DatabaseSync, private sql: string) {}
	bind(...values: (string | number)[]): this { this.values = values; return this; }
	async all<T>() { return { results: this.database.prepare(this.sql).all(...this.values) as T[] }; }
	async first<T>() { return (this.database.prepare(this.sql).get(...this.values) as T) ?? null; }
	async run() { return this.database.prepare(this.sql).run(...this.values); }
}

async function fixture(t: TestContext) {
	const database = new DatabaseSync(':memory:');
	t.after(() => database.close());
	database.exec(readFileSync(new URL('../04-storage/SCHEMA.sql', import.meta.url), 'utf8'));
	const env = { API_PASSWORD: 'test-secret', DB: { prepare: (sql: string) => new Statement(database, sql) } } as unknown as Env;
	const auth = `GoogleLogin auth=pigeon/${await generateApiToken(env.API_PASSWORD)}`;
	database.exec(`INSERT INTO feeds (rowid, feed_key, display_name, custom_title, source_type, category, is_active)
		VALUES (1, 'one', 'Weekly Original', 'Weekly Custom', 'rss', 'Design', 1),
		(2, 'two', 'Second Feed', NULL, 'email', NULL, 1), (3, 'inactive', 'Hidden Feed', NULL, 'rss', NULL, 0);
		INSERT INTO feed_tags (feed_key, label) VALUES ('one', 'Design'), ('one', 'Other'), ('two', '100%_literal');`);
	function insert(id: number, options: { feed?: string; title?: string; author?: string; email?: string; text?: string; date?: string; read?: number; starred?: number } = {}) {
		database.prepare(`INSERT INTO items (rowid, id, feed_key, subject, from_name, from_email, html_content, text_content, received_at, is_read, is_starred)
			VALUES (?, ?, ?, ?, ?, ?, '<p>body</p>', ?, ?, ?, ?)`)
			.run(id, `item-${id}`, options.feed ?? 'one', options.title ?? `Story ${id}`, options.author ?? null,
				options.email ?? null, options.text ?? '', options.date ?? '2026-10-12T12:00:00.000Z', options.read ?? 0, options.starred ?? 0);
	}
	function request(params: Record<string, string> = {}, options: { auth?: string | null; method?: string } = {}) {
		const url = new URL('https://pigeon.example/api/v1/browser/articles');
		for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
		return new Request(url, { method: options.method ?? 'GET', headers: options.auth === null ? {} : { Authorization: options.auth ?? auth } });
	}
	async function query(params: Record<string, string> = {}) {
		const response = await handleNativeApiRequest(request(params), env);
		assert.equal(response.status, 200, await response.clone().text());
		return await response.json() as { itemIds: string[]; continuation: string | null; hasMore: boolean; sort: string };
	}
	return { database, env, insert, request, query };
}

test('route authenticates before touching storage and supports only GET', async (t) => {
	const state = await fixture(t);
	assert.equal((await worker.fetch(state.request({}, { auth: null }), state.env)).status, 401);
	assert.equal((await worker.fetch(state.request({}, { auth: 'GoogleLogin auth=pigeon/wrong' }), state.env)).status, 401);
	assert.equal((await worker.fetch(state.request({}, { method: 'POST' }), state.env)).status, 405);
	state.insert(1);
	assert.equal((await worker.fetch(state.request(), state.env)).status, 200);
});

for (const sort of ['newest', 'oldest']) {
	test(`${sort} traverses 237 articles across bounded pages with timestamp ties`, async (t) => {
		const state = await fixture(t);
		for (let id = 1; id <= 237; id++) state.insert(id, { date: id < 100 ? '2026-10-11 12:00:00' : '2026-10-12T12:00:00.000Z' });
		state.insert(238, { feed: 'inactive' });
		let continuation: string | null = null;
		const actual: string[] = [];
		let pages = 0;
		do {
			const page = await state.query({ sort, limit: '100', ...(continuation ? { continuation } : {}) });
			assert.ok(page.itemIds.length <= 100);
			assert.equal(page.hasMore, page.continuation !== null);
			actual.push(...page.itemIds);
			continuation = page.continuation;
			assert.ok(++pages <= 3);
		} while (continuation);
		const expected = Array.from({ length: 237 }, (_, index) => String(index + 1));
		if (sort === 'newest') expected.reverse();
		assert.deepEqual(actual, expected);
		assert.equal(new Set(actual).size, 237);
	});
}

test('equivalent SQLite/ISO dates tie by row ID rather than string formatting', async (t) => {
	const state = await fixture(t);
	state.insert(1, { date: '2026-10-12T12:00:00.000Z' });
	state.insert(2, { date: '2026-10-12 12:00:00' });
	state.insert(3, { date: '2026-10-12T12:00:00Z' });
	const first = await state.query({ limit: '1' });
	const second = await state.query({ limit: '1', continuation: first.continuation! });
	const third = await state.query({ limit: '1', continuation: second.continuation! });
	assert.deepEqual([...first.itemIds, ...second.itemIds, ...third.itemIds], ['3', '2', '1']);
});

test('all/feed/folder/read/starred streams and state filters combine correctly without duplicate folder rows', async (t) => {
	const state = await fixture(t);
	state.insert(1);
	state.insert(2, { read: 1, starred: 1 });
	state.insert(3, { feed: 'two', starred: 1 });
	state.insert(4, { feed: 'inactive' });
	assert.deepEqual((await state.query()).itemIds, ['3', '2', '1']);
	assert.deepEqual((await state.query({ stream: 'reading-list' })).itemIds, ['3', '2', '1']);
	assert.deepEqual((await state.query({ stream: 'read' })).itemIds, ['2']);
	assert.deepEqual((await state.query({ stream: 'starred' })).itemIds, ['3', '2']);
	assert.deepEqual((await state.query({ stream: 'feed/1' })).itemIds, ['2', '1']);
	assert.deepEqual((await state.query({ stream: 'feed/999' })).itemIds, []);
	assert.deepEqual((await state.query({ stream: 'user/-/label/Design' })).itemIds, ['2', '1']);
	assert.deepEqual((await state.query({ stream: 'user/-/label/Other' })).itemIds, ['2', '1']);
	assert.deepEqual((await state.query({ stream: 'user/-/label/100%_literal' })).itemIds, ['3']);
	assert.deepEqual((await state.query({ stream: 'user/-/state/com.google/read' })).itemIds, ['2']);
	assert.deepEqual((await state.query({ stream: 'user/-/state/com.google/starred', filter: 'unread' })).itemIds, ['3']);
	assert.deepEqual((await state.query({ filter: 'read' })).itemIds, ['2']);
	assert.deepEqual((await state.query({ filter: 'unread' })).itemIds, ['3', '1']);
});

test('search finds titles/authors/RSS author fallback/custom feed titles/text outside the first page', async (t) => {
	const state = await fixture(t);
	for (let id = 1; id <= 105; id++) state.insert(id);
	state.insert(106, { title: 'special title' });
	state.insert(107, { author: 'special author' });
	state.insert(108, { email: 'special RSS author fallback' });
	state.insert(109, { text: 'special body words' });
	state.insert(110, { feed: 'two', email: 'special sender email is not author' });
	state.database.prepare('UPDATE items SET subject = ? WHERE rowid = 1').run('special title beyond first page');
	assert.deepEqual((await state.query({ q: 'SPECIAL' })).itemIds, ['109', '108', '107', '106', '1']);
	const first = await state.query({ q: 'Weekly Custom', limit: '100' });
	assert.equal(first.itemIds.length, 100);
	assert.equal((await state.query({ q: 'Weekly Custom', limit: '100', continuation: first.continuation! })).itemIds.length, 9);
	assert.deepEqual((await state.query({ q: 'Second Feed' })).itemIds, ['110']);
	assert.deepEqual((await state.query({ q: 'Weekly Original' })).itemIds, []);
});

test('search and folder names treat SQL injection and LIKE wildcards literally', async (t) => {
	const state = await fixture(t);
	state.insert(1, { title: 'plain title' });
	state.insert(2, { title: 'literal 100%_value\\path' });
	state.insert(3, { title: "literal ' OR 1=1 --" });
	assert.deepEqual((await state.query({ q: '%' })).itemIds, ['2']);
	assert.deepEqual((await state.query({ q: '_' })).itemIds, ['2']);
	assert.deepEqual((await state.query({ q: '\\' })).itemIds, ['2']);
	assert.deepEqual((await state.query({ q: "' OR 1=1 --" })).itemIds, ['3']);
	assert.deepEqual((await state.query({ stream: "user/-/label/' OR 1=1 --" })).itemIds, []);
	assert.equal(state.database.prepare('SELECT count(*) AS count FROM items').get()!.count, 3);
});

test('Today bounds are inclusive/exclusive and combine with search and pagination', async (t) => {
	const state = await fixture(t);
	state.insert(1, { date: '2026-10-12T03:59:59.000Z' });
	state.insert(2, { date: '2026-10-12T04:00:00.000Z' });
	state.insert(3, { date: '2026-10-13T03:59:59.000Z' });
	state.insert(4, { date: '2026-10-13T04:00:00.000Z' });
	assert.deepEqual((await state.query({ since: '2026-10-12T04:00:00Z', before: '2026-10-13T04:00:00Z' })).itemIds, ['3', '2']);
});

test('cursor is tied to the complete normalized query and rejects malformed positions', async (t) => {
	const state = await fixture(t);
	state.insert(1); state.insert(2);
	const page = await state.query({ limit: '1' });
	for (const changes of [{ sort: 'oldest' }, { filter: 'unread' }, { q: 'story' }, { stream: 'feed/1' }, { since: '2026-10-12T00:00:00Z' }]) {
		assert.equal((await handleNativeApiRequest(state.request({ ...changes, continuation: page.continuation! }), state.env)).status, 400);
	}
	assert.deepEqual((await state.query({ stream: 'all', limit: '100', continuation: page.continuation! })).itemIds, ['1']);
	const cursor = JSON.parse(atob(page.continuation!.replace(/-/g, '+').replace(/_/g, '/')));
	for (const invalid of ['', 'invalid!', 'x'.repeat(1025), btoa('{}'), btoa(JSON.stringify({ ...cursor, rowid: -1 })), btoa(JSON.stringify({ ...cursor, date: 'bad' })), btoa(JSON.stringify({ ...cursor, v: 2 }))]) {
		assert.equal((await handleNativeApiRequest(state.request({ continuation: invalid }), state.env)).status, 400);
	}
});

test('invalid query inputs fail closed, including unsupported score sort and ambiguous duplicates', async (t) => {
	const state = await fixture(t);
	for (const params of [{ limit: '0' }, { limit: '101' }, { limit: '2.5' }, { sort: 'score' }, { sort: 'recommended' }, { filter: 'unknown' }, { stream: 'feed/0' }, { stream: 'feed/1 OR 1=1' }, { stream: 'bad' }, { q: 'x'.repeat(201) }, { since: '2026-02-30T00:00:00Z' }, { before: '2026-10-12' }, { since: '2026-10-12T00:00:00Z', before: '2026-10-11T00:00:00Z' }, { unknown: 'value' }]) {
		assert.equal((await handleNativeApiRequest(state.request(params), state.env)).status, 400, JSON.stringify(params));
	}
	const duplicate = new URL(state.request().url); duplicate.search = 'filter=all&filter=unread';
	assert.equal((await handleNativeApiRequest(new Request(duplicate, { headers: state.request().headers }), state.env)).status, 400);
});

test('database failures return a recoverable error without disclosing query internals', async (t) => {
	const state = await fixture(t);
	await state.query();
	state.database.exec('DROP TABLE items');
	const response = await handleNativeApiRequest(state.request(), state.env);
	assert.equal(response.status, 503);
	assert.deepEqual(await response.json(), { error: 'Could not query articles' });
});
