import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { generateApiToken } from '../src/api-auth';
import app from '../src/index';
import { createSchemaDatabase } from './helpers/sqlite-d1';

const PASSWORD = 'write-path-password';
const BASE_URL = 'https://pigeon.example';

async function setup() {
	const { database, db } = createSchemaDatabase();
	database.exec(`INSERT INTO feeds (feed_key, display_name, source_type, source_url)
		VALUES ('blog', 'Blog', 'rss', 'https://blog.example.com/feed.xml')`);
	const statements: string[] = [];
	const prepare = db.prepare.bind(db);
	db.prepare = ((sql: string) => {
		statements.push(sql);
		return prepare(sql);
	}) as typeof db.prepare;
	const env = { API_PASSWORD: PASSWORD, BASE_URL, ITEMS_PER_FEED: '50', DB: db };
	const token = await generateApiToken(PASSWORD);
	const request = (path: string, init: RequestInit = {}, authorized = true) => {
		const headers = new Headers(init.headers);
		if (authorized) headers.set('Authorization', `GoogleLogin auth=pigeon/${token}`);
		return app.fetch(new Request(`${BASE_URL}${path}`, { ...init, headers }), env as never);
	};
	const form = (path: string, body: Record<string, string>) => request(path, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams(body).toString(),
	});
	const insertArticle = (id: string, isRead: number) => database.prepare(
		`INSERT INTO items (id, feed_key, subject, html_content, message_id, received_at, is_read)
		 VALUES (?, 'blog', ?, '<p>body</p>', ?, ?, ?)`,
	).run(id, `Subject ${id}`, `m-${id}`, '2026-11-01T00:00:00.000Z', isRead);
	const count = (sql: string) => Number((database.prepare(sql).get() as { n: number }).n);
	return { database, statements, request, form, insertArticle, count };
}

for (const [name, init] of [
	['a JSON body', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"Passwd":"nope"}' }],
	['a plain-text body', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'hello' }],
	['an empty body', { method: 'POST' }],
	['a malformed multipart body', { method: 'POST', headers: { 'Content-Type': 'multipart/form-data' }, body: 'not multipart at all' }],
] as const) {
	test(`ClientLogin answers ${name} with BadAuthentication instead of throwing`, async () => {
		const s = await setup();
		const response = await s.request('/accounts/ClientLogin', init as RequestInit, false);
		assert.equal(response.status, 401);
		assert.equal(await response.text(), 'Error=BadAuthentication');
		s.database.close();
	});
}

test('ClientLogin still accepts a form-encoded password', async () => {
	const s = await setup();
	const response = await s.request('/accounts/ClientLogin', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ Email: 'pigeon', Passwd: PASSWORD }).toString(),
	}, false);
	assert.equal(response.status, 200);
	assert.match(await response.text(), /^SID=pigeon\//);
	s.database.close();
});

test('ClientLogin takes the password from the query string even when the form body has an empty one', async () => {
	const s = await setup();
	const response = await s.request(`/accounts/ClientLogin?Passwd=${PASSWORD}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: 'Email=pigeon&Passwd=',
	}, false);
	assert.equal(response.status, 200);
	s.database.close();
});

for (const [name, stream] of [
	['the reading list', 'user/-/state/com.google/reading-list'],
	['one feed', 'feed/1'],
] as const) {
	test(`mark-all-as-read on ${name} writes only the unread rows`, async () => {
		const s = await setup();
		for (let index = 0; index < 200; index += 1) s.insertArticle(`read-${index}`, 1);
		s.insertArticle('unread-1', 0);
		const before = s.count('SELECT total_changes() AS n');
		const response = await s.form('/reader/api/0/mark-all-as-read', { s: stream });
		assert.equal(response.status, 200);
		const written = s.count('SELECT total_changes() AS n') - before;
		assert.equal(s.count('SELECT COUNT(*) AS n FROM items WHERE is_read = 0'), 0);
		assert.ok(written < 20, `marking 1 unread article read (200 already read) wrote ${written} rows`);
		s.database.close();
	});
}

test('a status mutation looks up item_statuses by primary key instead of scanning it', async () => {
	const s = await setup();
	s.insertArticle('11111111-1111-4111-8111-111111111111', 0);
	const response = await s.request('/api/v1/mutations', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ mutations: [{ id: 'read-1', kind: 'set_read', itemIds: ['11111111-1111-4111-8111-111111111111'], value: true }] }),
	});
	assert.equal(((await response.json()) as { results: Array<{ status: string }> }).results[0].status, 'applied');
	const update = s.statements.find((sql) => /UPDATE item_statuses SET mutation_id/.test(sql));
	assert.ok(update, 'the mutation stamps item_statuses');
	const plan = (s.database.prepare(`EXPLAIN QUERY PLAN ${update}`).all() as Array<{ detail: string }>).map((row) => row.detail);
	assert.ok(!plan.some((detail) => /^SCAN item_statuses/.test(detail)), `plan scans the table: ${plan.join(' | ')}`);
	s.database.close();
});
