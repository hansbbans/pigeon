import * as assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
	canonicalizeYouTubeFeedUrl,
	extractYouTubeChannelId,
	isYouTubeChannelId,
	youtubeChannelFeedUrl,
} from '../src/youtube';
import { discoverFeeds } from '../src/feed-discovery';
import { parseFeed } from '../src/rss-parser';
import { subscribeToFeed } from '../src/subscribe';
import {
	createArticleFrameDocument,
	createYouTubeEmbedUrl,
	extractYouTubeVideoId as extractBrowserYouTubeVideoId,
	sanitizeArticleHtml,
} from '../src/browser-app-client';
import { renderBrowserAppHtml, renderBrowserAppRuntimeScript } from '../src/browser-app';

const CHANNEL_ID = 'UC_x5XG1OV2P6uZZ5FSM9Ttw';
const VIDEO_ID = 'M1q063UD-gw';
const CANONICAL_FEED_URL = `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL_ID}`;
const HANDLE_URL = 'https://www.youtube.com/@GoogleDevelopers';

const ATOM_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:yt="http://www.youtube.com/xml/schemas/2015"
      xmlns:media="http://search.yahoo.com/mrss/">
  <title>Google for Developers</title>
  <link rel="alternate" href="https://www.youtube.com/channel/${CHANNEL_ID}" />
  <entry>
    <id>yt:video:${VIDEO_ID}</id>
    <yt:videoId>${VIDEO_ID}</yt:videoId>
    <title>Use the &amp;lt;platform&amp;gt; effectively</title>
    <link rel="alternate" href="https://www.youtube.com/shorts/${VIDEO_ID}" />
    <published>2026-09-12T13:14:15+00:00</published>
    <author><name>Google for Developers</name></author>
    <media:group>
      <media:title>Use the &amp;lt;platform&amp;gt; effectively</media:title>
      <media:description>Learn &amp;lt;one&amp;gt; thing &amp;amp; another.
Second line stays readable.</media:description>
      <media:thumbnail url="https://i.ytimg.com/vi/${VIDEO_ID}/hqdefault.jpg" />
      <media:content url="https://www.youtube.com/v/${VIDEO_ID}" type="application/x-shockwave-flash" />
    </media:group>
  </entry>
</feed>`;

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

test('YouTube channel and video URL helpers accept official shapes and reject look-alikes', () => {
	assert.equal(isYouTubeChannelId(CHANNEL_ID), true);
	assert.equal(extractYouTubeChannelId(`https://www.youtube.com/channel/${CHANNEL_ID}`), CHANNEL_ID);
	assert.equal(
		canonicalizeYouTubeFeedUrl(
			`https://youtube.com/feeds/videos.xml?unused=1&channel_id=${CHANNEL_ID}`,
		)?.href,
		CANONICAL_FEED_URL,
	);
	assert.equal(youtubeChannelFeedUrl(CHANNEL_ID).href, CANONICAL_FEED_URL);
	assert.equal(canonicalizeYouTubeFeedUrl(`https://www.youtube.com/playlist?list=${CHANNEL_ID}`), null);

	assert.equal(extractBrowserYouTubeVideoId(`https://www.youtube.com/embed/${VIDEO_ID}`), VIDEO_ID);
	assert.equal(extractBrowserYouTubeVideoId(`https://www.youtube.com/watch?v=${VIDEO_ID}`), VIDEO_ID);
	assert.equal(extractBrowserYouTubeVideoId(`https://www.youtube.com/shorts/${VIDEO_ID}`), VIDEO_ID);
	assert.equal(extractBrowserYouTubeVideoId(`https://youtu.be/${VIDEO_ID}`), VIDEO_ID);
	assert.equal(extractBrowserYouTubeVideoId(`https://www.youtube.com/watch/extra?v=${VIDEO_ID}`), null);
	assert.equal(extractBrowserYouTubeVideoId(`https://www.youtube.com/watch?v=too-short`), null);
	assert.equal(extractBrowserYouTubeVideoId(`https://www.youtube.com.evil.example/watch?v=${VIDEO_ID}`), null);
	assert.equal(extractBrowserYouTubeVideoId(`https://youtu.be.evil.example/${VIDEO_ID}`), null);
	assert.equal(createYouTubeEmbedUrl(`https://www.youtube.com/watch?v=${VIDEO_ID}`), `https://www.youtube.com/embed/${VIDEO_ID}?controls=1`);
	assert.equal(createYouTubeEmbedUrl(`https://www.youtube.com.evil.example/watch?v=${VIDEO_ID}`), null);
});

test('YouTube Atom Media RSS preserves video identity, plain description, and thumbnail', () => {
	const feed = parseFeed(ATOM_FEED, {
		sourceUrl: CANONICAL_FEED_URL,
		contentType: 'application/atom+xml',
	});
	const item = feed.items[0];

	assert.equal(feed.format, 'atom');
	assert.equal(feed.title, 'Google for Developers');
	assert.equal(item?.guid, `yt:video:${VIDEO_ID}`);
	assert.equal(item?.link, `https://www.youtube.com/shorts/${VIDEO_ID}`);
	assert.equal(item?.title, 'Use the &lt;platform&gt; effectively');
	assert.equal(item?.pubDate, '2026-09-12T13:14:15.000Z');
	assert.equal(
		item?.content,
		'<p>Learn &amp;lt;one&amp;gt; thing &amp;amp; another.<br>Second line stays readable.</p>',
	);
	assert.deepEqual(item?.attachments, [
		{
			url: `https://i.ytimg.com/vi/${VIDEO_ID}/hqdefault.jpg`,
			mimeType: 'image/jpeg',
			title: 'Use the &lt;platform&gt; effectively thumbnail',
		},
	]);
});

test('YouTube channel pages and handles discover the same canonical Atom feed', async () => {
	const requestedUrls: string[] = [];
	globalThis.fetch = (async (input) => {
		const url = new URL(String(input));
		requestedUrls.push(url.href);
		if (url.pathname === '/@GoogleDevelopers') {
			return new Response(
				`<html><head><link rel="alternate" type="application/rss+xml" title="Google for Developers" href="/feeds/videos.xml?channel_id=${CHANNEL_ID}"></head></html>`,
				{ status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
			);
		}
		if (url.pathname === '/feeds/videos.xml' && url.searchParams.get('channel_id') === CHANNEL_ID) {
			return new Response(ATOM_FEED, {
				status: 200,
				headers: { 'Content-Type': 'application/atom+xml' },
			});
		}
		return new Response('missing', { status: 404 });
	}) as typeof fetch;

	const handleResult = await discoverFeeds(HANDLE_URL);
	assert.equal(handleResult.candidates.length, 1);
	assert.equal(handleResult.candidates[0]?.url, CANONICAL_FEED_URL);
	assert.equal(handleResult.candidates[0]?.title, 'Google for Developers');
	assert.equal(handleResult.candidates[0]?.source, 'alternate');

	const channelResult = await discoverFeeds(`https://www.youtube.com/channel/${CHANNEL_ID}`);
	assert.equal(channelResult.candidates.length, 1);
	assert.equal(channelResult.candidates[0]?.url, CANONICAL_FEED_URL);
	assert.equal(channelResult.candidates[0]?.source, 'direct');
	assert.deepEqual(channelResult.candidates[0]?.aliases, [`https://www.youtube.com/channel/${CHANNEL_ID}`]);
	assert.equal(
		requestedUrls.filter((url) => url.includes('/feeds/videos.xml?channel_id=')).length,
		2,
	);
});

test('subscribing through a handle and its canonical feed reuses one feed row', async () => {
	const database = new SqliteD1Database();
	globalThis.fetch = (async (input) => {
		const url = new URL(String(input));
		if (url.pathname === '/@GoogleDevelopers') {
			return new Response(
				`<html><head><link rel="alternate" type="application/rss+xml" href="/feeds/videos.xml?channel_id=${CHANNEL_ID}"></head></html>`,
				{ status: 200, headers: { 'Content-Type': 'text/html' } },
			);
		}
		if (url.pathname === '/feeds/videos.xml') {
			return new Response(ATOM_FEED, {
				status: 200,
				headers: { 'Content-Type': 'application/atom+xml' },
			});
		}
		return new Response('missing', { status: 404 });
	}) as typeof fetch;

	try {
		const env = {
			API_PASSWORD: 'secret-password',
			BASE_URL: 'https://pigeon.example',
			ITEMS_PER_FEED: '25',
			DB: database,
		};
		const first = await subscribeToFeed(env as never, HANDLE_URL);
		const second = await subscribeToFeed(env as never, CANONICAL_FEED_URL);

		assert.equal(first.wasCreated, true);
		assert.equal(second.wasCreated, false);
		assert.equal(second.feed_key, first.feed_key);
		assert.equal(database.count('feeds'), 1);
		assert.deepEqual(database.aliases(), [HANDLE_URL]);
	} finally {
		database.close();
	}
});

test('browser player is isolated from article markup and only emits official embeds', () => {
	const appHtml = renderBrowserAppHtml('https://pigeon.example');
	const runtime = renderBrowserAppRuntimeScript();
	const frame = createArticleFrameDocument(
		'<p style="color: red">Keep article formatting.</p><iframe src="https://evil.example"></iframe><script>alert(1)</script><a href="javascript:alert(1)">bad</a>',
	);

	assert.match(appHtml, /id="reader-player-shell"/);
	assert.match(appHtml, /id="reader-player-container"/);
	assert.match(appHtml, /id="reader-player-fallback"/);
	assert.match(runtime, /strict-origin-when-cross-origin/);
	assert.match(runtime, /allowfullscreen/);
	assert.match(runtime, /activeYouTubeVideoId/);
	assert.doesNotMatch(runtime, /embed\/\$\{videoId\}[^`]*autoplay/);
	assert.match(frame, /style="color: red"/);
	assert.doesNotMatch(frame, /<iframe|<script|javascript:/i);
	assert.equal(sanitizeArticleHtml('<p>Keep <strong>formatting</strong>.</p>'), '<p>Keep <strong>formatting</strong>.</p>');
});

class SqliteD1Database {
	private readonly database = new DatabaseSync(':memory:');

	constructor() {
		this.database.exec(`
			CREATE TABLE feeds (
				feed_key TEXT PRIMARY KEY,
				display_name TEXT NOT NULL,
				source_type TEXT NOT NULL,
				source_url TEXT,
				canonical_url TEXT UNIQUE,
				feed_format TEXT,
				site_url TEXT,
				category TEXT,
				icon_url TEXT,
				is_active INTEGER,
				first_seen_at TEXT,
				next_fetch_at TEXT
			);
			CREATE TABLE feed_url_aliases (
				alias_url TEXT PRIMARY KEY,
				feed_key TEXT NOT NULL,
				canonical_url TEXT NOT NULL
			);
		`);
	}

	prepare(sql: string) {
		const database = this.database;
		let values: unknown[] = [];
		const statement = {
			bind(...boundValues: unknown[]) {
				values = boundValues;
				return statement;
			},
			async first<T>() {
				return (database.prepare(sql).get(...values) ?? null) as T | null;
			},
			async run() {
				database.prepare(sql).run(...values);
			},
		};
		return statement;
	}

	async batch(statements: Array<{ run(): Promise<void> }>): Promise<void> {
		for (const statement of statements) await statement.run();
	}

	count(table: string): number {
		const row = this.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
		return Number(row.count);
	}

	aliases(): string[] {
		const rows = this.database.prepare('SELECT alias_url FROM feed_url_aliases ORDER BY alias_url').all() as Array<{ alias_url: string }>;
		return rows.map((row) => row.alias_url);
	}

	close(): void {
		this.database.close();
	}
}
