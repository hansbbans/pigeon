import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { generateApiToken } from '../src/api-auth';
import { handleBrowserYouTubeProxy } from '../src/browser-reading-api';
import app from '../src/index';
import {
	MAX_TRANSCRIPT_JSON_BYTES,
	MAX_TRANSCRIPT_REQUEST_BYTES,
	parseTranscriptDocument,
} from '../src/item-transcripts';
import type { Env } from '../src/types';
import { createSchemaDatabase } from './helpers/sqlite-d1';

const PASSWORD = 'transcript-password';
const BASE_URL = 'https://pigeon.example';
const VIDEO = '00000000-0000-4000-8000-000000000001';
const SAVED_VIDEO = '00000000-0000-4000-8000-000000000002';
const ARTICLE = '00000000-0000-4000-8000-000000000003';

const TRANSCRIPT = {
	version: 1,
	language: 'en',
	segments: [
		{ start: 4, duration: 2, text: 'This is a 3.' },
		{ start: 6, duration: 8, text: "It's sloppily written." },
		{ start: 14, text: 'And I want you to take a moment.' },
	],
	chapters: [{ start: 0, title: 'Introduction' }, { start: 14, title: 'Why it matters' }],
};

async function setup() {
	const { database, db } = createSchemaDatabase();
	database.exec(`
		INSERT INTO feeds (rowid, feed_key, display_name, source_type, source_url)
		VALUES (1, 'channel', 'Channel', 'rss', 'https://www.youtube.com/feeds/videos.xml?channel_id=UC0000000000000000000000'),
		       (2, 'blog', 'Blog', 'rss', 'https://blog.example.com/feed.xml'),
		       (3, 'pigeon:saved', 'Read It Later', 'saved', NULL);
		INSERT INTO items (rowid, id, feed_key, subject, html_content, original_url, message_id, received_at, media_kind)
		VALUES (1, '${VIDEO}', 'channel', 'A video', '<p>Description</p>', 'https://www.youtube.com/watch?v=aircAruvnKk', 'yt-1', '2026-11-01T09:00:00.000Z', 'video'),
		       (2, '${SAVED_VIDEO}', 'pigeon:saved', 'Saved video', '', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'saved:1', '2026-11-01T09:00:00.000Z', NULL),
		       (3, '${ARTICLE}', 'blog', 'An essay', '<p>Words</p>', 'https://blog.example.com/essay', 'blog-1', '2026-11-01T09:00:00.000Z', 'text');
	`);
	const env = { API_PASSWORD: PASSWORD, BASE_URL, DB: db } as unknown as Env;
	const token = await generateApiToken(PASSWORD);
	const request = (path: string, init: RequestInit = {}) => {
		const headers = new Headers(init.headers);
		headers.set('Authorization', `GoogleLogin auth=pigeon/${token}`);
		return app.fetch(new Request(`${BASE_URL}${path}`, { ...init, headers }), env);
	};
	const put = async (id: string, body: unknown, method = 'PUT') => {
		const response = await request(`/api/v1/items/${encodeURIComponent(id)}/transcript`, {
			method, headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
		});
		return { status: response.status, body: await response.json() as Record<string, any> };
	};
	const get = async (id: string) => {
		const response = await request(`/api/v1/items/${encodeURIComponent(id)}/transcript`);
		return { status: response.status, headers: response.headers, body: await response.json() as Record<string, any> };
	};
	const articleEvents = (id: string) => (database.prepare(
		"SELECT COUNT(*) AS count FROM sync_changes WHERE entity_type = 'article' AND entity_id = ?",
	).get(id) as { count: number }).count;
	return { database, env, request, put, get, articleEvents };
}

test('parseTranscriptDocument keeps the versioned format, sorts, drops blanks and unknown keys', () => {
	const parsed = parseTranscriptDocument({
		version: 1, language: ' en-US ', extra: true,
		segments: [{ start: 9.87654, text: '  second\n line ', speaker: 2 }, { start: 1, duration: 8.88888, text: 'first' }, { start: 3, text: '   ' }],
		chapters: [{ start: 5, title: ' B ' }, { start: 0, title: 'A' }, { start: 1, title: '' }],
	});
	assert.deepEqual(parsed.document, {
		version: 1, language: 'en-US',
		segments: [{ start: 1, duration: 8.889, text: 'first' }, { start: 9.877, text: 'second line' }],
		chapters: [{ start: 0, title: 'A' }, { start: 5, title: 'B' }],
	});
	assert.equal(parsed.json, JSON.stringify(parsed.document));
	assert.equal(parsed.text, 'A\nB\nfirst\nsecond line');
	assert.deepEqual(parseTranscriptDocument({ version: 1, segments: [{ start: 0, text: 'x' }], chapters: [] }).document,
		{ version: 1, segments: [{ start: 0, text: 'x' }] }, 'empty chapters and no language are omitted');
	for (const bad of [
		null, [], { version: 2, segments: [{ start: 0, text: 'x' }] }, { version: 1 }, { version: 1, segments: [] },
		{ version: 1, segments: [{ start: -1, text: 'x' }] }, { version: 1, segments: [{ start: Number.NaN, text: 'x' }] },
		{ version: 1, segments: [{ start: '1', text: 'x' }] }, { version: 1, segments: [{ start: 1, text: 3 }] },
		{ version: 1, segments: [{ start: 1, text: 'x', duration: -2 }] }, { version: 1, language: 'not a tag!', segments: [{ start: 0, text: 'x' }] },
		{ version: 1, segments: [{ start: 0, text: 'x' }], chapters: {} }, { version: 1, segments: [{ start: 0, text: 'x' }], chapters: [{ start: 0 }] },
		{ version: 1, segments: [{ start: 0, text: 'x'.repeat(5001) }] },
	]) {
		assert.throws(() => parseTranscriptDocument(bad), (error: any) => error.status === 400, JSON.stringify(bad));
	}
});

test('PUT stores a transcript for a feed video and a saved YouTube link; GET reads it back', async (t) => {
	const state = await setup();
	t.after(() => state.database.close());
	assert.equal((await state.get(VIDEO)).status, 404);
	assert.equal((await state.get(VIDEO)).body.code, 'transcript_not_found');

	const stored = await state.put(VIDEO, TRANSCRIPT);
	assert.equal(stored.status, 200);
	assert.deepEqual(stored.body, { itemId: VIDEO, updated: true, language: 'en', segmentCount: 3, chapterCount: 2, bytes: JSON.stringify(TRANSCRIPT).length });
	const read = await state.get(VIDEO);
	assert.equal(read.status, 200);
	assert.match(read.headers.get('Content-Type') ?? '', /^application\/json/);
	assert.equal(read.headers.get('Cache-Control'), 'no-store');
	assert.equal(read.body.itemId, VIDEO);
	assert.match(read.body.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
	assert.deepEqual(read.body.transcript, TRANSCRIPT);
	const row = state.database.prepare('SELECT language, text FROM item_transcripts WHERE item_id = ?').get(VIDEO) as any;
	assert.equal(row.language, 'en');
	assert.equal(row.text, "Introduction\nWhy it matters\nThis is a 3.\nIt's sloppily written.\nAnd I want you to take a moment.");

	// Any reader id form addresses the same item; a saved YouTube link qualifies by its URL alone.
	assert.deepEqual((await state.get('tag:google.com,2005:reader/item/0000000000000001')).body.transcript, TRANSCRIPT);
	assert.deepEqual((await state.get('1')).body.transcript, TRANSCRIPT);
	const saved = await state.put('tag:google.com,2005:reader/item/0000000000000002', { version: 1, segments: [{ start: 0, text: 'Never gonna' }] }, 'POST');
	assert.equal(saved.status, 200);
	assert.equal(saved.body.itemId, SAVED_VIDEO);
	assert.deepEqual((await state.get(SAVED_VIDEO)).body.transcript, { version: 1, segments: [{ start: 0, text: 'Never gonna' }] });
});

test('a repeat upload is a no-op with no sync event; a changed one replaces it and adds one', async (t) => {
	const state = await setup();
	t.after(() => state.database.close());
	const before = state.articleEvents(VIDEO);
	assert.equal((await state.put(VIDEO, TRANSCRIPT)).body.updated, true);
	assert.equal(state.articleEvents(VIDEO), before + 1);
	for (let attempt = 0; attempt < 5; attempt += 1) {
		const repeat = await state.put(VIDEO, { ...TRANSCRIPT, unknownKey: attempt });
		assert.equal(repeat.status, 200);
		assert.equal(repeat.body.updated, false);
	}
	assert.equal(state.articleEvents(VIDEO), before + 1, 'identical uploads add no sync_changes rows');
	const changed = { ...TRANSCRIPT, language: 'de', segments: [{ start: 0, text: 'Das ist eine 3.' }] };
	assert.equal((await state.put(VIDEO, changed)).body.updated, true);
	assert.equal(state.articleEvents(VIDEO), before + 2);
	assert.deepEqual((await state.get(VIDEO)).body.transcript, { version: 1, language: 'de', segments: [{ start: 0, text: 'Das ist eine 3.' }], chapters: TRANSCRIPT.chapters });
	assert.equal((state.database.prepare('SELECT COUNT(*) AS count FROM item_transcripts').get() as any).count, 1);
	// Removing the item takes its transcript with it.
	state.database.prepare('DELETE FROM items WHERE id = ?').run(VIDEO);
	assert.equal((state.database.prepare('SELECT COUNT(*) AS count FROM item_transcripts').get() as any).count, 0);
});

test('transcripts are refused for text items, unknown items, bad bodies and oversize documents', async (t) => {
	const state = await setup();
	t.after(() => state.database.close());
	assert.deepEqual(await state.put(ARTICLE, TRANSCRIPT), { status: 422, body: { error: 'Transcripts are stored only for YouTube videos', code: 'not_a_video' } });
	assert.equal((await state.put('00000000-0000-4000-8000-00000000ffff', TRANSCRIPT)).body.code, 'item_not_found');
	assert.equal((await state.put('not-an-id', TRANSCRIPT)).status, 404);
	assert.equal((await state.get('%E0%A4%A')).status, 404);
	assert.equal((await state.put(VIDEO, '{not json')).body.code, 'invalid_transcript');
	assert.equal((await state.put(VIDEO, { version: 1, segments: [] })).status, 400);

	// Canonical JSON over the cap: a 413, and nothing stored.
	const big = { version: 1, segments: Array.from({ length: 200 }, (_, index) => ({ start: index, text: 'word '.repeat(480).trim() })) };
	assert.ok(JSON.stringify(big).length > MAX_TRANSCRIPT_JSON_BYTES && JSON.stringify(big).length < MAX_TRANSCRIPT_REQUEST_BYTES);
	assert.deepEqual((await state.put(VIDEO, big)).body.code, 'transcript_too_large');
	// A request body over the request cap, with or without a Content-Length.
	const huge = JSON.stringify({ version: 1, segments: [{ start: 0, text: 'x' }], pad: 'x'.repeat(MAX_TRANSCRIPT_REQUEST_BYTES) });
	assert.equal((await state.put(VIDEO, huge)).status, 413);
	const chunked = await state.request(`/api/v1/items/${VIDEO}/transcript`, {
		method: 'PUT', headers: { 'Content-Type': 'application/json' }, duplex: 'half',
		body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(huge)); controller.close(); } }),
	} as RequestInit);
	assert.equal(chunked.status, 413);
	const tooMany = { version: 1, segments: Array.from({ length: 20_001 }, (_, index) => ({ start: index, text: 'a' })) };
	assert.equal((await state.put(VIDEO, tooMany)).status, 413);
	assert.equal((state.database.prepare('SELECT COUNT(*) AS count FROM item_transcripts').get() as any).count, 0);
	assert.equal((await state.request(`/api/v1/items/${VIDEO}/transcript`, { method: 'DELETE' })).status, 405);
	assert.equal((await state.request(`/api/v1/items/${VIDEO}/other`)).status, 404);
});

test('transcript and YouTube proxy routes require Pigeon authentication before any DB or network access', async (t) => {
	let calls = 0;
	t.mock.method(globalThis, 'fetch', () => { calls += 1; throw new Error('must not fetch'); });
	const env = { API_PASSWORD: PASSWORD, BASE_URL, DB: { prepare() { calls += 1; throw new Error('must not query'); } } } as unknown as Env;
	for (const [path, method] of [
		[`/api/v1/items/${VIDEO}/transcript`, 'GET'], [`/api/v1/items/${VIDEO}/transcript`, 'PUT'],
		['/api/v1/browser/youtube-proxy?url=' + encodeURIComponent('https://www.youtube.com/api/timedtext?v=x'), 'GET'],
	]) {
		const response = await app.fetch(new Request(BASE_URL + path, { method, headers: { Authorization: 'GoogleLogin auth=pigeon/wrong' } }), env);
		assert.equal(response.status, 401, path);
	}
	assert.equal(calls, 0);
});

test('sync and GReader article payloads carry hasTranscript only once a transcript exists', async (t) => {
	const state = await setup();
	t.after(() => state.database.close());
	const sync = async (cursor = '') => (await (await state.request(`/api/v1/sync?limit=200${cursor ? `&cursor=${cursor}` : ''}`)).json()) as any;
	const first = await sync();
	const video = first.changes.find((change: any) => change.entityId === VIDEO);
	assert.equal('hasTranscript' in video.payload, false, 'absent, not false, so fixtures and old clients see no new key');
	await state.put(VIDEO, TRANSCRIPT);
	const next = await sync(first.cursor);
	assert.deepEqual(next.changes.map((change: any) => [change.entityId, change.operation]), [[VIDEO, 'upsert']]);
	assert.equal(next.changes[0].payload.hasTranscript, true);
	assert.equal((await sync(next.cursor)).changes.length, 0);
	await state.put(VIDEO, TRANSCRIPT);
	assert.equal((await sync(next.cursor)).changes.length, 0, 'a repeat upload sends nothing new');

	const body = new URLSearchParams([['i', '1'], ['i', '3']]);
	const contents = await (await state.request('/reader/api/0/stream/items/contents', {
		method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
	})).json() as any;
	assert.equal(contents.items.find((item: any) => item.title === 'A video').hasTranscript, true);
	assert.equal('hasTranscript' in contents.items.find((item: any) => item.title === 'An essay'), false);
});

function proxyRequest(target: string, init: RequestInit = {}) {
	return new Request(`${BASE_URL}/api/v1/browser/youtube-proxy?url=${encodeURIComponent(target)}`, {
		...init, headers: { Authorization: 'caller-secret', Cookie: 'session=caller-cookie', ...(init.headers as Record<string, string> ?? {}) },
	});
}
const PLAYER = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const CAPTIONS = 'https://www.youtube.com/api/timedtext?v=aircAruvnKk&lang=en';

test('YouTube proxy forwards only the InnerTube and caption endpoints, with no caller credentials', async () => {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(input), init: init ?? {} });
		return String(input).includes('timedtext')
			? new Response('<transcript><text start="0">Hi</text></transcript>', { headers: { 'Content-Type': 'text/xml; charset=UTF-8' } })
			: Response.json({ captions: {} });
	}) as typeof fetch;

	const player = await handleBrowserYouTubeProxy(proxyRequest(PLAYER, {
		method: 'POST', body: JSON.stringify({ context: { client: { clientName: 'ANDROID' } }, videoId: 'aircAruvnKk' }),
		headers: { 'Content-Type': 'application/json', 'X-Pigeon-Upstream-User-Agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 14)', 'X-Pigeon-Upstream-Language': 'en-US,en;q=0.9' },
	}), fetcher);
	assert.equal(player.status, 200);
	assert.deepEqual(await player.json(), { captions: {} });
	assert.equal(player.headers.get('Cache-Control'), 'no-store');
	assert.equal(player.headers.get('X-Content-Type-Options'), 'nosniff');
	const [call] = calls;
	assert.equal(call.url, PLAYER);
	assert.equal(call.init.method, 'POST');
	assert.equal(call.init.redirect, 'manual');
	assert.ok(call.init.signal instanceof AbortSignal);
	assert.equal(new TextDecoder().decode(call.init.body as Uint8Array), JSON.stringify({ context: { client: { clientName: 'ANDROID' } }, videoId: 'aircAruvnKk' }));
	assert.deepEqual(call.init.headers, {
		Accept: 'application/json', 'User-Agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 14)',
		'Accept-Language': 'en-US,en;q=0.9', 'Content-Type': 'application/json',
	});

	const captions = await handleBrowserYouTubeProxy(proxyRequest(CAPTIONS, { headers: { 'X-Pigeon-Upstream-User-Agent': 'curl/8', 'X-Pigeon-Upstream-Language': 'en<script>' } }), fetcher);
	assert.equal(captions.status, 200);
	assert.equal(captions.headers.get('Content-Type'), 'text/xml; charset=utf-8');
	assert.equal(await captions.text(), '<transcript><text start="0">Hi</text></transcript>');
	const headers = calls[1].init.headers as Record<string, string>;
	assert.equal(headers['User-Agent'], 'Mozilla/5.0', 'an unexpected agent falls back to the default');
	assert.equal('Accept-Language' in headers, false);
	for (const { init } of calls) {
		const sent = JSON.stringify(init.headers).toLowerCase();
		assert.equal(sent.includes('caller-secret') || sent.includes('cookie') || sent.includes('authorization'), false);
	}
	// m.youtube.com and the bare domain are YouTube too.
	assert.equal((await handleBrowserYouTubeProxy(proxyRequest('https://m.youtube.com/api/timedtext?v=x'), fetcher)).status, 200);
	assert.equal((await handleBrowserYouTubeProxy(proxyRequest('https://youtube.com/api/timedtext?v=x'), fetcher)).status, 200);
	assert.equal(calls.length, 4);
});

test('YouTube proxy rejects other hosts, paths, schemes, ports, credentials and private addresses before fetching', async () => {
	let calls = 0;
	const fetcher = (async () => { calls += 1; return new Response('{}'); }) as typeof fetch;
	for (const target of [
		'https://example.com/api/timedtext', 'https://www.youtube.com.evil.example/api/timedtext', 'https://evilyoutube.com/api/timedtext',
		'https://youtube.com.evil.example/youtubei/v1/player', 'http://www.youtube.com/api/timedtext', 'https://www.youtube.com:8443/api/timedtext',
		'https://user:pass@www.youtube.com/api/timedtext', 'https://www.youtube.com/watch?v=aircAruvnKk', 'https://www.youtube.com/api/timedtext/../../account',
		'https://www.youtube.com/youtubei/v1/browse', 'https://127.0.0.1/api/timedtext', 'https://localhost/api/timedtext', 'https://[::1]/api/timedtext',
		'https://169.254.169.254/api/timedtext', 'file:///etc/passwd', 'javascript:alert(1)', 'https://www.youtube.com\u0000.evil/api/timedtext',
		'https://-bad-.youtube.com/api/timedtext', '',
	]) {
		const response = await handleBrowserYouTubeProxy(proxyRequest(target), fetcher);
		assert.equal(response.status, 400, target);
	}
	assert.equal((await handleBrowserYouTubeProxy(new Request(`${BASE_URL}/api/v1/browser/youtube-proxy`), fetcher)).status, 400);
	assert.equal((await handleBrowserYouTubeProxy(new Request(`${BASE_URL}/api/v1/browser/youtube-proxy?url=${encodeURIComponent(CAPTIONS)}&url=${encodeURIComponent(CAPTIONS)}`), fetcher)).status, 400);
	assert.equal((await handleBrowserYouTubeProxy(new Request(`${BASE_URL}/api/v1/browser/youtube-proxy?url=${encodeURIComponent(CAPTIONS)}&x=1`), fetcher)).status, 400);
	// Each path takes only its one method; POST bodies are small JSON.
	assert.equal((await handleBrowserYouTubeProxy(proxyRequest(PLAYER), fetcher)).status, 405);
	assert.equal((await handleBrowserYouTubeProxy(proxyRequest(CAPTIONS, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } }), fetcher)).status, 405);
	assert.equal((await handleBrowserYouTubeProxy(proxyRequest(PLAYER, { method: 'POST', body: '{}', headers: { 'Content-Type': 'text/plain' } }), fetcher)).status, 415);
	assert.equal((await handleBrowserYouTubeProxy(proxyRequest(PLAYER, { method: 'POST', body: 'x'.repeat(16_385), headers: { 'Content-Type': 'application/json' } }), fetcher)).status, 413);
	assert.equal(calls, 0);
});

test('YouTube proxy turns refusals, redirects, odd types, oversize bodies and network failures into clean errors', async () => {
	const answer = (response: Response | Error) => (async () => { if (response instanceof Error) throw response; return response; }) as unknown as typeof fetch;
	const run = async (response: Response | Error) => {
		const result = await handleBrowserYouTubeProxy(proxyRequest(CAPTIONS), answer(response));
		return { status: result.status, body: await result.json() as Record<string, unknown> };
	};
	assert.deepEqual(await run(new Response('blocked', { status: 429 })), { status: 502, body: { error: 'YouTube did not return the transcript data', code: 'youtube_unavailable', upstreamStatus: 429 } });
	assert.equal((await run(new Response(null, { status: 302, headers: { Location: 'https://consent.youtube.com/' } }))).body.upstreamStatus, 302, 'redirects are not followed');
	assert.equal((await run(new Response('<html>', { headers: { 'Content-Type': 'text/html' } }))).status, 502);
	assert.equal((await run(new Response('x', { headers: { 'Content-Type': 'text/xml', 'Content-Length': '4000001' } }))).status, 413);
	const stream = new ReadableStream({ start(controller) { for (let index = 0; index < 5; index += 1) controller.enqueue(new Uint8Array(1_000_000)); controller.close(); } });
	assert.equal((await run(new Response(stream, { headers: { 'Content-Type': 'text/xml' } }))).status, 413);
	assert.deepEqual(await run(new TypeError('network down')), { status: 502, body: { error: 'Could not reach YouTube', code: 'youtube_unreachable' } });
	assert.equal((await run(new DOMException('The operation timed out.', 'TimeoutError'))).body.code, 'youtube_unreachable');
	const empty = await handleBrowserYouTubeProxy(proxyRequest(CAPTIONS), answer(new Response(null, { status: 204, headers: { 'Content-Type': 'text/xml' } })));
	assert.equal(empty.status, 200);
	assert.equal(await empty.text(), '');
});
