import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRssItemStatements } from '../src/rss-fetcher';
import type { ParsedItem } from '../src/rss-parser';
import { articleSyncChanges, createSchemaDatabase } from './helpers/sqlite-d1';

const FEED = { link: 'https://example.com', sourceUrl: 'https://example.com/feed.xml' };

function item(overrides: Partial<ParsedItem> = {}): ParsedItem {
	return {
		guid: 'post-1',
		title: 'A post',
		link: 'https://example.com/posts/1',
		pubDate: '2026-11-01T00:00:00.000Z',
		content: '<p>Four words of body</p>',
		attachments: [],
		...overrides,
	};
}

function setup() {
	const state = createSchemaDatabase();
	state.database.exec("INSERT INTO feeds (feed_key, display_name, source_type) VALUES ('blog', 'Blog', 'rss')");
	return state;
}

async function store(state: ReturnType<typeof setup>, items: ParsedItem[], updateExisting = true) {
	const statements = await buildRssItemStatements(state.db as never, 'blog', FEED, items, '2026-11-01T00:00:00.000Z', { updateExisting });
	await state.db.batch(statements as never);
}

function row(state: ReturnType<typeof setup>, guidLink = 'https://example.com/posts/1'): { word_count: number | null; media_kind: string | null } {
	return { ...(state.database.prepare('SELECT word_count, media_kind FROM items WHERE original_url = ?').get(guidLink) as object) };
}

test('RSS ingest stores a text media kind and leaves word count to the clients', async () => {
	const state = setup();
	await store(state, [item()]);
	assert.deepEqual(row(state), { word_count: null, media_kind: 'text' });
});

test('RSS ingest marks videos from a YouTube channel feed as video, but not link-blog posts', async () => {
	const state = setup();
	const video = item({ guid: 'yt:video:dQw4w9WgXcQ', link: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
	const channelFeed = { link: 'https://www.youtube.com/@channel', sourceUrl: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCabcdefghijklmnopqrstuv' };
	await state.db.batch(await buildRssItemStatements(state.db as never, 'blog', channelFeed, [video], '2026-11-01T00:00:00.000Z', { updateExisting: true }) as never);
	assert.deepEqual(row(state, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'), { word_count: null, media_kind: 'video' });

	await store(state, [item({ guid: 'link-post', link: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' })]);
	assert.deepEqual(row(state, 'https://www.youtube.com/watch?v=aaaaaaaaaaa'), { word_count: null, media_kind: 'text' });
});

test('an unchanged RSS refresh rewrites nothing and adds no sync change', async () => {
	const state = setup();
	await store(state, [item()]);
	const before = articleSyncChanges(state.database);
	await store(state, [item()]);
	assert.equal(articleSyncChanges(state.database), before);
});

test('a reported count survives metadata refreshes and is dropped when the body changes', async () => {
	const state = setup();
	await store(state, [item()]);
	state.database.exec("UPDATE items SET word_count = 3000 WHERE original_url = 'https://example.com/posts/1'");
	await store(state, [item({ author: 'Ada' })]);
	assert.equal(row(state).word_count, 3000);
	await store(state, [item({ content: '<p>Now there are six words here</p>' })]);
	assert.equal(row(state).word_count, null);
});

test('an item keeps its media kind when a refresh brings a different link', async () => {
	const state = setup();
	await store(state, [item()]);
	await store(state, [item({ link: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', content: '<p>changed</p>' })]);
	const rows = state.database.prepare('SELECT original_url, media_kind FROM items').all() as Array<{ original_url: string; media_kind: string }>;
	assert.deepEqual(rows.map((stored) => ({ ...stored })), [{ original_url: 'https://example.com/posts/1', media_kind: 'text' }]);
});

test('the insert-only RSS path stores media kind too', async () => {
	const state = setup();
	await store(state, [item()], false);
	assert.deepEqual(row(state), { word_count: null, media_kind: 'text' });
});
