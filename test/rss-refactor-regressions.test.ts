import * as assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { fetchAndStoreRssFeed } from '../src/rss-fetcher';
import { subscribeToFeed } from '../src/subscribe';
import { handleGreaderRequest } from '../src/greader';
import { generateApiToken } from '../src/api-auth';
import { resolveRssItemUrl, unwrapFeedBlitzUrl } from '../src/rss-links';

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
const FEEDBLITZ_WRAPPED_FEED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Marginal REVOLUTION</title>
    <link>https://marginalrevolution.com/</link>
    <item>
      <guid isPermaLink="false">https://marginalrevolution.com/?p=93071</guid>
      <title>New Aesthetics awards</title>
      <link>https://feeds.feedblitz.com/~/957246533/0/marginalrevolution~New-Aesthetics-awards.html</link>
      <pubDate>Mon, 25 May 2026 16:40:51 GMT</pubDate>
      <content:encoded><![CDATA[
        <p>Patrick Collison <a href="https://feeds.feedblitz.com/~/t/0/0/marginalrevolution/~https://x.com/patrickc/status/2058931538029662435">tweets</a>.</p>
        <p>The post <a href="https://feeds.feedblitz.com/~/t/0/0/marginalrevolution/~https://marginalrevolution.com/marginalrevolution/2026/05/new-aesthetics-awards.html">New Aesthetics awards</a> appeared first on <a href="https://feeds.feedblitz.com/~/t/0/0/marginalrevolution/~https://marginalrevolution.com">Marginal REVOLUTION</a>.</p>
      ]]></content:encoded>
    </item>
  </channel>
</rss>`;
const RELATIVE_LINK_FEED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Relative Link Feed</title>
    <link>https://example.com/blog/</link>
    <item>
      <guid>relative-1</guid>
      <title>Relative item</title>
      <link>/blog/posts/relative-item</link>
      <description><![CDATA[<p><a href="/blog/about">About</a> <img src="../images/hero.jpg"></p>]]></description>
      <pubDate>Fri, 20 Mar 2026 12:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;
const RELATIVE_MEDIA_FEED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>Relative Media Feed</title>
    <link>https://example.com/articles/</link>
    <item>
      <guid>media-1</guid>
      <title>Media item</title>
      <description><![CDATA[<p>Article body</p>]]></description>
      <media:content url="../images/hero.jpg" type="image/jpeg" title="Hero image" />
      <enclosure url="../audio/episode.mp3" type="audio/mpeg" />
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
			async all<T>() {
				if (sql === 'PRAGMA table_info(feeds)') {
					return { results: migrationFeedColumns() as T[] };
				}

				if (sql === 'PRAGMA table_info(items)') {
					return { results: migrationItemColumns() as T[] };
				}

				throw new Error(`Unexpected SQL in all(): ${sql}`);
			},
			async first<T>() {
				if (sql === "SELECT value FROM _meta WHERE key = 'schema_version'") {
					return { value: '12' } as T;
				}

				throw new Error(`Unexpected SQL in first(): ${sql}`);
			},
			async run() {
				if (isMigrationSql(sql) || sql.startsWith('UPDATE feeds SET last_fetched_at')) {
					return;
				}

				throw new Error(`Unexpected SQL in run(): ${sql}`);
			},
		};
	}

	async batch(statements: Array<{ sql: string; values: unknown[] }>): Promise<void> {
		this.batches.push(
			statements.map((statement) => new RecordingPreparedStatement(statement.sql, statement.values)),
		);
	}
}

function migrationFeedColumns(): Array<{ name: string }> {
	return [
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
	].map((name) => ({ name }));
}

function migrationItemColumns(): Array<{ name: string }> {
	return [{ name: 'original_url' }, { name: 'content_pruned_at' }];
}

function isMigrationSql(sql: string): boolean {
	return (
		sql.startsWith('CREATE TABLE IF NOT EXISTS _meta') ||
		sql.startsWith('INSERT OR IGNORE INTO _meta') ||
		sql.startsWith('ALTER TABLE feeds ADD COLUMN ') ||
		sql.startsWith('ALTER TABLE items ADD COLUMN ') ||
		sql.startsWith('CREATE INDEX IF NOT EXISTS idx_feeds_next_fetch') ||
		sql.startsWith('CREATE INDEX IF NOT EXISTS idx_feeds_refresh_due') ||
		sql.startsWith('CREATE UNIQUE INDEX IF NOT EXISTS idx_feeds_canonical_url') ||
		sql.startsWith('CREATE TABLE IF NOT EXISTS feed_url_aliases') ||
		sql.startsWith('CREATE INDEX IF NOT EXISTS idx_feed_url_aliases_') ||
		sql.startsWith('CREATE TABLE IF NOT EXISTS refresh_activity') ||
		sql.startsWith('CREATE INDEX IF NOT EXISTS idx_refresh_activity_') ||
		sql.startsWith('CREATE TABLE IF NOT EXISTS item_statuses') ||
		sql.startsWith('CREATE INDEX IF NOT EXISTS idx_item_statuses_') ||
		sql.startsWith('INSERT OR IGNORE INTO item_statuses') ||
		sql.startsWith('CREATE TRIGGER IF NOT EXISTS trg_items_') ||
		sql.startsWith('CREATE TABLE IF NOT EXISTS sync_changes') ||
		sql.startsWith('CREATE INDEX IF NOT EXISTS idx_sync_changes_') ||
		sql.startsWith('CREATE TABLE IF NOT EXISTS mutation_receipts') ||
		sql.startsWith('CREATE INDEX IF NOT EXISTS idx_mutation_receipts_') ||
		sql.startsWith('CREATE TRIGGER IF NOT EXISTS trg_sync_') ||
		sql.startsWith('INSERT INTO sync_changes') ||
		sql.startsWith('CREATE TABLE IF NOT EXISTS feed_tags') ||
		sql.startsWith('CREATE INDEX IF NOT EXISTS idx_feed_tags_label') ||
		sql.includes('CREATE TABLE IF NOT EXISTS engagement_events') ||
		sql.startsWith('ALTER TABLE engagement_events ADD COLUMN destination_host') ||
		sql.includes('CREATE INDEX IF NOT EXISTS idx_engagement_events_') ||
		(sql.startsWith('INSERT OR IGNORE INTO feed_tags') && sql.includes('SELECT feed_key, category')) ||
		sql.startsWith('UPDATE _meta SET value')
	);
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
		if (this.sql === "SELECT value FROM _meta WHERE key = 'schema_version'") {
			return { value: '12' } as T;
		}

		if (this.sql.includes('SELECT rowid, feed_key, display_name FROM feeds WHERE feed_key = ?')) {
			const [feedKey, canonicalUrl, sourceUrl] = this.boundValues as string[];
			const feed =
				this.store.feeds.get(feedKey) ??
				[...this.store.feeds.values()].find(
					(candidate) =>
						candidate.canonical_url === canonicalUrl || candidate.source_url === sourceUrl,
				);
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

		if (this.sql.includes('FROM feed_url_aliases a')) {
			const feedKey = this.store.aliases.get(this.boundValues[0] as string);
			const feed = feedKey ? this.store.feeds.get(feedKey) : undefined;
			if (!feed) return null;
			return {
				rowid: feed.rowid,
				feed_key: feed.feed_key,
				display_name: feed.display_name,
			} as T;
		}

		throw new Error(`Unexpected SQL in first(): ${this.sql}`);
	}

	async all<T>(): Promise<{ results: T[] }> {
		if (this.sql === 'PRAGMA table_info(feeds)') {
			return { results: migrationFeedColumns() as T[] };
		}

		if (this.sql === 'PRAGMA table_info(items)') {
			return { results: migrationItemColumns() as T[] };
		}

		throw new Error(`Unexpected SQL in all(): ${this.sql}`);
	}

	async run(): Promise<void> {
		if (isMigrationSql(this.sql)) {
			return;
		}

		if (this.sql.startsWith('INSERT INTO feeds')) {
			const [
				feedKey,
				displayName,
				sourceUrl,
				canonicalUrl,
				feedFormat,
				siteUrl,
				category,
				iconUrl,
			] = this.boundValues;
			this.store.feeds.set(feedKey as string, {
				rowid: this.store.nextRowId++,
				feed_key: feedKey as string,
				display_name: displayName as string,
				source_url: sourceUrl as string,
				canonical_url: canonicalUrl as string,
				feed_format: feedFormat as string,
				site_url: (siteUrl as string | null) ?? null,
				category: (category as string | null) ?? null,
				icon_url: iconUrl as string,
				is_active: 1,
			});
			return;
		}

		if (this.sql.includes('SET display_name = ?, source_url = ?, canonical_url = ?')) {
			const [displayName, sourceUrl, canonicalUrl, feedFormat, siteUrl, , feedKey] = this.boundValues;
			const feed = this.store.feeds.get(feedKey as string);
			if (feed) {
				feed.display_name = displayName as string;
				feed.source_url = sourceUrl as string;
				feed.canonical_url = canonicalUrl as string;
				feed.feed_format = feedFormat as string;
				feed.site_url = (siteUrl as string | null) ?? feed.site_url;
				feed.is_active = 1;
			}
			return;
		}

		if (this.sql.startsWith('INSERT OR IGNORE INTO feed_url_aliases')) {
			const [aliasUrl, feedKey] = this.boundValues;
			if (!this.store.aliases.has(aliasUrl as string)) {
				this.store.aliases.set(aliasUrl as string, feedKey as string);
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
	canonical_url: string;
	feed_format: string;
	site_url: string | null;
	category: string | null;
	icon_url: string;
	is_active: number;
}

class SubscriptionStore {
	readonly feeds = new Map<string, StoredFeed>();
	readonly aliases = new Map<string, string>();
	nextRowId = 1;

	prepare(sql: string): FeedStoreStatement {
		return new FeedStoreStatement(sql, this);
	}

	async batch(statements: FeedStoreStatement[]): Promise<void> {
		for (const statement of statements) await statement.run();
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

	const firstInsert = db.batches[0]?.find((statement) => statement.sql.includes('INSERT INTO items'));
	const secondInsert = db.batches[1]?.find((statement) => statement.sql.includes('INSERT INTO items'));

	assert.ok(firstInsert);
	assert.ok(secondInsert);
	assert.match(firstInsert.sql, /INSERT INTO items \(\s*id,\s*message_id,/);
	assert.match(firstInsert.sql, /ON CONFLICT\(message_id\) DO UPDATE SET/);

	const firstId = firstInsert.values[0];
	const secondId = secondInsert.values[0];

	assert.equal(typeof firstId, 'string');
	assert.match(firstId as string, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
	assert.equal(firstId, secondId);
});

test('fetchAndStoreRssFeed preserves the original item URL for imported RSS items', async () => {
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

	const insert = db.batches[0]?.find((statement) => statement.sql.includes('INSERT INTO items'));
	assert.ok(insert);
	assert.match(insert.sql, /original_url/);
	assert.equal(insert.values[insert.values.length - 1], 'https://example.com/posts/first-item');
});

test('fetchAndStoreRssFeed unwraps FeedBlitz item and content links to the original destinations', async () => {
	installFeedFetch(FEEDBLITZ_WRAPPED_FEED_XML);
	const db = new RecordingDb();
	const env = {
		DB: db,
		BASE_URL: 'https://pigeon.example',
		ITEMS_PER_FEED: '25',
		API_PASSWORD: 'secret-password',
	};

	await fetchAndStoreRssFeed(env as never, {
		feed_key: 'feeds-feedblitz-com-marginalrevolution',
		source_url: 'https://feeds.feedblitz.com/marginalrevolution',
		etag: null,
		last_modified: null,
	});

	const insert = db.batches[0]?.find((statement) => statement.sql.includes('INSERT INTO items'));
	assert.ok(insert);
	assert.match(insert.sql, /excluded\.feed_key LIKE '%feedblitz%'/);
	assert.equal(
		insert.values[insert.values.length - 1],
		'https://marginalrevolution.com/?p=93071',
	);
	assert.match(insert.values[6] as string, /href="https:\/\/x\.com\/patrickc\/status\/2058931538029662435"/);
	assert.match(
		insert.values[6] as string,
		/href="https:\/\/marginalrevolution\.com\/marginalrevolution\/2026\/05\/new-aesthetics-awards\.html"/,
	);
	assert.doesNotMatch(insert.values[6] as string, /feeds\.feedblitz\.com\/~\/t/);
});

test('fetchAndStoreRssFeed resolves relative RSS item and content links against the feed site', async () => {
	installFeedFetch(RELATIVE_LINK_FEED_XML);
	const db = new RecordingDb();
	const env = {
		DB: db,
		BASE_URL: 'https://pigeon.example',
		ITEMS_PER_FEED: '25',
		API_PASSWORD: 'secret-password',
	};

	await fetchAndStoreRssFeed(env as never, {
		feed_key: 'relative-feed',
		source_url: 'https://example.com/feed.xml',
		etag: null,
		last_modified: null,
	});

	const insert = db.batches[0]?.find((statement) => statement.sql.includes('INSERT INTO items'));
	assert.ok(insert);
	assert.equal(insert.values[insert.values.length - 1], 'https://example.com/blog/posts/relative-item');
	assert.match(insert.values[6] as string, /href="https:\/\/example\.com\/blog\/about"/);
	assert.match(insert.values[6] as string, /src="https:\/\/example\.com\/blog\/images\/hero\.jpg"/);
});

test('fetchAndStoreRssFeed preserves relative media and enclosure links in article content', async () => {
	installFeedFetch(RELATIVE_MEDIA_FEED_XML);
	const db = new RecordingDb();
	const env = {
		DB: db,
		BASE_URL: 'https://pigeon.example',
		ITEMS_PER_FEED: '25',
		API_PASSWORD: 'secret-password',
	};

	await fetchAndStoreRssFeed(env as never, {
		feed_key: 'relative-media-feed',
		source_url: 'https://example.com/feed.xml',
		etag: null,
		last_modified: null,
	});

	const insert = db.batches[0]?.find((statement) => statement.sql.includes('INSERT INTO items'));
	assert.ok(insert);
	assert.match(insert.values[6] as string, /src="https:\/\/example\.com\/images\/hero\.jpg"/);
	assert.match(insert.values[6] as string, /href="https:\/\/example\.com\/audio\/episode\.mp3"/);
});

test('unwrapFeedBlitzUrl tolerates malformed numeric HTML entities', () => {
	assert.equal(
		unwrapFeedBlitzUrl('https://feeds.feedblitz.com/~/t/0/0/feed/~https://example.com/posts/&#9999999999;'),
		'https://example.com/posts/&#9999999999;',
	);
});

test('resolveRssItemUrl does not fall back to unrelated same-site links for FeedBlitz items', () => {
	const resolved = resolveRssItemUrl({
		itemGuid: 'feedblitz-item-1',
		itemLink: 'https://feeds.feedblitz.com/~/957246533/0/example~Important-article.html',
		content: `
			<p><a href="https://example.com/about">About</a></p>
			<p><a href="https://example.com/archive">Archive</a></p>
		`,
		title: 'Important article',
		feedSiteUrl: 'https://example.com/',
		feedSourceUrl: 'https://feeds.feedblitz.com/example',
	});

	assert.equal(resolved, null);
});

test('resolveRssItemUrl uses embedded FeedBlitz tracking targets when present', () => {
	const resolved = resolveRssItemUrl({
		itemGuid: 'feedblitz-item-direct',
		itemLink: 'https://feeds.feedblitz.com/~/t/0/0/example/~https://example.com/posts/embedded-target',
		content: '<p>No permalink footer.</p>',
		title: 'Embedded Target',
		feedSiteUrl: 'https://example.com/',
		feedSourceUrl: 'https://feeds.feedblitz.com/example',
	});

	assert.equal(resolved, 'https://example.com/posts/embedded-target');
});

test('resolveRssItemUrl accepts same-site title links across www and non-www hosts', () => {
	const resolved = resolveRssItemUrl({
		itemGuid: 'feedblitz-item-2',
		itemLink: 'https://feeds.feedblitz.com/~/957246533/0/example~Hello-World-Update.html',
		content: '<p><a href="https://www.example.com/posts/hello-world-update">Hello World Update</a></p>',
		title: 'Hello World Update',
		feedSiteUrl: 'https://example.com/',
		feedSourceUrl: 'https://feeds.feedblitz.com/example',
	});

	assert.equal(resolved, 'https://www.example.com/posts/hello-world-update');
});

test('resolveRssItemUrl prefers a self-referential post permalink when FeedBlitz anchor text is generic', () => {
	const resolved = resolveRssItemUrl({
		itemGuid: 'feedblitz-item-3',
		itemLink: 'https://feeds.feedblitz.com/~/957246533/0/example~Hello-World-Update.html',
		content: `
			<p>
				The post <a href="https://example.com/posts/hello-world-update">Read here</a> appeared first on
				<a href="https://example.com/">Example</a>.
			</p>
		`,
		title: 'Hello World Update',
		feedSiteUrl: 'https://example.com/',
		feedSourceUrl: 'https://feeds.feedblitz.com/example',
	});

	assert.equal(resolved, 'https://example.com/posts/hello-world-update');
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
	assert.equal(metadataUpdate.values[3], 'https://example.com/');
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

	const firstInsert = db.batches[0]?.find((statement) => statement.sql.includes('INSERT INTO items'));
	const secondInsert = db.batches[1]?.find((statement) => statement.sql.includes('INSERT INTO items'));

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

	const firstInsert = db.batches[0]?.find((statement) => statement.sql.includes('INSERT INTO items'));
	const secondInsert = db.batches[1]?.find((statement) => statement.sql.includes('INSERT INTO items'));

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
	assert.equal(store.feeds.get(first.feed_key)?.site_url, 'https://example.com/');
	assert.equal(store.feeds.get(second.feed_key)?.site_url, 'https://example.com/');
});

test('subscribeToFeed does not collide for the reproduced query-string hash collision pair', async () => {
	installFeedFetch();
	const { env, store } = createSubscriptionEnv();

	const first = await subscribeToFeed(env as never, 'https://example.com/feed.xml?tag=f3edjb34');
	const second = await subscribeToFeed(env as never, 'https://example.com/feed.xml?tag=gmocv9i5');

	assert.notEqual(first.feed_key, second.feed_key);
	assert.equal(store.feeds.size, 2);
	assert.equal(store.feeds.get(first.feed_key)?.site_url, 'https://example.com/');
	assert.equal(store.feeds.get(second.feed_key)?.site_url, 'https://example.com/');
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
	assert.equal(payload.isNew, true);

	const duplicateResponse = await handleGreaderRequest(
		new Request(request.url, { headers: request.headers }),
		env as never,
	);
	const duplicatePayload = await duplicateResponse.json();
	assert.equal(duplicatePayload.streamId, 'feed/1');
	assert.equal(duplicatePayload.isNew, false);
});
