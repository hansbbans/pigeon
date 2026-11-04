/**
 * Backoff for opportunistic retries of queued saves (browser start, page
 * loads). Without it, every page load while Pigeon is down would re-send the
 * oldest queued extraction, up to 2 MB. Retries the user causes (a new save,
 * signing in) ignore it.
 */

import type { FlushResult } from './save';

export const MIN_RETRY_DELAY_MS = 60_000;
export const MAX_RETRY_DELAY_MS = 30 * 60_000;

export interface RetryState {
	nextAt: number;
	delayMs: number;
}

export function retryDue(state: RetryState | null | undefined, now: number): boolean {
	return !state || now >= state.nextAt;
}

/** Doubles the wait after an unreachable Pigeon; anything else clears it. */
export function nextRetryState(previous: RetryState | null | undefined, result: FlushResult, now: number): RetryState | null {
	if (result.stoppedBy !== 'unreachable') return null;
	const delayMs = previous ? Math.min(previous.delayMs * 2, MAX_RETRY_DELAY_MS) : MIN_RETRY_DELAY_MS;
	return { nextAt: now + delayMs, delayMs };
}

export function parseRetryState(value: unknown): RetryState | null {
	if (!value || typeof value !== 'object') return null;
	const { nextAt, delayMs } = value as Partial<RetryState>;
	return typeof nextAt === 'number' && typeof delayMs === 'number' ? { nextAt, delayMs } : null;
}
