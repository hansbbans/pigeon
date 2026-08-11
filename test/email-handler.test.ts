import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { handleIncomingEmail } from '../src/email-handler';

const RAW_EMAIL = [
	'From: "Wes Kao" <weskao@substack.com>',
	'To: pigeon@example.com',
	"Subject: I'm an introvert. This is how I get myself to speak up.",
	'Date: Wed, 01 Apr 2026 10:00:00 +0000',
	'Message-ID: <msg-1@example.com>',
	'MIME-Version: 1.0',
	'Content-Type: text/html; charset=UTF-8',
	'',
	'<html><body>',
	'<a href="https://substack.com/redirect/subscribe">Subscribe here</a>',
	'<a href="https://substack.com/app-link/post?publication_id=289208&post_id=172818809">I&#8217;m an introvert. This is how I get myself to speak up.</a>',
	'<a href="https://substack.com/app-link/post?comments=true&post_id=172818809">Comment</a>',
	'</body></html>',
].join('\r\n');

class RecordingStatement {
	readonly sql: string;
	values: unknown[] = [];
	private readonly routingRules: unknown[];

	constructor(sql: string, routingRules: unknown[]) {
		this.sql = sql;
		this.routingRules = routingRules;
	}

	bind(...values: unknown[]): this {
		this.values = values;
		return this;
	}

	async all<T>(): Promise<{ results: T[] }> {
		if (this.sql === 'PRAGMA table_info(feeds)') {
			return {
				results: [
					'source_type',
					'source_url',
					'fetch_interval_minutes',
					'last_fetched_at',
					'fetch_error',
					'etag',
					'last_modified',
					'icon_url',
					'site_url',
					'category',
				].map((name) => ({ name })) as T[],
			};
		}

		if (this.sql === 'PRAGMA table_info(items)') {
			return { results: [{ name: 'original_url' }] as T[] };
		}

		if (this.sql.includes('FROM routing_rules')) {
			return { results: this.routingRules as T[] };
		}

		throw new Error(`Unexpected SQL in all(): ${this.sql}`);
	}

	async run(): Promise<void> {
		if (
			this.sql.startsWith('CREATE TABLE IF NOT EXISTS _meta') ||
			this.sql.startsWith('INSERT OR IGNORE INTO _meta') ||
			this.sql.startsWith('CREATE INDEX IF NOT EXISTS idx_feeds_next_fetch') ||
			this.sql.startsWith('CREATE TABLE IF NOT EXISTS feed_tags') ||
			this.sql.startsWith('CREATE INDEX IF NOT EXISTS idx_feed_tags_label') ||
			this.sql.startsWith('INSERT OR IGNORE INTO feed_tags') ||
			this.sql.includes('CREATE TABLE IF NOT EXISTS engagement_events') ||
			this.sql.startsWith('ALTER TABLE engagement_events ADD COLUMN destination_host') ||
			this.sql.includes('CREATE INDEX IF NOT EXISTS idx_engagement_events_') ||
			this.sql.startsWith('UPDATE _meta SET value')
		) {
			return;
		}

		throw new Error(`Unexpected SQL in run(): ${this.sql}`);
	}
}

class RecordingDb {
	readonly routingRules: unknown[] = [];
	batchedStatements: RecordingStatement[][] = [];

	prepare(sql: string): RecordingStatement {
		return new RecordingStatement(sql, this.routingRules);
	}

	async batch(statements: RecordingStatement[]): Promise<void> {
		this.batchedStatements.push(statements);
	}
}

test('handleIncomingEmail stores the best-effort original article URL for newsletters', async () => {
	const db = new RecordingDb();
	const env = {
		DB: db,
		BASE_URL: 'https://pigeon.example',
		ITEMS_PER_FEED: '25',
		API_PASSWORD: 'secret-password',
	};

	await handleIncomingEmail(
		{
			from: 'weskao@substack.com',
			to: 'pigeon@example.com',
			raw: new Blob([RAW_EMAIL]).stream(),
		} as unknown as ForwardableEmailMessage,
		env as never,
	);

	const itemInsert = db.batchedStatements[0]?.find((statement) => statement.sql.includes('INSERT INTO items'));
	const feedUpsert = db.batchedStatements[0]?.find((statement) => statement.sql.includes('INSERT INTO feeds'));
	assert.ok(feedUpsert);
	assert.match(feedUpsert.sql, /site_url/);
	assert.equal(feedUpsert.values[4], 'https://substack.com/');

	assert.ok(itemInsert);
	assert.match(itemInsert.sql, /original_url/);
	assert.match(itemInsert.sql, /ON CONFLICT\(message_id\) DO UPDATE SET/);
	assert.equal(
		itemInsert.values[7],
		'https://substack.com/app-link/post?publication_id=289208&post_id=172818809',
	);
});
