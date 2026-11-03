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

function row(state: ReturnType<typeof setup>, guidLink = 'https://example.com/posts/1') {
	return { ...(state.database.prepare('SELECT word_count, media_kind FROM items WHERE original_url = ?').get(guidLink) as object) };
}

test('RSS ingest stores a word count and text media kind', async () => {
	const state = setup();
	await store(state, [item()]);
	assert.deepEqual(row(state), { word_count: 4, media_kind: 'text' });
});

test('RSS ingest marks YouTube items as video', async () => {
	const state = setup();
	await store(state, [item({ guid: 'yt:video:dQw4w9WgXcQ', link: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' })]);
	assert.deepEqual(row(state, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'), { word_count: 4, media_kind: 'video' });
});

test('an unchanged RSS refresh rewrites nothing and adds no sync change', async () => {
	const state = setup();
	await store(state, [item()]);
	const before = articleSyncChanges(state.database);
	await store(state, [item()]);
	assert.equal(articleSyncChanges(state.database), before);
});

test('a changed RSS body recounts, but an unchanged body keeps a client-reported count', async () => {
	const state = setup();
	await store(state, [item()]);
	state.database.exec("UPDATE items SET word_count = 3000 WHERE original_url = 'https://example.com/posts/1'");
	await store(state, [item({ author: 'Ada' })]);
	assert.equal((row(state) as { word_count: number }).word_count, 3000);
	await store(state, [item({ content: '<p>Now there are six words here</p>' })]);
	assert.equal((row(state) as { word_count: number }).word_count, 6);
});

test('the insert-only RSS path stores reading length too', async () => {
	const state = setup();
	await store(state, [item()], false);
	assert.deepEqual(row(state), { word_count: 4, media_kind: 'text' });
});
