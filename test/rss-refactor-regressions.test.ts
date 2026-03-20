import * as assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { fetchAndStoreRssFeed } from '../src/rss-fetcher';
import { subscribeToFeed } from '../src/subscribe';
import { handleGreaderRequest } from '../src/greader';
import { generateApiToken } from '../src/api-auth';

const FEED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Example Feed</title>
    <item>
      <guid>item-1</guid>
      <title>First item</title>
      <description><![CDATA[<p>Hello world</p>]]></description>
      <pubDate>Fri, 20 Mar 2026 12:00:00 GMT</pubDate>
      <author>author@example.com</author>
    </item>
  </channel>
</rss>`;
const LONG_CONTENT = 'Long article body '.repeat(200);
const FEED_WITHOUT_GUID_OR_LINK_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Fallback Identity Feed</title>
    <item>
      <title>Fallback item</title>
      <description><![CDATA[<p>${LONG_CONTENT}</p>]]></description>
      <pubDate>Fri, 20 Mar 2026 12:00:00 GMT</pubDate>
      <author>author@example.com</author>
    </item>
  </channel>
</rss>`;

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function installFeedFetch(xmlText = FEED_XML): void {
	globalThis.fetch = (async () =>
		new Response(xmlText, {
			status: 200,
			headers: {
				'Content-Type': 'application/rss+xml',
				ETag: '"etag-1"',
				'Last-Modified': 'Fri, 20 Mar 2026 12:00:00 GMT',
			},
		})) as typeof fetch;
}

class RecordingPreparedStatement {
	readonly sql: string;
	readonly values: unknown[];

	constructor(sql: string, values: unknown[]) {
		this.sql = sql;
		this.values = values;
	}
}

class RecordingDb {
	batches: RecordingPreparedStatement[][] = [];

	prepare(sql: string) {
		return {
			sql,
			values: [] as unknown[],
			bind(...values: unknown[]) {
				this.values = values;
				return this;
			},
		};
	}

	async batch(statements: Array<{ sql: string; values: unknown[] }>): Promise<void> {
		this.batches.push(
			statements.map((statement) => new RecordingPreparedStatement(statement.sql, statement.values)),
		);
	}
}

class FeedStoreStatement {
	private readonly sql: string;
	private readonly store: SubscriptionStore;
	private boundValues: unknown[] = [];

	constructor(sql: string, store: SubscriptionStore) {
		this.sql = sql;
		this.store = store;
	}

	bind(...values: unknown[]): this {
		this.boundValues = values;
		return this;
	}

	async first<T>(): Promise<T | null> {
		if (this.sql.includes('SELECT rowid, feed_key, display_name FROM feeds WHERE feed_key = ?')) {
			const feed = this.store.feeds.get(this.boundValues[0] as string);
			if (!feed) {
				return null;
			}

			return {
				rowid: feed.rowid,
				feed_key: feed.feed_key,
				display_name: feed.display_name,
			} as T;
		}

		if (this.sql.includes('SELECT rowid FROM feeds WHERE feed_key = ?')) {
			const feed = this.store.feeds.get(this.boundValues[0] as string);
			if (!feed) {
				return null;
			}

			return { rowid: feed.rowid } as T;
		}

		throw new Error(`Unexpected SQL in first(): ${this.sql}`);
	}

	async run(): Promise<void> {
		if (this.sql.startsWith('INSERT INTO feeds')) {
			const [feedKey, displayName, sourceUrl, category, iconUrl] = this.boundValues;
			this.store.feeds.set(feedKey as string, {
				rowid: this.store.nextRowId++,
				feed_key: feedKey as string,
				display_name: displayName as string,
				source_url: sourceUrl as string,
				category: (category as string | null) ?? null,
				icon_url: iconUrl as string,
				is_active: 1,
			});
			return;
		}

		if (this.sql === 'UPDATE feeds SET is_active = 1 WHERE feed_key = ?') {
			const feed = this.store.feeds.get(this.boundValues[0] as string);
			if (feed) {
				feed.is_active = 1;
			}
			return;
		}

		throw new Error(`Unexpected SQL in run(): ${this.sql}`);
	}
}

interface StoredFeed {
	rowid: number;
	feed_key: string;
	display_name: string;
	source_url: string;
	category: string | null;
	icon_url: string;
	is_active: number;
}

class SubscriptionStore {
	readonly feeds = new Map<string, StoredFeed>();
	nextRowId = 1;

	prepare(sql: string): FeedStoreStatement {
		return new FeedStoreStatement(sql, this);
	}
}

function createSubscriptionEnv(store = new SubscriptionStore()) {
	return {
		store,
		env: {
			API_PASSWORD: 'secret-password',
			BASE_URL: 'https://pigeon.example',
			ITEMS_PER_FEED: '25',
			DB: store,
		},
	};
}

test('fetchAndStoreRssFeed stores a stable non-null item id for imported RSS items', async () => {
	installFeedFetch();
	const db = new RecordingDb();
	const env = {
		DB: db,
		BASE_URL: 'https://pigeon.example',
		ITEMS_PER_FEED: '25',
		API_PASSWORD: 'secret-password',
	};
	const feed = {
		feed_key: 'example-feed',
		source_url: 'https://example.com/feed.xml',
		etag: null,
		last_modified: null,
	};

	await fetchAndStoreRssFeed(env as never, feed);
	await fetchAndStoreRssFeed(env as never, feed);

	const firstInsert = db.batches[0]?.find((statement) => statement.sql.includes('INSERT OR IGNORE INTO items'));
	const secondInsert = db.batches[1]?.find((statement) => statement.sql.includes('INSERT OR IGNORE INTO items'));

	assert.ok(firstInsert);
	assert.ok(secondInsert);
	assert.match(firstInsert.sql, /INSERT OR IGNORE INTO items \(\s*id,\s*message_id,/);

	const firstId = firstInsert.values[0];
	const secondId = secondInsert.values[0];

	assert.equal(typeof firstId, 'string');
	assert.match(firstId as string, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
	assert.equal(firstId, secondId);
});

test('fetchAndStoreRssFeed refreshes parent feed metadata after successful imports', async () => {
	installFeedFetch();
	const db = new RecordingDb();
	const env = {
		DB: db,
		BASE_URL: 'https://pigeon.example',
		ITEMS_PER_FEED: '25',
		API_PASSWORD: 'secret-password',
	};

	await fetchAndStoreRssFeed(env as never, {
		feed_key: 'example-feed',
		source_url: 'https://example.com/feed.xml',
		etag: null,
		last_modified: null,
	});

	const metadataUpdate = db.batches[0]?.find(
		(statement) =>
			statement.sql.includes('UPDATE feeds') &&
			statement.sql.includes('last_item_at') &&
			statement.sql.includes('item_count'),
	);

	assert.ok(metadataUpdate, 'expected feed metadata update for last_item_at and item_count');
});

test('fetchAndStoreRssFeed scopes message dedupe identity to the feed key', async () => {
	installFeedFetch();
	const db = new RecordingDb();
	const env = {
		DB: db,
		BASE_URL: 'https://pigeon.example',
		ITEMS_PER_FEED: '25',
		API_PASSWORD: 'secret-password',
	};

	await fetchAndStoreRssFeed(env as never, {
		feed_key: 'feed-one',
		source_url: 'https://example.com/feed-one.xml',
		etag: null,
		last_modified: null,
	});
	await fetchAndStoreRssFeed(env as never, {
		feed_key: 'feed-two',
		source_url: 'https://example.com/feed-two.xml',
		etag: null,
		last_modified: null,
	});

	const firstInsert = db.batches[0]?.find((statement) => statement.sql.includes('INSERT OR IGNORE INTO items'));
	const secondInsert = db.batches[1]?.find((statement) => statement.sql.includes('INSERT OR IGNORE INTO items'));

	assert.ok(firstInsert);
	assert.ok(secondInsert);
	assert.notEqual(firstInsert.values[1], secondInsert.values[1]);
});

test('fetchAndStoreRssFeed keeps fallback message ids compact when guid and link are missing', async () => {
	installFeedFetch(FEED_WITHOUT_GUID_OR_LINK_XML);
	const db = new RecordingDb();
	const env = {
		DB: db,
		BASE_URL: 'https://pigeon.example',
		ITEMS_PER_FEED: '25',
		API_PASSWORD: 'secret-password',
	};
	const feed = {
		feed_key: 'fallback-feed',
		source_url: 'https://example.com/fallback.xml',
		etag: null,
		last_modified: null,
	};

	await fetchAndStoreRssFeed(env as never, feed);
	await fetchAndStoreRssFeed(env as never, feed);

	const firstInsert = db.batches[0]?.find((statement) => statement.sql.includes('INSERT OR IGNORE INTO items'));
	const secondInsert = db.batches[1]?.find((statement) => statement.sql.includes('INSERT OR IGNORE INTO items'));

	assert.ok(firstInsert);
	assert.ok(secondInsert);

	const firstMessageId = firstInsert.values[1];
	const secondMessageId = secondInsert.values[1];

	assert.equal(typeof firstMessageId, 'string');
	assert.equal(firstMessageId, secondMessageId);
	assert.ok((firstMessageId as string).length < 100, 'expected compact fallback message id');
	assert.doesNotMatch(firstMessageId as string, /Long article body/);
});

test('subscribeToFeed distinguishes feeds that only differ by query string', async () => {
	installFeedFetch();
	const { env, store } = createSubscriptionEnv();

	const first = await subscribeToFeed(env as never, 'https://example.com/feed.xml?tag=alpha');
	const second = await subscribeToFeed(env as never, 'https://example.com/feed.xml?tag=beta');

	assert.notEqual(first.feed_key, second.feed_key);
	assert.equal(store.feeds.size, 2);
});

test('subscribeToFeed does not collide for the reproduced query-string hash collision pair', async () => {
	installFeedFetch();
	const { env, store } = createSubscriptionEnv();

	const first = await subscribeToFeed(env as never, 'https://example.com/feed.xml?tag=f3edjb34');
	const second = await subscribeToFeed(env as never, 'https://example.com/feed.xml?tag=gmocv9i5');

	assert.notEqual(first.feed_key, second.feed_key);
	assert.equal(store.feeds.size, 2);
});

test('handleGreaderRequest wires quick-add requests through to subscription creation', async () => {
	installFeedFetch();
	const { env } = createSubscriptionEnv();
	const token = await generateApiToken(env.API_PASSWORD);
	const request = new Request(
		'https://pigeon.example/reader/api/0/subscription/quickadd?quickadd=https%3A%2F%2Fexample.com%2Ffeed.xml%3Ftag%3Dalpha',
		{
			headers: {
				Authorization: `GoogleLogin auth=pigeon/${token}`,
			},
		},
	);

	const response = await handleGreaderRequest(request, env as never);
	assert.equal(response.status, 200);

	const payload = await response.json();
	assert.equal(payload.query, 'https://example.com/feed.xml?tag=alpha');
	assert.equal(payload.numResults, 1);
	assert.equal(payload.streamId, 'feed/1');
	assert.equal(payload.streamName, 'Example Feed');
});
