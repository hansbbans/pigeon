import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateApiToken } from '../src/api-auth';
import { handleBrowserReaderSource, handleBrowserReadwiseSave } from '../src/browser-reading-api';
import worker from '../src/index';
import type { Env } from '../src/types';

function sourceRequest(url = 'https://public.example/story', method = 'GET') {
	return new Request(`https://pigeon.example/api/v1/browser/reader-source?url=${encodeURIComponent(url)}`, {
		method, headers: { Authorization: 'caller-secret', Cookie: 'session=caller-cookie' },
	});
}
function saveRequest(body: unknown = { url: 'https://public.example/story', token: 'mock-only-token' }, method = 'POST') {
	return new Request('https://pigeon.example/api/v1/browser/readwise/save', {
		method, headers: { 'Content-Type': 'application/json', Authorization: 'caller-secret', Cookie: 'caller-cookie' },
		...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
	});
}
function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch {
	return (async (input: string | URL | Request, init?: RequestInit) => handler(input instanceof Request ? input.url : String(input), init ?? {})) as typeof fetch;
}

test('both browser routes require Pigeon authentication before any outbound fetch or DB access', async (t) => {
	let calls = 0;
	t.mock.method(globalThis, 'fetch', mockFetch(() => { calls++; throw new Error('must not fetch'); }));
	const env = { API_PASSWORD: 'fixture-password' } as Env;
	for (const path of ['reader-source?url=https://public.example', 'readwise/save']) {
		assert.equal((await worker.fetch(new Request(`https://pigeon.example/api/v1/browser/${path}`), env)).status, 401);
	}
	const auth = `GoogleLogin auth=pigeon/${await generateApiToken(env.API_PASSWORD)}`;
	assert.equal((await worker.fetch(new Request('https://pigeon.example/api/v1/browser/reader-source', { method: 'POST', headers: { Authorization: auth } }), env)).status, 405);
	assert.equal((await worker.fetch(new Request('https://pigeon.example/api/v1/browser/readwise/save', { headers: { Authorization: auth } }), env)).status, 405);
	assert.equal(calls, 0);
});

test('reader source follows validated relative redirects and forwards no user credentials', async () => {
	const calls: string[] = [];
	let deadline: AbortSignal | undefined;
	const fetcher = mockFetch((url, init) => {
		calls.push(url);
		assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual');
		const headers = new Headers(init.headers);
		assert.equal(headers.get('Authorization'), null); assert.equal(headers.get('Cookie'), null);
		assert.match(headers.get('Accept')!, /text\/html/);
		if (deadline) assert.equal(init.signal, deadline); else deadline = init.signal!;
		return calls.length === 1 ? new Response(null, { status: 302, headers: { Location: '/final#fragment' } })
			: new Response('<html><p>A useful article 日本語</p></html>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
	});
	const response = await handleBrowserReaderSource(sourceRequest(), fetcher);
	assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
	assert.deepEqual(await response.json(), { url: 'https://public.example/final', html: '<html><p>A useful article 日本語</p></html>' });
	assert.deepEqual(calls, ['https://public.example/story', 'https://public.example/final']);
});

test('source fetch rejects private/credential/non-http/unsupported-port destinations before fetch', async () => {
	for (const url of ['http://127.0.0.1/', 'http://2130706433/', 'http://[::1]/', 'http://10.0.0.1/', 'http://169.254.169.254/', 'http://localhost/', 'https://host.local/', 'https://user:pass@public.example/', 'https://public.example:8443/', 'file:///tmp/test', 'javascript:alert(1)', 'x'.repeat(4097)]) {
		let calls = 0;
		assert.equal((await handleBrowserReaderSource(sourceRequest(url), mockFetch(() => { calls++; return new Response('bad'); }))).status, 400, url);
		assert.equal(calls, 0);
	}
});

test('source redirect validation blocks private addresses and redirect loops', async () => {
	let calls = 0;
	const unsafe = await handleBrowserReaderSource(sourceRequest(), mockFetch(() => { calls++; return new Response(null, { status: 302, headers: { Location: 'http://192.168.1.1/' } }); }));
	assert.equal(unsafe.status, 400); assert.equal(calls, 1);
	calls = 0;
	const loop = await handleBrowserReaderSource(sourceRequest(), mockFetch(() => { calls++; return new Response(null, { status: 302, headers: { Location: '/again' } }); }));
	assert.equal(loop.status, 502); assert.equal(calls, 6);
	assert.equal((await handleBrowserReaderSource(sourceRequest(), mockFetch(() => new Response(null, { status: 302 })))).status, 502);
});

test('source rejects non-HTML, missing type, upstream errors, empty HTML and unsafe query shape', async () => {
	for (const [response, status] of [
		[new Response('binary', { headers: { 'Content-Type': 'application/pdf' } }), 415],
		[new Response('<html>untyped</html>'), 415],
		[new Response('server-private-error', { status: 500 }), 502],
		[new Response(' ', { headers: { 'Content-Type': 'text/html' } }), 422],
	] as const) assert.equal((await handleBrowserReaderSource(sourceRequest(), mockFetch(() => response))).status, status);
	assert.equal((await handleBrowserReaderSource(new Request('https://pigeon.example/api/v1/browser/reader-source?url=x&url=y'))).status, 400);
	assert.equal((await handleBrowserReaderSource(new Request('https://pigeon.example/api/v1/browser/reader-source?url=https://public.example&extra=1'))).status, 400);
	assert.equal((await handleBrowserReaderSource(sourceRequest('https://public.example', 'POST'))).status, 405);
});

test('source bounds declared length, streamed bytes, UTF8 bytes and serialized JSON size', async () => {
	const htmlHeaders = { 'Content-Type': 'text/html' };
	assert.equal((await handleBrowserReaderSource(sourceRequest(), mockFetch(() => new Response('small', { headers: { ...htmlHeaders, 'Content-Length': '5000001' } })))).status, 413);
	assert.equal((await handleBrowserReaderSource(sourceRequest(), mockFetch(() => new Response('x'.repeat(5_000_001), { headers: htmlHeaders })))).status, 413);
	assert.equal((await handleBrowserReaderSource(sourceRequest(), mockFetch(() => new Response('日'.repeat(1_666_667), { headers: htmlHeaders })))).status, 413);
	assert.equal((await handleBrowserReaderSource(sourceRequest(), mockFetch(() => new Response('<html>' + '\u0000'.repeat(1_400_000), { headers: htmlHeaders })))).status, 413);
});

test('source body deadline cancels slow streams and reports generic fetch failure', async (t) => {
	const controller = new AbortController();
	t.mock.method(AbortSignal, 'timeout', () => controller.signal);
	let cancelled = false;
	const source = new ReadableStream<Uint8Array>({
		start(stream) { stream.enqueue(new TextEncoder().encode('<html>')); },
		cancel() { cancelled = true; },
	});
	const pending = handleBrowserReaderSource(sourceRequest(), mockFetch(() => new Response(source, { headers: { 'Content-Type': 'text/html' } })));
	setTimeout(() => controller.abort(), 10);
	const response = await pending;
	assert.equal(response.status, 502); assert.equal(cancelled, true);
	assert.deepEqual(await response.json(), { error: 'Could not fetch article' });
});

test('Readwise sends token only to fixed endpoint and accepts 200/201 without reflecting upstream content', async () => {
	for (const status of [200, 201]) {
		let calls = 0;
		const response = await handleBrowserReadwiseSave(saveRequest(), mockFetch((url, init) => {
			calls++; assert.equal(url, 'https://readwise.io/api/v3/save/');
			assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'manual'); assert.ok(init.signal);
			const headers = new Headers(init.headers);
			assert.equal(headers.get('Authorization'), 'Token mock-only-token'); assert.equal(headers.get('Cookie'), null);
			assert.equal(headers.get('Content-Type'), 'application/json');
			assert.deepEqual(JSON.parse(init.body as string), { url: 'https://public.example/story' });
			return new Response('mock-only-token SECRET UPSTREAM', { status });
		}));
		assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
		assert.deepEqual(await response.json(), { saved: true }); assert.equal(calls, 1);
	}
});

test('Readwise rejects malformed/oversized JSON, private URLs, invalid tokens without outbound traffic', async () => {
	for (const body of [null, [], {}, { url: 'https://public.example', token: '' }, { url: 'https://public.example', token: 'line\r\nbreak' }, { url: 'https://public.example', token: '日' }, { url: 'https://public.example', token: 'x'.repeat(1025) }, { url: 'http://127.0.0.1', token: 'mock-token' }, { url: 'https://public.example', token: 'mock-token', endpoint: 'https://evil.example' }, '{invalid']) {
		let calls = 0;
		assert.equal((await handleBrowserReadwiseSave(saveRequest(body), mockFetch(() => { calls++; throw new Error(); }))).status, 400);
		assert.equal(calls, 0);
	}
	assert.equal((await handleBrowserReadwiseSave(saveRequest('x'.repeat(8193)))).status, 413);
	const wrongType = new Request('https://pigeon.example/api/v1/browser/readwise/save', { method: 'POST', body: 'body' });
	assert.equal((await handleBrowserReadwiseSave(wrongType)).status, 415);
	assert.equal((await handleBrowserReadwiseSave(saveRequest({}, 'GET'))).status, 405);
});

test('Readwise errors/redirects never echo token or upstream body and do not misclassify Pigeon auth', async () => {
	for (const [upstream, expected, code] of [[401, 422, 'readwise_authentication_failed'], [403, 422, 'readwise_authentication_failed'], [429, 429, 'readwise_rate_limited'], [500, 502, undefined], [302, 502, undefined], [204, 502, undefined]] as const) {
		let calls = 0;
		const response = await handleBrowserReadwiseSave(saveRequest(), mockFetch(() => {
			calls++; return new Response(upstream === 204 ? null : 'mock-only-token SECRET', { status: upstream, headers: { Location: 'https://evil.example' } });
		}));
		assert.equal(response.status, expected); assert.equal(calls, 1);
		const body = await response.json() as { error: string; code?: string };
		assert.equal(body.code, code); assert.ok(!JSON.stringify(body).includes('mock-only-token')); assert.ok(!JSON.stringify(body).includes('SECRET'));
	}
	const response = await handleBrowserReadwiseSave(saveRequest(), mockFetch(() => { throw new Error('mock-only-token leaked network error'); }));
	assert.equal(response.status, 502); assert.deepEqual(await response.json(), { error: 'Could not save to Readwise' });
});
