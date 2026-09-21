import * as assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { fetchAndStoreRssFeed } from '../src/rss-fetcher';
import { subscribeToFeed } from '../src/subscribe';

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

const RSS_FEED = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Initial RSS</title><link>https://example.com/</link>
<item><guid>old</guid><title>Old</title><link>https://example.com/old</link><pubDate>Thu, 01 Jan 2026 00:00:00 GMT</pubDate><description>old</description></item>
<item><guid>second</guid><title>Second newest</title><link>https://example.com/second</link><pubDate>Sun, 01 Mar 2026 00:00:00 GMT</pubDate><description>second</description></item>
<item><guid>missing</guid><title>Missing date</title><link>https://example.com/missing</link><description>missing</description></item>
<item><guid>newest</guid><title>Newest</title><link>https://example.com/newest</link><pubDate>Tue, 03 Mar 2026 00:00:00 GMT</pubDate><description>newest</description></item>
<item><guid>third</guid><title>Third newest</title><link>https://example.com/third</link><pubDate>Mon, 02 Mar 2026 00:00:00 GMT</pubDate><description>third</description></item>
</channel></rss>`;

const ATOM_FEED = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Initial Atom</title><link href="https://example.com/" rel="alternate" />
<entry><id>tag:example.com,2026:old</id><title>Atom old</title><link href="https://example.com/atom-old" /><published>2026-01-01T00:00:00Z</published><content>old</content></entry>
<entry><id>tag:example.com,2026:two</id><title>Atom second</title><link href="https://example.com/atom-second" /><published>2026-03-01T00:00:00Z</published><content>second</content></entry>
<entry><id>tag:example.com,2026:new</id><title>Atom newest</title><link href="https://example.com/atom-new" /><published>2026-03-03T00:00:00Z</published><content>newest</content></entry>
<entry><id>tag:example.com,2026:three</id><title>Atom third</title><link href="https://example.com/atom-third" /><published>2026-03-02T00:00:00Z</published><content>third</content></entry>
</feed>`;

const JSON_FEED = JSON.stringify({
	version: 'https://jsonfeed.org/version/1.1',
	title: 'Initial JSON',
	home_page_url: 'https://example.com/',
	items: [
		{ id: 'json-old', title: 'JSON old', url: 'https://example.com/json-old', date_published: '2026-01-01T00:00:00Z', content_text: 'old' },
		{ id: 'json-second', title: 'JSON second', url: 'https://example.com/json-second', date_published: '2026-03-01T00:00:00Z', content_text: 'second' },
		{ id: 'json-newest', title: 'JSON newest', url: 'https://example.com/json-newest', date_published: '2026-03-03T00:00:00Z', content_text: 'newest' },
		{ id: 'json-third', title: 'JSON third', url: 'https://example.com/json-third', date_published: '2026-03-02T00:00:00Z', content_text: 'third' },
	],
});

const YOUTUBE_ATOM_FEED = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015"><title>Initial YouTube</title><link rel="alternate" href="https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw" />
<entry><id>yt:video:oldvideo001</id><yt:videoId>oldvideo001</yt:videoId><title>YouTube old</title><link rel="alternate" href="https://www.youtube.com/watch?v=oldvideo001" /><published>2026-01-01T00:00:00Z</published><content>old</content></entry>
<entry><id>yt:video:secondvid01</id><yt:videoId>secondvid01</yt:videoId><title>YouTube second</title><link rel="alternate" href="https://www.youtube.com/watch?v=secondvid01" /><published>2026-03-01T00:00:00Z</published><content>second</content></entry>
<entry><id>yt:video:newvideo001</id><yt:videoId>newvideo001</yt:videoId><title>YouTube newest</title><link rel="alternate" href="https://www.youtube.com/watch?v=newvideo001" /><published>2026-03-03T00:00:00Z</published><content>newest</content></entry>
<entry><id>yt:video:thirdvideo1</id><yt:videoId>thirdvideo1</yt:videoId><title>YouTube third</title><link rel="alternate" href="https://www.youtube.com/watch?v=thirdvideo1" /><published>2026-03-02T00:00:00Z</published><content>third</content></entry>
</feed>`;

const DUPLICATE_RSS_FEED = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Duplicate Feed</title><link>https://example.com/</link>
<item><guid>duplicate</guid><title>Duplicate first</title><pubDate>2026-03-02T00:00:00Z</pubDate><description>first</description></item>
<item><guid>duplicate</guid><title>Duplicate second</title><pubDate>2026-03-03T00:00:00Z</pubDate><description>second</description></item>
<item><guid>unique-third</guid><title>Unique third</title><pubDate>2026-03-01T00:00:00Z</pubDate><description>third</description></item>
<item><guid>unique-fourth</guid><title>Unique fourth</title><pubDate>2026-02-01T00:00:00Z</pubDate><description>fourth</description></item>
</channel></rss>`;

const CHANGED_FEED_ONE = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Initial RSS</title><link>https://example.com/</link>
<item><guid>new-dated-one</guid><title>New dated one</title><link>https://example.com/new-dated-one</link><pubDate>Wed, 04 Mar 2026 00:00:00 GMT</pubDate><description>new dated one</description></item>
<item><guid>new-undated-one</guid><title>New undated one</title><link>https://example.com/new-undated-one</link><description>new undated one</description></item>
<item><guid>same-day-one</guid><title>Same day newcomer</title><link>https://example.com/same-day-one</link><pubDate>Sun, 01 Mar 2026 00:00:00 GMT</pubDate><description>same day newcomer</description></item>
<item><guid>newest</guid><title>Newest updated</title><link>https://example.com/newest</link><pubDate>Tue, 03 Mar 2026 00:00:00 GMT</pubDate><description>updated newest</description></item>
<item><guid>third</guid><title>Third newest</title><link>https://example.com/third</link><pubDate>Mon, 02 Mar 2026 00:00:00 GMT</pubDate><description>third</description></item>
<item><guid>second</guid><title>Second newest</title><link>https://example.com/second</link><pubDate>Sun, 01 Mar 2026 00:00:00 GMT</pubDate><description>second</description></item>
<item><guid>old</guid><title>Old</title><link>https://example.com/old</link><pubDate>Thu, 01 Jan 2026 00:00:00 GMT</pubDate><description>old</description></item>
<item><guid>missing</guid><title>Missing date</title><link>https://example.com/missing</link><description>missing</description></item>
</channel></rss>`;

const CHANGED_FEED_TWO = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Initial RSS</title><link>https://example.com/</link>
<item><guid>new-dated-two</guid><title>New dated two</title><link>https://example.com/new-dated-two</link><pubDate>Thu, 05 Mar 2026 00:00:00 GMT</pubDate><description>new dated two</description></item>
<item><guid>new-undated-two</guid><title>New undated two</title><link>https://example.com/new-undated-two</link><description>new undated two</description></item>
<item><guid>new-dated-one</guid><title>New dated one</title><link>https://example.com/new-dated-one</link><pubDate>Wed, 04 Mar 2026 00:00:00 GMT</pubDate><description>new dated one</description></item>
<item><guid>new-undated-one</guid><title>New undated one</title><link>https://example.com/new-undated-one</link><description>new undated one</description></item>
<item><guid>same-day-one</guid><title>Same day newcomer</title><link>https://example.com/same-day-one</link><pubDate>Sun, 01 Mar 2026 00:00:00 GMT</pubDate><description>same day newcomer</description></item>
<item><guid>newest</guid><title>Newest updated again</title><link>https://example.com/newest</link><pubDate>Tue, 03 Mar 2026 00:00:00 GMT</pubDate><description>updated newest again</description></item>
<item><guid>third</guid><title>Third newest</title><link>https://example.com/third</link><pubDate>Mon, 02 Mar 2026 00:00:00 GMT</pubDate><description>third</description></item>
<item><guid>second</guid><title>Second newest</title><link>https://example.com/second</link><pubDate>Sun, 01 Mar 2026 00:00:00 GMT</pubDate><description>second</description></item>
<item><guid>old</guid><title>Old</title><link>https://example.com/old</link><pubDate>Thu, 01 Jan 2026 00:00:00 GMT</pubDate><description>old</description></item>
<item><guid>missing</guid><title>Missing date</title><link>https://example.com/missing</link><description>missing</description></item>
</channel></rss>`;

const ONE_ITEM_FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>One item</title><link>https://example.com/</link><item><guid>one</guid><title>Only item</title><link>https://example.com/one</link><pubDate>2026-03-01T00:00:00Z</pubDate><description>one</description></item></channel></rss>`;
const EMPTY_FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>Empty feed</title><link>https://example.com/</link></channel></rss>`;


function installFeed(body: string, contentType = 'application/rss+xml'): { calls: string[]; setBody: (nextBody: string) => void } {
	const calls: string[] = [];
	let responseBody = body;
	globalThis.fetch = (async (input) => {
		calls.push(String(input));
		return new Response(responseBody, { status: 200, headers: { 'Content-Type': contentType } });
	}) as typeof fetch;
	return { calls, setBody: (nextBody) => { responseBody = nextBody; } };
}

class SqliteD1Database {
	private readonly database = new DatabaseSync(':memory:');
	private coordinateCanonicalReads = false;
	private canonicalReads = 0;
	private canonicalReadGate: Promise<void> | null = null;
	private releaseCanonicalReadGate: (() => void) | null = null;
	failAfterStatements: number | null = null;

	constructor() {
		this.database.exec(`
			CREATE TABLE feeds (
				feed_key TEXT PRIMARY KEY,
				display_name TEXT NOT NULL,
				from_email TEXT,
				source_type TEXT NOT NULL DEFAULT 'email',
				source_url TEXT,
				site_url TEXT,
				fetch_interval_minutes INTEGER DEFAULT 60,
				last_fetched_at TEXT,
				fetch_error TEXT,
				etag TEXT,
				last_modified TEXT,
				first_seen_at TEXT NOT NULL,
				last_item_at TEXT,
				item_count INTEGER DEFAULT 0,
				is_active INTEGER DEFAULT 1,
				stale_archived INTEGER NOT NULL DEFAULT 0,
				custom_title TEXT,
				category TEXT,
				icon_url TEXT,
				canonical_url TEXT,
				feed_format TEXT,
				next_fetch_at TEXT,
				last_attempt_at TEXT,
				last_success_at TEXT,
				consecutive_failures INTEGER NOT NULL DEFAULT 0,
				last_http_status INTEGER,
				retry_after_at TEXT,
				content_hash TEXT,
				conditional_checked_at TEXT,
				refresh_lease_until TEXT,
				refresh_lease_token TEXT,
				last_refresh_outcome TEXT,
				last_fetch_duration_ms INTEGER
			);
			CREATE TABLE feed_url_aliases (
				alias_url TEXT PRIMARY KEY,
				feed_key TEXT NOT NULL,
				canonical_url TEXT NOT NULL
			);
			CREATE TABLE _meta (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
			INSERT INTO _meta (key, value) VALUES ('schema_version', '13');
			CREATE TABLE refresh_activity (
				id TEXT PRIMARY KEY,
				feed_key TEXT NOT NULL,
				attempted_at TEXT NOT NULL,
				completed_at TEXT NOT NULL,
				outcome TEXT NOT NULL,
				http_status INTEGER,
				duration_ms INTEGER NOT NULL,
				items_added INTEGER NOT NULL DEFAULT 0,
				response_bytes INTEGER,
				error_code TEXT,
				error_message TEXT,
				retry_at TEXT
			);
			CREATE TABLE items (
				id TEXT PRIMARY KEY,
				feed_key TEXT NOT NULL,
				from_name TEXT,
				from_email TEXT,
				subject TEXT NOT NULL,
				html_content TEXT NOT NULL,
				text_content TEXT,
				original_url TEXT,
				message_id TEXT UNIQUE,
				received_at TEXT NOT NULL,
				is_read INTEGER DEFAULT 0,
				is_starred INTEGER DEFAULT 0,
				content_pruned_at TEXT
			);
		`);
	}

	prepare(sql: string) {
		const database = this.database;
		const owner = this;
		let values: unknown[] = [];
		const statement = {
			bind(...boundValues: unknown[]) {
				values = boundValues;
				return statement;
			},
			async first<T>() {
				if (
					owner.coordinateCanonicalReads &&
					sql.startsWith('SELECT rowid, feed_key, display_name FROM feeds WHERE feed_key = ?')
				) {
					owner.canonicalReads += 1;
					if (owner.canonicalReads === 2) owner.releaseCanonicalReadGate?.();
					await owner.canonicalReadGate;
				}
				return (database.prepare(sql).get(...values) ?? null) as T | null;
			},
			async all<T>() {
				return { results: database.prepare(sql).all(...values) as T[] };
			},
			async run() {
				const result = database.prepare(sql).run(...values);
				return { meta: { changes: Number(result.changes) } };
			},
		};
		return statement;
	}

	coordinateNewSubscriptionRace(): void {
		this.coordinateCanonicalReads = true;
		this.canonicalReadGate = new Promise((resolve) => {
			this.releaseCanonicalReadGate = resolve;
		});
	}

	async batch(statements: Array<{ run(): Promise<unknown> }>): Promise<void> {
		this.database.exec('BEGIN');
		try {
			for (const [index, statement] of statements.entries()) {
				await statement.run();
				if (this.failAfterStatements !== null && index + 1 >= this.failAfterStatements) {
					this.failAfterStatements = null;
					throw new Error('simulated initial persistence failure');
				}
			}
			this.database.exec('COMMIT');
		} catch (error) {
			this.database.exec('ROLLBACK');
			throw error;
		}
	}

	count(table: 'feeds' | 'items'): number {
		const row = this.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
		return Number(row.count);
	}

	metaValue(key: string): string | null {
		const row = this.database.prepare('SELECT value FROM _meta WHERE key = ?').get(key) as { value: string } | undefined;
		return row?.value ?? null;
	}

	items(): Array<{ subject: string; received_at: string; is_read: number }> {
		return this.database
			.prepare('SELECT subject, received_at, is_read FROM items ORDER BY received_at DESC, rowid DESC')
			.all() as Array<{ subject: string; received_at: string; is_read: number }>;
	}

	contentFor(subject: string): string {
		const row = this.database.prepare('SELECT html_content FROM items WHERE subject = ?').get(subject) as { html_content: string };
		return row.html_content;
	}

	feed(feedKey: string): {
		is_active: number;
		stale_archived: number;
		last_fetched_at: string | null;
		feed_key: string;
		source_url: string;
		etag: string | null;
		last_modified: string | null;
		fetch_interval_minutes: number | null;
		consecutive_failures: number | null;
		content_hash: string | null;
		conditional_checked_at: string | null;
	} {
		return this.database.prepare(`SELECT is_active, stale_archived, last_fetched_at,
			feed_key, source_url, etag, last_modified, fetch_interval_minutes,
			consecutive_failures, content_hash, conditional_checked_at
			FROM feeds WHERE feed_key = ?`).get(feedKey) as {
			is_active: number;
			stale_archived: number;
			last_fetched_at: string | null;
			feed_key: string;
			source_url: string;
			etag: string | null;
			last_modified: string | null;
			fetch_interval_minutes: number | null;
			consecutive_failures: number | null;
			content_hash: string | null;
			conditional_checked_at: string | null;
		};
	}

	markItemsRead(): void {
		this.database.prepare('UPDATE items SET is_read = 1').run();
	}

	insertLegacyFeed(feedKey = 'legacy-feed'): void {
		this.database.prepare(
			`INSERT INTO feeds (feed_key, display_name, source_type, source_url, canonical_url, first_seen_at)
			 VALUES (?, 'Legacy feed', 'rss', 'https://legacy.example/feed.xml', 'https://legacy.example/feed.xml', ?)`,
		).run(feedKey, new Date().toISOString());
	}

	setArchived(feedKey: string): void {
		this.database.prepare('UPDATE feeds SET is_active = 0, stale_archived = 1 WHERE feed_key = ?').run(feedKey);
	}

	close(): void {
		this.database.close();
	}
}

function env(db: SqliteD1Database) {
	return {
		API_PASSWORD: 'secret-password',
		BASE_URL: 'https://pigeon.example',
		ITEMS_PER_FEED: '25',
		DB: db,
	};
}

test('a new RSS subscription stores only its three newest items as unread', async () => {
	const fetchState = installFeed(RSS_FEED);
	const db = new SqliteD1Database();
	try {
		const result = await subscribeToFeed(env(db) as never, 'https://example.com/feed.xml');

		assert.equal(result.wasCreated, true);
		assert.equal(fetchState.calls.length, 1, 'subscription should reuse the discovery fetch');
		assert.deepEqual(db.items().map((item) => item.subject), ['Newest', 'Third newest', 'Second newest']);
		assert.deepEqual(db.items().map((item) => item.is_read), [0, 0, 0]);
		assert.equal(db.count('items'), 3);
	} finally {
		db.close();
	}
});

test('concurrent new subscriptions converge on one initial import', async () => {
	installFeed(RSS_FEED);
	const db = new SqliteD1Database();
	db.coordinateNewSubscriptionRace();
	try {
		const results = await Promise.all([
			subscribeToFeed(env(db) as never, 'https://example.com/feed.xml'),
			subscribeToFeed(env(db) as never, 'https://example.com/feed.xml'),
		]);
		assert.deepEqual(results.map((result) => result.wasCreated).sort(), [false, true]);
		assert.equal(db.count('feeds'), 1);
		assert.equal(db.count('items'), 3);
		assert.deepEqual(db.items().map((item) => item.is_read), [0, 0, 0]);
	} finally {
		db.close();
	}
});

test('existing and reactivated subscriptions do not replay the initial import', async () => {
	installFeed(RSS_FEED);
	const db = new SqliteD1Database();
	try {
		const first = await subscribeToFeed(env(db) as never, 'https://example.com/feed.xml');
		db.markItemsRead();
		const second = await subscribeToFeed(env(db) as never, 'https://example.com/feed.xml');
		assert.equal(second.wasCreated, false);
		assert.equal(db.count('items'), 3);
		assert.deepEqual(db.items().map((item) => item.is_read), [1, 1, 1]);

		db.setArchived(first.feed_key);
		const reactivated = await subscribeToFeed(env(db) as never, 'https://example.com/feed.xml');
		assert.equal(reactivated.wasCreated, false);
		assert.equal(db.count('items'), 3);
		const feed = db.feed(first.feed_key);
		assert.equal(feed.is_active, 1);
		assert.equal(feed.stale_archived, 0);
		assert.ok(feed.last_fetched_at);
	} finally {
		db.close();
	}
});

test('new Atom, JSON, and YouTube subscriptions each import three newest distinct items', async () => {
	const cases = [
		{ body: ATOM_FEED, contentType: 'application/atom+xml', expected: ['Atom newest', 'Atom third', 'Atom second'] },
		{ body: JSON_FEED, contentType: 'application/feed+json', expected: ['JSON newest', 'JSON third', 'JSON second'] },
		{ body: YOUTUBE_ATOM_FEED, contentType: 'application/atom+xml', expected: ['YouTube newest', 'YouTube third', 'YouTube second'] },
	] as const;

	for (const [index, feedCase] of cases.entries()) {
		installFeed(feedCase.body, feedCase.contentType);
		const db = new SqliteD1Database();
		try {
			const result = await subscribeToFeed(env(db) as never, `https://example.com/feed-${index}.xml`);
			assert.deepEqual(db.items().map((item) => item.subject), feedCase.expected);
			assert.deepEqual(db.items().map((item) => item.is_read), [0, 0, 0]);
			assert.equal(result.wasCreated, true);
		} finally {
			db.close();
		}
	}
});

test('initial selection deduplicates repeated identities and handles fewer-than-three or empty feeds', async () => {
	const cases = [
		{ body: DUPLICATE_RSS_FEED, expected: ['Duplicate second', 'Unique third', 'Unique fourth'] },
		{ body: ONE_ITEM_FEED, expected: ['Only item'] },
		{ body: EMPTY_FEED, expected: [] },
	] as const;

	for (const [index, feedCase] of cases.entries()) {
		installFeed(feedCase.body);
		const db = new SqliteD1Database();
		try {
			await subscribeToFeed(env(db) as never, `https://example.com/edge-${index}.xml`);
			assert.deepEqual(db.items().map((item) => item.subject), feedCase.expected);
			assert.ok(db.count('feeds') === 1);
		} finally {
			db.close();
		}
	}
});

test('initial baseline survives two changed polls while admitting dated and undated new items', async () => {
	const fetchState = installFeed(RSS_FEED);
	const db = new SqliteD1Database();
	try {
		const result = await subscribeToFeed(env(db) as never, 'https://example.com/feed.xml');
		fetchState.setBody(CHANGED_FEED_ONE);
		const firstRefresh = await fetchAndStoreRssFeed(env(db) as never, db.feed(result.feed_key));
		assert.equal(firstRefresh.outcome, 'success');
		assert.equal(firstRefresh.itemsProcessed, 6, 'three selected items may refresh plus three new items');
		assert.equal(db.count('items'), 6);
		assert.equal(db.items().filter((item) => item.is_read === 0).length, 6);
		assert.ok(db.items().some((item) => item.subject === 'New dated one'));
		assert.ok(db.items().some((item) => item.subject === 'New undated one'));
		assert.ok(db.items().some((item) => item.subject === 'Same day newcomer'));
		assert.match(db.contentFor('Newest'), /updated newest/);

		fetchState.setBody(CHANGED_FEED_TWO);
		const secondRefresh = await fetchAndStoreRssFeed(env(db) as never, db.feed(result.feed_key));
		assert.equal(secondRefresh.outcome, 'success');
		assert.equal(secondRefresh.itemsProcessed, 8, 'selected and five known new items remain refreshable');
		assert.equal(db.count('items'), 8);
		assert.equal(db.items().filter((item) => item.is_read === 0).length, 8);
		assert.deepEqual(
			db.items().filter((item) => item.subject === 'Old' || item.subject === 'Missing date'),
			[],
			'initially skipped backlog remains excluded across changed polls',
		);
	} finally {
		db.close();
	}
});

test('an empty initial feed admits its first dated item even when the date is old', async () => {
	const fetchState = installFeed(EMPTY_FEED);
	const db = new SqliteD1Database();
	try {
		const result = await subscribeToFeed(env(db) as never, 'https://example.com/empty.xml');
		fetchState.setBody(ONE_ITEM_FEED.replace('2026-03-01T00:00:00Z', '2025-01-01T00:00:00Z'));
		const refresh = await fetchAndStoreRssFeed(env(db) as never, db.feed(result.feed_key));
		assert.equal(refresh.outcome, 'success');
		assert.equal(db.count('items'), 1);
		assert.equal(db.items()[0]?.subject, 'Only item');
	} finally {
		db.close();
	}
});

test('feeds created before initial-baseline metadata keep existing polling behavior', async () => {
	installFeed(RSS_FEED);
	const db = new SqliteD1Database();
	try {
		db.insertLegacyFeed();
		const result = await fetchAndStoreRssFeed(env(db) as never, {
			feed_key: 'legacy-feed',
			source_url: 'https://legacy.example/feed.xml',
			etag: null,
			last_modified: null,
		});
		assert.equal(result.outcome, 'success');
		assert.equal(db.count('items'), 5, 'legacy feeds still process their bounded polling window');
	} finally {
		db.close();
	}
});

test('a failed initial batch rolls back the feed so retry can persist it', async () => {
	installFeed(RSS_FEED);
	const db = new SqliteD1Database();
	try {
		db.failAfterStatements = 2;
		await assert.rejects(
			() => subscribeToFeed(env(db) as never, 'https://example.com/feed.xml'),
			/simulated initial persistence failure/,
		);
		assert.equal(db.count('feeds'), 0);
		assert.equal(db.count('items'), 0);
		assert.equal(db.metaValue('feed_initial_baseline:example-com-feed-xml'), null);

		const retry = await subscribeToFeed(env(db) as never, 'https://example.com/feed.xml');
		assert.equal(retry.wasCreated, true);
		assert.equal(db.count('items'), 3);
	} finally {
		db.close();
	}
});
