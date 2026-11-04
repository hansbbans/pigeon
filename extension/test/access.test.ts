import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserFamily, hasHostAccess, shortcutLabel } from '../src/core/access';
import { MIN_RETRY_DELAY_MS, nextRetryDelay } from '../src/core/retry';
import { readQueue } from '../src/core/queue';
import { flushQueue, saveLink, savePage } from '../src/core/save';
import { grantHostAccess, missingHostAccess } from '../src/core/sign-in';
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

test('without access to Pigeon a save waits in the queue and sends nothing', async () => {
	const store = await signedInStore();
	const { fetch, requests } = mockFetch([]);
	const { check } = access(false);
	const outcome = await savePage({ url: 'https://example.com/a', title: 'A' }, null, { fetch, store, hasHostAccess: check });
	assert.deepEqual(outcome, { status: 'needsAccess', queued: 1, origin: ORIGIN });
	assert.equal(requests.length, 0);
	assert.equal((await readQueue(store)).length, 1);
	const flushed = await flushQueue({ fetch, store, hasHostAccess: check });
	assert.equal(flushed.stoppedBy, 'noAccess');
	assert.equal(flushed.remaining, 1);
	assert.equal(requests.length, 0);
});

test('once access is allowed the waiting save goes out', async () => {
	const store = await signedInStore();
	await saveLink('https://example.com/a', { fetch: mockFetch([]).fetch, store, hasHostAccess: access(false).check });
	const { fetch, requests } = mockFetch(() => savedReply('pending'));
	const flushed = await flushQueue({ fetch, store, hasHostAccess: access(true).check });
	assert.equal(flushed.sent, 1);
	assert.equal(requests.length, 1);
	assert.deepEqual(await readQueue(store), []);
});

test('signed out wins over missing access: sign-in asks for access anyway', async () => {
	const outcome = await saveLink('https://example.com/a', { fetch: mockFetch([]).fetch, store: new MemoryStore(), hasHostAccess: access(false).check });
	assert.equal(outcome.status, 'needsSignIn');
});

test('waiting for access backs off like an unreachable Pigeon instead of stopping', () => {
	const noAccess = { sent: 0, dropped: 0, passedOver: 0, remaining: 1, stoppedBy: 'noAccess' as const };
	assert.equal(nextRetryDelay(null, noAccess), MIN_RETRY_DELAY_MS);
	assert.equal(nextRetryDelay(MIN_RETRY_DELAY_MS, noAccess), 2 * MIN_RETRY_DELAY_MS);
});

test('the options page offers "Allow access" only when signed in without access', async () => {
	const store = new MemoryStore();
	assert.equal(await missingHostAccess(store, access(false).check), null);
	await storeSignIn(store, 'https://pigeon.example.dev', 'pigeon/t');
	assert.deepEqual(await missingHostAccess(store, access(false).check), { origin: 'https://pigeon.example.dev', pattern: 'https://pigeon.example.dev/*' });
	assert.equal(await missingHostAccess(store, access(true).check), null);
	assert.equal(await grantHostAccess('https://pigeon.example.dev/*', async () => true), true);
	assert.equal(await grantHostAccess('https://pigeon.example.dev/*', async () => false), false);
	assert.equal(await grantHostAccess('https://pigeon.example.dev/*', async () => { throw new Error('gesture required'); }), false);
});

test('Safari is told apart by its extension URL scheme, and gets its own shortcut hint', () => {
	assert.equal(browserFamily('safari-web-extension://4A1B2C3D/'), 'safari');
	assert.equal(browserFamily('chrome-extension://abcdefghijklmnop/'), 'chromium');
	assert.equal(shortcutLabel('⌥⇧S', 'safari'), '⌥⇧S');
	assert.equal(shortcutLabel('', 'chromium'), 'a shortcut (set one at chrome://extensions/shortcuts)');
	assert.match(shortcutLabel(undefined, 'safari'), /toolbar button/);
	assert.doesNotMatch(shortcutLabel(undefined, 'safari'), /chrome:/);
});
