/**
 * The save flow, free of browser APIs: the background script passes in
 * storage, fetch and the page extraction. Rule from the spec: a save must land
 * even when extraction fails, so every path ends in a stored link or a queued one.
 */

import { postSave, type Fetch, type SaveResponseBody } from './api';
import { isSaveableUrl } from './config';
import { buildSaveAttempts, type PageExtraction, type SaveRequestBody } from './payload';
import { enqueue, readQueue, removeFromQueue } from './queue';
import { loadSettings, markNeedsSignIn, type KeyValueStore } from './session';

export interface SaveDeps {
	fetch: Fetch;
	store: KeyValueStore;
}

export type SaveOutcome =
	/** Stored on Pigeon. `withContent` is false for a bare link (pending extraction). */
	| { status: 'saved'; withContent: boolean; response: SaveResponseBody }
	/** Not signed in, or the token stopped working; the save waits in the queue. */
	| { status: 'needsSignIn'; queued: number }
	/** Pigeon unreachable; the save waits in the queue. */
	| { status: 'queued'; queued: number; message: string }
	/** Not a web page (chrome://, file://, …). Nothing to save. */
	| { status: 'unsupported' }
	/** Pigeon rejected even the bare link (for example a URL it cannot accept). */
	| { status: 'failed'; message: string };

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
	| { status: 'retry'; message: string }
	| { status: 'failed'; message: string };

/** Tries each request in order; a rejected request (400/413) falls through to the next. */
async function tryAttempts(attempts: SaveRequestBody[], origin: string, auth: string, fetchImpl: Fetch): Promise<AttemptResult> {
	let lastRejection = 'Pigeon rejected the save.';
	for (const body of attempts) {
		const result = await postSave(fetchImpl, origin, auth, body);
		if (result.kind === 'ok') return { status: 'saved', withContent: Boolean(body.content) && result.body.state === 'done', response: result.body };
		if (result.kind === 'unauthorized') return { status: 'unauthorized' };
		if (result.kind === 'retry') return { status: 'retry', message: result.message };
		lastRejection = result.message;
	}
	return { status: 'failed', message: lastRejection };
}

async function sendAttempts(attempts: SaveRequestBody[], deps: SaveDeps): Promise<SaveOutcome> {
	const settings = await loadSettings(deps.store);
	if (!settings.auth) {
		return { status: 'needsSignIn', queued: await enqueue(deps.store, attempts) };
	}
	const result = await tryAttempts(attempts, settings.origin, settings.auth, deps.fetch);
	switch (result.status) {
		case 'saved':
			return result;
		case 'unauthorized':
			await markNeedsSignIn(deps.store);
			return { status: 'needsSignIn', queued: await enqueue(deps.store, attempts) };
		case 'retry':
			return { status: 'queued', queued: await enqueue(deps.store, attempts), message: result.message };
		case 'failed':
			return { status: 'failed', message: result.message };
	}
}

export interface FlushResult {
	sent: number;
	/** Dropped because Pigeon rejected even the bare link. */
	dropped: number;
	remaining: number;
	stoppedBy?: 'signedOut' | 'unauthorized' | 'unreachable';
}

let flushing: Promise<FlushResult> | null = null;

/** Sends queued saves oldest first; stops at the first sign that Pigeon is unreachable. */
export function flushQueue(deps: SaveDeps): Promise<FlushResult> {
	flushing ??= runFlush(deps).finally(() => {
		flushing = null;
	});
	return flushing;
}

async function runFlush(deps: SaveDeps): Promise<FlushResult> {
	const result: FlushResult = { sent: 0, dropped: 0, remaining: 0 };
	const queue = await readQueue(deps.store);
	result.remaining = queue.length;
	if (queue.length === 0) return result;
	const settings = await loadSettings(deps.store);
	if (!settings.auth) return { ...result, stoppedBy: 'signedOut' };
	for (const entry of queue) {
		const attempt = await tryAttempts(entry.attempts, settings.origin, settings.auth, deps.fetch);
		if (attempt.status === 'unauthorized') {
			await markNeedsSignIn(deps.store);
			return { ...result, stoppedBy: 'unauthorized' };
		}
		if (attempt.status === 'retry') return { ...result, stoppedBy: 'unreachable' };
		if (attempt.status === 'saved') result.sent++;
		else result.dropped++;
		result.remaining = await removeFromQueue(deps.store, entry.id);
	}
	return result;
}
