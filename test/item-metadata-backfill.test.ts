import * as assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { handleCronTrigger } from '../src/cron-handler';
import {
	BACKFILL_BYTE_BUDGET,
	parseYouTubeDuration,
	runWordCountBackfill,
	runYouTubeDurationBackfill,
} from '../src/item-metadata-backfill';
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

test('word-count backfill fills newest items first, tags video, and skips pruned bodies', async () => {
	const state = setup();
	insertItem(state, 'old', '2026-10-01T00:00:00.000Z', '<p>one two three</p>');
	insertItem(state, 'new', '2026-11-01T00:00:00.000Z', '', { text: 'plain text body', url: 'https://youtu.be/dQw4w9WgXcQ' });
	insertItem(state, 'pruned', '2026-11-02T00:00:00.000Z', '', { pruned: true });
	insertItem(state, 'done', '2026-11-03T00:00:00.000Z', '<p>x</p>', { wordCount: 900, mediaKind: 'text' });
	const before = articleSyncChanges(state.database);

	assert.equal(await runWordCountBackfill(state.db as never, new RefreshQueryBudget(47)), 2);

	assert.deepEqual(item(state, 'old'), { word_count: 3, media_kind: 'text', duration_seconds: null, content_version: 1 });
	assert.deepEqual(item(state, 'new'), { word_count: 3, media_kind: 'video', duration_seconds: null, content_version: 1 });
	assert.equal(item(state, 'pruned').word_count, null);
	assert.deepEqual(item(state, 'done'), { word_count: 900, media_kind: 'text', duration_seconds: null, content_version: 0 });
	assert.equal(articleSyncChanges(state.database), before + 2);
});

test('word-count backfill stays inside its byte budget across runs', async () => {
	const state = setup();
	const body = `<p>${'word '.repeat(60_000)}</p>`; // 300 007 characters, counted up to the scan cap
	assert.ok(body.length * 2 > BACKFILL_BYTE_BUDGET);
	for (const [index, day] of ['01', '02', '03'].entries()) insertItem(state, `big-${index}`, `2026-11-${day}T00:00:00.000Z`, body);

	for (const expectedRemaining of [2, 1, 0]) {
		assert.equal(await runWordCountBackfill(state.db as never, new RefreshQueryBudget(47)), 1);
		const remaining = (state.database.prepare('SELECT COUNT(*) AS count FROM items WHERE word_count IS NULL').get() as { count: number }).count;
		assert.equal(remaining, expectedRemaining);
	}
	assert.equal(item(state, 'big-2').word_count, 60_000);
});

test('an image-only item stores zero words and is not selected again', async () => {
	const state = setup();
	insertItem(state, 'image', '2026-11-01T00:00:00.000Z', '<p><img src="https://example.com/a.png"></p>');
	assert.equal(await runWordCountBackfill(state.db as never, new RefreshQueryBudget(47)), 1);
	assert.equal(item(state, 'image').word_count, 0);
	const before = articleSyncChanges(state.database);
	assert.equal(await runWordCountBackfill(state.db as never, new RefreshQueryBudget(47)), 0);
	assert.equal(articleSyncChanges(state.database), before);
});

test('the word-count backfill does nothing without three queries of budget', async () => {
	const state = setup();
	insertItem(state, 'a', '2026-11-01T00:00:00.000Z', '<p>words</p>');
	const budget = new RefreshQueryBudget(2);
	assert.equal(await runWordCountBackfill(state.db as never, budget), 0);
	assert.equal(budget.reserve(2), true);
	assert.equal(item(state, 'a').word_count, null);
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

function insertVideo(state: State, id: string, videoId: string, day: string) {
	insertItem(state, id, `2026-11-${day}T00:00:00.000Z`, '<p>description</p>', {
		url: `https://www.youtube.com/watch?v=${videoId}`,
		wordCount: 1,
		mediaKind: 'video',
	});
}

test('duration backfill stores durations from one API call and zero for missing videos', async () => {
	const state = setup();
	insertVideo(state, 'v1', 'aaaaaaaaaaa', '01');
	insertVideo(state, 'v2', 'bbbbbbbbbbb', '02');
	insertVideo(state, 'v3', 'ccccccccccc', '03');
	const requests = stubYouTube({ aaaaaaaaaaa: 'PT18M20S', bbbbbbbbbbb: 'PT1H5M' });

	assert.equal(await runYouTubeDurationBackfill(state.db as never, new RefreshQueryBudget(47), 'test-key'), 3);

	assert.equal(requests.length, 1);
	assert.equal(requests[0]?.searchParams.get('part'), 'contentDetails');
	assert.deepEqual([item(state, 'v1').duration_seconds, item(state, 'v2').duration_seconds, item(state, 'v3').duration_seconds], [1100, 3900, 0]);
	assert.equal(item(state, 'v1').content_version, 1);
	assert.equal(await runYouTubeDurationBackfill(state.db as never, new RefreshQueryBudget(47), 'test-key'), 0);
	assert.equal(requests.length, 1);
});

test('duration backfill writes nothing on an API error and makes no call without a key', async () => {
	const state = setup();
	insertVideo(state, 'v1', 'aaaaaaaaaaa', '01');
	const requests = stubYouTube({ aaaaaaaaaaa: 'PT1M' }, 500);

	assert.equal(await runYouTubeDurationBackfill(state.db as never, new RefreshQueryBudget(47), 'test-key'), 0);
	assert.equal(item(state, 'v1').duration_seconds, null);
	assert.equal(await runYouTubeDurationBackfill(state.db as never, new RefreshQueryBudget(47), undefined), 0);
	assert.equal(await runYouTubeDurationBackfill(state.db as never, new RefreshQueryBudget(47), '  '), 0);
	assert.equal(requests.length, 1);
});

test('the cron runs both backfills when no feed is due', async () => {
	const state = setup();
	insertItem(state, 'a', '2026-11-01T00:00:00.000Z', '<p>four words right here</p>');
	insertVideo(state, 'v1', 'aaaaaaaaaaa', '02');
	stubYouTube({ aaaaaaaaaaa: 'PT12M' });

	await handleCronTrigger({ DB: state.db, YOUTUBE_API_KEY: 'test-key' } as never);

	assert.equal(item(state, 'a').word_count, 4);
	assert.equal(item(state, 'v1').duration_seconds, 720);
});
