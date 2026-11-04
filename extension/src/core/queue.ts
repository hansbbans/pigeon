/**
 * Every save is written here before it is sent and removed once Pigeon has
 * answered, so a save survives being offline, a 5xx, a sign-out or 401, and
 * the service worker being stopped mid-request.
 */

import type { SaveRequestBody } from './payload';
import { requestBytes } from './payload';
import type { KeyValueStore } from './session';

const QUEUE_KEY = 'pigeonPendingSaves';
/** Count and size of the queue, kept next to it so readers need not load (or measure) the entries. */
export const QUEUE_SUMMARY_KEY = 'pigeonPendingSummary';
/** storage.local holds 10 MB in Chromium; queued extractions stay well under it. */
export const MAX_QUEUED_CONTENT_BYTES = 4_000_000;

export interface QueuedSave {
	id: string;
	/** The requests to try in order (full save, then the bare link). */
	attempts: SaveRequestBody[];
	queuedAt: string;
	/** Request bytes of `attempts`, measured once when queued. */
	bytes: number;
	/** Sends of the full save that ended in "try again later". */
	failures?: number;
}

export interface QueueSummary {
	count: number;
	bytes: number;
}

export async function readQueue(store: KeyValueStore): Promise<QueuedSave[]> {
	const value = (await store.get(QUEUE_KEY))[QUEUE_KEY];
	return Array.isArray(value) ? (value.filter(isQueuedSave) as QueuedSave[]) : [];
}

export async function readQueueSummary(store: KeyValueStore): Promise<QueueSummary> {
	const value = (await store.get(QUEUE_SUMMARY_KEY))[QUEUE_SUMMARY_KEY] as Partial<QueueSummary> | undefined;
	return { count: typeof value?.count === 'number' ? value.count : 0, bytes: typeof value?.bytes === 'number' ? value.bytes : 0 };
}

async function writeQueue(store: KeyValueStore, queue: QueuedSave[]): Promise<void> {
	if (queue.length === 0) {
		await store.remove([QUEUE_KEY, QUEUE_SUMMARY_KEY]);
		return;
	}
	const summary: QueueSummary = { count: queue.length, bytes: queue.reduce((total, entry) => total + entry.bytes, 0) };
	await store.set({ [QUEUE_KEY]: queue, [QUEUE_SUMMARY_KEY]: summary });
}

let lock: Promise<unknown> = Promise.resolve();

/** Serializes queue read-modify-write cycles inside one service worker. */
export function withQueueLock<T>(task: () => Promise<T>): Promise<T> {
	const run = lock.then(task, task);
	lock = run.catch(() => undefined);
	return run;
}

const attemptBytes = (attempts: SaveRequestBody[]) => attempts.reduce((sum, body) => sum + requestBytes(body), 0);
const hasContent = (attempts: SaveRequestBody[]) => attempts.some((body) => body.content !== undefined);

/** A later save of the same URL: keep queued content unless the new save brings its own; take the newest title. */
function mergeAttempts(previous: SaveRequestBody[], next: SaveRequestBody[]): SaveRequestBody[] {
	if (hasContent(next) || !hasContent(previous)) return next;
	const title = next.find((body) => body.title)?.title;
	return title ? previous.map((body) => ({ ...body, title })) : previous;
}

/**
 * Adds a save and returns its id, the queue length, and the requests as
 * stored (send those: they may carry an earlier extraction). A URL already waiting
 * is merged into the new entry: an extraction is never replaced by a bare
 * link. When the queue is full of extractions, the new entry keeps only its
 * bare link.
 */
export async function enqueue(store: KeyValueStore, attempts: SaveRequestBody[], now = new Date()): Promise<{ id: string; queued: number; attempts: SaveRequestBody[] }> {
	return withQueueLock(async () => {
		const existing = await readQueue(store);
		const url = attempts[0]?.url;
		const previous = existing.find((entry) => entry.attempts[0]?.url === url);
		const queue = existing.filter((entry) => entry !== previous);
		let kept = previous ? mergeAttempts(previous.attempts, attempts) : attempts;
		if (queue.reduce((total, entry) => total + entry.bytes, 0) + attemptBytes(kept) > MAX_QUEUED_CONTENT_BYTES) {
			kept = kept.slice(-1);
		}
		const id = `${now.getTime()}-${Math.random().toString(36).slice(2, 10)}`;
		queue.push({ id, attempts: kept, queuedAt: now.toISOString(), bytes: attemptBytes(kept) });
		await writeQueue(store, queue);
		return { id, queued: queue.length, attempts: kept };
	});
}

export async function removeFromQueue(store: KeyValueStore, id: string): Promise<number> {
	return withQueueLock(async () => {
		const queue = (await readQueue(store)).filter((entry) => entry.id !== id);
		await writeQueue(store, queue);
		return queue.length;
	});
}

/**
 * Counts a failed send of an entry's full save. After `limit` of them the
 * entry keeps only its bare link, so a body Pigeon keeps timing out on (or
 * answering 5xx to) cannot hold the save back forever. Returns the entry as stored.
 */
export async function recordFailure(store: KeyValueStore, id: string, limit: number): Promise<QueuedSave | null> {
	return withQueueLock(async () => {
		const queue = await readQueue(store);
		const entry = queue.find((candidate) => candidate.id === id);
		if (!entry) return null;
		entry.failures = (entry.failures ?? 0) + 1;
		if (entry.failures >= limit && entry.attempts.length > 1) {
			entry.attempts = entry.attempts.slice(-1);
			entry.bytes = attemptBytes(entry.attempts);
		}
		await writeQueue(store, queue);
		return entry;
	});
}

function isQueuedSave(value: unknown): boolean {
	if (!value || typeof value !== 'object') return false;
	const entry = value as Partial<QueuedSave>;
	return typeof entry.id === 'string' && typeof entry.bytes === 'number' && Array.isArray(entry.attempts) && entry.attempts.length > 0 &&
		entry.attempts.every((body) => body && typeof body.url === 'string');
}
