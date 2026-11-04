import * as assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

import { renderBrowserAppHtml } from '../src/browser-app';
import { handleBrowserYouTubeProxy } from '../src/browser-reading-api';
import {
	activeTranscriptIndex,
	createTranscriptView,
	createYouTubeProxyFetch,
	fetchYouTubeTranscript,
	formatTranscriptTime,
	parseDefuddleTranscript,
	readYouTubePlayerMessage,
	shouldAutoScrollTranscript,
	transcriptScrollTarget,
	youtubePlayerCommand,
} from '../src/browser-transcript';
import { parseTranscriptDocument } from '../src/item-transcripts';
import {
	createBrowserHarness,
	createElement,
	findListButtonByItemId,
	flushBrowserTasks,
	waitForBrowserCondition,
} from './helpers/browser-app-client-harness';

const helpers = { formatTranscriptTime, activeTranscriptIndex, readYouTubePlayerMessage, youtubePlayerCommand, transcriptScrollTarget, shouldAutoScrollTranscript };
const VIDEO_ID = 'aircAruvnKk';
const VIDEO_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;
// The shape Defuddle 0.19.6 puts in variables.transcript (utils/transcript.js buildTranscript).
const DEFUDDLE_TEXT = [
	'### Introduction example', '', '**0:04** · This is a 3.', "**0:06** · It's sloppily written · and rendered.", '',
	'### Neural networks', '', '**1:02:14** · What are the neurons?', '**bad** · ignored', 'stray line',
].join('\n');
const TRANSCRIPT = {
	version: 1 as const,
	language: 'en',
	segments: [
		{ start: 4, duration: 2, text: 'This is a 3.' },
		{ start: 6, duration: 8, text: "It's sloppily written." },
		{ start: 14, text: 'And I want you to take a moment.' },
	],
	chapters: [{ start: 0, title: 'Introduction' }, { start: 14, title: 'Why it matters' }],
};

test('pure transcript helpers: times, Defuddle text, active segment, player messages, scrolling', async () => {
	assert.deepEqual([0, 4.9, 65, 3599, 3600, 3725, -3, Number.NaN].map(formatTranscriptTime), ['0:00', '0:04', '1:05', '59:59', '1:00:00', '1:02:05', '0:00', '0:00']);

	const parsed = parseDefuddleTranscript(DEFUDDLE_TEXT, 'en');
	assert.deepEqual(parsed, {
		version: 1, language: 'en',
		segments: [
			{ start: 4, duration: 2, text: 'This is a 3.' },
			{ start: 6, duration: 3728, text: "It's sloppily written · and rendered." },
			{ start: 3734, text: 'What are the neurons?' },
		],
		chapters: [{ start: 4, title: 'Introduction example' }, { start: 3734, title: 'Neural networks' }],
	});
	// What the client builds is exactly what the Worker stores.
	assert.deepEqual((await parseTranscriptDocument(parsed)).document, parsed);
	assert.equal(parseDefuddleTranscript('**0:01** · hi', 'not a tag')?.language, undefined);
	for (const empty of [undefined, null, '', '   ', '### Only a heading', 'no timestamps here', 42]) assert.equal(parseDefuddleTranscript(empty), null);

	const starts = [4, 6, 14];
	assert.deepEqual([0, 3.99, 4, 5.5, 6, 13.9, 14, 999, Number.NaN].map((time) => activeTranscriptIndex(starts, time)), [-1, -1, 0, 0, 1, 1, 2, 2, -1]);
	assert.equal(activeTranscriptIndex([], 10), -1);

	assert.deepEqual(readYouTubePlayerMessage('{"event":"infoDelivery","info":{"currentTime":12.5,"playerState":1}}'), { currentTime: 12.5, playerState: 1 });
	assert.deepEqual(readYouTubePlayerMessage({ event: 'infoDelivery', info: { currentTime: 3 } }), { currentTime: 3 });
	for (const noise of ['not json', '{"event":"onReady"}', '{"info":{"currentTime":"3"}}', '{"info":{"currentTime":null}}', null, 7, 'x'.repeat(100_001)]) {
		assert.equal(readYouTubePlayerMessage(noise), null);
	}
	assert.deepEqual(JSON.parse(youtubePlayerCommand('seekTo', [12, true])), { event: 'command', func: 'seekTo', args: [12, true], id: 'pigeon-transcript', channel: 'widget' });

	assert.equal(transcriptScrollTarget(400, 40, 300, 2000), 320, 'a third of the way down');
	assert.equal(transcriptScrollTarget(10, 40, 300, 2000), 0, 'never above the top');
	assert.equal(transcriptScrollTarget(1990, 40, 300, 2000), 1700, 'never past the end');
	assert.equal(transcriptScrollTarget(Number.NaN, 40, 300, 2000), null);
	assert.equal(transcriptScrollTarget(10, 40, 0, 2000), null);
	assert.equal(shouldAutoScrollTranscript(10_000, 6_000, 4_000), true);
	assert.equal(shouldAutoScrollTranscript(9_999, 6_000, 4_000), false);
	assert.equal(shouldAutoScrollTranscript(0, Number.NEGATIVE_INFINITY, 4_000), true);
});

test('the proxy fetch sends YouTube requests to the Worker route with the agent and language in their own headers', async () => {
	const calls: Array<[string, Record<string, any>]> = [];
	const proxied = createYouTubeProxyFetch(async (input, init) => { calls.push([input, init]); return new Response('{}'); });
	const signal = new AbortController().signal;
	await proxied('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
		method: 'POST', body: '{"videoId":"x"}', signal,
		headers: { 'Content-Type': 'application/json', 'User-Agent': 'com.google.android.youtube/20.10.38', 'Accept-Language': 'en', Cookie: 'dropped' },
	});
	await proxied({ url: 'https://www.youtube.com/api/timedtext?v=x&lang=en' });
	assert.deepEqual(calls[0], ['/api/v1/browser/youtube-proxy?url=https%3A%2F%2Fwww.youtube.com%2Fyoutubei%2Fv1%2Fplayer%3FprettyPrint%3Dfalse', {
		method: 'POST', body: '{"videoId":"x"}', signal,
		headers: { 'Content-Type': 'application/json', 'X-Pigeon-Upstream-User-Agent': 'com.google.android.youtube/20.10.38', 'X-Pigeon-Upstream-Language': 'en' },
	}]);
	assert.deepEqual(calls[1], ['/api/v1/browser/youtube-proxy?url=https%3A%2F%2Fwww.youtube.com%2Fapi%2Ftimedtext%3Fv%3Dx%26lang%3Den', { method: 'GET', headers: {} }]);
});

// Upstream YouTube, as the Worker proxy sees it.
function fakeYouTube(options: { captions?: boolean; status?: number } = {}) {
	const requests: string[] = [];
	const fetcher = (async (input: string | URL | Request) => {
		const url = new URL(String(input));
		requests.push(url.pathname);
		if (options.status) return new Response('no', { status: options.status });
		if (url.pathname === '/youtubei/v1/player') {
			return Response.json(options.captions === false ? { playabilityStatus: { status: 'OK' } } : {
				captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: `https://www.youtube.com/api/timedtext?v=${VIDEO_ID}&lang=en`, languageCode: 'en' }] } },
			});
		}
		if (url.pathname === '/youtubei/v1/next') {
			return Response.json({ playerOverlays: { playerOverlayRenderer: { decoratedPlayerBarRenderer: { decoratedPlayerBarRenderer: { playerBar: { multiMarkersPlayerBarRenderer: { markersMap: [{ value: { chapters: [
				{ chapterRenderer: { title: { simpleText: 'Introduction' }, timeRangeStartMillis: 0 } },
				{ chapterRenderer: { title: { simpleText: 'Layers' }, timeRangeStartMillis: 30_000 } },
			] } }] } } } } } } });
		}
		return new Response('<timedtext format="3"><body><p t="4000" d="2000">This is a 3.</p><p t="31000" d="4000">Each layer &amp; its neurons.</p></body></timedtext>', {
			headers: { 'Content-Type': 'text/xml; charset=UTF-8' },
		});
	}) as typeof fetch;
	return { requests, fetcher };
}

function viaWorkerProxy(fetcher: typeof fetch) {
	return createYouTubeProxyFetch(async (input, init) => handleBrowserYouTubeProxy(new Request('https://pigeon.example' + input, init as RequestInit), fetcher));
}

test('the vendored Defuddle YouTube extractor, routed through the Worker proxy, yields a storable transcript', async () => {
	const Defuddle = createRequire(import.meta.url)('defuddle');
	const { window } = new JSDOM('<!doctype html><html><body></body></html>');
	const youtube = fakeYouTube();
	const transcript = await fetchYouTubeTranscript({
		Defuddle: Defuddle.default ?? Defuddle, doc: window.document, videoId: VIDEO_ID,
		fetch: viaWorkerProxy(youtube.fetcher), parse: parseDefuddleTranscript, timeoutMs: 10_000,
	});
	assert.deepEqual(transcript, {
		version: 1, language: 'en',
		segments: [{ start: 4, duration: 27, text: 'This is a 3.' }, { start: 31, text: 'Each layer & its neurons.' }],
		chapters: [{ start: 4, title: 'Introduction' }, { start: 31, title: 'Layers' }],
	});
	assert.ok(youtube.requests.includes('/youtubei/v1/player') && youtube.requests.includes('/api/timedtext'), youtube.requests.join());
	assert.deepEqual((await parseTranscriptDocument(transcript)).document, transcript);

	for (const blocked of [fakeYouTube({ status: 429 }), fakeYouTube({ captions: false })]) {
		await assert.rejects(fetchYouTubeTranscript({
			Defuddle: Defuddle.default ?? Defuddle, doc: window.document, videoId: VIDEO_ID,
			fetch: viaWorkerProxy(blocked.fetcher), parse: parseDefuddleTranscript, timeoutMs: 10_000,
		}), /no transcript/);
	}
	window.close();
});

test('the view sends "listening" with backoff until the player first answers, then runs no timer', (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const posted: string[] = [];
	const player = { postMessage(message: string) { posted.push(JSON.parse(message).event); } };
	let onMessage: ((event: unknown) => void) | undefined;
	const win = { addEventListener: (_type: string, handler: (event: unknown) => void) => { onMessage = handler; }, removeEventListener() {} };
	const doc = { createElement: (tag: string) => createElement('', [], tag) };
	const view = createTranscriptView({ doc, win, container: createElement('', [], 'div'), transcript: TRANSCRIPT, getPlayerWindow: () => player, listenDelayMs: 100, helpers });
	t.after(() => view.destroy());
	assert.equal(posted.length, 1);
	t.mock.timers.tick(99);
	assert.equal(posted.length, 1);
	t.mock.timers.tick(1);
	assert.equal(posted.length, 2, 'retried after 100 ms');
	t.mock.timers.tick(200);
	assert.equal(posted.length, 3, 'then after 200 ms');
	t.mock.timers.tick(399);
	assert.equal(posted.length, 3, 'backing off');
	onMessage!({ source: player, origin: 'https://www.youtube.com', data: '{"event":"initialDelivery","info":{"playerState":-1}}' });
	for (let step = 0; step < 60; step += 1) t.mock.timers.tick(1_000);
	assert.deepEqual(posted, ['listening', 'listening', 'listening'], 'nothing more once the player answered');
	// A player that never answers gets ten tries, then the timer stops.
	posted.length = 0;
	const silent = createTranscriptView({ doc, win, container: createElement('', [], 'div'), transcript: TRANSCRIPT, getPlayerWindow: () => player, listenDelayMs: 100, helpers });
	for (let step = 0; step < 120; step += 1) t.mock.timers.tick(5_000);
	assert.equal(posted.length, 10);
	silent.destroy();
});

test('fetchYouTubeTranscript aborts in-flight requests when it ends and rejects later ones', async () => {
	const doc = { implementation: { createHTMLDocument: () => ({}) } };
	const signals: AbortSignal[] = [];
	let lateFetch: (() => Promise<unknown>) | undefined;
	const hangingFetch = (_input: unknown, init: { signal: AbortSignal }) => {
		signals.push(init.signal);
		return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
	};
	class Fetching {
		private readonly fetch: (input: unknown, init?: unknown) => Promise<unknown>;
		constructor(_page: unknown, options: { fetch: (input: unknown, init?: unknown) => Promise<unknown> }) { this.fetch = options.fetch; }
		parseAsync() { lateFetch = () => this.fetch('https://www.youtube.com/api/timedtext', {}); return this.fetch('https://www.youtube.com/youtubei/v1/player', { signal: new AbortController().signal }); }
	}
	await assert.rejects(fetchYouTubeTranscript({ Defuddle: Fetching, doc, videoId: VIDEO_ID, fetch: hangingFetch, parse: parseDefuddleTranscript, timeoutMs: 30 }), /timed out/);
	assert.equal(signals.length, 1);
	assert.equal(signals[0].aborted, true, 'the timeout aborted the request in flight');
	await assert.rejects(lateFetch!(), /ended/);
	assert.equal(signals.length, 1, 'a request after the run ended never reaches the network');

	// The caller's signal ends a run early (a newer run, or logging out).
	const caller = new AbortController();
	const run = fetchYouTubeTranscript({ Defuddle: Fetching, doc, videoId: VIDEO_ID, fetch: hangingFetch, parse: parseDefuddleTranscript, timeoutMs: 10_000, signal: caller.signal });
	caller.abort();
	await assert.rejects(run, /cancelled/);
	assert.equal(signals[1].aborted, true);
});

test('fetchYouTubeTranscript never waits past its deadline and refuses bad input', async () => {
	const doc = { implementation: { createHTMLDocument: () => ({}) } };
	class Hanging { parseAsync() { return new Promise(() => {}); } }
	const started = Date.now();
	await assert.rejects(fetchYouTubeTranscript({ Defuddle: Hanging, doc, videoId: VIDEO_ID, fetch, parse: parseDefuddleTranscript, timeoutMs: 30 }), /timed out/);
	assert.ok(Date.now() - started < 1000);
	await assert.rejects(fetchYouTubeTranscript({ Defuddle: undefined, doc, videoId: VIDEO_ID, fetch, parse: parseDefuddleTranscript }), /unavailable/);
	await assert.rejects(fetchYouTubeTranscript({ Defuddle: Hanging, doc, videoId: 'x"><script>', fetch, parse: parseDefuddleTranscript }), /Not a YouTube video/);
	let options: any;
	class Recording { constructor(_page: unknown, opts: unknown) { options = opts; } async parseAsync() { return { language: 'en', variables: { transcript: '**0:01** · hi' } }; } }
	assert.deepEqual(await fetchYouTubeTranscript({ Defuddle: Recording, doc, videoId: VIDEO_ID, fetch, parse: parseDefuddleTranscript }),
		{ version: 1, language: 'en', segments: [{ start: 1, text: 'hi' }] });
	assert.equal(options.url, VIDEO_URL);
	assert.equal(options.useAsync, true);
});

function viewHarness() {
	let now = 100_000;
	const posted: Array<{ message: any; origin: string }> = [];
	const player = { postMessage(message: string, origin: string) { posted.push({ message: JSON.parse(message), origin }); } };
	const windowHandlers = new Map<string, (event: any) => void>();
	const win = {
		addEventListener(type: string, handler: (event: any) => void) { windowHandlers.set(type, handler); },
		removeEventListener(type: string) { windowHandlers.delete(type); },
		getSelection: () => '',
	};
	const doc = { visibilityState: 'visible', createElement: (tag: string) => createElement('', [], tag) };
	const container = createElement('', [], 'div');
	const view = createTranscriptView({ doc, win, container, transcript: TRANSCRIPT, getPlayerWindow: () => player, now: () => now, listenDelayMs: 60_000, helpers });
	// Lay the rows out 40px apart in a 120px box.
	container.children.forEach((child: any, index: number) => { child.offsetTop = index * 40; child.offsetHeight = 40; });
	Object.assign(container, { clientHeight: 120, scrollHeight: container.children.length * 40 });
	const message = (data: unknown, source: unknown = player, origin = 'https://www.youtube.com') => windowHandlers.get('message')?.({ data, source, origin });
	return { view, container, posted, message, windowHandlers, advance: (ms: number) => { now += ms; } };
}

test('the transcript view renders chapters as headings, follows the player, auto-scrolls, and seeks on click', (t) => {
	const { view, container, posted, message, windowHandlers, advance } = viewHarness();
	t.after(() => view.destroy());
	const kinds = container.children.map((child: any) => child.tagName + ':' + child.textContent);
	assert.deepEqual(kinds, ['H4:0:00Introduction', 'P:0:04This is a 3.', "P:0:06It's sloppily written.", 'H4:0:14Why it matters', 'P:0:14And I want you to take a moment.']);
	const rows = container.children.filter((child: any) => child.tagName === 'P');
	assert.equal(rows[0].children[0].tagName, 'BUTTON');
	assert.equal(rows[0].children[0].getAttribute('aria-label'), 'Play from 0:04');
	// It subscribes to the player at once with "listening", and polls nothing.
	assert.deepEqual(posted.map((entry) => [entry.message.event, entry.origin]), [['listening', 'https://www.youtube.com']]);

	message(JSON.stringify({ event: 'infoDelivery', info: { currentTime: 7 } }));
	assert.equal(view.activeIndex(), 1);
	assert.equal(rows[1].classList.contains('is-active'), true);
	assert.equal(rows[1].getAttribute('aria-current'), 'true');
	assert.equal(container.scrollTop, 60, 'the active row (offset 80) sits a third of the way down');
	// Messages from other frames or origins are ignored.
	message(JSON.stringify({ event: 'infoDelivery', info: { currentTime: 15 } }), {}, 'https://www.youtube.com');
	message(JSON.stringify({ event: 'infoDelivery', info: { currentTime: 15 } }), undefined, 'https://evil.example');
	assert.equal(view.activeIndex(), 1);

	// The reader scrolls: auto-scroll pauses, then resumes after the cooldown.
	container.scrollTop = 0;
	container.dispatch('scroll');
	advance(1000);
	message({ event: 'infoDelivery', info: { currentTime: 20 } });
	assert.equal(view.activeIndex(), 2);
	assert.equal(rows[1].classList.contains('is-active'), false);
	assert.equal(container.scrollTop, 0, 'no jump while the reader is looking elsewhere');
	advance(4000);
	message({ event: 'infoDelivery', info: { currentTime: 4.5 } });
	assert.equal(view.activeIndex(), 0);
	assert.equal(container.scrollTop, 20, 'resumed after the cooldown');
	message({ event: 'infoDelivery', info: { currentTime: 15 } });
	assert.equal(container.scrollTop, 80, 'clamped to the end of the box');
	container.dispatch('scroll');
	advance(10);
	message({ event: 'infoDelivery', info: { currentTime: 6 } });
	assert.equal(container.scrollTop, 60, 'our own scroll event did not count as the reader scrolling');
	// Regression: after our own scroll event, a keyboard or scrollbar scroll still pauses auto-scroll.
	container.dispatch('scroll');
	container.scrollTop = 5;
	container.dispatch('scroll');
	advance(10);
	message({ event: 'infoDelivery', info: { currentTime: 15 } });
	assert.equal(container.scrollTop, 5, 'a scroll that is not ours pauses auto-scroll');
	advance(4000);
	message({ event: 'infoDelivery', info: { currentTime: 4.5 } });
	assert.equal(container.scrollTop, 20, 'and it resumes after the cooldown');

	// Click the text of a row, or a chapter's time: seek there.
	posted.length = 0;
	container.dispatch('click', { target: rows[2].children[1] });
	const chapterTime = container.children[0].children[0];
	container.dispatch('click', { target: chapterTime });
	container.dispatch('click', { target: container });
	assert.deepEqual(posted.map((entry) => [entry.message.func, entry.message.args]), [['seekTo', [14, true]], ['seekTo', [0, true]]]);
	assert.equal(view.activeIndex(), -1, 'before the first segment nothing is active');

	view.destroy();
	assert.equal(windowHandlers.has('message'), false);
	assert.equal(container.children.length, 0);
	view.destroy();
});

const ITEM_URL = '/api/v1/items/tag%3Agoogle.com%2C2005%3Areader%2Fitem%2F0000000000000065/transcript';

async function videoReader(options: {
	hasTranscript?: boolean; stored?: unknown; defuddle?: (fetch: any) => Promise<unknown>;
	getTranscript?: () => Promise<Response>; putTranscript?: () => Promise<Response>;
} = {}) {
	const requests: Array<{ method: string; input: string; body?: string }> = [];
	const harness = await createBrowserHarness({
		fetchImpl: async (input, init) => {
			const method = init?.method ?? 'GET';
			requests.push({ method, input, ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
			if (input === '/accounts/ClientLogin' && method === 'POST') return new Response('SID=pigeon/live-token\nLSID=null\nAuth=pigeon/live-token');
			if (input === '/reader/api/0/subscription/list') return Response.json({ subscriptions: [{ id: 'feed/1', title: '3Blue1Brown' }] });
			if (input === '/reader/api/0/unread-count') return Response.json({ unreadcounts: [{ id: 'feed/1', count: 2 }] });
			if (input.startsWith('/reader/api/0/stream/items/ids?')) return Response.json({ itemRefs: [{ id: '101' }, { id: '102' }] });
			if (input === '/reader/api/0/stream/items/contents' && method === 'POST') {
				return Response.json({ items: [
					{ id: 'tag:google.com,2005:reader/item/0000000000000065', title: 'But what is a neural network?', published: 1_742_460_800,
						origin: { title: '3Blue1Brown' }, content: { content: '<p>Video body</p>' }, alternate: [{ href: VIDEO_URL }],
						mediaKind: 'video', ...(options.hasTranscript ? { hasTranscript: true } : {}) },
					{ id: 'tag:google.com,2005:reader/item/0000000000000066', title: 'An essay', published: 1_742_460_700,
						origin: { title: '3Blue1Brown' }, content: { content: '<p>Words</p>' }, alternate: [{ href: 'https://example.com/essay' }] },
				] });
			}
			if (input === ITEM_URL && method === 'GET' && options.getTranscript) return options.getTranscript();
			if (input === ITEM_URL && method === 'GET') {
				return options.stored ? Response.json({ itemId: 'x', updatedAt: '2026-11-01T11:00:00.000Z', transcript: options.stored }) : Response.json({ code: 'transcript_not_found' }, { status: 404 });
			}
			if (input === ITEM_URL && method === 'PUT') return options.putTranscript ? options.putTranscript() : Response.json({ updated: true });
			if (input.startsWith('/api/v1/browser/youtube-proxy?url=')) return Response.json({ error: 'blocked', code: 'youtube_unavailable' }, { status: 502 });
			throw new Error(`Unexpected fetch: ${method} ${input}`);
		},
	});
	if (options.defuddle) {
		const run = options.defuddle;
		harness.window.Defuddle = class { private readonly fetch: unknown; constructor(_doc: unknown, opts: { fetch: unknown }) { this.fetch = opts.fetch; } parseAsync() { return run(this.fetch); } };
	}
	await harness.elements.get('login-form')!.dispatch('submit');
	const container = harness.elements.get('reader-player-container')!;
	await waitForBrowserCondition(() => container.children.length === 1);
	const posted: any[] = [];
	(container.children[0] as any).contentWindow = { postMessage: (message: string) => posted.push(JSON.parse(message)) };
	await flushBrowserTasks();
	return { harness, requests, posted, elements: harness.elements };
}

test('the reader shell puts the transcript button and panel under the player', () => {
	const html = renderBrowserAppHtml('https://pigeon.example');
	assert.match(html, /<button class="transcript-button" id="transcript-button" type="button" data-icon="transcript" hidden>Get transcript<\/button>/);
	assert.match(html, /id="reader-transcript" role="region" aria-label="Transcript"/);
	assert.ok(html.indexOf('id="reader-player-container"') < html.indexOf('id="reader-transcript"'));
	assert.match(html, /window\.PigeonTranscript = /);
	assert.match(html, /Obsidian Web Clipper \(src\/utils\/reader-transcript.ts\),\n\/\/ MIT License, Copyright \(c\) 2024 Obsidian/);
});

test('web reader: a YouTube item without a transcript shows the button and makes no transcript request', async () => {
	const { harness, requests, elements } = await videoReader();
	const button = elements.get('transcript-button')!;
	assert.equal(button.hidden, false);
	assert.equal(elements.get('reader-transcript')!.classList.contains('hidden'), true);
	assert.equal(requests.some((request) => request.input.includes('transcript') || request.input.includes('youtube-proxy')), false);
	// A text article has no player and no button.
	await findListButtonByItemId(elements.get('articles-list'), '102')!.dispatch('click');
	await waitForBrowserCondition(() => elements.get('reader-title')!.textContent === 'An essay');
	assert.equal(button.hidden, true);
	await elements.get('logout-button')!.dispatch('click');
	assert.equal(harness.elements.get('reader-transcript')!.children.length, 0);
});

test('web reader: Get transcript runs Defuddle through the proxy, shows the result and stores it', async () => {
	const proxied: string[] = [];
	const { requests, posted, elements } = await videoReader({
		defuddle: async (fetch) => {
			const response = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
			proxied.push(String(response.status));
			return { language: 'en', variables: { transcript: '### Intro\n\n**0:04** · This is a 3.\n**0:06** · It is sloppy.' } };
		},
	});
	const button = elements.get('transcript-button')!;
	const panel = elements.get('reader-transcript')!;
	await button.dispatch('click');
	assert.equal(elements.get('transcript-status')!.textContent, 'Getting the transcript…');
	assert.equal(button.disabled, true);
	await waitForBrowserCondition(() => requests.some((request) => request.method === 'PUT'), 60);
	assert.equal(panel.classList.contains('hidden'), false);
	assert.equal(button.hidden, true);
	assert.equal(elements.get('transcript-status')!.textContent, '');
	assert.deepEqual(panel.children.map((child: any) => child.textContent), ['0:04Intro', '0:04This is a 3.', '0:06It is sloppy.']);
	assert.deepEqual(proxied, ['502'], 'Defuddle\'s requests went to the Worker proxy');
	const methods = requests.filter((request) => request.input === ITEM_URL).map((request) => request.method);
	assert.deepEqual(methods, ['GET', 'PUT'], 'a stored copy is checked first, then the new one is stored');
	assert.deepEqual(JSON.parse(requests.find((request) => request.method === 'PUT')!.body!), {
		version: 1, language: 'en',
		segments: [{ start: 4, duration: 2, text: 'This is a 3.' }, { start: 6, text: 'It is sloppy.' }],
		chapters: [{ start: 4, title: 'Intro' }],
	});
	// The player was enabled for the IFrame API and is followed and seeked.
	assert.match(elements.get('reader-player-container')!.children[0].getAttribute('src')!, /enablejsapi=1/);
	assert.ok(posted.some((message) => message.event === 'listening'));
	panel.dispatch('click', { target: panel.children[2].children[1] });
	assert.deepEqual(posted.at(-1), { event: 'command', func: 'seekTo', args: [6, true], id: 'pigeon-transcript', channel: 'widget' });
	await elements.get('logout-button')!.dispatch('click');
	assert.equal(panel.children.length, 0);
});

test('web reader: a failed fetch says to try the iPhone app, never spins, and can be retried', async () => {
	let attempts = 0;
	const { requests, elements } = await videoReader({
		defuddle: async (fetch) => {
			attempts += 1;
			await fetch('https://www.youtube.com/api/timedtext?v=x', {});
			return { content: '<iframe></iframe>', variables: {} };
		},
	});
	const button = elements.get('transcript-button')!;
	const status = elements.get('transcript-status')!;
	for (let attempt = 1; attempt <= 2; attempt += 1) {
		await button.dispatch('click');
		await waitForBrowserCondition(() => status.textContent !== 'Getting the transcript…', 60);
		assert.equal(status.textContent, "Couldn't get the transcript here, try from the iPhone app");
		assert.equal(button.hidden, false);
		assert.equal(button.disabled, false);
		assert.equal(button.getAttribute('aria-busy'), 'false');
		assert.equal(elements.get('reader-transcript')!.classList.contains('hidden'), true);
		assert.equal(attempts, attempt);
	}
	assert.equal(requests.some((request) => request.method === 'PUT'), false);
	await elements.get('logout-button')!.dispatch('click');
});

test('web reader: an item with a stored transcript shows it directly, with no button and no fetch', async () => {
	let defuddleRuns = 0;
	const { requests, elements } = await videoReader({ hasTranscript: true, stored: TRANSCRIPT, defuddle: async () => { defuddleRuns += 1; return {}; } });
	const panel = elements.get('reader-transcript')!;
	await waitForBrowserCondition(() => panel.children.length > 0, 60);
	assert.equal(elements.get('transcript-button')!.hidden, true);
	assert.equal(panel.classList.contains('hidden'), false);
	assert.equal(panel.children.filter((child: any) => child.tagName === 'H4').length, 2);
	assert.equal(defuddleRuns, 0);
	assert.equal(requests.some((request) => request.input.includes('youtube-proxy') || request.method === 'PUT'), false);
	// Switching away and back reuses the loaded copy.
	await findListButtonByItemId(elements.get('articles-list'), '102')!.dispatch('click');
	await waitForBrowserCondition(() => elements.get('reader-title')!.textContent === 'An essay');
	assert.equal(panel.classList.contains('hidden'), true);
	await findListButtonByItemId(elements.get('articles-list'), '101')!.dispatch('click');
	await waitForBrowserCondition(() => panel.children.length > 0, 60);
	assert.equal(requests.filter((request) => request.input === ITEM_URL).length, 1);
	await elements.get('logout-button')!.dispatch('click');
});

test('web reader: a stored copy that cannot be read falls back to the button once, with no reload loop', async () => {
	for (const failure of [
		async () => Response.json({ error: 'down' }, { status: 503 }),
		async () => { throw new TypeError('Failed to fetch'); },
		async () => Response.json({ code: 'transcript_not_found' }, { status: 404 }),
		async () => Response.json({ transcript: { version: 9, segments: [] } }),
	]) {
		const { requests, elements } = await videoReader({ hasTranscript: true, getTranscript: failure });
		const button = elements.get('transcript-button')!;
		await waitForBrowserCondition(() => button.hidden === false, 60);
		for (let tick = 0; tick < 20; tick += 1) await flushBrowserTasks();
		assert.equal(requests.filter((request) => request.input === ITEM_URL).length, 1, 'one read, no retry loop');
		assert.equal(elements.get('transcript-status')!.textContent, '');
		assert.equal(elements.get('reader-transcript')!.classList.contains('hidden'), true);
		await elements.get('logout-button')!.dispatch('click');
	}
});

test('web reader: a fetched transcript shows at once while its upload is still in flight', async () => {
	let finishUpload: (response: Response) => void = () => {};
	const { requests, elements } = await videoReader({
		defuddle: async () => ({ language: 'en', variables: { transcript: '**0:01** · Hello there.' } }),
		putTranscript: () => new Promise<Response>((resolve) => { finishUpload = resolve; }),
	});
	const panel = elements.get('reader-transcript')!;
	await elements.get('transcript-button')!.dispatch('click');
	await waitForBrowserCondition(() => requests.some((request) => request.method === 'PUT'), 60);
	await waitForBrowserCondition(() => panel.children.length === 1, 60);
	assert.equal(panel.classList.contains('hidden'), false, 'shown before the upload answers');
	assert.equal(elements.get('transcript-button')!.hidden, true);
	finishUpload(Response.json({ updated: true }));
	await flushBrowserTasks();
	assert.equal(panel.children.length, 1);
	await elements.get('logout-button')!.dispatch('click');
});
