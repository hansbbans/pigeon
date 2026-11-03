/**
 * Legacy timestamps in the JSON APIs the iOS app reads.
 *
 * Older D1 rows can hold SQLite `datetime('now')` values (`YYYY-MM-DD HH:MM:SS`,
 * UTC without `T`/`Z`), and a damaged row can hold something unparseable. The
 * app's decoder rejects the whole response when any date is not ISO 8601, so
 * every date these endpoints return must be ISO 8601 UTC or null.
 */
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';

import { generateApiToken } from '../src/api-auth';
import app from '../src/index';
import { handleRecommendations, RecommendationSessions } from '../src/recommendations';
import { apiTimestamp, toISO8601 } from '../src/timestamps';
import { MONITORED_TOPICS_META_KEY } from '../src/topic-preferences';

const PASSWORD = 'legacy-password';
const BASE_URL = 'https://pigeon.example';
const NOW = '2026-11-01T12:00:00.000Z';
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

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

	async batch(statements: SqliteStatement[]): Promise<unknown[]> {
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

const LEGACY_ITEM = '5a8bcf07-1c2d-4e3f-8a9b-0c1d2e3f4a5b';
const OLD_ITEM = '6b9cd018-2d3e-4f50-9bac-1d2e3f4a5b6c';
const GARBAGE_ITEM = '7cade129-3e4f-4061-acbd-2e3f4a5b6c7d';

async function legacyLibrary(t: TestContext) {
	t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
	const database = new DatabaseSync(':memory:');
	database.exec('PRAGMA foreign_keys = ON');
	database.exec(readFileSync(new URL('../04-storage/SCHEMA.sql', import.meta.url), 'utf8'));
	database.exec(`
		INSERT INTO feeds (rowid, feed_key, display_name, source_type, source_url, site_url, first_seen_at,
		  last_fetched_at, last_attempt_at, last_success_at, next_fetch_at, retry_after_at, consecutive_failures,
		  last_http_status, last_refresh_outcome, last_fetch_duration_ms, fetch_error)
		VALUES (1, 'legacy-feed', 'Legacy Feed', 'rss', 'https://legacy.example.com/feed', 'https://legacy.example.com',
		  '2026-02-11 01:33:50', '2026-11-01 11:30:00', '2026-11-01 11:30:00', '2026-10-01 08:00:00',
		  '2026-11-01 12:30:00', 'not a date', 1, 500, 'http_error', 300, 'HTTP 500');
		INSERT INTO feeds (rowid, feed_key, display_name, source_type, source_url, first_seen_at)
		VALUES (2, 'quiet-feed', 'Quiet Feed', 'rss', 'https://quiet.example.com/feed', '2024-01-01 00:00:00');
		INSERT INTO feeds (rowid, feed_key, display_name, source_type, source_url, first_seen_at, last_success_at, stale_archived)
		VALUES (3, 'broken-feed', 'Broken Feed', 'rss', 'https://broken.example.com/feed', '2024-01-01 00:00:00', 'garbage', 1);
		INSERT INTO refresh_activity (id, feed_key, attempted_at, completed_at, outcome, http_status, duration_ms,
		  items_added, error_code, error_message, retry_at)
		VALUES ('legacy-activity', 'legacy-feed', '2026-11-01 11:30:00', '2026-11-01 11:30:00', 'http_error', 500, 300,
		  0, 'http_500', 'HTTP 500', '2026-11-01 13:00:00'),
		       ('garbage-activity', 'legacy-feed', 'garbage', 'garbage', 'http_error', 500, 300, 0, NULL, NULL, '');
		INSERT INTO _meta (key, value) VALUES ('${MONITORED_TOPICS_META_KEY}', '["typography"]');
	`);
	const insertItem = database.prepare(
		`INSERT INTO items (rowid, id, feed_key, subject, html_content, text_content, message_id, received_at, is_read)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
	);
	insertItem.run(1, LEGACY_ITEM, 'legacy-feed', 'Typography in legacy rows', '<p>Typography matters.</p>',
		'Typography matters.', 'legacy-1', '2026-11-01 09:00:00');
	insertItem.run(2, OLD_ITEM, 'quiet-feed', 'Typography from long ago', '<p>Old typography.</p>',
		'Old typography.', 'legacy-2', '2025-01-15 00:00:00');
	insertItem.run(3, GARBAGE_ITEM, 'broken-feed', 'Typography with no date', '<p>Undated typography.</p>',
		'Undated typography.', 'legacy-3', 'garbage');
	database.exec(`
		INSERT INTO engagement_events (id, event_key, item_id, feed_key, event_type, client_family, occurred_at)
		VALUES ('legacy-event', 'legacy-event', '${LEGACY_ITEM}', 'legacy-feed', 'explicit_open', 'pigeon', '2026-11-01 10:00:00'),
		       ('garbage-event', 'garbage-event', '${LEGACY_ITEM}', 'legacy-feed', 'explicit_open', 'pigeon', 'garbage');
		INSERT INTO mutation_receipts (mutation_id, mutation_kind, applied_at, result_json)
		VALUES ('legacy-receipt', 'set_read', '2026-10-30 05:00:00',
		        '{"mutationId":"legacy-receipt","status":"applied","appliedAt":"2026-10-30 05:00:00"}'),
		       ('damaged-receipt', 'set_read', '2026-10-31 07:00:00', '{not json'),
		       ('empty-receipt', 'set_read', '2026-10-31 08:00:00', '{"appliedAt":""}'),
		       ('lost-receipt', 'set_read', 'garbage', '{}');
	`);

	const sessions = new RecommendationSessions();
	const env = {
		API_PASSWORD: PASSWORD,
		BASE_URL,
		ITEMS_PER_FEED: '50',
		DB: new SqliteD1(database),
		RECOMMENDATIONS: { getByName: () => ({ fetch: (request: Request) => handleRecommendations(request, env as never, sessions) }) },
	};
	const token = await generateApiToken(PASSWORD);
	t.after(() => database.close());
	return {
		database,
		async get(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
			const headers = new Headers(init.headers);
			headers.set('Authorization', `GoogleLogin auth=pigeon/${token}`);
			headers.set('Accept', 'application/json');
			const response = await app.fetch(new Request(`${BASE_URL}${path}`, { ...init, headers }), env as never);
			const body = await response.text();
			assert.equal(response.status, 200, `${path}: ${body}`);
			return JSON.parse(body) as Record<string, unknown>;
		},
	};
}

/** Every `...At` field and `cutoff` anywhere in the body is ISO 8601 UTC or null. */
function assertDatesAreISO(value: unknown, path = '$'): void {
	if (Array.isArray(value)) {
		value.forEach((entry, index) => assertDatesAreISO(entry, `${path}[${index}]`));
		return;
	}
	if (!value || typeof value !== 'object') return;
	for (const [key, entry] of Object.entries(value)) {
		if ((key.endsWith('At') || key === 'cutoff') && entry !== null) {
			assert.equal(typeof entry, 'string', `${path}.${key} must be a string or null`);
			assert.match(entry as string, ISO_UTC, `${path}.${key} is not ISO 8601 UTC: ${JSON.stringify(entry)}`);
		}
		assertDatesAreISO(entry, `${path}.${key}`);
	}
}

type Row = Record<string, unknown>;

test('apiTimestamp keeps ISO values byte-identical and converts SQLite datetime values', () => {
	assert.equal(apiTimestamp('2026-11-01T10:06:00Z'), '2026-11-01T10:06:00Z');
	assert.equal(apiTimestamp('2026-11-01T10:06:00.123Z'), '2026-11-01T10:06:00.123Z');
	assert.equal(apiTimestamp('2026-11-01 10:06:00'), '2026-11-01T10:06:00.000Z');
	assert.equal(apiTimestamp('2026-11-01 10:06:00.5'), '2026-11-01T10:06:00.500Z');
	assert.equal(apiTimestamp('2026-11-01T12:06:00+02:00'), '2026-11-01T10:06:00.000Z');
	assert.equal(apiTimestamp('2026-11-01T10:06:00.123456Z'), '2026-11-01T10:06:00.123Z');
	assert.equal(apiTimestamp('2026-13-01T10:06:00Z'), null);
	assert.equal(apiTimestamp('garbage'), null);
	assert.equal(apiTimestamp(''), null);
	assert.equal(apiTimestamp(null), null);
	assert.equal(apiTimestamp(undefined), null);
	// The sync endpoint's strict form still canonicalizes and rejects garbage.
	assert.equal(toISO8601('2026-11-01 10:06:00'), '2026-11-01T10:06:00.000Z');
	assert.equal(toISO8601('2026-11-01T10:06:00Z'), '2026-11-01T10:06:00.000Z');
	assert.throws(() => toISO8601('garbage'), /Invalid database timestamp/);
});

test('recommendations return ISO receivedAt for legacy rows and skip undated items', async (t) => {
	const library = await legacyLibrary(t);
	for (const view of ['for-you', 'unread']) {
		const body = await library.get(`/api/v1/recommendations?view=${view}`);
		assertDatesAreISO(body);
		const items = body.items as Row[];
		const legacy = items.find((item) => item.id === LEGACY_ITEM);
		assert.ok(legacy, `${view}: legacy item missing`);
		assert.equal(legacy.receivedAt, '2026-11-01T09:00:00.000Z', view);
		assert.equal(items.some((item) => item.id === GARBAGE_ITEM), false, `${view}: undated item returned`);
	}
});

test('stale feeds return ISO lastArticleAt and null for unreadable dates', async (t) => {
	const library = await legacyLibrary(t);
	const body = await library.get('/api/v1/stale-feeds?days=90');
	assertDatesAreISO(body);
	const feeds = body.feeds as Row[];
	const quiet = feeds.find((feed) => feed.feedKey === 'quiet-feed');
	assert.equal(quiet?.lastArticleAt, '2025-01-15T00:00:00.000Z');
	const broken = feeds.find((feed) => feed.feedKey === 'broken-feed');
	assert.ok(broken, 'archived feed missing');
	assert.equal(broken.lastArticleAt, null);
	assert.equal(broken.lastSuccessAt, null);
});

test('app status returns ISO times, null for unreadable optional times, and skips undated activity', async (t) => {
	const library = await legacyLibrary(t);
	const body = await library.get('/app/status');
	assertDatesAreISO(body);
	const syncHealth = body.syncHealth as { feeds: Row[]; recentActivity: Row[] };
	const feed = syncHealth.feeds.find((entry) => entry.feedKey === 'legacy-feed');
	assert.equal(feed?.lastAttemptAt, '2026-11-01T11:30:00.000Z');
	assert.equal(feed?.lastSuccessAt, '2026-10-01T08:00:00.000Z');
	assert.equal(feed?.nextFetchAt, '2026-11-01T12:30:00.000Z');
	assert.equal(feed?.retryAt, null);
	assert.deepEqual(syncHealth.recentActivity.map((activity) => [activity.attemptedAt, activity.retryAt]), [
		['2026-11-01T11:30:00.000Z', '2026-11-01T13:00:00.000Z'],
	]);
	// MAX(received_at) picks the unreadable value, which is reported as unknown.
	assert.equal((body.items as Row).newestAt, null);
	assert.equal((body.rss as Row).latestFetchAttemptAt, '2026-11-01T11:30:00.000Z');
	assert.equal(((body.feeds as Row).failing as Row[])[0].lastFetchedAt, '2026-11-01T11:30:00.000Z');

	library.database.prepare('DELETE FROM items WHERE id = ?').run(GARBAGE_ITEM);
	const items = (await library.get('/app/status')).items as Row;
	assert.equal(items.newestAt, '2026-11-01T09:00:00.000Z');
	assert.equal(items.newestRssAt, '2026-11-01T09:00:00.000Z');
});

test('personalization history returns ISO occurredAt and skips undated events', async (t) => {
	const library = await legacyLibrary(t);
	for (const path of ['/api/v1/personalization', '/api/v1/personalization?download=1']) {
		const body = await library.get(path);
		assertDatesAreISO(body);
		assert.deepEqual((body.history as Row[]).map((entry) => [entry.id, entry.occurredAt]), [
			['legacy-event', '2026-11-01T10:00:00.000Z'],
		], path);
	}
});

test('mutation receipts replay an ISO appliedAt even when the stored receipt is legacy or damaged', async (t) => {
	const library = await legacyLibrary(t);
	const mutation = (id: string) => ({ id, kind: 'set_read', itemIds: [LEGACY_ITEM], value: true });
	const body = await library.get('/api/v1/mutations', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ mutations: ['legacy-receipt', 'damaged-receipt', 'empty-receipt', 'lost-receipt'].map(mutation) }),
	});
	assertDatesAreISO(body);
	assert.deepEqual((body.results as Row[]).map((result) => [result.mutationId, result.status, result.appliedAt]), [
		['legacy-receipt', 'already_applied', '2026-10-30T05:00:00.000Z'],
		// An unreadable receipt body falls back to the receipt row's own applied_at.
		['damaged-receipt', 'already_applied', '2026-10-31T07:00:00.000Z'],
		['empty-receipt', 'already_applied', '2026-10-31T08:00:00.000Z'],
		// With no readable time at all, the replay reports when it was confirmed.
		['lost-receipt', 'already_applied', NOW],
	]);
});
