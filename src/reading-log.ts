import { classifyClientFamily, loadItemsByIDs } from './engagement';
import type { Env } from './types';

/**
 * The reading log records what the reader was shown and did, so a ranking
 * change can be judged against real behaviour. It is separate from
 * engagement_events (which the live ranker reads) and loosely typed on
 * purpose: adding a kind of event here needs no schema change.
 *
 * - impression: a card was at least half visible in a list for a second.
 *   `view` names the list, `position` is its 0-based rank as displayed.
 */
export const READING_LOG_EVENT_TYPES = ['impression'] as const;
export type ReadingLogEventType = (typeof READING_LOG_EVENT_TYPES)[number];

export interface ValidatedReadingLogEvent {
	id: string;
	itemId: string;
	type: ReadingLogEventType;
	view: string | null;
	position: number | null;
	value: number | null;
	sessionId: string | null;
	metadataJson: string | null;
	occurredAt: string;
}

/**
 * engagement_events can only say "pigeon" for both first-party apps (its
 * client_family has a CHECK). The reading log has no such limit, so it keeps
 * them apart: whether each app is still logging is the first thing to check.
 */
export function classifyReadingLogClient(request: Request): string {
	const client = (request.headers.get('X-Pigeon-Client') ?? '').toLowerCase();
	if (client.startsWith('pigeon-web')) return 'pigeon_web';
	if (client.startsWith('pigeon-reader')) return 'pigeon_ios';
	return classifyClientFamily(request);
}

const MAX_EVENTS_PER_REQUEST = 200;
const MAX_ID_LENGTH = 200;
const MAX_SESSION_ID_LENGTH = 100;
const MAX_POSITION = 100_000;
const MAX_VALUE = 86_400;
const MAX_METADATA_BYTES = 1_024;
const VIEW_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAbsent(value: unknown): value is undefined | null {
	return value === undefined || value === null;
}

function boundedString(value: unknown, name: string, maximum: number): string | null {
	if (isAbsent(value)) return null;
	if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
		throw new Error(`${name} is invalid`);
	}
	return value;
}

export function validateReadingLogEvents(body: unknown): ValidatedReadingLogEvent[] {
	if (!isRecord(body) || !Array.isArray(body.events)) {
		throw new Error('Request body must contain an events array');
	}
	if (body.events.length === 0 || body.events.length > MAX_EVENTS_PER_REQUEST) {
		throw new Error(`events must contain between 1 and ${MAX_EVENTS_PER_REQUEST} entries`);
	}

	return body.events.map((rawEvent, index) => {
		const field = (name: string) => `events[${index}].${name}`;
		if (!isRecord(rawEvent)) {
			throw new Error(`events[${index}] must be an object`);
		}
		const itemId = boundedString(rawEvent.itemId, field('itemId'), MAX_ID_LENGTH);
		if (itemId === null) throw new Error(`${field('itemId')} is invalid`);
		const type = rawEvent.type;
		if (typeof type !== 'string' || !(READING_LOG_EVENT_TYPES as readonly string[]).includes(type)) {
			throw new Error(`${field('type')} is invalid`);
		}

		const view = boundedString(rawEvent.view, field('view'), 40);
		if (view !== null && !VIEW_PATTERN.test(view)) throw new Error(`${field('view')} is invalid`);
		if (type === 'impression' && view === null) throw new Error(`${field('view')} is required for impressions`);

		const position = isAbsent(rawEvent.position) ? null : rawEvent.position;
		if (position !== null && (typeof position !== 'number' || !Number.isInteger(position) || position < 0 || position > MAX_POSITION)) {
			throw new Error(`${field('position')} must be an integer between 0 and ${MAX_POSITION}`);
		}
		const value = isAbsent(rawEvent.value) ? null : rawEvent.value;
		if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_VALUE)) {
			throw new Error(`${field('value')} must be between 0 and ${MAX_VALUE}`);
		}

		let metadataJson: string | null = null;
		if (!isAbsent(rawEvent.metadata)) {
			if (!isRecord(rawEvent.metadata)) throw new Error(`${field('metadata')} must be an object`);
			metadataJson = JSON.stringify(rawEvent.metadata);
			if (new TextEncoder().encode(metadataJson).byteLength > MAX_METADATA_BYTES) {
				throw new Error(`${field('metadata')} must be at most ${MAX_METADATA_BYTES} bytes`);
			}
		}

		let occurredAt: string;
		if (isAbsent(rawEvent.occurredAt)) {
			occurredAt = new Date().toISOString();
		} else if (typeof rawEvent.occurredAt === 'string' && Number.isFinite(Date.parse(rawEvent.occurredAt))) {
			occurredAt = new Date(rawEvent.occurredAt).toISOString();
		} else {
			throw new Error(`${field('occurredAt')} must be a valid ISO 8601 timestamp`);
		}

		return {
			id: boundedString(rawEvent.id, field('id'), MAX_ID_LENGTH) ?? crypto.randomUUID(),
			itemId,
			type: type as ReadingLogEventType,
			view,
			position,
			value,
			sessionId: boundedString(rawEvent.sessionId, field('sessionId'), MAX_SESSION_ID_LENGTH),
			metadataJson,
			occurredAt,
		};
	});
}

/**
 * POST /api/v1/reading-log, JSON {events: [...]}, 1 to 200 events.
 * Idempotent per client event id. Events for items that no longer exist are
 * skipped rather than failing the batch: a card can be logged after its
 * article was deleted, and one stale row must not cost the other 199.
 */
export async function handleReadingLogIngestion(request: Request, env: Env): Promise<Response> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: 'Request body must be valid JSON' }, { status: 400 });
	}

	let events: ValidatedReadingLogEvent[];
	try {
		events = validateReadingLogEvents(body);
	} catch (error) {
		return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
	}

	const clientFamily = classifyReadingLogClient(request);
	const itemsByID = await loadItemsByIDs(env, events.map((event) => event.itemId));
	const stored = events.flatMap((event) => {
		const item = itemsByID.get(event.itemId);
		return item
			? [{ ...event, eventKey: `client:${clientFamily}:${event.id}`, itemId: item.id, feedKey: item.feed_key }]
			: [];
	});

	if (stored.length > 0) {
		await env.DB.prepare(
			`INSERT OR IGNORE INTO reading_log
			 (id, event_key, event_type, item_id, feed_key, client_family, view, position, value, session_id, metadata_json, occurred_at)
			 SELECT json_extract(value, '$.id'), json_extract(value, '$.eventKey'), json_extract(value, '$.type'),
			        json_extract(value, '$.itemId'), json_extract(value, '$.feedKey'), ?,
			        json_extract(value, '$.view'), json_extract(value, '$.position'), json_extract(value, '$.value'),
			        json_extract(value, '$.sessionId'), json_extract(value, '$.metadataJson'), json_extract(value, '$.occurredAt')
			 FROM json_each(?)`,
		).bind(clientFamily, JSON.stringify(stored)).run();
	}
	return Response.json({ accepted: stored.length, skipped: events.length - stored.length, clientFamily });
}
