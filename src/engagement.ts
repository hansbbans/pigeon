import type { D1PreparedStatement } from '@cloudflare/workers-types';

import type { Env } from './types';

export const CLIENT_FAMILIES = ['pigeon', 'reeder_classic', 'netnewswire', 'other'] as const;
export type ClientFamily = (typeof CLIENT_FAMILIES)[number];

export const ENGAGEMENT_EVENT_TYPES = [
	'explicit_open',
	'active_reading',
	'scroll_depth',
	'outbound_link',
	'star',
	'unstar',
	'more_like_this',
	'not_interested',
	'read',
	'unread',
	'bulk_mark_all_read',
] as const;
export type EngagementEventType = (typeof ENGAGEMENT_EVENT_TYPES)[number];

export interface ValidatedEngagementEvent {
	id: string;
	itemId: string;
	type: EngagementEventType;
	value: number | null;
	durationSeconds: number | null;
	scrollDepth: number | null;
	destinationHost: string | null;
	occurredAt: string;
}

interface ItemStateRow {
	rowid: number;
	id: string;
	feed_key: string;
	is_read: number;
	is_starred: number;
}

const MAX_EVENTS_PER_REQUEST = 100;
const MAX_ITEM_ID_LENGTH = 200;
const MAX_DESTINATION_HOST_LENGTH = 253;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function numberOrNull(value: unknown): number | null {
	if (value === undefined || value === null || value === '') {
		return null;
	}
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return Number.NaN;
	}
	return value;
}

function validateTimestamp(value: unknown): string {
	if (value === undefined || value === null || value === '') {
		return new Date().toISOString();
	}
	if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
		throw new Error('occurredAt must be a valid ISO 8601 timestamp');
	}
	return new Date(value).toISOString();
}

function validateOptionalRange(value: number | null, name: string, minimum: number, maximum: number): number | null {
	if (value === null) {
		return null;
	}
	if (!Number.isFinite(value) || value < minimum || value > maximum) {
		throw new Error(`${name} must be between ${minimum} and ${maximum}`);
	}
	return value;
}

function normalizeDestinationHost(value: unknown, eventType: EngagementEventType, index: number): string | null {
	if (value === undefined || value === null || value === '') {
		if (eventType === 'outbound_link') {
			throw new Error(`events[${index}].destinationHost is required for outbound links`);
		}
		return null;
	}
	if (eventType !== 'outbound_link') {
		throw new Error(`events[${index}].destinationHost is only valid for outbound links`);
	}
	if (typeof value !== 'string') {
		throw new Error(`events[${index}].destinationHost is invalid`);
	}

	const normalized = value.trim().toLowerCase().replace(/\.$/, '');
	if (
		normalized.length === 0 ||
		normalized.length > MAX_DESTINATION_HOST_LENGTH ||
		/[^a-z0-9.-]/.test(normalized) ||
		normalized.split('.').some((label) => label.length === 0 || label.length > 63 || label.startsWith('-') || label.endsWith('-'))
	) {
		throw new Error(`events[${index}].destinationHost is invalid`);
	}

	return normalized;
}

export function classifyClientFamily(request: Request): ClientFamily {
	const hint = `${request.headers.get('X-Pigeon-Client') ?? ''} ${request.headers.get('User-Agent') ?? ''}`.toLowerCase();
	if (hint.includes('netnewswire')) {
		return 'netnewswire';
	}
	if (hint.includes('reeder')) {
		return 'reeder_classic';
	}
	if (hint.includes('pigeon')) {
		return 'pigeon';
	}
	return 'other';
}

export function validateEngagementEvents(value: unknown): ValidatedEngagementEvent[] {
	if (!isRecord(value) || !Array.isArray(value.events)) {
		throw new Error('Request body must contain an events array');
	}
	if (value.events.length === 0 || value.events.length > MAX_EVENTS_PER_REQUEST) {
		throw new Error(`events must contain between 1 and ${MAX_EVENTS_PER_REQUEST} entries`);
	}

	return value.events.map((rawEvent, index) => {
		if (!isRecord(rawEvent)) {
			throw new Error(`events[${index}] must be an object`);
		}
		const itemId = rawEvent.itemId;
		if (typeof itemId !== 'string' || itemId.length === 0 || itemId.length > MAX_ITEM_ID_LENGTH) {
			throw new Error(`events[${index}].itemId is invalid`);
		}
		const type = rawEvent.type;
		if (typeof type !== 'string' || !(ENGAGEMENT_EVENT_TYPES as readonly string[]).includes(type)) {
			throw new Error(`events[${index}].type is invalid`);
		}

		const id = rawEvent.id;
		if (id !== undefined && (typeof id !== 'string' || id.length === 0 || id.length > 200)) {
			throw new Error(`events[${index}].id is invalid`);
		}

		const durationSeconds = validateOptionalRange(
			numberOrNull(rawEvent.durationSeconds),
			'durationSeconds',
			0,
			86_400,
		);
		const scrollDepth = validateOptionalRange(numberOrNull(rawEvent.scrollDepth), 'scrollDepth', 0, 1);
		const value = numberOrNull(rawEvent.value);
		if (value !== null && !Number.isFinite(value)) {
			throw new Error(`events[${index}].value must be a finite number`);
		}

		return {
			id: typeof id === 'string' ? id : crypto.randomUUID(),
			itemId,
			type: type as EngagementEventType,
			value,
			durationSeconds,
			scrollDepth,
			destinationHost: normalizeDestinationHost(rawEvent.destinationHost, type as EngagementEventType, index),
			occurredAt: validateTimestamp(rawEvent.occurredAt),
		};
	});
}

function chunkValues<T>(values: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let index = 0; index < values.length; index += size) {
		chunks.push(values.slice(index, index + size));
	}
	return chunks;
}

async function loadItemsByIDs(env: Env, itemIds: string[]): Promise<Map<string, { id: string; feed_key: string }>> {
	const rows = await Promise.all(
		chunkValues([...new Set(itemIds)], 90).map(async (chunk) => {
			const placeholders = chunk.map(() => '?').join(',');
			return env.DB.prepare(`SELECT id, feed_key FROM items WHERE id IN (${placeholders})`)
				.bind(...chunk)
				.all<{ id: string; feed_key: string }>();
		}),
	);
	return new Map(rows.flatMap((result) => result.results).map((row) => [row.id, row]));
}

export async function handleEngagementIngestion(request: Request, env: Env): Promise<Response> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: 'Request body must be valid JSON' }, { status: 400 });
	}

	let events: ValidatedEngagementEvent[];
	try {
		events = validateEngagementEvents(body);
	} catch (error) {
		return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
	}

	const itemsByID = await loadItemsByIDs(env, events.map((event) => event.itemId));
	const missingItem = events.find((event) => !itemsByID.has(event.itemId));
	if (missingItem) {
		return Response.json({ error: `Unknown item ${missingItem.itemId}` }, { status: 404 });
	}

	const clientFamily = classifyClientFamily(request);
	const statements = events.map((event) => {
		const item = itemsByID.get(event.itemId) as { id: string; feed_key: string };
		const eventKey = `client:${clientFamily}:${event.id}`;
		return env.DB.prepare(
			`INSERT OR IGNORE INTO engagement_events
			 (id, event_key, item_id, feed_key, event_type, client_family, value, duration_seconds, scroll_depth, destination_host, occurred_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
			.bind(
				event.id,
				eventKey,
				item.id,
				item.feed_key,
				event.type,
				clientFamily,
				event.value,
				event.durationSeconds,
				event.scrollDepth,
				event.destinationHost,
				event.occurredAt,
			);
	});

	await env.DB.batch(statements);
	return Response.json({ accepted: events.length, clientFamily });
}

export async function buildStateTransitionEventStatements(
	env: Env,
	rowids: number[],
	options: {
		kind: 'read' | 'star';
		target: boolean;
		eventType: 'read' | 'unread' | 'star' | 'unstar' | 'bulk_mark_all_read';
		clientFamily: ClientFamily;
	},
): Promise<D1PreparedStatement[]> {
	const uniqueRowids = [...new Set(rowids)].filter((rowid) => Number.isFinite(rowid));
	if (uniqueRowids.length === 0) {
		return [];
	}

	const rows = await Promise.all(
		chunkValues(uniqueRowids, 90).map(async (chunk) => {
			const placeholders = chunk.map(() => '?').join(',');
			return env.DB.prepare(
				`SELECT rowid, id, feed_key, is_read, is_starred FROM items WHERE rowid IN (${placeholders})`,
			)
				.bind(...chunk)
				.all<ItemStateRow>();
		}),
	);

	const now = new Date().toISOString();
	return rows.flatMap((result) =>
		result.results.flatMap((row) => {
			const oldValue = options.kind === 'read' ? row.is_read === 1 : row.is_starred === 1;
			if (oldValue === options.target) {
				return [];
			}
			const eventKey = `state:${row.id}:${options.kind}:${oldValue ? 1 : 0}->${options.target ? 1 : 0}:${options.eventType}:${options.clientFamily}:${now}:${crypto.randomUUID()}`;
			return [
				env.DB.prepare(
					`INSERT OR IGNORE INTO engagement_events
					 (id, event_key, item_id, feed_key, event_type, client_family, occurred_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				)
					.bind(crypto.randomUUID(), eventKey, row.id, row.feed_key, options.eventType, options.clientFamily, now),
			];
		}),
	);
}
