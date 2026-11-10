import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ensureRetryScheduled, MAX_RETRY_DELAY_MS, MIN_RETRY_DELAY_MS, nextRetryDelay, RETRY_ALARM, runRetry } from '../src/core/retry';
import { enqueue } from '../src/core/queue';
import { MemoryStore, mockFetch, signedInStore } from './helpers/fakes';
import { flushQueue, saveLink, type FlushResult } from '../src/core/save';

const unreachable = { sent: 0, dropped: 0, passedOver: 2, remaining: 2, stoppedBy: 'unreachable' as const };

test('retries back off while Pigeon is unreachable, up to 30 minutes', () => {
	let delay = nextRetryDelay(null, unreachable);
	assert.equal(delay, MIN_RETRY_DELAY_MS);
	delay = nextRetryDelay(delay, unreachable);
	assert.equal(delay, 2 * MIN_RETRY_DELAY_MS);
	for (let i = 0; i < 10; i++) delay = nextRetryDelay(delay, unreachable);
	assert.equal(delay, MAX_RETRY_DELAY_MS);
});

test('no retry when the queue is empty or waits for sign-in; passed-over saves retry soon', () => {
	assert.equal(nextRetryDelay(MAX_RETRY_DELAY_MS, { sent: 2, dropped: 0, passedOver: 0, remaining: 0 }), null);
	assert.equal(nextRetryDelay(null, { sent: 0, dropped: 0, passedOver: 0, remaining: 1, stoppedBy: 'unauthorized' }), null);
	assert.equal(nextRetryDelay(null, { sent: 0, dropped: 0, passedOver: 0, remaining: 1, stoppedBy: 'signedOut' }), null);
	assert.equal(nextRetryDelay(MAX_RETRY_DELAY_MS, { sent: 3, dropped: 0, passedOver: 1, remaining: 1 }), MIN_RETRY_DELAY_MS);
});

class FakeAlarms {
	alarms = new Map<string, number>();
	async create(name: string, info: { delayInMinutes: number }) { this.alarms.set(name, info.delayInMinutes); }
	async clear(name: string) { return this.alarms.delete(name); }
	async get(name: string) { return this.alarms.has(name) ? { name } : undefined; }
}

test('runRetry schedules a backing-off alarm while Pigeon is unreachable and clears it once the queue is empty', async () => {
	const store = new MemoryStore();
	const alarms = new FakeAlarms();
	await enqueue(store, [{ url: 'https://example.com/a' }]);
	const flushes: FlushResult[] = [unreachable, unreachable];
	const deps = { store, alarms, flush: async () => flushes.shift() ?? unreachable };
	await runRetry(false, deps);
	assert.equal(alarms.alarms.get(RETRY_ALARM), 1);
	await runRetry(false, deps);
	assert.equal(alarms.alarms.get(RETRY_ALARM), 2);
	// A retry the user caused restarts the backoff.
	await runRetry(true, deps);
	assert.equal(alarms.alarms.get(RETRY_ALARM), 1);
	await store.remove(['pigeonPendingSaves', 'pigeonPendingSummary']);
	assert.equal(await runRetry(false, deps), null);
	assert.equal(alarms.alarms.has(RETRY_ALARM), false);
});

test('a rejected token clears the alarm; a new queued save schedules one without resetting the backoff', async () => {
	const store = new MemoryStore();
	const alarms = new FakeAlarms();
	await enqueue(store, [{ url: 'https://example.com/a' }]);
	alarms.alarms.set(RETRY_ALARM, 4);
	await runRetry(false, { store, alarms, flush: async () => ({ sent: 0, dropped: 0, passedOver: 0, remaining: 1, stoppedBy: 'unauthorized' }) });
	assert.equal(alarms.alarms.has(RETRY_ALARM), false);
	await ensureRetryScheduled({ store, alarms });
	assert.equal(alarms.alarms.get(RETRY_ALARM), 1);
	alarms.alarms.set(RETRY_ALARM, 8);
	await ensureRetryScheduled({ store, alarms });
	assert.equal(alarms.alarms.get(RETRY_ALARM), 8);
});

test('a flush that finds no token (as one can mid sign-in) leaves the scheduled retry alone', async () => {
	const store = new MemoryStore();
	const alarms = new FakeAlarms();
	await enqueue(store, [{ url: 'https://example.com/a' }]);
	alarms.alarms.set(RETRY_ALARM, 4);
	await store.set({ pigeonRetryDelayMs: 4 * 60_000 });
	const signedOut: FlushResult = { sent: 0, dropped: 0, passedOver: 0, remaining: 1, stoppedBy: 'signedOut' };
	assert.deepEqual(await runRetry(true, { store, alarms, flush: async () => signedOut }), signedOut);
	assert.equal(alarms.alarms.get(RETRY_ALARM), 4);
	assert.equal((await store.get('pigeonRetryDelayMs')).pigeonRetryDelayMs, 4 * 60_000);
});

test('a single queued save backs off while Pigeon stays unreachable', async () => {
	const store = await signedInStore();
	const offline = mockFetch(() => 'network-error');
	await saveLink('https://example.com/only', { fetch: offline.fetch, store });
	const alarms = new FakeAlarms();
	const deps = { store, alarms, flush: () => flushQueue({ fetch: offline.fetch, store }) };
	const delays: Array<number | undefined> = [];
	for (let i = 0; i < 4; i++) {
		await runRetry(false, deps);
		delays.push(alarms.alarms.get(RETRY_ALARM));
	}
	assert.deepEqual(delays, [1, 2, 4, 8]);
});

test('a retry whose flush throws still leaves a retry scheduled', async () => {
	const store = new MemoryStore();
	const alarms = new FakeAlarms(); // empty: the one-shot alarm that started this retry has already fired
	await enqueue(store, [{ url: 'https://example.com/a' }]);
	await assert.rejects(runRetry(false, { store, alarms, flush: async () => { throw new Error('QUOTA_BYTES quota exceeded'); } }));
	assert.equal(alarms.alarms.has(RETRY_ALARM), true, 'one save is queued and no alarm will retry it');
});

test('a flush that finds the user signed out does not start a retry loop of its own', async () => {
	const store = new MemoryStore();
	const alarms = new FakeAlarms();
	await enqueue(store, [{ url: 'https://example.com/a' }]);
	const result = await runRetry(false, { store, alarms, flush: async () => ({ sent: 0, dropped: 0, passedOver: 0, remaining: 1, stoppedBy: 'signedOut' }) });
	assert.equal(result?.stoppedBy, 'signedOut');
	assert.equal(alarms.alarms.has(RETRY_ALARM), false);
});

test('a single queued save that Pigeon answers with an error keeps the short retry', async () => {
	const store = await signedInStore();
	const failing = mockFetch(() => new Response('unavailable', { status: 503 }));
	await saveLink('https://example.com/only', { fetch: failing.fetch, store });
	const alarms = new FakeAlarms();
	const deps = { store, alarms, flush: () => flushQueue({ fetch: failing.fetch, store }) };
	const delays: Array<number | undefined> = [];
	for (let i = 0; i < 3; i++) {
		await runRetry(false, deps);
		delays.push(alarms.alarms.get(RETRY_ALARM));
	}
	assert.deepEqual(delays, [1, 1, 1]);
});
