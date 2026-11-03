import * as assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { handleCronTrigger } from '../src/cron-handler';
import { parseYouTubeDuration, runYouTubeDurationBackfill } from '../src/item-metadata-backfill';
import { RefreshQueryBudget } from '../src/rss-fetcher';
import { articleSyncChanges, createSchemaDatabase } from './helpers/sqlite-d1';

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

function setup() {
	const state = createSchemaDatabase();
	state.database.exec("INSERT INTO feeds (feed_key, display_name, source_type) VALUES ('blog', 'Blog', 'rss')");
	return state;
}

type State = ReturnType<typeof setup>;

function insertItem(state: State, id: string, receivedAt: string, html: string, options: {
	text?: string | null;
	url?: string | null;
	pruned?: boolean;
	wordCount?: number | null;
	mediaKind?: string | null;
} = {}) {
	state.database.prepare(
		`INSERT INTO items (id, feed_key, subject, html_content, text_content, original_url, message_id, received_at,
		  content_pruned_at, word_count, media_kind)
		 VALUES (?, 'blog', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		id, id, html, options.text ?? null, options.url ?? null, `message-${id}`, receivedAt,
		options.pruned ? '2026-10-01T00:00:00.000Z' : null, options.wordCount ?? null, options.mediaKind ?? null,
	);
}

function item(state: State, id: string) {
	return { ...(state.database.prepare('SELECT word_count, media_kind, duration_seconds, content_version FROM items WHERE id = ?').get(id) as object) } as {
		word_count: number | null;
		media_kind: string | null;
		duration_seconds: number | null;
		content_version: number;
	};
}

test('parseYouTubeDuration reads ISO 8601 durations', () => {
	assert.equal(parseYouTubeDuration('PT1H2M3S'), 3723);
	assert.equal(parseYouTubeDuration('PT18M20S'), 1100);
	assert.equal(parseYouTubeDuration('P0D'), 0);
	assert.equal(parseYouTubeDuration('P1DT2H'), 93_600);
	assert.equal(parseYouTubeDuration('PT'), null);
	assert.equal(parseYouTubeDuration('garbage'), null);
});

function stubYouTube(durations: Record<string, string>, status = 200) {
	const requests: URL[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input instanceof Request ? input.url : input));
		requests.push(url);
		assert.equal(new Headers(init?.headers).get('x-goog-api-key'), 'test-key');
		const ids = (url.searchParams.get('id') ?? '').split(',');
		const items = ids.filter((id) => durations[id]).map((id) => ({ id, contentDetails: { duration: durations[id] } }));
		return new Response(JSON.stringify({ items }), { status, headers: { 'Content-Type': 'application/json' } });
	}) as typeof fetch;
	return requests;
}

const NOW = new Date('2026-11-04T00:00:00.000Z');

function insertVideo(state: State, id: string, videoId: string, receivedAt: string) {
	insertItem(state, id, receivedAt.length === 2 ? `2026-11-${receivedAt}T00:00:00.000Z` : receivedAt, '<p>description</p>', {
		url: `https://www.youtube.com/watch?v=${videoId}`,
		mediaKind: 'video',
	});
}

test('duration backfill stores durations from one API call and zero for missing videos', async () => {
	const state = setup();
	insertVideo(state, 'v1', 'aaaaaaaaaaa', '01');
	insertVideo(state, 'v2', 'bbbbbbbbbbb', '02');
	insertVideo(state, 'v3', 'ccccccccccc', '03');
	const requests = stubYouTube({ aaaaaaaaaaa: 'PT18M20S', bbbbbbbbbbb: 'PT1H5M' });

	assert.equal(await runYouTubeDurationBackfill(state.db as never, new RefreshQueryBudget(47), 'test-key', NOW), 3);

	assert.equal(requests.length, 1);
	assert.equal(requests[0]?.searchParams.get('part'), 'contentDetails');
	assert.deepEqual([item(state, 'v1').duration_seconds, item(state, 'v2').duration_seconds, item(state, 'v3').duration_seconds], [1100, 3900, 0]);
	assert.equal(item(state, 'v1').content_version, 1);
	assert.equal(await runYouTubeDurationBackfill(state.db as never, new RefreshQueryBudget(47), 'test-key', NOW), 0);
	assert.equal(requests.length, 1);
});

test('duration backfill writes nothing on an API error and makes no call without a key', async () => {
	const state = setup();
	insertVideo(state, 'v1', 'aaaaaaaaaaa', '01');
	const requests = stubYouTube({ aaaaaaaaaaa: 'PT1M' }, 500);

	assert.equal(await runYouTubeDurationBackfill(state.db as never, new RefreshQueryBudget(47), 'test-key', NOW), 0);
	assert.equal(item(state, 'v1').duration_seconds, null);
	assert.equal(await runYouTubeDurationBackfill(state.db as never, new RefreshQueryBudget(47), undefined), 0);
	assert.equal(await runYouTubeDurationBackfill(state.db as never, new RefreshQueryBudget(47), '  '), 0);
	assert.equal(requests.length, 1);
});

test('a premiere or live stream (P0D) is retried for a week, then settles on zero', async () => {
	const state = setup();
	insertVideo(state, 'fresh', 'aaaaaaaaaaa', '2026-11-02T00:00:00.000Z');
	insertVideo(state, 'stale', 'bbbbbbbbbbb', '2026-10-20T00:00:00.000Z');
	stubYouTube({ aaaaaaaaaaa: 'P0D', bbbbbbbbbbb: 'P0D' });

	assert.equal(await runYouTubeDurationBackfill(state.db as never, new RefreshQueryBudget(47), 'test-key', NOW), 1);
	assert.equal(item(state, 'fresh').duration_seconds, null);
	assert.equal(item(state, 'stale').duration_seconds, 0);

	stubYouTube({ aaaaaaaaaaa: 'PT1H30M' });
	assert.equal(await runYouTubeDurationBackfill(state.db as never, new RefreshQueryBudget(47), 'test-key', NOW), 1);
	assert.equal(item(state, 'fresh').duration_seconds, 5400);
});

test('the cron fills durations even when no feed is due', async () => {
	const state = setup();
	insertVideo(state, 'v1', 'aaaaaaaaaaa', '02');
	stubYouTube({ aaaaaaaaaaa: 'PT12M' });

	await handleCronTrigger({ DB: state.db, YOUTUBE_API_KEY: 'test-key' } as never);

	assert.equal(item(state, 'v1').duration_seconds, 720);
});
