/**
 * When to retry queued saves. The background schedules the answer with
 * chrome.alarms, so retries survive service-worker restarts and back off
 * while Pigeon stays unreachable instead of re-sending large bodies on every
 * page load. Retries the user causes (a new save, signing in) send at once.
 */

import { readQueueSummary } from './queue';
import type { FlushResult } from './save';
import type { KeyValueStore } from './session';

export const MIN_RETRY_DELAY_MS = 60_000;
export const MAX_RETRY_DELAY_MS = 30 * 60_000;

/**
 * The wait before the next retry, or null when none is needed: the queue is
 * empty, or it waits for the user to sign in. Doubles while Pigeon stays
 * unreachable; saves that were only passed over retry after the minimum.
 */
export function nextRetryDelay(previousMs: number | null | undefined, result: FlushResult): number | null {
	if (result.remaining === 0 || result.stoppedBy === 'signedOut' || result.stoppedBy === 'unauthorized') return null;
	if (result.stoppedBy !== 'unreachable') return MIN_RETRY_DELAY_MS;
	return previousMs ? Math.min(Math.max(previousMs * 2, MIN_RETRY_DELAY_MS), MAX_RETRY_DELAY_MS) : MIN_RETRY_DELAY_MS;
}

export const RETRY_ALARM = 'pigeon-retry';
const RETRY_DELAY_KEY = 'pigeonRetryDelayMs';

/** The `alarms` calls used here. */
export interface AlarmsApi {
	create(name: string, info: { delayInMinutes: number }): void | Promise<void>;
	clear(name: string): Promise<boolean>;
	get(name: string): Promise<unknown>;
}

export interface RetryDeps {
	store: KeyValueStore;
	alarms: AlarmsApi;
	flush(): Promise<FlushResult>;
}

/**
 * Sends queued saves, then schedules the next try (backing off while Pigeon
 * stays unreachable) or clears the alarm when nothing waits. `force` (a new
 * save, signing in) restarts the backoff. Returns null when the queue was empty.
 */
export async function runRetry(force: boolean, deps: RetryDeps): Promise<FlushResult | null> {
	if ((await readQueueSummary(deps.store)).count === 0) {
		await clearRetry(deps);
		return null;
	}
	const result = await deps.flush();
	const previous = force ? null : (await deps.store.get(RETRY_DELAY_KEY))[RETRY_DELAY_KEY];
	const delay = nextRetryDelay(typeof previous === 'number' ? previous : null, result);
	if (delay === null) await clearRetry(deps);
	else await scheduleRetry(deps, delay);
	return result;
}

/** A save just went into the queue: make sure a retry is coming, without resetting a running backoff. */
export async function ensureRetryScheduled(deps: Omit<RetryDeps, 'flush'>): Promise<void> {
	if (!(await deps.alarms.get(RETRY_ALARM))) await scheduleRetry(deps, MIN_RETRY_DELAY_MS);
}

async function scheduleRetry(deps: Omit<RetryDeps, 'flush'>, delayMs: number): Promise<void> {
	await deps.alarms.create(RETRY_ALARM, { delayInMinutes: delayMs / 60_000 });
	await deps.store.set({ [RETRY_DELAY_KEY]: delayMs });
}

async function clearRetry(deps: Omit<RetryDeps, 'flush'>): Promise<void> {
	await deps.alarms.clear(RETRY_ALARM);
	await deps.store.remove(RETRY_DELAY_KEY);
}
