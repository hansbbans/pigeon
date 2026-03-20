import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { generateApiToken } from '../src/api-auth';
import app from '../src/index';

class FakePreparedStatement {
	private readonly sql: string;

	constructor(sql: string) {
		this.sql = sql;
	}

	bind(..._values: unknown[]): this {
		return this;
	}

	async first<T>(): Promise<T | null> {
		if (this.sql.includes("SELECT value FROM _meta WHERE key = 'schema_version'")) {
			return { value: '3' } as T;
		}

		if (this.sql.includes('SELECT MAX(last_fetched_at) AS value FROM feeds')) {
			return { value: '2026-03-20T12:05:00.000Z' } as T;
		}

		if (this.sql.includes('MAX(i.received_at) AS value') && this.sql.includes("f.source_type = 'email'")) {
			return { value: '2026-03-20T11:00:00.000Z' } as T;
		}

		if (this.sql.includes('MAX(i.received_at) AS value') && this.sql.includes("f.source_type = 'rss'")) {
			return { value: '2026-03-20T12:00:00.000Z' } as T;
		}

		throw new Error(`Unexpected SQL in first(): ${this.sql}`);
	}

	async all<T>(): Promise<{ results: T[] }> {
		if (this.sql.includes('SELECT COUNT(*) AS active_feed_count')) {
			return {
				results: [
					{
						active_feed_count: 3,
						email_feed_count: 2,
						rss_feed_count: 1,
						failing_rss_feed_count: 1,
					},
				] as T[],
			};
		}

		if (this.sql.includes('SELECT COUNT(*) AS total_item_count')) {
			return {
				results: [
					{
						total_item_count: 5,
						unread_item_count: 3,
						starred_item_count: 1,
						newest_item_at: '2026-03-20T12:00:00.000Z',
					},
				] as T[],
			};
		}

		if (this.sql.includes('COALESCE(custom_title, display_name) AS title') && this.sql.includes('fetch_error')) {
			return {
				results: [
					{
						feed_key: 'rss-feed',
						title: 'RSS Feed',
						fetch_error: 'HTTP 500',
						last_fetched_at: '2026-03-20T12:05:00.000Z',
					},
				] as T[],
			};
		}

		throw new Error(`Unexpected SQL in all(): ${this.sql}`);
	}
}

function createEnv(overrides?: { DB?: { prepare(sql: string): FakePreparedStatement } }) {
	return {
		API_PASSWORD: 'secret-password',
		BASE_URL: 'https://pigeon.example',
		ITEMS_PER_FEED: '50',
		DB:
			overrides?.DB ||
			{
				prepare() {
					throw new Error('DB should not be used in these route tests');
				},
			},
	};
}

test('GET /app returns an HTML shell', async () => {
	const response = await app.fetch(
		new Request('https://pigeon.example/app'),
		createEnv() as never,
	);

	assert.equal(response.status, 200);
	assert.equal(response.headers.get('Content-Type'), 'text/html; charset=utf-8');
	assert.match(await response.text(), /id="app"/);
});

test('GET /app/ returns the same HTML shell as /app', async () => {
	const response = await app.fetch(
		new Request('https://pigeon.example/app/'),
		createEnv() as never,
	);

	assert.equal(response.status, 200);
	assert.equal(response.headers.get('Content-Type'), 'text/html; charset=utf-8');
	assert.match(await response.text(), /id="app"/);
});

test('GET /app/status requires auth', async () => {
	const response = await app.fetch(
		new Request('https://pigeon.example/app/status'),
		createEnv() as never,
	);

	assert.equal(response.status, 401);
});

test('GET /app/status returns aggregated status JSON when authenticated', async () => {
	const token = await generateApiToken('secret-password');
	const response = await app.fetch(
		new Request('https://status.example/app/status', {
			headers: {
				Authorization: `GoogleLogin auth=pigeon/${token}`,
			},
		}),
		createEnv({
			DB: {
				prepare(sql: string) {
					return new FakePreparedStatement(sql);
				},
			},
		}) as never,
	);

	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		configuredBaseUrl: 'https://pigeon.example',
		currentOrigin: 'https://status.example',
		healthUrl: 'https://status.example/health',
		schemaVersion: '3',
		feeds: {
			activeCount: 3,
			emailCount: 2,
			rssCount: 1,
			failingRssCount: 1,
			failing: [
				{
					feedKey: 'rss-feed',
					title: 'RSS Feed',
					error: 'HTTP 500',
					lastFetchedAt: '2026-03-20T12:05:00.000Z',
				},
			],
		},
		items: {
			totalCount: 5,
			unreadCount: 3,
			starredCount: 1,
			newestAt: '2026-03-20T12:00:00.000Z',
			newestEmailAt: '2026-03-20T11:00:00.000Z',
			newestRssAt: '2026-03-20T12:00:00.000Z',
		},
		rss: {
			latestFetchAttemptAt: '2026-03-20T12:05:00.000Z',
		},
	});
});
