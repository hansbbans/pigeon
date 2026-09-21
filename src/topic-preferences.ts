import type { Env } from './types';

export const MONITORED_TOPICS_META_KEY = 'personalization.monitored_topics.v1';
export const MAX_MONITORED_TOPICS = 20;
export const MIN_MONITORED_TOPIC_LENGTH = 2;
export const MAX_MONITORED_TOPIC_LENGTH = 80;
export const MAX_PERSONALIZATION_BODY_BYTES = 16 * 1024;

interface MetaRow {
	value: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Normalize and validate the complete monitored-topic setting before writing. */
export function normalizeMonitoredTopics(value: unknown): string[] {
	if (!Array.isArray(value)) {
		throw new Error('monitoredTopics must be an array');
	}
	if (value.length > MAX_MONITORED_TOPICS) {
		throw new Error(`monitoredTopics may contain at most ${MAX_MONITORED_TOPICS} topics`);
	}

	const topics: string[] = [];
	const seen = new Set<string>();
	for (const rawTopic of value) {
		if (typeof rawTopic !== 'string') {
			throw new Error('Each monitored topic must be a string');
		}
		const normalized = rawTopic.normalize('NFKC').replace(/\s+/gu, ' ').trim();
		if (
			normalized.length < MIN_MONITORED_TOPIC_LENGTH ||
			normalized.length > MAX_MONITORED_TOPIC_LENGTH
		) {
			throw new Error(
				`Each monitored topic must contain ${MIN_MONITORED_TOPIC_LENGTH}-${MAX_MONITORED_TOPIC_LENGTH} characters`,
			);
		}
		if (!/[\p{L}\p{N}]/u.test(normalized)) {
			throw new Error('Each monitored topic must include a letter or number');
		}
		const key = normalized.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		topics.push(normalized);
	}
	return topics;
}

function decodeStoredTopics(value: unknown): string[] {
	if (typeof value !== 'string' || value.length > MAX_PERSONALIZATION_BODY_BYTES) return [];
	try {
		const parsed: unknown = JSON.parse(value);
		const rawTopics = Array.isArray(parsed)
			? parsed
			: isRecord(parsed) && Array.isArray(parsed.monitoredTopics)
				? parsed.monitoredTopics
				: [];
		return normalizeMonitoredTopics(rawTopics);
	} catch {
		// A malformed old value should not make recommendations or settings
		// unavailable. The next successful PUT replaces it atomically.
		return [];
	}
}

export async function loadMonitoredTopics(env: Env): Promise<string[]> {
	const row = await env.DB.prepare(`SELECT value FROM _meta WHERE key = ?`)
		.bind(MONITORED_TOPICS_META_KEY)
		.first<MetaRow>();
	return decodeStoredTopics(row?.value);
}

export async function saveMonitoredTopics(env: Env, topics: string[]): Promise<void> {
	// Callers pass already validated values. Keep a second guard here so future
	// callers cannot accidentally persist an unbounded setting.
	const normalized = normalizeMonitoredTopics(topics);
	const value = JSON.stringify({ version: 1, monitoredTopics: normalized });
	await env.DB.prepare(
		`INSERT INTO _meta (key, value) VALUES (?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
	)
		.bind(MONITORED_TOPICS_META_KEY, value)
		.run();
}

export async function clearMonitoredTopics(env: Env): Promise<void> {
	await env.DB.prepare('DELETE FROM _meta WHERE key = ?').bind(MONITORED_TOPICS_META_KEY).run();
}

export async function readBoundedJson(request: Request): Promise<unknown> {
	const contentLength = request.headers.get('Content-Length');
	if (contentLength !== null) {
		const parsedLength = Number.parseInt(contentLength, 10);
		if (!Number.isFinite(parsedLength) || parsedLength < 0 || parsedLength > MAX_PERSONALIZATION_BODY_BYTES) {
			throw new Error('Request body is too large');
		}
	}

	let body = '';
	if (request.body) {
		const reader = request.body.getReader();
		const decoder = new TextDecoder();
		let byteLength = 0;
		try {
			while (true) {
				const chunk = await reader.read();
				if (chunk.done) {
					body += decoder.decode();
					break;
				}
				byteLength += chunk.value.byteLength;
				if (byteLength > MAX_PERSONALIZATION_BODY_BYTES) {
					await reader.cancel();
					throw new Error('Request body is too large');
				}
				body += decoder.decode(chunk.value, { stream: true });
			}
		} finally {
			reader.releaseLock();
		}
	}
	try {
		return JSON.parse(body) as unknown;
	} catch {
		throw new Error('Request body must be valid JSON');
	}
}
