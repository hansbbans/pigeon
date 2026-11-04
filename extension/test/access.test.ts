import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserFamily, hasHostAccess, shortcutLabel } from '../src/core/access';
import { MAX_RETRY_DELAY_MS, MIN_RETRY_DELAY_MS, nextRetryDelay } from '../src/core/retry';
import { readQueue } from '../src/core/queue';
import { flushQueue, saveLink, savePage } from '../src/core/save';
import { optionsState, requestHostAccess } from '../src/core/sign-in';
import { storeSignIn } from '../src/core/session';
import { MemoryStore, mockFetch, ORIGIN, savedReply, signedInStore } from './helpers/fakes';

/** permissions.contains as Safari answers it before the user allows the Pigeon site. */
function access(granted: boolean) {
	const asked: string[] = [];
	return { asked, check: async (pattern: string) => { asked.push(pattern); return granted; } };
}

test('host access is checked for the Pigeon origin pattern; no API or a throwing one counts as access', async () => {
	const { asked, check } = access(false);
	assert.equal(await hasHostAccess('http://localhost:8787', check), false);
	assert.deepEqual(asked, ['http://localhost/*']);
	assert.equal(await hasHostAccess(ORIGIN, undefined), true);
	assert.equal(await hasHostAccess(ORIGIN, async () => { throw new Error('permissions.contains is not a function'); }), true);
});

test('a save is always tried first: Safari may not report access granted in its own UI', async () => {
	const store = await signedInStore();
	const { fetch, requests } = mockFetch(() => savedReply('pending'));
	const { asked, check } = access(false);
	const outcome = await saveLink('https://example.com/a', { fetch, store, hasHostAccess: check });
	assert.equal(outcome.status, 'saved');
	assert.equal(requests.length, 1);
	assert.deepEqual(asked, []);
	const flushStore = await signedInStore();
	await saveLink('https://example.com/b', { fetch: mockFetch(() => 'network-error').fetch, store: flushStore });
	const flushed = await flushQueue({ fetch, store: flushStore, hasHostAccess: check });
	assert.equal(flushed.sent, 1);
});

test('a request that fails like being offline without access waits for access, not for Pigeon', async () => {
	const store = await signedInStore();
	const offline = mockFetch(() => 'network-error');
	const outcome = await savePage({ url: 'https://example.com/a', title: 'A' }, null, { fetch: offline.fetch, store, hasHostAccess: access(false).check });
	assert.deepEqual(outcome, { status: 'needsAccess', queued: 1, origin: ORIGIN });
	assert.equal(offline.requests.length, 1);
	await saveLink('https://example.com/b', { fetch: offline.fetch, store, hasHostAccess: access(false).check });
	// The flush stops at the first such failure: every other request would fail the same way.
	const flushOffline = mockFetch(() => 'network-error');
	const flushed = await flushQueue({ fetch: flushOffline.fetch, store, hasHostAccess: access(false).check });
	assert.equal(flushed.stoppedBy, 'noAccess');
	assert.equal(flushed.remaining, 2);
	assert.equal(flushOffline.requests.length, 1);
});

test('with access, an offline failure is still "unreachable"; other failures never ask about access', async () => {
	const store = await signedInStore();
	const { asked, check } = access(true);
	const offline = await saveLink('https://example.com/a', { fetch: mockFetch(() => 'network-error').fetch, store, hasHostAccess: check });
	assert.equal(offline.status, 'queued');
	assert.equal(asked.length, 1);
	const denied = access(false);
	const server = await saveLink('https://example.com/b', { fetch: mockFetch(() => new Response('', { status: 503 })).fetch, store, hasHostAccess: denied.check });
	assert.equal(server.status, 'queued');
	assert.deepEqual(denied.asked, []);
	const flushed = await flushQueue({ fetch: mockFetch(() => 'network-error').fetch, store, hasHostAccess: check });
	assert.equal(flushed.stoppedBy, 'unreachable');
});

test('once access is allowed the waiting save goes out', async () => {
	const store = await signedInStore();
	await saveLink('https://example.com/a', { fetch: mockFetch(() => 'network-error').fetch, store, hasHostAccess: access(false).check });
	const { fetch, requests } = mockFetch(() => savedReply('pending'));
	const flushed = await flushQueue({ fetch, store, hasHostAccess: access(true).check });
	assert.equal(flushed.sent, 1);
	assert.equal(requests.length, 1);
	assert.deepEqual(await readQueue(store), []);
});

test('waiting for access retries at the minimum delay instead of backing off', () => {
	const noAccess = { sent: 0, dropped: 0, passedOver: 0, remaining: 1, stoppedBy: 'noAccess' as const };
	assert.equal(nextRetryDelay(null, noAccess), MIN_RETRY_DELAY_MS);
	assert.equal(nextRetryDelay(MAX_RETRY_DELAY_MS, noAccess), MIN_RETRY_DELAY_MS);
});

test('the options state offers "Allow access" only when signed in without access, from one settings read', async () => {
	const store = new MemoryStore();
	assert.equal((await optionsState(store, access(false).check)).missingAccess, null);
	await storeSignIn(store, 'https://pigeon.example.dev', 'pigeon/t');
	let reads = 0;
	const get = store.get.bind(store);
	store.get = async (keys) => { reads++; return get(keys); };
	const state = await optionsState(store, access(false).check);
	assert.equal(state.missingAccess, 'https://pigeon.example.dev/*');
	assert.equal(state.origin, 'https://pigeon.example.dev');
	assert.equal(reads, 2); // the settings and the queue summary
	assert.equal((await optionsState(store, access(true).check)).missingAccess, null);
	assert.equal((await optionsState(store)).missingAccess, null);
	assert.equal(await requestHostAccess('https://pigeon.example.dev/*', async () => true), true);
	assert.equal(await requestHostAccess('https://pigeon.example.dev/*', async () => false), false);
	assert.equal(await requestHostAccess('https://pigeon.example.dev/*', async () => { throw new Error('gesture required'); }), false);
});

test('Safari is told apart by its extension URL scheme, and gets its own shortcut hint', () => {
	assert.equal(browserFamily('safari-web-extension://4A1B2C3D/'), 'safari');
	assert.equal(browserFamily('chrome-extension://abcdefghijklmnop/'), 'chromium');
	assert.equal(shortcutLabel('⌥⇧S', 'safari'), '⌥⇧S');
	assert.equal(shortcutLabel('', 'chromium'), 'a shortcut (set one at chrome://extensions/shortcuts)');
	assert.match(shortcutLabel(undefined, 'safari'), /toolbar button/);
	assert.doesNotMatch(shortcutLabel(undefined, 'safari'), /chrome:/);
});
