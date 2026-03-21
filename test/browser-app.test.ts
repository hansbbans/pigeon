import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { generateApiToken } from '../src/api-auth';
import app from '../src/index';

const SCHEMA_VERSION_SQL = normalizeSql("SELECT value FROM _meta WHERE key = 'schema_version'");
const FEED_COUNTS_SQL = normalizeSql(`SELECT COUNT(*) AS active_feed_count,
	        SUM(CASE WHEN source_type = 'email' THEN 1 ELSE 0 END) AS email_feed_count,
	        SUM(CASE WHEN source_type = 'rss' THEN 1 ELSE 0 END) AS rss_feed_count,
	        SUM(CASE WHEN source_type = 'rss' AND COALESCE(fetch_error, '') != '' THEN 1 ELSE 0 END) AS failing_rss_feed_count
	   FROM feeds
	  WHERE is_active = 1`);
const ITEM_COUNTS_SQL = normalizeSql(`SELECT COUNT(*) AS total_item_count,
	        SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS unread_item_count,
	        SUM(CASE WHEN is_starred = 1 THEN 1 ELSE 0 END) AS starred_item_count,
	        MAX(received_at) AS newest_item_at
	   FROM items`);
const NEWEST_EMAIL_SQL = normalizeSql(`SELECT MAX(i.received_at) AS value
	   FROM items i
	   JOIN feeds f ON f.feed_key = i.feed_key
	  WHERE f.source_type = 'email'`);
const NEWEST_RSS_SQL = normalizeSql(`SELECT MAX(i.received_at) AS value
	   FROM items i
	   JOIN feeds f ON f.feed_key = i.feed_key
	  WHERE f.source_type = 'rss'`);
const LATEST_FETCH_SQL = normalizeSql(`SELECT MAX(last_fetched_at) AS value FROM feeds WHERE source_type = 'rss'`);
const FAILING_FEEDS_SQL = normalizeSql(`SELECT feed_key,
	        COALESCE(custom_title, display_name) AS title,
	        fetch_error,
	        last_fetched_at
	   FROM feeds
	  WHERE is_active = 1
	    AND source_type = 'rss'
	    AND COALESCE(fetch_error, '') != ''
	  ORDER BY last_fetched_at DESC
	  LIMIT 5`);

function normalizeSql(sql: string): string {
	return sql.replace(/\s+/g, ' ').trim();
}

interface FakeDbScenario {
	schemaVersion?: string | null;
	throwOnSchemaVersion?: boolean;
	feedCounts?: {
		active_feed_count: number | null;
		email_feed_count: number | null;
		rss_feed_count: number | null;
		failing_rss_feed_count: number | null;
	};
	itemCounts?: {
		total_item_count: number | null;
		unread_item_count: number | null;
		starred_item_count: number | null;
		newest_item_at: string | null;
	};
	newestEmailAt?: string | null;
	newestRssAt?: string | null;
	latestFetchAttemptAt?: string | null;
	failingFeeds?: Array<{
		feed_key: string;
		title: string;
		fetch_error: string;
		last_fetched_at: string | null;
	}>;
}

class FakePreparedStatement {
	private readonly sql: string;
	private readonly scenario: FakeDbScenario;

	constructor(sql: string, scenario: FakeDbScenario) {
		this.sql = normalizeSql(sql);
		this.scenario = scenario;
	}

	bind(..._values: unknown[]): this {
		return this;
	}

	async first<T>(): Promise<T | null> {
		switch (this.sql) {
			case SCHEMA_VERSION_SQL:
				if (this.scenario.throwOnSchemaVersion) {
					throw new Error('no such table: _meta');
				}
				return this.scenario.schemaVersion === undefined
					? ({ value: '3' } as T)
					: ({ value: this.scenario.schemaVersion } as T);
			case LATEST_FETCH_SQL:
				return {
					value:
						this.scenario.latestFetchAttemptAt === undefined
							? '2026-03-20T12:05:00.000Z'
							: this.scenario.latestFetchAttemptAt,
				} as T;
			case NEWEST_EMAIL_SQL:
				return {
					value:
						this.scenario.newestEmailAt === undefined
							? '2026-03-20T11:00:00.000Z'
							: this.scenario.newestEmailAt,
				} as T;
			case NEWEST_RSS_SQL:
				return {
					value:
						this.scenario.newestRssAt === undefined
							? '2026-03-20T12:00:00.000Z'
							: this.scenario.newestRssAt,
				} as T;
		}

		throw new Error(`Unexpected SQL in first(): ${this.sql}`);
	}

	async all<T>(): Promise<{ results: T[] }> {
		switch (this.sql) {
			case FEED_COUNTS_SQL:
				return {
					results: [
						this.scenario.feedCounts ?? {
							active_feed_count: 3,
							email_feed_count: 2,
							rss_feed_count: 1,
							failing_rss_feed_count: 1,
						},
					] as T[],
				};
			case ITEM_COUNTS_SQL:
				return {
					results: [
						this.scenario.itemCounts ?? {
							total_item_count: 5,
							unread_item_count: 3,
							starred_item_count: 1,
							newest_item_at: '2026-03-20T12:00:00.000Z',
						},
					] as T[],
				};
			case FAILING_FEEDS_SQL:
				return {
					results: (this.scenario.failingFeeds ?? [
						{
							feed_key: 'rss-feed',
							title: 'RSS Feed',
							fetch_error: 'HTTP 500',
							last_fetched_at: '2026-03-20T12:05:00.000Z',
						},
					]) as T[],
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

function createStatusDb(scenario: FakeDbScenario = {}) {
	return {
		prepare(sql: string) {
			return new FakePreparedStatement(sql, scenario);
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
	const html = await response.text();
	assert.match(html, /id="app"/);
	assert.match(html, /id="login-form"/);
	assert.match(html, /id="reader-window-bar"/);
	assert.match(html, /id="reader-toolbar"/);
	assert.match(html, /id="logout-button"/);
	assert.match(html, /id="feeds-panel"/);
	assert.match(html, /id="articles-panel"/);
	assert.match(html, /id="reader-panel"/);
	assert.match(html, /id="reader-pane-toolbar"/);
	assert.match(html, /id="real-views-section"/);
	assert.match(html, /id="real-feeds-section"/);
	assert.match(html, /id="views-list"/);
	assert.match(html, /id="settings-panel"/);
	assert.match(html, /"baseUrl":"https:\/\/pigeon\.example"/);
	assert.match(html, /grid-template-columns:\s*minmax\(14rem, 16rem\) minmax\(20rem, 26rem\) minmax\(24rem, 1fr\);/);
	assert.match(html, /@media \(max-width: 1100px\)/);
	assert.match(html, /@media \(max-width: 900px\)/);
	assert.doesNotMatch(html, /@media \(max-width: 960px\)/);
	assert.match(
		html,
		/@media \(max-width: 900px\)\s*\{[\s\S]*?\.reader-grid\s*\{[\s\S]*?grid-template-columns:\s*1fr;[\s\S]*?grid-template-areas:\s*"sidebar"\s*"stream"\s*"reader";/,
	);
	assert.match(
		html,
		/@media \(max-width: 900px\)\s*\{[\s\S]*?#settings-panel\s*\{[\s\S]*?top:\s*auto;[\s\S]*?right:\s*0\.75rem;[\s\S]*?bottom:\s*0\.75rem;[\s\S]*?left:\s*0\.75rem;[\s\S]*?width:\s*auto;/,
	);
	assert.match(html, /window\.__PIGEON_BROWSER_CLIENT__ =/);
	assert.match(html, /\/reader\/api\/0\/subscription\/list/);
	assert.match(html, /\/reader\/api\/0\/unread-count/);
	assert.match(html, /\/reader\/api\/0\/stream\/items\/ids/);
	assert.match(html, /\/reader\/api\/0\/stream\/items\/contents/);
	assert.match(html, /\/app\/status/);
	assert.match(html, /srcdoc/);
	assert.match(html, /sandbox=""/);
	assert.match(html, /data-presentational-control="true"/);
	assert.match(
		html,
		/<button[^>]+data-presentational-control="true"[^>]+data-control-tone="subtle"[^>]+disabled[^>]*>/,
	);
	assert.match(html, /\.toolbar-pill\[data-control-tone="subtle"\]\[disabled\]:hover\s*\{/);
	assert.doesNotMatch(html, /\.toolbar-pill\[data-control-tone="subtle"\]\[disabled\]\s*\{[^}]*opacity:\s*1;/);
	assert.doesNotMatch(html, /feedsList\.innerHTML\s*=/);
	assert.doesNotMatch(html, /articlesList\.innerHTML\s*=/);
	assert.doesNotMatch(html, /settingsContent\.innerHTML\s*=/);
	assert.match(html, /starredCount/);
	assert.match(html, /newestEmailAt/);
	assert.match(html, /newestRssAt/);
	assert.match(html, /failingRssCount/);
	assert.match(html, /iconUrl/);
});

test('GET /app/ returns the same HTML shell as /app', async () => {
	const response = await app.fetch(
		new Request('https://pigeon.example/app/'),
		createEnv() as never,
	);

	assert.equal(response.status, 200);
	assert.equal(response.headers.get('Content-Type'), 'text/html; charset=utf-8');
	const html = await response.text();
	assert.match(html, /id="app"/);
	assert.match(html, /id="login-form"/);
	assert.match(html, /id="logout-button"/);
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
			DB: createStatusDb(),
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

test('GET /app/status falls back to unknown schema version and empty counts', async () => {
	const token = await generateApiToken('secret-password');
	const response = await app.fetch(
		new Request('https://status.example/app/status', {
			headers: {
				Authorization: `GoogleLogin auth=pigeon/${token}`,
			},
		}),
		createEnv({
			DB: createStatusDb({
				throwOnSchemaVersion: true,
				feedCounts: {
					active_feed_count: null,
					email_feed_count: null,
					rss_feed_count: null,
					failing_rss_feed_count: null,
				},
				itemCounts: {
					total_item_count: null,
					unread_item_count: null,
					starred_item_count: null,
					newest_item_at: null,
				},
				newestEmailAt: null,
				newestRssAt: null,
				latestFetchAttemptAt: null,
				failingFeeds: [],
			}),
		}) as never,
	);

	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		configuredBaseUrl: 'https://pigeon.example',
		currentOrigin: 'https://status.example',
		healthUrl: 'https://status.example/health',
		schemaVersion: 'unknown',
		feeds: {
			activeCount: 0,
			emailCount: 0,
			rssCount: 0,
			failingRssCount: 0,
			failing: [],
		},
		items: {
			totalCount: 0,
			unreadCount: 0,
			starredCount: 0,
			newestAt: null,
			newestEmailAt: null,
			newestRssAt: null,
		},
		rss: {
			latestFetchAttemptAt: null,
		},
	});
});
