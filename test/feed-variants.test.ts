import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import app from '../src/index';

const FEED_SQL =
	'SELECT feed_key, display_name, from_email, custom_title, source_url, site_url, icon_url, last_item_at FROM feeds WHERE feed_key = ? AND is_active = 1';

const ITEMS_SQL =
	'SELECT id, message_id, subject, html_content, text_content, original_url, from_name, from_email, received_at FROM items WHERE feed_key = ? ORDER BY received_at DESC LIMIT ?';

const FEEDS_SQL_FRAGMENT = 'FROM feeds WHERE is_active = 1 ORDER BY last_item_at DESC';
const OPML_SQL_FRAGMENT = 'FROM feeds WHERE is_active = 1 ORDER BY display_name';

class FeedVariantStatement {
	private readonly sql: string;
	private readonly feed: {
		feed_key: string;
		display_name: string;
		from_email: string | null;
		custom_title: string | null;
		source_url: string | null;
		site_url: string | null;
		icon_url: string | null;
		last_item_at: string | null;
	};
	private readonly items: Array<{
		id: string | null;
		message_id: string | null;
		subject: string;
		html_content: string;
		text_content: string | null;
		original_url: string | null;
		from_name: string | null;
		from_email: string | null;
		received_at: string;
	}>;
	private readonly feeds: Array<{
		feed_key: string;
		display_name: string;
		from_email: string | null;
			source_type: string;
			source_url: string | null;
			site_url: string | null;
			icon_url: string | null;
		item_count: number;
		last_item_at: string | null;
		custom_title: string | null;
		category: string | null;
	}>;
	private readonly tracker: {
		lastItemsLimit: number | null;
	};
	private boundValues: unknown[] = [];

	constructor(
		sql: string,
		feed: FeedVariantStatement['feed'],
		items: FeedVariantStatement['items'],
		feeds: FeedVariantStatement['feeds'],
		tracker: FeedVariantStatement['tracker'],
	) {
		this.sql = sql;
		this.feed = feed;
		this.items = items;
		this.feeds = feeds;
		this.tracker = tracker;
	}

	bind(...values: unknown[]): this {
		this.boundValues = values;
		return this;
	}

	async first<T>(): Promise<T | null> {
		if (this.sql === FEED_SQL) {
			return this.feed as T;
		}

		throw new Error(`Unexpected SQL in first(): ${this.sql}`);
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

		if (this.sql === ITEMS_SQL) {
			this.tracker.lastItemsLimit = this.boundValues[1] as number;
			return { results: this.items as T[] };
		}

		if (this.sql.includes(FEEDS_SQL_FRAGMENT)) {
			return { results: this.feeds as T[] };
		}

		if (this.sql.includes(OPML_SQL_FRAGMENT)) {
			return { results: this.feeds as T[] };
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

function createEnv(iconURL: string | null = 'https://example.com/favicon.ico') {
	const feed = {
		feed_key: 'example-feed',
		display_name: 'Example Feed',
		from_email: 'feed@example.com',
		custom_title: null,
		source_url: 'https://example.com/feed.xml',
		site_url: 'https://example.com/',
		icon_url: iconURL,
		last_item_at: '2026-03-27T12:34:56.000Z',
	};
	const items = [
		{
			id: '9c2772b1-1e53-4de8-89a6-77af6fb9c104',
			message_id: 'rss:8e337bf4910bb5d0b060af5ec864fa7ab0b4f72ea0d2126df683b7b17ab08e6d',
			subject: 'Heavy newsletter',
			html_content:
				'<style>.noise{display:none}</style><div data-full-only="yes">FULL BODY MARKER</div><p>Hello from the lightweight feed test.</p>',
			text_content: null,
			original_url: 'https://example.com/posts/heavy-newsletter',
			from_name: 'Example Feed',
			from_email: 'feed@example.com',
			received_at: '2026-03-27T12:34:56.000Z',
		},
	];
	const feeds = [
		{
			feed_key: 'example-feed',
			display_name: 'Example Feed',
			from_email: 'feed@example.com',
				source_type: 'rss',
				source_url: 'https://example.com/feed.xml',
				site_url: 'https://example.com/',
				icon_url: 'https://example.com/favicon.ico',
			item_count: 12,
			last_item_at: '2026-03-27T12:34:56.000Z',
			custom_title: null,
			category: 'Test',
		},
	];
	const tracker = { lastItemsLimit: null as number | null };

	return {
		tracker,
		env: {
			API_PASSWORD: 'secret-password',
			BASE_URL: 'https://pigeon.example',
			ITEMS_PER_FEED: '25',
			LIGHT_ITEMS_PER_FEED: '12',
			DB: {
				prepare(sql: string) {
					return new FeedVariantStatement(sql, feed, items, feeds, tracker);
				},
			},
		},
	};
}

test('GET /feed/:feed_key/light returns the lightweight feed variant with a smaller default limit', async () => {
	const { env, tracker } = createEnv();
	const response = await app.fetch(
		new Request('https://pigeon.example/feed/example-feed/light'),
		env as never,
	);

	assert.equal(response.status, 200);
	assert.equal(tracker.lastItemsLimit, 12);

	const xml = await response.text();
	assert.match(xml, /<title>Example Feed \(Light\)<\/title>/);
	assert.match(xml, /<link href="https:\/\/pigeon\.example\/feed\/example-feed\/light" rel="self"/);
	assert.match(xml, /<link href="https:\/\/example\.com\/" rel="alternate" type="text\/html"\/>/);
	assert.match(xml, /<entry xml:base="https:\/\/example\.com\/posts\/heavy-newsletter">/);
	assert.match(xml, /<link href="https:\/\/example\.com\/posts\/heavy-newsletter"\/>/);
	assert.match(xml, /<icon>https:\/\/example\.com\/favicon\.ico<\/icon>/);
	assert.match(xml, /data-full-only="yes"/);
	assert.match(xml, /Hello from the lightweight feed test\./);
	assert.doesNotMatch(xml, /<!doctype|<html|<head|<body|<style>/i);
});

test('feed Atom variants emit one escaped icon URL when the feed has an icon', async () => {
	for (const path of ['/feed/example-feed', '/feed/example-feed/light']) {
		const { env } = createEnv('https://example.com/icon.svg?size=32&theme=light');
		const response = await app.fetch(new Request(`https://pigeon.example${path}`), env as never);

		assert.equal(response.status, 200);
		const xml = await response.text();
		assert.equal((xml.match(/<icon>.*?<\/icon>/g) ?? []).length, 1);
		assert.match(xml, /<icon>https:\/\/example\.com\/icon\.svg\?size=32&amp;theme=light<\/icon>/);
	}
});

test('feed Atom variants omit the icon element when the feed icon is null, empty, or whitespace-only', async () => {
	for (const iconURL of [null, '', '   ']) {
		for (const path of ['/feed/example-feed', '/feed/example-feed/light']) {
			const { env } = createEnv(iconURL);
			const response = await app.fetch(new Request(`https://pigeon.example${path}`), env as never);

			assert.equal(response.status, 200);
			const xml = await response.text();
			assert.doesNotMatch(xml, /<icon>/);
		}
	}
});

test('GET /feeds includes a dedicated lightweight feed URL alongside the full feed URL', async () => {
	const { env } = createEnv();
	const response = await app.fetch(
		new Request('https://pigeon.example/feeds'),
		env as never,
	);

	assert.equal(response.status, 200);
	const payload = await response.json();

	assert.equal(payload.feeds[0].feed_url, 'https://pigeon.example/feed/example-feed');
	assert.equal(payload.feeds[0].light_feed_url, 'https://pigeon.example/feed/example-feed/light');
	assert.equal(payload.feeds[0].site_url, 'https://example.com/');
});

test('GET /feeds/opml includes the feed homepage when available', async () => {
	const { env } = createEnv();
	const response = await app.fetch(
		new Request('https://pigeon.example/feeds/opml'),
		env as never,
	);

	assert.equal(response.status, 200);
	const opml = await response.text();
	assert.match(opml, /xmlUrl="https:\/\/pigeon\.example\/feed\/example-feed"/);
	assert.match(opml, /htmlUrl="https:\/\/example\.com\/"/);
});
