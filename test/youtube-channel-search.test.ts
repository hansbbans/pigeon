import * as assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { generateApiToken } from '../src/api-auth';
import { discoverFeeds } from '../src/feed-discovery';
import app from '../src/index';
import {
	clearYouTubeChannelSearchCache,
	handleYouTubeChannelSearch,
	type YouTubeChannelSearchResponse,
} from '../src/youtube-channel-search';
import { YOUTUBE_DISCOVERY_HTML_BYTES } from '../src/youtube';

const PASSWORD = 'secret-password';
const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	clearYouTubeChannelSearchCache();
});

function createEnv(apiKey?: string) {
	return {
		API_PASSWORD: PASSWORD,
		BASE_URL: 'https://pigeon.example',
		ITEMS_PER_FEED: '50',
		...(apiKey === undefined ? {} : { YOUTUBE_API_KEY: apiKey }),
	} as never;
}

async function authenticatedRequest(query?: string): Promise<Request> {
	const token = await generateApiToken(PASSWORD);
	const url = new URL('https://pigeon.example/feeds/youtube/search');
	if (query !== undefined) url.searchParams.set('q', query);
	return new Request(url, {
		headers: { Authorization: `GoogleLogin auth=pigeon/${token}` },
	});
}

async function callSearch(query: string | undefined, apiKey?: string) {
	return handleYouTubeChannelSearch(await authenticatedRequest(query), createEnv(apiKey));
}

async function readResponse(response: Response): Promise<YouTubeChannelSearchResponse> {
	return (await response.json()) as YouTubeChannelSearchResponse;
}

function atomFeed(title: string, channelUrl: string): string {
	return `<feed xmlns="http://www.w3.org/2005/Atom">
		<title>${title}</title>
		<link rel="alternate" href="${channelUrl}" />
	</feed>`;
}

test('channel search route requires auth and validates the bounded query', async () => {
	let fetchCalls = 0;
	globalThis.fetch = (async () => {
		fetchCalls += 1;
		throw new Error('fetch should not run');
	}) as typeof fetch;

	const unauthenticated = await app.fetch(
		new Request('https://pigeon.example/feeds/youtube/search?q=mkbhd'),
		createEnv(),
	);
	assert.equal(unauthenticated.status, 401);

	const tooShort = await callSearch('a');
	assert.equal(tooShort.status, 400);
	assert.deepEqual(await readResponse(tooShort), {
		channels: [],
		mode: 'search',
		message: 'Search query must be between 2 and 100 characters.',
		error: 'Search query must be between 2 and 100 characters.',
	});
	assert.equal(tooShort.headers.get('Cache-Control'), 'no-store');

	const tooLong = await callSearch('x'.repeat(101));
	assert.equal(tooLong.status, 400);
	assert.equal((await readResponse(tooLong)).channels.length, 0);
	assert.equal(fetchCalls, 0);
});

test('no-key handle lookup resolves the published Atom feed and canonical channel ID', async () => {
	const channelId = 'UC' + 'A'.repeat(22);
	const requested: string[] = [];
	globalThis.fetch = (async (input) => {
		const url = new URL(String(input));
		requested.push(url.href);
		if (url.hostname === 'www.youtube.com' && url.pathname === '/@mkbhd') {
			return new Response(
				`<html><head><link rel="alternate" type="application/atom+xml" title="Marques Brownlee" href="/feeds/videos.xml?channel_id=${channelId}"></head></html>`,
				{ headers: { 'Content-Type': 'text/html' } },
			);
		}
		if (url.pathname === '/feeds/videos.xml' && url.searchParams.get('channel_id') === channelId) {
			return new Response(atomFeed('Marques Brownlee', 'https://www.youtube.com/@mkbhd'), {
				headers: { 'Content-Type': 'application/atom+xml' },
			});
		}
		return new Response('missing', { status: 404 });
	}) as typeof fetch;

	const response = await callSearch('mkbhd');
	assert.equal(response.status, 200);
	assert.deepEqual(await readResponse(response), {
		channels: [
			{
				id: channelId,
				title: 'Marques Brownlee',
				description: '',
				channelUrl: 'https://www.youtube.com/@mkbhd',
				feedUrl: `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`,
				thumbnailUrl: null,
			},
		],
		mode: 'handle',
		message: null,
	});
	assert.equal(requested[0], 'https://www.youtube.com/@mkbhd');
	assert.equal(requested.some((url) => url.includes('/feeds/videos.xml?channel_id=')), true);
});

test('no-key handle lookup stops after an early Atom link in an oversized HTML stream', async () => {
	const channelId = 'UC' + 'E'.repeat(22);
	const prefix = `<html><head><link rel="alternate" type="application/atom+xml" href="https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}"></head></html>`;
	const prefixBytes = new TextEncoder().encode(prefix);
	const remainingBytes = YOUTUBE_DISCOVERY_HTML_BYTES + 1;
	const streamStats: Array<{ readCalls: number; cancelled: boolean; released: boolean }> = [];
	function oversizedPageResponse(): Response {
		const stats = { readCalls: 0, cancelled: false, released: false };
		streamStats.push(stats);
		const reader = {
			async read(): Promise<{ done: boolean; value?: Uint8Array }> {
				stats.readCalls += 1;
				if (stats.readCalls === 1) return { done: false, value: prefixBytes };
				return {
					done: false,
					value: new Uint8Array(remainingBytes),
				};
			},
			async cancel(): Promise<void> {
				stats.cancelled = true;
			},
			releaseLock(): void {
				stats.released = true;
			},
		};
		return { ok: true, body: { getReader: () => reader } } as unknown as Response;
	}
	const requested: string[] = [];
	globalThis.fetch = (async (input) => {
		const url = String(input);
		requested.push(url);
		if (url === 'https://youtube.com/@mkbhd') {
			return new Response(null, {
				status: 301,
				headers: { Location: 'https://www.youtube.com/@mkbhd' },
			});
		}
		if (url === 'https://www.youtube.com/@mkbhd') {
			return oversizedPageResponse();
		}
		if (url.includes(`/feeds/videos.xml?channel_id=${channelId}`)) {
			return new Response(atomFeed('Marques Brownlee', 'https://www.youtube.com/@mkbhd'), {
				headers: { 'Content-Type': 'application/atom+xml' },
			});
		}
		return new Response('missing', { status: 404 });
	}) as typeof fetch;

	assert.ok(prefixBytes.byteLength + remainingBytes > YOUTUBE_DISCOVERY_HTML_BYTES);
	const response = await callSearch('mkbhd');
	assert.equal(response.status, 200);
	const searchBody = await readResponse(response);
	assert.equal(searchBody.channels[0]?.id, channelId);

	const pastedUrlResult = await discoverFeeds('https://youtube.com/@mkbhd');
	assert.equal(pastedUrlResult.candidates[0]?.url, searchBody.channels[0]?.feedUrl);
	assert.equal(pastedUrlResult.candidates[0]?.title, 'Marques Brownlee');
	assert.deepEqual(streamStats, [
		{ readCalls: 1, cancelled: true, released: true },
		{ readCalls: 1, cancelled: true, released: true },
	]);
	assert.deepEqual(requested, [
		'https://www.youtube.com/@mkbhd',
		`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`,
		'https://youtube.com/@mkbhd',
		'https://www.youtube.com/@mkbhd',
		`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`,
	]);
});

test('no-key search stays handle-mode for names and returns a useful next step', async () => {
	let fetchCalls = 0;
	globalThis.fetch = (async () => {
		fetchCalls += 1;
		throw new Error('generic search scraping is not allowed');
	}) as typeof fetch;

	const response = await callSearch('Marques Brownlee');
	assert.equal(response.status, 200);
	assert.deepEqual(await readResponse(response), {
		channels: [],
		mode: 'handle',
		message: 'Search by @handle or paste a channel link.',
	});
	assert.equal(fetchCalls, 0);
});

test('no-key handle lookup distinguishes a missing channel from upstream failure', async () => {
	globalThis.fetch = (async () => new Response('not found', { status: 404 })) as typeof fetch;
	const noMatch = await callSearch('@does-not-exist');
	assert.equal(noMatch.status, 200);
	assert.deepEqual(await readResponse(noMatch), {
		channels: [],
		mode: 'handle',
		message: 'No YouTube channel found for that handle.',
	});

	clearYouTubeChannelSearchCache();
	globalThis.fetch = (async () => new Response('upstream failure', { status: 503 })) as typeof fetch;
	const unavailable = await callSearch('@temporarily-unavailable');
	assert.equal(unavailable.status, 503);
	assert.deepEqual(await readResponse(unavailable), {
		channels: [],
		mode: 'handle',
		message: 'YouTube channel search is temporarily unavailable.',
		error: 'YouTube channel search is temporarily unavailable.',
	});
	assert.equal(unavailable.headers.get('Cache-Control'), 'no-store');
});

test('official API results are bounded, deduplicated, validated, and cached', async () => {
	const firstId = 'UC' + 'B'.repeat(22);
	const secondId = 'UC' + 'C'.repeat(22);
	const laterId = 'UC' + 'D'.repeat(22);
	const apiKey = 'api-key-must-stay-out-of-the-url';
	let fetchCalls = 0;
	let requestUrl = '';
	let requestApiKey = '';
	globalThis.fetch = (async (input, init) => {
		fetchCalls += 1;
		requestUrl = String(input);
		requestApiKey = new Headers(init?.headers).get('x-goog-api-key') ?? '';
		return Response.json({
			items: [
				{
					id: { kind: 'youtube#channel', channelId: firstId },
					snippet: {
						title: 'First channel',
						description: 'First description',
						thumbnails: { high: { url: 'https://i.ytimg.com/vi/example/hqdefault.jpg' } },
					},
				},
				{
					id: { kind: 'youtube#channel', channelId: firstId },
					snippet: { title: 'Duplicate', description: 'ignored' },
				},
				{ id: { kind: 'youtube#channel', channelId: 'UC-too-short' }, snippet: {} },
				{
					id: { kind: 'youtube#channel', channelId: secondId },
					snippet: {
						title: 'Second channel',
						description: 'Second description',
						thumbnails: { high: { url: 'https://evil.example/steal' } },
					},
				},
				{ id: { kind: 'youtube#channel', channelId: 'invalid' }, snippet: {} },
				{ id: { kind: 'youtube#channel', channelId: 'UC-invalid' }, snippet: {} },
				{ id: { kind: 'youtube#channel', channelId: 'UC-invalid-too' }, snippet: {} },
				{ id: { kind: 'youtube#channel', channelId: 'UC-invalid-too-2' }, snippet: {} },
				{
					id: { kind: 'youtube#channel', channelId: laterId },
					snippet: { title: 'Beyond API limit', description: '' },
				},
			],
		});
	}) as typeof fetch;

	const firstResponse = await callSearch('camera phones', apiKey);
	assert.equal(firstResponse.status, 200);
	const firstBody = await readResponse(firstResponse);
	assert.deepEqual(firstBody, {
		channels: [
			{
				id: firstId,
				title: 'First channel',
				description: 'First description',
				channelUrl: `https://www.youtube.com/channel/${firstId}`,
				feedUrl: `https://www.youtube.com/feeds/videos.xml?channel_id=${firstId}`,
				thumbnailUrl: 'https://i.ytimg.com/vi/example/hqdefault.jpg',
			},
			{
				id: secondId,
				title: 'Second channel',
				description: 'Second description',
				channelUrl: `https://www.youtube.com/channel/${secondId}`,
				feedUrl: `https://www.youtube.com/feeds/videos.xml?channel_id=${secondId}`,
				thumbnailUrl: null,
			},
		],
		mode: 'search',
		message: null,
	});
	assert.match(requestUrl, /^https:\/\/www\.googleapis\.com\/youtube\/v3\/search\?/);
	assert.match(requestUrl, /[?&]part=snippet(?:&|$)/);
	assert.match(requestUrl, /[?&]type=channel(?:&|$)/);
	assert.match(requestUrl, /[?&]maxResults=8(?:&|$)/);
	assert.match(requestUrl, /q=camera\+phones/);
	assert.doesNotMatch(requestUrl, /api-key-must-stay-out-of-the-url/);
	assert.equal(requestApiKey, apiKey);

	const cachedResponse = await callSearch('camera phones', apiKey);
	assert.equal(cachedResponse.status, 200);
	assert.deepEqual(await readResponse(cachedResponse), firstBody);
	assert.equal(fetchCalls, 1);
});

test('official API redirects fail without forwarding the API key', async () => {
	const apiKey = 'redirect-key-must-not-leak';
	const requested: Array<{ url: string; apiKey: string }> = [];
	globalThis.fetch = (async (input, init) => {
		requested.push({
			url: String(input),
			apiKey: new Headers(init?.headers).get('x-goog-api-key') ?? '',
		});
		return new Response(null, {
			status: 302,
			headers: { Location: 'https://evil.example/collect' },
		});
	}) as typeof fetch;

	const response = await callSearch('redirect test', apiKey);
	assert.equal(response.status, 503);
	const body = await readResponse(response);
	assert.deepEqual(body, {
		channels: [],
		mode: 'search',
		message: 'YouTube channel search is temporarily unavailable.',
		error: 'YouTube channel search is temporarily unavailable.',
	});
	assert.equal(requested.length, 1);
	assert.equal(requested[0]?.apiKey, apiKey);
	assert.doesNotMatch(requested[0]?.url ?? '', /redirect-key-must-not-leak/);
});

test('API quota and network failures return generic retryable errors without caching', async () => {
	const apiKey = 'quota-key-must-not-leak';
	let fetchCalls = 0;
	globalThis.fetch = (async () => {
		fetchCalls += 1;
		if (fetchCalls === 1) return new Response('quota exceeded', { status: 429 });
		throw new Error('network failure with quota-key-must-not-leak');
	}) as typeof fetch;

	const first = await callSearch('quota test', apiKey);
	assert.equal(first.status, 503);
	const firstBody = await readResponse(first);
	assert.deepEqual(firstBody, {
		channels: [],
		mode: 'search',
		message: 'YouTube channel search is temporarily unavailable.',
		error: 'YouTube channel search is temporarily unavailable.',
	});
	assert.equal(first.headers.get('Cache-Control'), 'no-store');
	assert.doesNotMatch(JSON.stringify(firstBody), /quota-key-must-not-leak|quota exceeded/i);

	const second = await callSearch('quota test', apiKey);
	assert.equal(second.status, 503);
	assert.equal(fetchCalls, 2);
});

test('invalid API responses do not expose credentials or accept malicious channel data', async () => {
	const apiKey = 'invalid-config-key';
	globalThis.fetch = (async () => new Response('{"error":{"message":"invalid key"}}', {
		status: 403,
		headers: { 'Content-Type': 'application/json' },
	})) as typeof fetch;

	const response = await callSearch('invalid config', apiKey);
	assert.equal(response.status, 503);
	assert.doesNotMatch(await response.text(), /invalid-config-key|invalid key/i);
});
