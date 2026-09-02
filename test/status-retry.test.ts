import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { generateApiToken } from '../src/api-auth';
import { handleStatusRetryRequest } from '../src/status';

class RetryStatement {
	values: unknown[] = [];
	constructor(readonly sql: string, private readonly changes: number) {}
	bind(...values: unknown[]): this {
		this.values = values;
		return this;
	}
	async all<T>(): Promise<{ results: T[] }> {
		if (this.sql === 'PRAGMA table_info(feeds)') {
			return {
				results: [
					'source_type', 'source_url', 'fetch_interval_minutes', 'last_fetched_at', 'fetch_error',
					'etag', 'last_modified', 'icon_url', 'site_url', 'canonical_url', 'feed_format',
					'next_fetch_at', 'last_attempt_at', 'last_success_at', 'consecutive_failures',
					'last_http_status', 'retry_after_at', 'content_hash', 'conditional_checked_at',
					'refresh_lease_until', 'refresh_lease_token', 'last_refresh_outcome',
					'last_fetch_duration_ms', 'category',
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
			return { value: '11' } as T;
		}
		throw new Error(`Unexpected first(): ${this.sql}`);
	}
	async run(): Promise<{ meta: { changes: number } }> {
		return { meta: { changes: this.sql.includes('SET next_fetch_at = ?') ? this.changes : 1 } };
	}
}

class RetryDb {
	lastRetry: RetryStatement | null = null;
	constructor(private readonly changes: number) {}
	prepare(sql: string): RetryStatement {
		const statement = new RetryStatement(sql, this.changes);
		if (sql.includes('SET next_fetch_at = ?')) this.lastRetry = statement;
		return statement;
	}
}

async function request(db: RetryDb, authorization = true): Promise<Response> {
	const token = await generateApiToken('secret-password');
	return handleStatusRetryRequest(
		new Request('https://pigeon.example/app/status/retry', {
			method: 'POST',
			headers: {
				...(authorization ? { Authorization: `GoogleLogin auth=pigeon/${token}` } : {}),
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ feed_key: 'example-feed' }),
		}),
		{
			DB: db,
			API_PASSWORD: 'secret-password',
			BASE_URL: 'https://pigeon.example',
			ITEMS_PER_FEED: '50',
		} as never,
	);
}

test('manual retry requires authentication and only queues an idle active RSS feed', async () => {
	assert.equal((await request(new RetryDb(1), false)).status, 401);

	const db = new RetryDb(1);
	const response = await request(db);
	assert.equal(response.status, 200);
	assert.equal((await response.json() as { feed_key: string }).feed_key, 'example-feed');
	assert.ok(db.lastRetry);
	assert.equal(db.lastRetry.values[1], 'example-feed');
	assert.match(db.lastRetry.sql, /retry_after_at IS NULL/);
});

test('manual retry reports a conflict when the feed is missing, rate limited, or already leased', async () => {
	const response = await request(new RetryDb(0));
	assert.equal(response.status, 409);
	assert.deepEqual(await response.json(), {
		error: 'Feed not found, waiting for Retry-After, or refresh already in progress',
	});
});
