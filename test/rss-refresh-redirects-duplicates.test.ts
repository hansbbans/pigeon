import * as assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { fetchAndStoreRssFeed } from '../src/rss-fetcher';
import { createSchemaDatabase } from './helpers/sqlite-d1';

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

const SOURCE = 'https://example.com/feed.xml';

function rss(items: string): string {
	return `<?xml version="1.0"?><rss version="2.0"><channel><title>Blog</title><link>https://example.com/</link>${items}</channel></rss>`;
}

function item(guid: string, title: string, body: string): string {
	return `<item><guid>${guid}</guid><title>${title}</title><link>https://example.com/${guid}</link><pubDate>Sun, 01 Nov 2026 00:00:00 GMT</pubDate><description>${body}</description></item>`;
}

function setup() {
	const state = createSchemaDatabase();
	state.database.exec(
		`INSERT INTO feeds (feed_key, display_name, source_type, source_url, canonical_url, site_url)
		 VALUES ('blog', 'Blog', 'rss', '${SOURCE}', '${SOURCE}', 'https://example.com/')`,
	);
	const env = { DB: state.db, BASE_URL: 'https://pigeon.example', ITEMS_PER_FEED: '50', API_PASSWORD: 'x' } as never;
	// The same columns the cron handler selects for a due feed.
	const feedRow = () => ({ ...(state.database.prepare(
		`SELECT feed_key, source_url, etag, last_modified, fetch_interval_minutes,
		        consecutive_failures, content_hash, conditional_checked_at
		   FROM feeds WHERE feed_key = 'blog'`,
	).get() as object) }) as never;
	const count = (sql: string) => Number((state.database.prepare(sql).get() as { n: number }).n);
	const sourceUrl = () => (state.database.prepare("SELECT source_url FROM feeds WHERE feed_key = 'blog'").get() as { source_url: string }).source_url;
	return { ...state, env, feedRow, count, sourceUrl };
}

function serve(body: () => string) {
	globalThis.fetch = (async () => new Response(body(), { status: 200, headers: { 'Content-Type': 'application/rss+xml' } })) as typeof fetch;
}

function serveWithRedirect(status: number, target: string, body: string) {
	globalThis.fetch = (async (input: string | URL) => {
		if (String(input) === SOURCE) return new Response(null, { status, headers: { Location: target } });
		return new Response(body, { status: 200, headers: { 'Content-Type': 'application/rss+xml' } });
	}) as typeof fetch;
}

test('a temporary redirect does not replace the stored source URL', async () => {
	for (const status of [302, 303, 307]) {
		const s = setup();
		serveWithRedirect(status, 'https://cdn.example.net/feed.xml?sig=expires-tomorrow', rss(item('a', 'A', 'alpha')));
		assert.equal((await fetchAndStoreRssFeed(s.env, s.feedRow())).outcome, 'success', String(status));
		assert.equal(s.count('SELECT COUNT(*) AS n FROM items'), 1, String(status));
		assert.equal(s.sourceUrl(), SOURCE, String(status));
		s.database.close();
	}
});

test('a permanent redirect still moves the stored source URL', async () => {
	for (const status of [301, 308]) {
		const s = setup();
		serveWithRedirect(status, 'https://new.example.com/feed.xml', rss(item('a', 'A', 'alpha')));
		assert.equal((await fetchAndStoreRssFeed(s.env, s.feedRow())).outcome, 'success', String(status));
		assert.equal(s.sourceUrl(), 'https://new.example.com/feed.xml', String(status));
		s.database.close();
	}
});

test('duplicate guids in one document do not rewrite the article on every changed poll', async () => {
	const s = setup();
	let extra = '';
	serve(() => rss(item('dup', 'Dup', 'first copy') + item('dup', 'Dup', 'second copy') + extra));
	await fetchAndStoreRssFeed(s.env, s.feedRow());
	// Whichever copy an earlier poll stored, later polls must leave the article alone.
	extra = item('new-0', 'New 0', 'x');
	await fetchAndStoreRssFeed(s.env, s.feedRow());
	const version = () => s.count("SELECT content_version AS n FROM items WHERE subject = 'Dup'");
	const articleChanges = () => s.count("SELECT COUNT(*) AS n FROM sync_changes WHERE entity_type = 'article'");
	const versionBefore = version();
	const changesBefore = articleChanges();
	for (let poll = 1; poll <= 3; poll += 1) {
		extra += item(`new-${poll}`, `New ${poll}`, 'x');
		assert.equal((await fetchAndStoreRssFeed(s.env, s.feedRow())).outcome, 'success');
	}
	assert.equal(version() - versionBefore, 0, 'content_version of the unchanged duplicate moved');
	assert.equal(articleChanges() - changesBefore, 3, 'one article sync row per new item');
	s.database.close();
});
