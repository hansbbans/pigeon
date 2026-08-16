import * as assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import app from '../src/index';
import {
	createLegacySchemaState,
	maybeHandleSchemaAll,
	maybeHandleSchemaFirst,
	maybeHandleSchemaRun,
	type SchemaState,
} from './schema-test-helpers';

const FEED_SQL =
	'SELECT feed_key, display_name, from_email, custom_title, source_url, site_url, icon_url, last_item_at FROM feeds WHERE feed_key = ? AND is_active = 1';

const ITEMS_SQL =
	'SELECT id, message_id, subject, html_content, text_content, original_url, from_name, from_email, received_at FROM items WHERE feed_key = ? ORDER BY received_at DESC LIMIT ?';

const RAW_EMAIL = [
	'From: "Example Sender" <sender@example.com>',
	'To: pigeon@example.com',
	'Subject: Migration check',
	'Date: Wed, 01 Apr 2026 10:00:00 +0000',
	'Message-ID: <migration@example.com>',
	'MIME-Version: 1.0',
	'Content-Type: text/html; charset=UTF-8',
	'',
	'<html><body><a href="https://example.com/posts/migration-check">Read</a></body></html>',
].join('\r\n');

const FEED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Example Feed</title>
    <link>https://example.com/</link>
    <item>
      <guid>item-1</guid>
      <title>First item</title>
      <link>https://example.com/posts/first-item</link>
      <description><![CDATA[<p>Hello world</p>]]></description>
      <pubDate>Fri, 20 Mar 2026 12:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function missingColumnError(columnName: string): Error {
	return new Error(`no such column: ${columnName}`);
}

class LegacySchemaStatement {
	readonly sql: string;
	private readonly state: SchemaState;
	private readonly mode: 'feed' | 'email' | 'scheduled';
	private boundValues: unknown[] = [];

	constructor(sql: string, state: SchemaState, mode: LegacySchemaStatement['mode']) {
		this.sql = sql;
		this.state = state;
		this.mode = mode;
	}

	bind(...values: unknown[]): this {
		this.boundValues = values;
		return this;
	}

	snapshot(): { sql: string; values: unknown[] } {
		return {
			sql: this.sql,
			values: [...this.boundValues],
		};
	}

	async first<T>(): Promise<T | null> {
		const schema = maybeHandleSchemaFirst<T>(this.sql, this.boundValues, this.state);
		if (schema.handled) {
			return schema.value;
		}

		if (this.mode === 'feed' && this.sql === FEED_SQL) {
			if (!this.state.feedColumns.has('site_url')) {
				throw missingColumnError('site_url');
			}

			this.state.operations.push('feed-select');
			return {
				feed_key: 'example-feed',
				display_name: 'Example Feed',
				from_email: 'feed@example.com',
				custom_title: null,
				source_url: 'https://example.com/feed.xml',
				site_url: 'https://example.com/',
				icon_url: null,
				last_item_at: '2026-03-27T12:34:56.000Z',
			} as T;
		}

		throw new Error(`Unexpected SQL in first(): ${this.sql}`);
	}

	async all<T>(): Promise<{ results: T[] }> {
		const schema = maybeHandleSchemaAll<T>(this.sql, this.state);
		if (schema.handled) {
			return { results: schema.results };
		}

		if (this.mode === 'feed' && this.sql === ITEMS_SQL) {
			if (!this.state.itemColumns.has('original_url')) {
				throw missingColumnError('original_url');
			}

			this.state.operations.push('item-select');
			return {
				results: [
					{
						id: 'item-1',
						message_id: 'message-1',
						subject: 'First item',
						html_content: '<p>Hello world</p>',
						text_content: null,
						original_url: 'https://example.com/posts/first-item',
						from_name: 'Example Feed',
						from_email: 'feed@example.com',
						received_at: '2026-03-27T12:34:56.000Z',
					},
				] as T[],
			};
		}

		if (
			this.mode === 'scheduled' &&
			this.sql.includes('SELECT feed_key, source_url, etag, last_modified, fetch_interval_minutes')
		) {
			this.state.operations.push('cron-select');
			return {
				results: [
					{
						feed_key: 'example-feed',
						source_url: 'https://example.com/feed.xml',
						etag: null,
						last_modified: null,
						fetch_interval_minutes: 60,
					},
				] as T[],
			};
		}

		if (this.mode === 'email' && this.sql.includes('FROM routing_rules')) {
			return { results: [] as T[] };
		}

		throw new Error(`Unexpected SQL in all(): ${this.sql}`);
	}

	async run(): Promise<void | { meta: { changes: number } }> {
		if (maybeHandleSchemaRun(this.sql, this.boundValues, this.state)) {
			return;
		}

		if (this.mode === 'scheduled' && this.sql.startsWith('UPDATE feeds SET last_fetched_at')) {
			this.state.operations.push('cron-update');
			return;
		}

		if (this.mode === 'scheduled' && this.sql.includes('SET refresh_lease_until = ?')) {
			this.state.operations.push('cron-lease');
			return { meta: { changes: 1 } };
		}

		if (this.mode === 'scheduled' && this.sql.startsWith('DELETE FROM refresh_activity')) {
			this.state.operations.push('cron-prune-activity');
			return;
		}

		if (this.mode === 'scheduled' && this.sql.startsWith('WITH ranked_items AS')) {
			this.state.operations.push('cron-prune-content');
			return;
		}

		throw new Error(`Unexpected SQL in run(): ${this.sql}`);
	}
}

class LegacySchemaDb {
	readonly state = createLegacySchemaState();
	readonly batches: Array<Array<{ sql: string; values: unknown[] }>> = [];
	private readonly mode: 'feed' | 'email' | 'scheduled';

	constructor(mode: LegacySchemaDb['mode']) {
		this.mode = mode;
	}

	prepare(sql: string): LegacySchemaStatement {
		return new LegacySchemaStatement(sql, this.state, this.mode);
	}

	async batch(statements: LegacySchemaStatement[]): Promise<void> {
		if (!this.state.feedColumns.has('site_url')) {
			throw missingColumnError('site_url');
		}
		if (!this.state.itemColumns.has('original_url')) {
			throw missingColumnError('original_url');
		}
		if (!this.state.hasFeedTagsTable) {
			throw new Error('no such table: feed_tags');
		}

		this.state.operations.push(this.mode === 'scheduled' ? 'rss-batch' : 'email-batch');
		this.batches.push(statements.map((statement) => statement.snapshot()));
	}
}

function createEnv(db: LegacySchemaDb) {
	return {
		API_PASSWORD: 'secret-password',
		BASE_URL: 'https://pigeon.example',
		ITEMS_PER_FEED: '25',
		DB: db,
	};
}

function operationIndex(state: SchemaState, name: string): number {
	return state.operations.indexOf(name);
}

test('fetch upgrades a legacy schema before reading feed rows that require site_url and original_url', async () => {
	const db = new LegacySchemaDb('feed');

	const response = await app.fetch(
		new Request('https://pigeon.example/feed/example-feed'),
		createEnv(db) as never,
	);

	assert.equal(response.status, 200);
	assert.equal(db.state.schemaVersion, '9');
	assert.equal(db.state.hasEngagementEventsTable, true);
	assert.equal(db.state.hasFeedTagsTable, true);
	assert.equal(db.state.hasFeedUrlAliasesTable, true);
	assert.equal(db.state.hasRefreshActivityTable, true);
	assert.equal(db.state.hasItemStatusesTable, true);
	assert.ok(operationIndex(db.state, 'add-site_url') !== -1);
	assert.ok(operationIndex(db.state, 'add-original_url') !== -1);
	assert.ok(operationIndex(db.state, 'create-feed_tags') !== -1);
	assert.ok(operationIndex(db.state, 'create-engagement_events') !== -1);
	assert.ok(operationIndex(db.state, 'add-site_url') < operationIndex(db.state, 'feed-select'));
	assert.ok(operationIndex(db.state, 'add-original_url') < operationIndex(db.state, 'item-select'));
});

test('email upgrades a legacy schema before inserting feed and item rows with site_url and original_url', async () => {
	const db = new LegacySchemaDb('email');

	await app.email(
		{
			from: 'sender@example.com',
			to: 'pigeon@example.com',
			raw: new Blob([RAW_EMAIL]).stream(),
		} as unknown as ForwardableEmailMessage,
		createEnv(db) as never,
		{} as ExecutionContext,
	);

	assert.equal(db.state.schemaVersion, '9');
	assert.equal(db.state.hasEngagementEventsTable, true);
	assert.equal(db.state.hasFeedUrlAliasesTable, true);
	assert.equal(db.state.hasRefreshActivityTable, true);
	assert.equal(db.state.hasItemStatusesTable, true);
	assert.equal(db.batches.length, 1);
	assert.ok(operationIndex(db.state, 'add-site_url') !== -1);
	assert.ok(operationIndex(db.state, 'add-original_url') !== -1);
	assert.ok(operationIndex(db.state, 'create-feed_tags') !== -1);
	assert.ok(operationIndex(db.state, 'create-engagement_events') !== -1);
	assert.ok(operationIndex(db.state, 'add-site_url') < operationIndex(db.state, 'email-batch'));
	assert.ok(operationIndex(db.state, 'add-original_url') < operationIndex(db.state, 'email-batch'));
});

test('scheduled upgrades a legacy schema before RSS refresh writes site_url and original_url', async () => {
	globalThis.fetch = (async () =>
		new Response(FEED_XML, {
			status: 200,
			headers: {
				'Content-Type': 'application/rss+xml',
				ETag: '"etag-1"',
				'Last-Modified': 'Fri, 20 Mar 2026 12:00:00 GMT',
			},
		})) as typeof fetch;

	const db = new LegacySchemaDb('scheduled');

	await app.scheduled({} as ScheduledController, createEnv(db) as never);

	assert.equal(db.state.schemaVersion, '9');
	assert.equal(db.state.hasEngagementEventsTable, true);
	assert.equal(db.state.hasFeedUrlAliasesTable, true);
	assert.equal(db.state.hasRefreshActivityTable, true);
	assert.equal(db.state.hasItemStatusesTable, true);
	assert.equal(db.batches.length, 1);
	assert.ok(operationIndex(db.state, 'add-site_url') !== -1);
	assert.ok(operationIndex(db.state, 'add-original_url') !== -1);
	assert.ok(operationIndex(db.state, 'create-feed_tags') !== -1);
	assert.ok(operationIndex(db.state, 'create-engagement_events') !== -1);
	assert.ok(operationIndex(db.state, 'add-site_url') < operationIndex(db.state, 'cron-select'));
	assert.ok(operationIndex(db.state, 'add-original_url') < operationIndex(db.state, 'rss-batch'));
});
