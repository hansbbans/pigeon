/**
 * API contract fixtures shared with the PigeonReader iOS app.
 *
 * Each case drives the real Worker router (`src/index.ts`) against an in-memory
 * SQLite database built from `04-storage/SCHEMA.sql`, using the requests the iOS
 * client sends, and compares the response with a fixture in
 * `test/fixtures/api-contract/`. The iOS suite `APIContractTests` decodes the
 * same fixtures with the app's production `PigeonAPIClient`, so a response
 * change that the shipped app cannot read fails here, in the Worker job.
 *
 * Changing a fixture is an API change: keep it backward compatible with the
 * build currently on TestFlight. To regenerate the response fixtures after an
 * intentional, compatible change:
 *
 *   UPDATE_CONTRACT_FIXTURES=1 npx tsx --test test/api-contract.test.ts
 *
 * Request fixtures (`*.request.json`) record what the iOS app sends; they are
 * never regenerated here. The iOS suite pins its encoders to them.
 */
import * as assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';

import { generateApiToken } from '../src/api-auth';
import app from '../src/index';
import { handleRecommendations, RecommendationSessions } from '../src/recommendations';
import { MONITORED_TOPICS_META_KEY } from '../src/topic-preferences';

const FIXTURES = new URL('./fixtures/api-contract/', import.meta.url);
const UPDATE = process.env.UPDATE_CONTRACT_FIXTURES === '1';
if (UPDATE && process.env.CI) {
	throw new Error('UPDATE_CONTRACT_FIXTURES must not be set in CI: regenerating fixtures would make every contract check pass.');
}
const PASSWORD = 'contract-password';
const BASE_URL = 'https://pigeon.example';
/** Wall clock for every request. SQLite `datetime('now')` values are pinned separately. */
const NOW = '2026-11-01T12:00:00.000Z';
const DB_NOW = '2026-11-01 11:00:00';

class SqliteStatement {
	private values: unknown[] = [];

	constructor(private readonly database: DatabaseSync, private readonly sql: string) {}

	bind(...values: unknown[]): this {
		if (values.length > 100) throw new Error('D1 maximum bound parameters exceeded');
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

	async execute(): Promise<{ results: unknown[]; meta: { changes: number } }> {
		const { results } = await this.all();
		const { changes } = this.database.prepare('SELECT changes() AS changes').get() as { changes: number };
		return { results, meta: { changes: Number(changes) } };
	}
}

class SqliteD1 {
	constructor(readonly database: DatabaseSync) {}

	prepare(sql: string): SqliteStatement {
		return new SqliteStatement(this.database, sql);
	}

	async batch(statements: SqliteStatement[]): Promise<Array<{ results: unknown[]; meta: { changes: number } }>> {
		this.database.exec('BEGIN IMMEDIATE');
		try {
			const results = [];
			for (const statement of statements) results.push(await statement.execute());
			this.database.exec('COMMIT');
			return results;
		} catch (error) {
			this.database.exec('ROLLBACK');
			throw error;
		}
	}
}

interface Library {
	database: DatabaseSync;
	env: never;
	/** Sends a request the way `PigeonAPIClient` does, through the Worker router. */
	request(path: string, init?: RequestInit): Promise<Response>;
	/** Pins the sync log's `datetime('now')` timestamps so sync pages are deterministic. */
	pinDatabaseClock(): void;
}

const ITEM = {
	durable: '0b3c7a52-5d1e-4f8e-9a51-1f2d3c4b5a61',
	typography: '1c4d8b63-6e2f-4a9f-8b62-2a3e4d5c6b72',
	brief: '2d5e9c74-7f3a-4bae-9c73-3b4f5e6d7c83',
	stale: '3e6fad85-8a4b-4cbf-ad84-4c5a6f7e8d94',
	removed: '4f7abe96-9b5c-4dc0-be95-5d6b7a8f9ea5',
};

/** A small library covering the shapes iOS reads: an RSS feed with a folder,
 * an email feed, a stale feed, read/starred/unread/pruned/paywalled items. */
async function library(t: TestContext): Promise<Library> {
	t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
	const database = new DatabaseSync(':memory:');
	database.exec('PRAGMA foreign_keys = ON');
	database.exec(readFileSync(new URL('../04-storage/SCHEMA.sql', import.meta.url), 'utf8'));
	database.exec(`
		INSERT INTO feeds (rowid, feed_key, display_name, source_type, source_url, site_url, icon_url, first_seen_at,
		  last_attempt_at, last_success_at, next_fetch_at, consecutive_failures, last_http_status,
		  last_refresh_outcome, last_fetch_duration_ms, canonical_url)
		VALUES (1, 'design-weekly', 'Design Weekly', 'rss', 'https://feeds.example.com/design.xml', 'https://example.com',
		  'https://example.com/icon.png', '2026-01-01T00:00:00.000Z', '2026-11-01T11:30:00.000Z', '2026-11-01T11:30:00.000Z',
		  '2026-11-01T12:30:00.000Z', 0, 200, 'success', 412, 'https://feeds.example.com/design.xml');
		INSERT INTO feeds (rowid, feed_key, display_name, from_email, source_type, first_seen_at)
		VALUES (2, 'morning-brief', 'Morning Brief', 'brief@news.example.com', 'email', '2026-01-01T00:00:00.000Z');
		INSERT INTO feeds (rowid, feed_key, display_name, source_type, source_url, site_url, first_seen_at,
		  last_attempt_at, last_success_at, next_fetch_at, consecutive_failures, last_http_status,
		  last_refresh_outcome, last_fetch_duration_ms, retry_after_at, fetch_error, canonical_url)
		VALUES (3, 'quiet-blog', 'Quiet Blog', 'rss', 'https://quiet.example.org/feed', 'https://quiet.example.org',
		  '2024-06-01T00:00:00.000Z', '2026-11-01T10:00:00.000Z', '2025-01-15T00:00:00.000Z', '2026-11-01T14:00:00.000Z',
		  3, 503, 'http_error', 1500, '2026-11-01T14:00:00.000Z', 'HTTP 503 Service Unavailable', 'https://quiet.example.org/feed');
		INSERT INTO feed_tags (feed_key, label) VALUES ('design-weekly', 'Design');
		INSERT INTO feed_tags (feed_key, label) VALUES ('quiet-blog', 'Blogs');
		INSERT INTO refresh_activity (id, feed_key, attempted_at, completed_at, outcome, http_status, duration_ms,
		  items_added, error_code, error_message, retry_at)
		VALUES ('activity-1', 'design-weekly', '2026-11-01T11:30:00.000Z', '2026-11-01T11:30:00.412Z', 'success', 200, 412,
		  2, NULL, NULL, NULL),
		       ('activity-2', 'quiet-blog', '2026-11-01T10:00:00.000Z', '2026-11-01T10:00:01.500Z', 'http_error', 503, 1500,
		  0, 'http_503', 'HTTP 503 Service Unavailable', '2026-11-01T14:00:00.000Z');
		INSERT INTO _meta (key, value) VALUES ('${MONITORED_TOPICS_META_KEY}', '["typography"]');
		INSERT INTO _meta (key, value) VALUES ('readwise_token', 'readwise-contract-token');
	`);
	const insertItem = database.prepare(
		`INSERT INTO items (rowid, id, feed_key, from_name, from_email, subject, html_content, text_content, original_url,
		  message_id, received_at, is_read, is_starred, content_pruned_at, content_version,
		  word_count, media_kind, duration_seconds)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	insertItem.run(1, ITEM.durable, 'design-weekly', 'Ada Lovelace', null, 'Typography for a durable reader',
		'<p>Typography decides whether a long read stays readable.</p>', 'Typography decides whether a long read stays readable.',
		'https://example.com/durable-reader', 'rss-durable', '2026-11-01T09:00:00.000Z', 0, 0, null, 2, 2380, 'text', null);
	insertItem.run(2, ITEM.typography, 'design-weekly', null, null, 'Notes on margins',
		'<p>Margins give text room.</p>', 'Margins give text room.',
		'https://example.com/margins', 'rss-margins', '2026-10-30T08:00:00.000Z', 1, 1, null, 1, 40, 'video', 1100);
	insertItem.run(3, ITEM.brief, 'morning-brief', 'Morning Brief', 'brief@news.example.com', 'Your Sunday brief',
		'<p>This week in brief.</p><div data-component-name="Paywall"><p>Keep reading with a paid subscription.</p></div>', null,
		null, 'email-brief', '2026-11-01T06:30:00.000Z', 0, 0, null, 0, null, null, null);
	insertItem.run(4, ITEM.stale, 'quiet-blog', null, null, 'Last post for a while',
		'', 'A short goodbye.', 'https://quiet.example.org/last', 'rss-last', '2025-01-15T00:00:00.000Z', 1, 0,
		'2025-06-01T00:00:00.000Z', 1, null, null, null);
	insertItem.run(5, ITEM.removed, 'morning-brief', null, null, 'Retracted', '<p>Gone</p>', null, null, 'email-gone',
		'2026-10-31T06:30:00.000Z', 0, 0, null, 0, null, null, null);
	database.prepare('DELETE FROM items WHERE id = ?').run(ITEM.removed);

	const db = new SqliteD1(database);
	const sessions = new RecommendationSessions();
	const env = {
		API_PASSWORD: PASSWORD,
		BASE_URL,
		ITEMS_PER_FEED: '50',
		DB: db,
		// Production forwards to the recommendations helper Worker; run the same handler in-process.
		RECOMMENDATIONS: { getByName: () => ({ fetch: (request: Request) => handleRecommendations(request, env as never, sessions) }) },
	};
	const token = await generateApiToken(PASSWORD);
	const pinDatabaseClock = () => {
		database.prepare('UPDATE sync_changes SET changed_at = ?').run(DB_NOW);
	};
	// Seeded statuses come from an insert trigger; mutations stamp their own appliedAt.
	database.prepare('UPDATE item_statuses SET updated_at = ?').run(DB_NOW);
	pinDatabaseClock();
	t.after(() => database.close());
	return {
		database,
		env: env as never,
		pinDatabaseClock,
		request(path, init = {}) {
			const headers = new Headers(init.headers);
			headers.set('Authorization', `GoogleLogin auth=pigeon/${token}`);
			headers.set('Accept', 'application/json');
			headers.set('X-Pigeon-Client', 'pigeon-reader/1');
			return app.fetch(new Request(`${BASE_URL}${path}`, { ...init, headers }), env as never);
		},
	};
}

function form(entries: Array<[string, string]>): RequestInit {
	return {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
		body: new URLSearchParams(entries).toString(),
	};
}

function json(method: string, body: unknown): RequestInit {
	return { method, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) };
}

function requestFixture(name: string): unknown {
	return JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8'));
}

async function assertMatchesFixture(response: Response, name: string, status = 200): Promise<void> {
	const body = await response.text();
	assert.equal(response.status, status, `${name}: ${body}`);
	const fixtureURL = new URL(name, FIXTURES);
	if (name.endsWith('.json')) {
		assert.match(response.headers.get('Content-Type') ?? '', /^application\/json/);
		const actual = JSON.parse(body) as unknown;
		if (UPDATE) writeFileSync(fixtureURL, `${JSON.stringify(actual, null, '\t')}\n`);
		assert.deepEqual(actual, JSON.parse(readFileSync(fixtureURL, 'utf8')), `${name} no longer matches its contract fixture`);
	} else {
		if (UPDATE) writeFileSync(fixtureURL, body);
		assert.equal(body, readFileSync(fixtureURL, 'utf8'), `${name} no longer matches its contract fixture`);
	}
}

test('ClientLogin returns the token line the app parses', async (t) => {
	const state = await library(t);
	const response = await app.fetch(new Request(`${BASE_URL}/accounts/ClientLogin`, form([
		['Email', 'pigeon'], ['Passwd', PASSWORD], ['service', 'reader'],
	])), state.env);
	await assertMatchesFixture(response, 'client-login.response.txt');
});

test('incremental sync page', async (t) => {
	const state = await library(t);
	await assertMatchesFixture(await state.request('/api/v1/sync?limit=200'), 'sync.response.json');
});

test('mutation batch: applied, then replayed', async (t) => {
	const state = await library(t);
	const request = requestFixture('mutations.request.json');
	await assertMatchesFixture(await state.request('/api/v1/mutations', json('POST', request)), 'mutations.response.json');
	t.mock.timers.setTime(Date.parse('2026-11-01T12:05:00.000Z'));
	await assertMatchesFixture(await state.request('/api/v1/mutations', json('POST', request)), 'mutations-replay.response.json');
	// The applied state is what the next sync page reports.
	state.pinDatabaseClock();
	await assertMatchesFixture(await state.request('/api/v1/sync?limit=200'), 'sync-after-mutations.response.json');
});

test('engagement ingestion accepts the app payload and feeds personalization', async (t) => {
	const state = await library(t);
	const response = await state.request('/api/v1/engagement', json('POST', requestFixture('engagement.request.json')));
	assert.equal(response.status, 200, await response.clone().text());
	await assertMatchesFixture(await state.request('/api/v1/personalization'), 'personalization.response.json');
});

test('personalization update returns the snapshot', async (t) => {
	const state = await library(t);
	await assertMatchesFixture(
		await state.request('/api/v1/personalization', json('PUT', { monitoredTopics: ['Typography', 'Climate policy'] })),
		'personalization-update.response.json',
	);
});

test('subscription list', async (t) => {
	const state = await library(t);
	await assertMatchesFixture(await state.request('/reader/api/0/subscription/list'), 'subscription-list.response.json');
});

test('unread counts', async (t) => {
	const state = await library(t);
	await assertMatchesFixture(await state.request('/reader/api/0/unread-count'), 'unread-count.response.json');
});

test('stream item ids page with continuation', async (t) => {
	const state = await library(t);
	await assertMatchesFixture(
		await state.request('/reader/api/0/stream/items/ids?s=user/-/state/com.google/reading-list&n=2'),
		'stream-item-ids.response.json',
	);
});

test('stream item contents for a Pigeon client', async (t) => {
	const state = await library(t);
	await assertMatchesFixture(
		await state.request('/reader/api/0/stream/items/contents', form([['i', '1'], ['i', '2'], ['i', '3'], ['i', '4']])),
		'stream-item-contents.response.json',
	);
});

test('quickadd subscribes to a discovered feed', async (t) => {
	const state = await library(t);
	t.mock.method(globalThis, 'fetch', async () => new Response(
		`<?xml version="1.0"?><rss version="2.0"><channel><title>Field Notes</title><link>https://notes.example.net/</link>
		<item><guid>note-1</guid><title>First note</title><link>https://notes.example.net/1</link>
		<pubDate>Sat, 31 Oct 2026 10:00:00 GMT</pubDate><description>Hello</description></item></channel></rss>`,
		{ status: 200, headers: { 'Content-Type': 'application/rss+xml' } },
	));
	await assertMatchesFixture(
		await state.request(`/reader/api/0/subscription/quickadd?quickadd=${encodeURIComponent('https://notes.example.net/feed.xml')}`),
		'quickadd.response.json',
	);
});

test('recommendations: for you', async (t) => {
	const state = await library(t);
	await assertMatchesFixture(await state.request('/api/v1/recommendations?view=for-you'), 'recommendations-for-you.response.json');
});

test('recommendations: unread', async (t) => {
	const state = await library(t);
	await assertMatchesFixture(await state.request('/api/v1/recommendations?view=unread&limit=30'), 'recommendations-unread.response.json');
});

test('Readwise token backup', async (t) => {
	const state = await library(t);
	await assertMatchesFixture(await state.request('/api/v1/readwise/token'), 'readwise-token.response.json');
});

test('server status with sync health', async (t) => {
	const state = await library(t);
	await assertMatchesFixture(await state.request('/app/status'), 'app-status.response.json');
});

test('stale feeds', async (t) => {
	const state = await library(t);
	await assertMatchesFixture(await state.request('/api/v1/stale-feeds?days=90'), 'stale-feeds.response.json');
});

test('Read It Later: save a link, upload its extraction, remove a save, then sync', async (t) => {
	const state = await library(t);
	const head = (state.database.prepare('SELECT MAX(sequence) AS head FROM sync_changes').get() as { head: number }).head;
	const createResponse = await state.request('/api/v1/saved', json('POST', requestFixture('saved-create.request.json')));
	const created = await createResponse.clone().json() as { id: string };
	await assertMatchesFixture(createResponse, 'saved-create.response.json', 201);
	await assertMatchesFixture(
		await state.request(`/api/v1/saved/${created.id}/content`, json('PUT', requestFixture('saved-content.request.json'))),
		'saved-content.response.json',
	);
	// A second save, removed again: the sync page carries its delete.
	const video = await state.request('/api/v1/saved', json('POST', { url: 'https://youtu.be/dQw4w9WgXcQ?si=share' }));
	assert.equal(video.status, 201);
	const removal = await state.request('/api/v1/mutations', json('POST', requestFixture('saved-remove.request.json')));
	assert.deepEqual((await removal.json() as { results: Array<{ status: string }> }).results.map((result) => result.status), ['applied']);
	state.pinDatabaseClock();
	await assertMatchesFixture(await state.request(`/api/v1/sync?limit=200&cursor=v1:${head}`), 'sync-saved.response.json');
});

test('YouTube transcript: store one for a video, read it back, then sync the signal', async (t) => {
	const state = await library(t);
	const head = (state.database.prepare('SELECT MAX(sequence) AS head FROM sync_changes').get() as { head: number }).head;
	const path = `/api/v1/items/${ITEM.typography}/transcript`;
	await assertMatchesFixture(
		await state.request(path, json('PUT', requestFixture('transcript-upload.request.json'))),
		'transcript-upload.response.json',
	);
	state.database.prepare('UPDATE item_transcripts SET created_at = ?').run(DB_NOW);
	await assertMatchesFixture(await state.request(path), 'transcript.response.json');
	state.pinDatabaseClock();
	await assertMatchesFixture(await state.request(`/api/v1/sync?limit=200&cursor=v1:${head}`), 'sync-transcript.response.json');
});

test('every contract fixture is checked by the iOS contract suite', () => {
	// The iOS suite names each fixture as a string literal. A fixture it never loads
	// would let a Worker change pass the native job without iOS decoding it.
	const swift = readFileSync(
		new URL('../ios/PigeonReader/PigeonReaderTests/Core/APIContractTests.swift', import.meta.url),
		'utf8',
	);
	const fixtures = readdirSync(FIXTURES).filter((name) => name !== 'README.md');
	assert.ok(fixtures.length > 0, 'no contract fixtures found');
	const unchecked = fixtures.filter((name) => !swift.includes(`"${name}"`));
	assert.deepEqual(unchecked, [], 'fixtures not referenced by APIContractTests.swift');
});
