import * as assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import {
	assertSafeFeedUrl,
	fetchBoundedFeedResource,
	isProbablyFeedContent,
} from '../src/feed-network';

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

test('normalizes public feed URLs and removes fragments', () => {
	const url = assertSafeFeedUrl('HTTPS://Feeds.Example.COM:443/news.xml#latest');
	assert.equal(url.href, 'https://feeds.example.com/news.xml');
});

for (const unsafeUrl of [
	'file:///etc/passwd',
	'http://user:password@example.com/feed',
	'https://example.com:8443/feed',
	'http://localhost/feed',
	'http://service.internal/feed',
	'http://router.local/feed',
	'http://10.0.0.1/feed',
	'http://127.0.0.1/feed',
	'http://169.254.169.254/latest/meta-data',
	'http://172.16.0.1/feed',
	'http://192.168.1.1/feed',
	'http://[::1]/feed',
	'http://[fd00::1]/feed',
	'http://[fe80::1]/feed',
	'http://[::ffff:127.0.0.1]/feed',
]) {
	test(`rejects unsafe feed URL ${unsafeUrl}`, () => {
		assert.throws(() => assertSafeFeedUrl(unsafeUrl), /feed url|private|internal|credentials|port/i);
	});
}

test('validates every redirect target before following it', async () => {
	let fetchCount = 0;
	globalThis.fetch = (async () => {
		fetchCount += 1;
		return new Response(null, {
			status: 302,
			headers: { Location: 'http://127.0.0.1/private-feed' },
		});
	}) as typeof fetch;

	await assert.rejects(
		fetchBoundedFeedResource('https://feeds.example.com/start'),
		/private or internal/i,
	);
	assert.equal(fetchCount, 1);
});

test('follows a bounded public redirect chain manually', async () => {
	const requested: string[] = [];
	globalThis.fetch = (async (input, init) => {
		requested.push(String(input));
		assert.equal(init?.redirect, 'manual');
		if (requested.length === 1) {
			return new Response(null, {
				status: 301,
				headers: { Location: '/canonical.xml' },
			});
		}
		return new Response('<rss><channel><title>Safe</title></channel></rss>', {
			status: 200,
			headers: { 'Content-Type': 'application/rss+xml' },
		});
	}) as typeof fetch;

	const result = await fetchBoundedFeedResource('https://feeds.example.com/start');
	assert.deepEqual(requested, [
		'https://feeds.example.com/start',
		'https://feeds.example.com/canonical.xml',
	]);
	assert.equal(result.finalUrl.href, 'https://feeds.example.com/canonical.xml');
	assert.equal(result.redirects.length, 1);
	assert.equal(result.contentType, 'application/rss+xml');
});

test('rejects redirect loops after the configured limit', async () => {
	globalThis.fetch = (async () =>
		new Response(null, { status: 302, headers: { Location: '/again' } })) as typeof fetch;

	await assert.rejects(
		fetchBoundedFeedResource('https://feeds.example.com/start', { maxRedirects: 2 }),
		/more than 2 times/i,
	);
});

test('rejects declared responses over the byte limit before buffering', async () => {
	globalThis.fetch = (async () =>
		new Response('small', {
			status: 200,
			headers: { 'Content-Length': '5001', 'Content-Type': 'application/rss+xml' },
		})) as typeof fetch;

	await assert.rejects(
		fetchBoundedFeedResource('https://feeds.example.com/feed', { maxBytes: 5_000 }),
		/exceeds 5000 bytes/i,
	);
});

test('stops a streamed response as soon as it exceeds the byte limit', async () => {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode('<rss>'));
			controller.enqueue(new Uint8Array(100));
			controller.close();
		},
	});
	globalThis.fetch = (async () =>
		new Response(stream, {
			status: 200,
			headers: { 'Content-Type': 'application/rss+xml' },
		})) as typeof fetch;

	await assert.rejects(
		fetchBoundedFeedResource('https://feeds.example.com/feed', { maxBytes: 20 }),
		/exceeds 20 bytes/i,
	);
});

test('rejects binary content types even when the response body looks textual', async () => {
	globalThis.fetch = (async () =>
		new Response('<rss></rss>', {
			status: 200,
			headers: { 'Content-Type': 'application/octet-stream' },
		})) as typeof fetch;

	await assert.rejects(
		fetchBoundedFeedResource('https://feeds.example.com/feed'),
		/unsupported content type/i,
	);
});

test('recognizes feed bodies independently of a generic content type', () => {
	assert.equal(
		isProbablyFeedContent('text/plain', '<feed xmlns="http://www.w3.org/2005/Atom"><title>Feed</title></feed>'),
		true,
	);
	assert.equal(isProbablyFeedContent('text/html', '<html><body>not a feed</body></html>'), false);
});
