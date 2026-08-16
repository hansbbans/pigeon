import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { handleImageProxy } from '../src/image-proxy';

function request(url: string): Request {
	return new Request(`https://pigeon.example/api/v1/image-proxy?url=${encodeURIComponent(url)}`);
}

test('privacy image proxy accepts bounded raster images and strips publisher headers', async () => {
	let fetched: URL | undefined;
	const response = await handleImageProxy(request('https://images.example/story.webp'), async (input) => {
		fetched = input instanceof URL ? input : new URL(input instanceof Request ? input.url : input);
		return new Response(new Uint8Array([1, 2, 3]), {
			headers: { 'Content-Type': 'image/webp', 'Set-Cookie': 'tracking=yes', ETag: 'publisher-tag' },
		});
	});

	assert.equal(fetched?.href, 'https://images.example/story.webp');
	assert.equal(response.status, 200);
	assert.equal(response.headers.get('Content-Type'), 'image/webp');
	assert.equal(response.headers.get('Set-Cookie'), null);
	assert.equal(response.headers.get('ETag'), null);
	assert.equal(response.headers.get('Cache-Control'), 'private, max-age=86400');
	assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3]);
});

test('privacy image proxy rejects private targets and revalidates redirects', async () => {
	assert.equal((await handleImageProxy(request('http://127.0.0.1/tracker.png'))).status, 400);

	const redirected = await handleImageProxy(request('https://images.example/start'), async () =>
		new Response(null, { status: 302, headers: { Location: 'http://192.168.1.7/secret.png' } }),
	);
	assert.equal(redirected.status, 400);
});

test('privacy image proxy rejects active and oversized content', async () => {
	const svg = await handleImageProxy(request('https://images.example/vector.svg'), async () =>
		new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } }),
	);
	assert.equal(svg.status, 415);

	const oversized = await handleImageProxy(request('https://images.example/huge.jpg'), async () =>
		new Response(new Uint8Array([1]), {
			headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(8 * 1_024 * 1_024 + 1) },
		}),
	);
	assert.equal(oversized.status, 413);
});
