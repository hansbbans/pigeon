/**
 * The save flow, free of browser APIs: the background script passes in
 * storage, fetch and the page extraction. Rule from the spec: a save must land
 * even when extraction fails, so every path ends in a stored link or a queued one.
 */

import { hasHostAccess, type HostAccessCheck } from './access';
import { postSave, type Fetch, type RetryCause, type SaveResponseBody } from './api';
import { isSaveableUrl } from './config';
import { buildSaveAttempts, type PageExtraction, type SaveRequestBody } from './payload';
import { enqueue, readQueue, recordFailure, removeFromQueue } from './queue';
import { loadSettings, markNeedsSignIn, type KeyValueStore } from './session';

export interface SaveDeps {
	fetch: Fetch;
	store: KeyValueStore;
	/**
	 * `permissions.contains` for the Pigeon origin. Asked only after a request
	 * failed like a network error, to tell "no access" from "unreachable":
	 * Safari may not report access granted in its own UI, so it never stops a request.
	 */
	hasHostAccess?: HostAccessCheck;
}

export type SaveOutcome =
	/** Stored on Pigeon. `withContent` is false for a bare link (pending extraction). */
	| { status: 'saved'; withContent: boolean; response: SaveResponseBody }
	/** Not signed in, or the token stopped working; the save waits in the queue. */
	| { status: 'needsSignIn'; queued: number }
	/** The browser has not allowed the extension to reach Pigeon (Safari asks per site); the save waits in the queue. */
	| { status: 'needsAccess'; queued: number; origin: string }
	/** Pigeon unreachable; the save waits in the queue. */
	| { status: 'queued'; queued: number; message: string }
	/** Not a web page (chrome://, file://, …). Nothing to save. */
	| { status: 'unsupported' }
	/** Pigeon rejected even the bare link (for example a URL it cannot accept). */
	| { status: 'failed'; message: string };

/** Runs a save so that it always ends in an outcome to show, even if something throws. */
export async function guardSave(save: () => Promise<SaveOutcome>): Promise<SaveOutcome> {
	try {
		return await save();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error('[Pigeon] Save failed:', message);
		return { status: 'failed', message };
	}
}

export interface PageTarget {
	url: string | undefined;
	title?: string;
}

/**
 * Saves the current page. `extract` runs Defuddle in the tab; when it throws,
 * times out or returns no content, the bare link is saved instead.
 */
export async function savePage(target: PageTarget, extract: (() => Promise<PageExtraction | null>) | null, deps: SaveDeps): Promise<SaveOutcome> {
	if (!isSaveableUrl(target.url)) return { status: 'unsupported' };
	let extraction: PageExtraction | null = null;
	if (extract) {
		try {
			extraction = await extract();
		} catch {
			extraction = null;
		}
	}
	const title = target.title || extraction?.title;
	return sendAttempts(buildSaveAttempts(target.url, title, extraction?.content), deps);
}

/** "Save link to Pigeon": the linked page isn't loaded, so only the link goes. */
export async function saveLink(url: string | undefined, deps: SaveDeps, title?: string): Promise<SaveOutcome> {
	if (!isSaveableUrl(url)) return { status: 'unsupported' };
	return sendAttempts(buildSaveAttempts(url, title, undefined), deps);
}

type AttemptResult =
	| { status: 'saved'; withContent: boolean; response: SaveResponseBody }
	| { status: 'unauthorized' }
	| { status: 'retry'; cause: RetryCause; message: string }
	| { status: 'failed'; message: string };

/** Tries each request in order; a rejected request (400/413) falls through to the next. */
async function tryAttempts(attempts: SaveRequestBody[], origin: string, auth: string, fetchImpl: Fetch): Promise<AttemptResult> {
	let lastRejection = 'Pigeon rejected the save.';
	for (const body of attempts) {
		const result = await postSave(fetchImpl, origin, auth, body);
		if (result.kind === 'ok') return { status: 'saved', withContent: Boolean(body.content) && result.body.state === 'done', response: result.body };
		if (result.kind === 'unauthorized') return { status: 'unauthorized' };
		if (result.kind === 'retry') return { status: 'retry', cause: result.cause, message: result.message };
		lastRejection = result.message;
	}
	return { status: 'failed', message: lastRejection };
}

/** Queue entries being sent right now; a flush leaves them alone. */
const inFlight = new Set<string>();
/**
 * Times a full save may time out or get a 5xx before it is cut to its bare
 * link (being offline does not count: that is not the request's fault).
 */
export const MAX_FULL_SAVE_FAILURES = 2;
/** A flush stops after this many queued saves in a row could not reach Pigeon. */
const UNREACHABLE_STREAK = 2;

async function sendAttempts(attempts: SaveRequestBody[], deps: SaveDeps): Promise<SaveOutcome> {
	// Write-ahead: if the browser stops the service worker mid-request, the save is still queued.
	// Send what was stored: it may have kept an earlier extraction of the same URL.
	const queued = await enqueue(deps.store, attempts);
	const settings = await loadSettings(deps.store);
	if (!settings.auth) return { status: 'needsSignIn', queued: queued.queued };
	inFlight.add(queued.id);
	let result: AttemptResult;
	try {
		result = await tryAttempts(queued.attempts, settings.origin, settings.auth, deps.fetch);
	} finally {
		inFlight.delete(queued.id);
	}
	switch (result.status) {
		case 'saved':
			await removeFromQueue(deps.store, queued.id);
			return result;
		case 'failed':
			await removeFromQueue(deps.store, queued.id);
			return { status: 'failed', message: result.message };
		case 'unauthorized':
			await markNeedsSignIn(deps.store, settings.auth);
			return { status: 'needsSignIn', queued: (await readQueue(deps.store)).length };
		case 'retry':
			if (countsAgainstRequest(result.cause)) await recordFailure(deps.store, queued.id, MAX_FULL_SAVE_FAILURES);
			if (await lacksAccess(result.cause, settings.origin, deps)) return { status: 'needsAccess', queued: (await readQueue(deps.store)).length, origin: settings.origin };
			return { status: 'queued', queued: (await readQueue(deps.store)).length, message: result.message };
	}
}

function countsAgainstRequest(cause: RetryCause): boolean {
	return cause === 'timeout' || cause === 'server';
}

/** A request without host access fails like being offline; only then is it worth asking the browser. */
async function lacksAccess(cause: RetryCause, origin: string, deps: SaveDeps): Promise<boolean> {
	return cause === 'offline' && !(await hasHostAccess(origin, deps.hasHostAccess));
}

/** True while a save or a flush is talking to Pigeon (the background keeps the worker alive meanwhile). */
export function isSending(): boolean {
	return inFlight.size > 0 || flushing !== null;
}

export interface FlushResult {
	sent: number;
	/** Dropped because Pigeon rejected even the bare link. */
	dropped: number;
	/** Could not get through this time; still queued for the next retry. */
	passedOver: number;
	remaining: number;
	stoppedBy?: 'signedOut' | 'unauthorized' | 'unreachable' | 'noAccess';
}

let flushing: Promise<FlushResult> | null = null;

/**
 * Sends queued saves oldest first. A save that cannot get through is passed
 * over (and cut to its bare link after repeated failures) so it cannot block
 * the ones behind it; the flush stops once several in a row fail, since
 * Pigeon is then most likely unreachable.
 */
export function flushQueue(deps: SaveDeps): Promise<FlushResult> {
	flushing ??= runFlush(deps).finally(() => {
		flushing = null;
	});
	return flushing;
}

async function runFlush(deps: SaveDeps): Promise<FlushResult> {
	const result: FlushResult = { sent: 0, dropped: 0, passedOver: 0, remaining: 0 };
	const queue = await readQueue(deps.store);
	result.remaining = queue.length;
	if (queue.length === 0) return result;
	const settings = await loadSettings(deps.store);
	if (!settings.auth) return { ...result, stoppedBy: 'signedOut' };
	let streak = 0;
	for (const queued of queue) {
		if (inFlight.has(queued.id)) continue;
		let entry = queued;
		let attempt = await tryAttempts(entry.attempts, settings.origin, settings.auth, deps.fetch);
		if (attempt.status === 'retry' && countsAgainstRequest(attempt.cause) && entry.attempts.length > 1) {
			const updated = await recordFailure(deps.store, entry.id, MAX_FULL_SAVE_FAILURES);
			// Just cut to its bare link: that small request may well get through now.
			if (updated && updated.attempts.length === 1) {
				entry = updated;
				attempt = await tryAttempts(entry.attempts, settings.origin, settings.auth, deps.fetch);
			}
		}
		if (attempt.status === 'unauthorized') {
			await markNeedsSignIn(deps.store, settings.auth);
			return { ...result, remaining: (await readQueue(deps.store)).length, stoppedBy: 'unauthorized' };
		}
		if (attempt.status === 'retry') {
			// Without access every request fails the same way: stop and ask for access.
			if (await lacksAccess(attempt.cause, settings.origin, deps)) {
				return { ...result, remaining: (await readQueue(deps.store)).length, stoppedBy: 'noAccess' };
			}
			result.passedOver++;
			if (++streak >= UNREACHABLE_STREAK) {
				return { ...result, remaining: (await readQueue(deps.store)).length, stoppedBy: 'unreachable' };
			}
			continue;
		}
		streak = 0;
		if (attempt.status === 'saved') result.sent++;
		else result.dropped++;
		await removeFromQueue(deps.store, entry.id);
	}
	result.remaining = (await readQueue(deps.store)).length;
	return result;
}
