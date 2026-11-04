/**
 * Every save is written here before it is sent and removed once Pigeon has
 * answered, so a save survives being offline, a 5xx, a sign-out or 401, and
 * the service worker being stopped mid-request.
 */

import type { SaveRequestBody } from './payload';
import { requestBytes } from './payload';
import type { KeyValueStore } from './session';

const QUEUE_KEY = 'pigeonPendingSaves';
/** storage.local holds 10 MB in Chromium; queued extractions stay well under it. */
export const MAX_QUEUED_CONTENT_BYTES = 4_000_000;

export interface QueuedSave {
	id: string;
	/** The requests to try in order (full save, then the bare link). */
	attempts: SaveRequestBody[];
	queuedAt: string;
}

export async function readQueue(store: KeyValueStore): Promise<QueuedSave[]> {
	const value = (await store.get(QUEUE_KEY))[QUEUE_KEY];
	return Array.isArray(value) ? (value.filter(isQueuedSave) as QueuedSave[]) : [];
}

async function writeQueue(store: KeyValueStore, queue: QueuedSave[]): Promise<void> {
	if (queue.length === 0) await store.remove(QUEUE_KEY);
	else await store.set({ [QUEUE_KEY]: queue });
}

let lock: Promise<unknown> = Promise.resolve();

/** Serializes queue read-modify-write cycles inside one service worker. */
export function withQueueLock<T>(task: () => Promise<T>): Promise<T> {
	const run = lock.then(task, task);
	lock = run.catch(() => undefined);
	return run;
}

function queuedBytes(queue: QueuedSave[]): number {
	return queue.reduce((total, entry) => total + entry.attempts.reduce((sum, body) => sum + requestBytes(body), 0), 0);
}

/**
 * Adds a save and returns its id and the queue length. A URL already waiting
 * is replaced (the newer save wins, and a re-save is what the Worker would do
 * anyway). When the queue is full of extractions, the new entry keeps only its
 * bare link.
 */
export async function enqueue(store: KeyValueStore, attempts: SaveRequestBody[], now = new Date()): Promise<{ id: string; queued: number }> {
	return withQueueLock(async () => {
		const queue = (await readQueue(store)).filter((entry) => entry.attempts[0]?.url !== attempts[0]?.url);
		let kept = attempts;
		if (queuedBytes(queue) + kept.reduce((sum, body) => sum + requestBytes(body), 0) > MAX_QUEUED_CONTENT_BYTES) {
			kept = attempts.slice(-1);
		}
		const id = `${now.getTime()}-${Math.random().toString(36).slice(2, 10)}`;
		queue.push({ id, attempts: kept, queuedAt: now.toISOString() });
		await writeQueue(store, queue);
		return { id, queued: queue.length };
	});
}

export async function removeFromQueue(store: KeyValueStore, id: string): Promise<number> {
	return withQueueLock(async () => {
		const queue = (await readQueue(store)).filter((entry) => entry.id !== id);
		await writeQueue(store, queue);
		return queue.length;
	});
}

function isQueuedSave(value: unknown): boolean {
	if (!value || typeof value !== 'object') return false;
	const entry = value as Partial<QueuedSave>;
	return typeof entry.id === 'string' && Array.isArray(entry.attempts) && entry.attempts.length > 0 &&
		entry.attempts.every((body) => body && typeof body.url === 'string');
}
