import * as assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { runWithRefreshLimits } from '../src/cron-handler';
import { fetchAndStoreRssFeed } from '../src/rss-fetcher';

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

class Statement {
	values: unknown[] = [];
	constructor(
		readonly sql: string,
		private readonly runChanges = 1,
	) {}
	bind(...values: unknown[]): this {
		this.values = values;
		return this;
	}
	async all<T>(): Promise<{ results: T[] }> {
		if (this.sql === 'PRAGMA table_info(feeds)') {
			return {
				results: [
					'source_type', 'source_url', 'fetch_interval_minutes', 'last_fetched_at',
					'fetch_error', 'etag', 'last_modified', 'icon_url', 'site_url', 'canonical_url',
					'feed_format', 'next_fetch_at', 'last_attempt_at', 'last_success_at',
					'consecutive_failures', 'last_http_status', 'retry_after_at', 'content_hash',
					'conditional_checked_at', 'refresh_lease_until', 'refresh_lease_token',
					'last_refresh_outcome', 'last_fetch_duration_ms', 'category',
				].map((name) => ({ name })) as T[],
			};
		}
		if (this.sql === 'PRAGMA table_info(items)') {
			return { results: [{ name: 'original_url' }] as T[] };
		}
		throw new Error(`Unexpected all(): ${this.sql}`);
	}
	async first<T>(): Promise<T | null> {
		if (this.sql === "SELECT value FROM _meta WHERE key = 'schema_version'") {
			return { value: '12' } as T;
		}
		throw new Error(`Unexpected first(): ${this.sql}`);
	}
	async run(): Promise<{ meta: { changes: number } }> {
		return { meta: { changes: this.runChanges } };
	}
}

class RecordingDb {
	readonly batches: Statement[][] = [];
	readonly statements: Statement[] = [];
	leaseRenewalChanges = 1;
	prepare(sql: string): Statement {
		const statement = new Statement(
			sql,
			sql.includes('SET refresh_lease_until = ?') ? this.leaseRenewalChanges : 1,
		);
		this.statements.push(statement);
		return statement;
	}
	async batch(statements: Statement[]): Promise<Array<{ meta: { changes: number } }>> {
		this.batches.push(statements);
		return statements.map(() => ({ meta: { changes: 1 } }));
	}
}

function env(db = new RecordingDb()) {
	return {
		db,
		env: {
			DB: db,
			BASE_URL: 'https://pigeon.example',
			ITEMS_PER_FEED: '50',
			API_PASSWORD: 'secret-password',
		},
	};
}

function feed(overrides: Record<string, unknown> = {}) {
	return {
		feed_key: 'example-feed',
		source_url: 'https://feeds.example.com/news.xml',
		etag: '"old-etag"',
		last_modified: null,
		fetch_interval_minutes: 60,
		consecutive_failures: 0,
		content_hash: null,
		...overrides,
	};
}

test('304 responses are successful checks and advance the next schedule without parsing', async () => {
	globalThis.fetch = (async () => new Response(null, { status: 304 })) as typeof fetch;
	const state = env();
	const result = await fetchAndStoreRssFeed(state.env as never, feed());
	assert.equal(result.outcome, 'not_modified');
	assert.equal(result.httpStatus, 304);
	assert.equal(result.errorMessage, null);
	const batch = state.db.batches.at(-1) ?? [];
	assert.equal(batch.some((statement) => statement.sql.includes('INSERT INTO items')), false);
	assert.equal(batch.some((statement) => statement.sql.includes('INSERT INTO refresh_activity')), true);
	const update = batch.find((statement) => statement.sql.includes('UPDATE feeds SET last_fetched_at'));
	assert.ok(update);
	assert.equal(update.values[4], null);
});

test('conditional validators are sent only within the periodic full-fetch window', async () => {
	const observedEtags: Array<string | null> = [];
	globalThis.fetch = (async (_input, init) => {
		observedEtags.push(new Headers(init?.headers).get('If-None-Match'));
		return observedEtags.length === 1
			? new Response(null, { status: 304 })
			: new Response('<rss><channel><title>Full</title></channel></rss>', {
					status: 200,
					headers: { 'Content-Type': 'application/rss+xml' },
				});
	}) as typeof fetch;
	const state = env();
	await fetchAndStoreRssFeed(
		state.env as never,
		feed({ conditional_checked_at: new Date(Date.now() - 86_400_000).toISOString() }),
	);
	await fetchAndStoreRssFeed(
		state.env as never,
		feed({ conditional_checked_at: new Date(Date.now() - 8 * 86_400_000).toISOString() }),
	);
	assert.deepEqual(observedEtags, ['"old-etag"', null]);
});

test('Cache-Control max-age defers the next successful refresh within a one-day cap', async () => {
	globalThis.fetch = (async () =>
		new Response('<rss><channel><title>Cached</title></channel></rss>', {
			status: 200,
			headers: {
				'Content-Type': 'application/rss+xml',
				'Cache-Control': 'public, max-age=7200',
			},
		})) as typeof fetch;
	const state = env();
	const result = await fetchAndStoreRssFeed(state.env as never, feed({ fetch_interval_minutes: 15 }));
	assert.ok(result.cacheUntilAt);
	const update = state.db.batches.at(-1)?.find((statement) => statement.sql.includes('UPDATE feeds'));
	assert.ok(update);
	const scheduledAt = update.values[9] as string;
	assert.ok(new Date(scheduledAt).getTime() - new Date(result.completedAt).getTime() >= 7_199_000);
});

test('rate limits honor Retry-After and persist a redacted typed outcome', async () => {
	globalThis.fetch = (async () =>
		new Response('slow down', {
			status: 429,
			headers: { 'Retry-After': '120' },
		})) as typeof fetch;
	const state = env();
	const result = await fetchAndStoreRssFeed(state.env as never, feed());
	assert.equal(result.outcome, 'rate_limited');
	assert.equal(result.errorCode, 'rate_limited');
	assert.equal(result.httpStatus, 429);
	assert.ok(result.retryAt);
	const retryDelay = new Date(result.retryAt).getTime() - new Date(result.completedAt).getTime();
	assert.ok(retryDelay >= 119_000 && retryDelay <= 121_000);
});

test('matching content hashes suppress parsing and item writes', async () => {
	const body = '<rss><channel><title>Unchanged</title></channel></rss>';
	const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
	const contentHash = [...new Uint8Array(hash)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
	globalThis.fetch = (async () =>
		new Response(body, {
			status: 200,
			headers: { 'Content-Type': 'application/rss+xml' },
		})) as typeof fetch;
	const state = env();
	const result = await fetchAndStoreRssFeed(state.env as never, feed({ content_hash: contentHash }));
	assert.equal(result.outcome, 'unchanged');
	assert.equal(
		state.db.batches.at(-1)?.some((statement) => statement.sql.includes('INSERT INTO items')),
		false,
	);
});

test('a stale refresh lease cannot write content or clear a newer worker lease', async () => {
	globalThis.fetch = (async () =>
		new Response(
			'<rss><channel><title>Stale</title><item><guid>1</guid><title>Old worker</title></item></channel></rss>',
			{ status: 200, headers: { 'Content-Type': 'application/rss+xml' } },
		)) as typeof fetch;
	const state = env();
	state.db.leaseRenewalChanges = 0;

	const result = await fetchAndStoreRssFeed(
		state.env as never,
		feed({ refresh_lease_token: 'expired-worker-token' }),
	);

	assert.equal(result.outcome, 'lease_lost');
	assert.equal(result.errorCode, 'lease_lost');
	assert.equal(state.db.batches.length, 0);
	assert.equal(
		state.db.statements.some((statement) => statement.sql.includes('INSERT INTO items')),
		true,
	);
	assert.equal(
		state.db.statements.some(
			(statement) => statement.sql.includes('INSERT INTO refresh_activity') && statement.values[4] === 'lease_lost',
		),
		true,
	);
});

test('malformed successful responses become parse failures instead of throwing', async () => {
	globalThis.fetch = (async () =>
		new Response('<html>not a feed</html>', {
			status: 200,
			headers: { 'Content-Type': 'text/plain' },
		})) as typeof fetch;
	const state = env();
	const result = await fetchAndStoreRssFeed(state.env as never, feed());
	assert.equal(result.outcome, 'parse_error');
	assert.equal(result.errorCode, 'unsupported_or_malformed_feed');
	assert.doesNotMatch(result.errorMessage ?? '', /https?:\/\//);
});

test('refresh execution enforces global and per-host concurrency limits', async () => {
	const feeds = [
		...Array.from({ length: 7 }, (_, index) => feed({ feed_key: `a-${index}`, source_url: `https://a.example/${index}` })),
		...Array.from({ length: 5 }, (_, index) => feed({ feed_key: `b-${index}`, source_url: `https://b.example/${index}` })),
		...Array.from({ length: 4 }, (_, index) => feed({ feed_key: `c-${index}`, source_url: `https://c.example/${index}` })),
	];
	let globalActive = 0;
	let maxGlobal = 0;
	const hostActive = new Map<string, number>();
	const maxHost = new Map<string, number>();

	await runWithRefreshLimits(
		feeds,
		async (candidate) => {
			const host = new URL(candidate.source_url).hostname;
			globalActive += 1;
			maxGlobal = Math.max(maxGlobal, globalActive);
			const active = (hostActive.get(host) ?? 0) + 1;
			hostActive.set(host, active);
			maxHost.set(host, Math.max(maxHost.get(host) ?? 0, active));
			await new Promise((resolve) => setTimeout(resolve, 5));
			globalActive -= 1;
			hostActive.set(host, active - 1);
		},
		5,
		2,
	);

	assert.equal(maxGlobal, 5);
	assert.equal([...maxHost.values()].every((maximum) => maximum <= 2), true);
});

test('one failing host does not prevent unrelated hosts from completing', async () => {
	const completed: string[] = [];
	await runWithRefreshLimits(
		[
			feed({ feed_key: 'failing', source_url: 'https://bad.example/feed' }),
			feed({ feed_key: 'healthy-a', source_url: 'https://a.example/feed' }),
			feed({ feed_key: 'healthy-b', source_url: 'https://b.example/feed' }),
		],
		async (candidate) => {
			if (candidate.feed_key === 'failing') throw new Error('host unavailable');
			completed.push(candidate.feed_key);
		},
		2,
		1,
	);

	assert.deepEqual(completed.sort(), ['healthy-a', 'healthy-b']);
});
