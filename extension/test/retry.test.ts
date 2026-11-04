import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_RETRY_DELAY_MS, MIN_RETRY_DELAY_MS, nextRetryState, parseRetryState, retryDue } from '../src/core/retry';

const unreachable = { sent: 0, dropped: 0, remaining: 2, stoppedBy: 'unreachable' as const };

test('retries back off while Pigeon is unreachable, up to 30 minutes', () => {
	let state = nextRetryState(null, unreachable, 1_000);
	assert.deepEqual(state, { nextAt: 1_000 + MIN_RETRY_DELAY_MS, delayMs: MIN_RETRY_DELAY_MS });
	assert.equal(retryDue(state, 1_000 + MIN_RETRY_DELAY_MS - 1), false);
	assert.equal(retryDue(state, 1_000 + MIN_RETRY_DELAY_MS), true);
	for (let i = 0; i < 10; i++) state = nextRetryState(state, unreachable, 0);
	assert.equal(state?.delayMs, MAX_RETRY_DELAY_MS);
});

test('any other outcome clears the backoff', () => {
	const state = nextRetryState(null, unreachable, 0);
	assert.equal(nextRetryState(state, { sent: 2, dropped: 0, remaining: 0 }, 0), null);
	assert.equal(nextRetryState(state, { sent: 0, dropped: 0, remaining: 1, stoppedBy: 'unauthorized' }, 0), null);
	assert.equal(retryDue(null, 0), true);
});

test('parseRetryState ignores junk from storage', () => {
	assert.equal(parseRetryState(undefined), null);
	assert.equal(parseRetryState({ nextAt: 'x' }), null);
	assert.deepEqual(parseRetryState({ nextAt: 5, delayMs: 60_000 }), { nextAt: 5, delayMs: 60_000 });
});
