import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_SAVED_HTML_BYTES, type PageExtraction } from '../src/core/payload';
import { MAX_QUEUED_CONTENT_BYTES, readQueue } from '../src/core/queue';
import { flushQueue, saveLink, savePage } from '../src/core/save';
import { loadSettings } from '../src/core/session';
import { AUTH, MemoryStore, mockFetch, ORIGIN, savedReply, signedInStore } from './helpers/fakes';

const PAGE = { url: 'https://example.com/essays/slow?utm_source=x', title: 'Slow software — Example' };
const extraction: PageExtraction = {
	url: PAGE.url,
	title: PAGE.title,
	content: { html: '<p>Body</p>', text: 'Body', title: 'Slow software', wordCount: 2650, author: 'Ada', site: 'Example', mediaKind: 'text' },
};

test('saves a page with its extraction', async () => {
	const store = await signedInStore();
	const { fetch, requests } = mockFetch(() => savedReply('done'));
	const outcome = await savePage(PAGE, async () => extraction, { fetch, store });
	assert.equal(outcome.status, 'saved');
	assert.equal(outcome.status === 'saved' && outcome.withContent, true);
	assert.equal(requests.length, 1);
	assert.deepEqual(JSON.parse(requests[0].body), { url: PAGE.url, title: PAGE.title, content: extraction.content });
	assert.equal(requests[0].headers.authorization, `GoogleLogin auth=${AUTH}`);
	assert.deepEqual(await readQueue(store), []);
});

test('"Save link" sends the bare link only', async () => {
	const store = await signedInStore();
	const { fetch, requests } = mockFetch(() => savedReply('pending'));
	const outcome = await saveLink('https://example.com/linked', { fetch, store });
	assert.equal(outcome.status === 'saved' && outcome.withContent, false);
	assert.deepEqual(JSON.parse(requests[0].body), { url: 'https://example.com/linked' });
});

test('a failed extraction still saves the bare link', async () => {
	for (const extract of [
		async () => { throw new Error('Cannot access contents of the page'); },
		async () => null,
		async (): Promise<PageExtraction> => ({ url: PAGE.url, title: 'From page', error: 'No readable content found' }),
	]) {
		const store = await signedInStore();
		const { fetch, requests } = mockFetch(() => savedReply('pending'));
		const outcome = await savePage(PAGE, extract, { fetch, store });
		assert.equal(outcome.status, 'saved');
		assert.equal(requests.length, 1);
		assert.deepEqual(JSON.parse(requests[0].body), { url: PAGE.url, title: PAGE.title });
	}
});

test('oversize html is never sent; the save lands as a bare link', async () => {
	const store = await signedInStore();
	const { fetch, requests } = mockFetch(() => savedReply('pending'));
	const big: PageExtraction = { url: PAGE.url, content: { html: 'x'.repeat(MAX_SAVED_HTML_BYTES + 10), title: 'Huge', mediaKind: 'text' } };
	const outcome = await savePage(PAGE, async () => big, { fetch, store });
	assert.equal(outcome.status, 'saved');
	assert.equal(requests.length, 1);
	assert.deepEqual(JSON.parse(requests[0].body), { url: PAGE.url, title: 'Huge' });
});

test('a 413 or 400 on the content retries as a bare link', async () => {
	for (const status of [413, 400]) {
		const store = await signedInStore();
		const { fetch, requests } = mockFetch([() => Response.json({ error: 'no' }, { status }), () => savedReply('pending')]);
		const outcome = await savePage(PAGE, async () => extraction, { fetch, store });
		assert.equal(outcome.status, 'saved', String(status));
		assert.equal(outcome.status === 'saved' && outcome.withContent, false);
		assert.equal(requests.length, 2);
		assert.equal(JSON.parse(requests[0].body).content.html, '<p>Body</p>');
		assert.deepEqual(JSON.parse(requests[1].body), { url: PAGE.url, title: 'Slow software' });
	}
});

test('contentTooLarge from the Worker still counts as a save (pending, link kept)', async () => {
	const store = await signedInStore();
	const { fetch, requests } = mockFetch(() => savedReply('pending', { contentTooLarge: true }));
	const outcome = await savePage(PAGE, async () => extraction, { fetch, store });
	assert.equal(outcome.status === 'saved' && outcome.withContent, false);
	assert.equal(requests.length, 1);
});

test('a 401 drops the token, asks for sign-in, and keeps the save for later', async () => {
	const store = await signedInStore();
	const { fetch } = mockFetch(() => new Response('Unauthorized', { status: 401 }));
	const outcome = await savePage(PAGE, async () => extraction, { fetch, store });
	assert.deepEqual(outcome, { status: 'needsSignIn', queued: 1 });
	const settings = await loadSettings(store);
	assert.equal(settings.auth, null);
	assert.equal(settings.needsSignIn, true);
	assert.equal(settings.origin, ORIGIN);
	const [queued] = await readQueue(store);
	assert.equal(queued.attempts[0].content?.html, '<p>Body</p>');
});

test('signed out: nothing is sent, the save waits', async () => {
	const store = new MemoryStore();
	const { fetch, requests } = mockFetch([]);
	assert.deepEqual(await saveLink('https://example.com/x', { fetch, store }), { status: 'needsSignIn', queued: 1 });
	assert.equal(requests.length, 0);
});

test('offline or 5xx queues the save; a later flush sends it once', async () => {
	const store = await signedInStore();
	const offline = mockFetch(() => 'network-error');
	const outcome = await savePage(PAGE, async () => extraction, { fetch: offline.fetch, store });
	assert.equal(outcome.status, 'queued');
	assert.equal(offline.requests.length, 1, 'no link-only retry while offline');
	const down = mockFetch(() => new Response('', { status: 503 }));
	await saveLink('https://example.com/second', { fetch: down.fetch, store });
	assert.equal((await readQueue(store)).length, 2);

	const stillDown = mockFetch(() => 'network-error');
	assert.deepEqual(await flushQueue({ fetch: stillDown.fetch, store }), { sent: 0, dropped: 0, remaining: 2, stoppedBy: 'unreachable' });
	assert.equal(stillDown.requests.length, 1, 'stops at the first unreachable request');

	const back = mockFetch(() => savedReply('done'));
	assert.deepEqual(await flushQueue({ fetch: back.fetch, store }), { sent: 2, dropped: 0, remaining: 0 });
	assert.deepEqual(back.requests.map((r) => JSON.parse(r.body).url), [PAGE.url, 'https://example.com/second']);
	assert.equal(JSON.parse(back.requests[0].body).content.html, '<p>Body</p>');
	assert.deepEqual(await readQueue(store), []);
});

test('saving the same URL twice while offline queues it once', async () => {
	const store = await signedInStore();
	const { fetch } = mockFetch(() => 'network-error');
	await saveLink('https://example.com/same', { fetch, store });
	await saveLink('https://example.com/same', { fetch, store });
	assert.equal((await readQueue(store)).length, 1);
});

test('rapid saves while offline are all kept', async () => {
	const store = await signedInStore();
	const { fetch } = mockFetch(() => 'network-error');
	await Promise.all(Array.from({ length: 8 }, (_, i) => saveLink(`https://example.com/${i}`, { fetch, store })));
	assert.equal((await readQueue(store)).length, 8);
});

test('a full queue keeps only the bare link of new saves', async () => {
	const store = await signedInStore();
	const { fetch } = mockFetch(() => 'network-error');
	const html = 'y'.repeat(800_000);
	for (let i = 0; i < 6; i++) {
		await savePage({ url: `https://example.com/${i}` }, async () => ({ url: '', content: { html, mediaKind: 'text' } }), { fetch, store });
	}
	const queue = await readQueue(store);
	assert.equal(queue.length, 6);
	const bytes = JSON.stringify(queue).length;
	assert.ok(bytes < MAX_QUEUED_CONTENT_BYTES + 100_000, `queue is ${bytes} bytes`);
	assert.deepEqual(queue[5].attempts, [{ url: 'https://example.com/5' }]);
});

test('a flush that hits 401 stops and asks for sign-in; rejected saves are dropped', async () => {
	const store = await signedInStore();
	await saveLink('https://example.com/a', { fetch: mockFetch(() => 'network-error').fetch, store });
	await saveLink('https://example.com/b', { fetch: mockFetch(() => 'network-error').fetch, store });
	const rejected = mockFetch([() => Response.json({ error: 'bad url' }, { status: 400 }), () => new Response('', { status: 401 })]);
	assert.deepEqual(await flushQueue({ fetch: rejected.fetch, store }), { sent: 0, dropped: 1, remaining: 1, stoppedBy: 'unauthorized' });
	assert.equal((await loadSettings(store)).needsSignIn, true);
	assert.deepEqual(await flushQueue({ fetch: mockFetch([]).fetch, store }), { sent: 0, dropped: 0, remaining: 1, stoppedBy: 'signedOut' });
});

test('concurrent flushes send each queued save once', async () => {
	const store = await signedInStore();
	await saveLink('https://example.com/a', { fetch: mockFetch(() => 'network-error').fetch, store });
	const { fetch, requests } = mockFetch(() => savedReply('pending'));
	await Promise.all([flushQueue({ fetch, store }), flushQueue({ fetch, store }), flushQueue({ fetch, store })]);
	assert.equal(requests.length, 1);
});

test('browser pages are not saveable and send nothing', async () => {
	const store = await signedInStore();
	const { fetch, requests } = mockFetch([]);
	assert.deepEqual(await savePage({ url: 'chrome://newtab/' }, async () => extraction, { fetch, store }), { status: 'unsupported' });
	assert.deepEqual(await saveLink('mailto:a@b.c', { fetch, store }), { status: 'unsupported' });
	assert.equal(requests.length, 0);
});

test('a link the Worker rejects outright reports failure', async () => {
	const store = await signedInStore();
	const { fetch } = mockFetch(() => Response.json({ error: 'url must not contain credentials' }, { status: 400 }));
	assert.deepEqual(await saveLink('https://example.com/x', { fetch, store }), { status: 'failed', message: 'url must not contain credentials' });
});
