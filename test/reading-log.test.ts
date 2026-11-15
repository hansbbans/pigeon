import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { generateApiToken } from '../src/api-auth';
import app from '../src/index';
import { createSchemaDatabase } from './helpers/sqlite-d1';

const PASSWORD = 'reading-log-password';
const BASE_URL = 'https://pigeon.example';

async function setup() {
	const { database, db } = createSchemaDatabase();
	database.exec(`
		INSERT INTO feeds (feed_key, display_name) VALUES ('daily-feed', 'Daily Feed');
		INSERT INTO items (id, feed_key, subject, html_content, message_id, received_at) VALUES
			('item-1', 'daily-feed', 'One', '<p>One</p>', 'message-1', '2026-11-01T10:00:00.000Z'),
			('item-2', 'daily-feed', 'Two', '<p>Two</p>', 'message-2', '2026-11-01T11:00:00.000Z');
	`);
	const env = { API_PASSWORD: PASSWORD, BASE_URL, ITEMS_PER_FEED: '50', DB: db };
	const token = await generateApiToken(PASSWORD);
	const post = (body: unknown, headers: Record<string, string> = { 'X-Pigeon-Client': 'pigeon-reader/1' }) =>
		app.fetch(new Request(`${BASE_URL}/api/v1/reading-log`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `GoogleLogin auth=pigeon/${token}`, ...headers },
			body: typeof body === 'string' ? body : JSON.stringify(body),
		}), env as never);
	const rows = () => database.prepare('SELECT * FROM reading_log ORDER BY occurred_at, id').all() as Array<Record<string, unknown>>;
	return { database, env, post, rows };
}

test('reading log requires authentication and POST', async () => {
	const { env, rows } = await setup();
	const unauthorized = await app.fetch(new Request(`${BASE_URL}/api/v1/reading-log`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ events: [{ itemId: 'item-1', type: 'impression', view: 'for-you' }] }),
	}), env as never);
	assert.equal(unauthorized.status, 401);

	const token = await generateApiToken(PASSWORD);
	const wrongMethod = await app.fetch(new Request(`${BASE_URL}/api/v1/reading-log`, {
		headers: { Authorization: `GoogleLogin auth=pigeon/${token}` },
	}), env as never);
	assert.equal(wrongMethod.status, 404);
	assert.equal(rows().length, 0);
});

test('reading log stores impressions with view, position, visible time, session and metadata', async () => {
	const { post, rows } = await setup();
	const response = await post({
		events: [
			{
				id: 'imp-1', itemId: 'item-1', type: 'impression', view: 'for-you', position: 0, value: 4.25,
				sessionId: 'session-a', occurredAt: '2026-11-15T09:00:00.000Z', metadata: { score: 82, ranker: 'v1' },
			},
			{ id: 'imp-2', itemId: 'item-2', type: 'impression', view: 'unread', position: 7, occurredAt: '2026-11-15T09:00:05.000Z' },
		],
	});
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { accepted: 2, skipped: 0, clientFamily: 'pigeon_ios' });

	const [first, second] = rows();
	assert.deepEqual(
		{ ...first, created_at: null },
		{
			id: 'imp-1', event_key: 'client:pigeon_ios:imp-1', event_type: 'impression', item_id: 'item-1', feed_key: 'daily-feed',
			client_family: 'pigeon_ios', view: 'for-you', position: 0, value: 4.25, session_id: 'session-a',
			metadata_json: '{"score":82,"ranker":"v1"}', occurred_at: '2026-11-15T09:00:00.000Z', created_at: null,
		},
	);
	assert.equal(second.view, 'unread');
	assert.equal(second.position, 7);
	assert.equal(second.value, null);
	assert.equal(second.session_id, null);
	assert.equal(second.metadata_json, null);
});

test('reading log is idempotent per client event id', async () => {
	const { post, rows } = await setup();
	const body = { events: [{ id: 'imp-1', itemId: 'item-1', type: 'impression', view: 'today', position: 2 }] };
	assert.equal((await post(body)).status, 200);
	assert.equal((await post(body)).status, 200);
	assert.equal(rows().length, 1);
});

test('reading log resolves Google Reader item ids and skips unknown items without failing the batch', async () => {
	const { database, post, rows } = await setup();
	const { rowid } = database.prepare("SELECT rowid FROM items WHERE id = 'item-2'").get() as { rowid: number };
	const googleItemId = `tag:google.com,2005:reader/item/${rowid.toString(16).padStart(16, '0')}`;
	const response = await post({
		events: [
			{ id: 'imp-known', itemId: googleItemId, type: 'impression', view: 'feed', position: 1 },
			{ id: 'imp-gone', itemId: 'deleted-item', type: 'impression', view: 'feed', position: 2 },
		],
	});
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { accepted: 1, skipped: 1, clientFamily: 'pigeon_ios' });
	assert.deepEqual(rows().map((row) => [row.id, row.item_id]), [['imp-known', 'item-2']]);
});

test('reading log keeps history after its article is deleted', async () => {
	const { database, post, rows } = await setup();
	await post({ events: [{ id: 'imp-1', itemId: 'item-1', type: 'impression', view: 'for-you', position: 0 }] });
	database.exec("DELETE FROM items WHERE id = 'item-1'");
	assert.equal(rows().length, 1);
});

test('reading log tells the web app, the iOS app and other clients apart, and stamps a missing time', async () => {
	const { post, rows } = await setup();
	const event = (id: string) => ({ events: [{ id, itemId: 'item-1', type: 'impression', view: 'unread' }] });
	assert.deepEqual(await (await post(event('web'), { 'X-Pigeon-Client': 'pigeon-web/1' })).json(), { accepted: 1, skipped: 0, clientFamily: 'pigeon_web' });
	assert.deepEqual(await (await post(event('ios'), { 'X-Pigeon-Client': 'pigeon-reader/1' })).json(), { accepted: 1, skipped: 0, clientFamily: 'pigeon_ios' });
	assert.deepEqual(await (await post(event('other'), { 'User-Agent': 'Mozilla/5.0' })).json(), { accepted: 1, skipped: 0, clientFamily: 'other' });
	assert.deepEqual(rows().map((row) => row.client_family).sort(), ['other', 'pigeon_ios', 'pigeon_web']);
	for (const row of rows()) assert.match(String(row.occurred_at), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('reading log rejects malformed batches without writing anything', async () => {
	const { post, rows } = await setup();
	const valid = { itemId: 'item-1', type: 'impression', view: 'for-you' };
	const invalidBodies: unknown[] = [
		'not json',
		{},
		{ events: [] },
		{ events: Array.from({ length: 201 }, () => valid) },
		{ events: [{ ...valid, type: 'explicit_open' }] },
		{ events: [{ ...valid, itemId: '' }] },
		{ events: [{ itemId: 'item-1', type: 'impression' }] },
		{ events: [{ ...valid, view: 'For You!' }] },
		{ events: [{ ...valid, position: -1 }] },
		{ events: [{ ...valid, position: 1.5 }] },
		{ events: [{ ...valid, value: -2 }] },
		{ events: [{ ...valid, value: 90_000 }] },
		{ events: [{ ...valid, sessionId: 'x'.repeat(101) }] },
		{ events: [{ ...valid, occurredAt: 'yesterday' }] },
		{ events: [{ ...valid, metadata: 'score' }] },
		{ events: [{ ...valid, metadata: { blob: 'x'.repeat(2_000) } }] },
		{ events: [valid, { ...valid, id: 7 }] },
	];
	for (const body of invalidBodies) {
		const response = await post(body);
		assert.equal(response.status, 400, JSON.stringify(body).slice(0, 80));
	}
	assert.equal(rows().length, 0);
});

test('reading log does not store request metadata that identifies the device', async () => {
	const { database } = await setup();
	const columns = (database.prepare('PRAGMA table_info(reading_log)').all() as Array<{ name: string }>).map(({ name }) => name);
	assert.equal(columns.some((name) => name === 'user_agent' || name === 'ip'), false);
});
