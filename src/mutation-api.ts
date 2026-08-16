import { parseGoogleReaderItemRowid } from './item-identity';
import type { Env } from './types';

const MAX_MUTATIONS_PER_REQUEST = 100;
const MAX_TOTAL_ITEM_IDS = 200;
const MAX_TITLE_LENGTH = 200;
const MAX_FOLDER_LENGTH = 80;

type MutationKind =
	| 'set_read'
	| 'set_starred'
	| 'set_read_batch'
	| 'feedback'
	| 'rename_feed'
	| 'move_feed'
	| 'unsubscribe_feed';

interface ClientMutation {
	id: string;
	kind: MutationKind;
	itemIds: string[];
	value?: boolean;
	feedback?: 'more_like_this' | 'not_interested';
	feedId?: string;
	title?: string;
	folders?: string[];
	scope?: 'single' | 'all' | 'above' | 'below' | 'older';
}

interface ItemTarget {
	rowid: number;
	id: string;
	feed_key: string;
}

interface FeedTarget {
	rowid: number;
	feed_key: string;
}

interface MutationReceiptRow {
	result_json: string;
}

export async function handleMutationBatch(request: Request, env: Env): Promise<Response> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: 'Request body must be valid JSON' }, { status: 400 });
	}

	let mutations: ClientMutation[];
	try {
		mutations = validateMutationBatch(body);
	} catch (error) {
		return Response.json({ error: errorMessage(error) }, { status: 400 });
	}

	const results = [];
	for (const mutation of mutations) {
		const existing = await receiptFor(env.DB, mutation.id);
		if (existing) {
			results.push({ mutationId: mutation.id, status: 'already_applied', appliedAt: existing.appliedAt });
			continue;
		}

		try {
			const appliedAt = new Date().toISOString();
			const resultJSON = JSON.stringify({ mutationId: mutation.id, status: 'applied', appliedAt });
			const statements = [
				env.DB.prepare(
					`INSERT INTO mutation_receipts
					 (account_id, mutation_id, mutation_kind, applied_at, result_json)
					 VALUES ('default', ?, ?, ?, ?)`,
				).bind(mutation.id, mutation.kind, appliedAt, resultJSON),
				...(await mutationStatements(env, mutation, appliedAt)),
			];
			await env.DB.batch(statements);
			results.push({ mutationId: mutation.id, status: 'applied', appliedAt });
		} catch (error) {
			// A concurrent retry may have committed the same idempotency key first.
			const racedReceipt = await receiptFor(env.DB, mutation.id);
			if (racedReceipt) {
				results.push({ mutationId: mutation.id, status: 'already_applied', appliedAt: racedReceipt.appliedAt });
			} else {
				results.push({ mutationId: mutation.id, status: 'failed', error: errorMessage(error).slice(0, 240) });
			}
		}
	}

	return Response.json({ results });
}

function validateMutationBatch(value: unknown): ClientMutation[] {
	if (!isRecord(value) || !Array.isArray(value.mutations)) {
		throw new Error('Request body must contain a mutations array');
	}
	if (value.mutations.length === 0 || value.mutations.length > MAX_MUTATIONS_PER_REQUEST) {
		throw new Error(`mutations must contain between 1 and ${MAX_MUTATIONS_PER_REQUEST} entries`);
	}

	let totalItemIDs = 0;
	const seenIDs = new Set<string>();
	const mutations = value.mutations.map((raw, index) => {
		if (!isRecord(raw)) throw new Error(`mutations[${index}] must be an object`);
		const id = requiredString(raw.id, `mutations[${index}].id`, 200);
		if (seenIDs.has(id)) throw new Error(`mutations[${index}].id is duplicated`);
		seenIDs.add(id);
		const kind = requiredString(raw.kind, `mutations[${index}].kind`, 40) as MutationKind;
		if (!isMutationKind(kind)) throw new Error(`mutations[${index}].kind is invalid`);
		const itemIds = raw.itemIds === undefined
			? []
			: uniqueStrings(raw.itemIds, `mutations[${index}].itemIds`, 200);
		totalItemIDs += itemIds.length;

		const mutation: ClientMutation = { id, kind, itemIds };
		if (kind === 'set_read' || kind === 'set_starred' || kind === 'set_read_batch') {
			if (typeof raw.value !== 'boolean') throw new Error(`mutations[${index}].value must be boolean`);
			if (itemIds.length === 0) throw new Error(`mutations[${index}].itemIds must not be empty`);
			mutation.value = raw.value;
			mutation.scope = optionalScope(raw.scope);
		}
		if (kind === 'set_read' || kind === 'set_starred') {
			if (itemIds.length !== 1) throw new Error(`mutations[${index}].itemIds must contain one item`);
		}
		if (kind === 'feedback') {
			if (itemIds.length !== 1) throw new Error(`mutations[${index}].itemIds must contain one item`);
			if (raw.feedback !== 'more_like_this' && raw.feedback !== 'not_interested') {
				throw new Error(`mutations[${index}].feedback is invalid`);
			}
			mutation.feedback = raw.feedback;
		}
		if (kind === 'rename_feed' || kind === 'move_feed' || kind === 'unsubscribe_feed') {
			mutation.feedId = requiredString(raw.feedId, `mutations[${index}].feedId`, 300);
		}
		if (kind === 'rename_feed') {
			mutation.title = requiredString(raw.title, `mutations[${index}].title`, MAX_TITLE_LENGTH).trim();
			if (!mutation.title) throw new Error(`mutations[${index}].title must not be empty`);
		}
		if (kind === 'move_feed') {
			mutation.folders = [
				...new Set(
					uniqueStrings(raw.folders ?? [], `mutations[${index}].folders`, MAX_FOLDER_LENGTH)
						.map((folder) => folder.trim())
						.filter(Boolean),
				),
			];
		}
		return mutation;
	});
	if (totalItemIDs > MAX_TOTAL_ITEM_IDS) {
		throw new Error(`mutations may reference at most ${MAX_TOTAL_ITEM_IDS} total items`);
	}
	return mutations;
}

async function mutationStatements(
	env: Env,
	mutation: ClientMutation,
	appliedAt: string,
): Promise<D1PreparedStatement[]> {
	switch (mutation.kind) {
	case 'set_read':
	case 'set_read_batch':
		return statusMutationStatements(env, mutation, 'is_read', mutation.value === true, appliedAt);
	case 'set_starred':
		return statusMutationStatements(env, mutation, 'is_starred', mutation.value === true, appliedAt);
	case 'feedback':
		return feedbackMutationStatements(env, mutation, appliedAt);
	case 'rename_feed': {
		const feed = await resolveFeed(env.DB, mutation.feedId as string);
		return [env.DB.prepare('UPDATE feeds SET custom_title = ? WHERE feed_key = ?').bind(mutation.title, feed.feed_key)];
	}
	case 'move_feed': {
		const feed = await resolveFeed(env.DB, mutation.feedId as string);
		return [
			env.DB.prepare('DELETE FROM feed_tags WHERE feed_key = ?').bind(feed.feed_key),
			...(mutation.folders ?? []).map((folder) =>
				env.DB.prepare('INSERT INTO feed_tags (feed_key, label) VALUES (?, ?)').bind(feed.feed_key, folder),
			),
			env.DB.prepare('UPDATE feeds SET category = ? WHERE feed_key = ?')
				.bind(mutation.folders?.[0] ?? null, feed.feed_key),
		];
	}
	case 'unsubscribe_feed': {
		const feed = await resolveFeed(env.DB, mutation.feedId as string);
		return [env.DB.prepare('UPDATE feeds SET is_active = 0 WHERE feed_key = ?').bind(feed.feed_key)];
	}
	}
}

async function statusMutationStatements(
	env: Env,
	mutation: ClientMutation,
	column: 'is_read' | 'is_starred',
	value: boolean,
	appliedAt: string,
): Promise<D1PreparedStatement[]> {
	const items = await resolveItems(env.DB, mutation.itemIds);
	const rowids = items.map((item) => item.rowid);
	const placeholders = rowids.map(() => '?').join(',');
	const eventType = column === 'is_read'
		? (value ? (mutation.scope === 'single' || mutation.kind === 'set_read' ? 'read' : 'bulk_mark_all_read') : 'unread')
		: (value ? 'star' : 'unstar');
	return [
		env.DB.prepare(`UPDATE items SET ${column} = ? WHERE rowid IN (${placeholders})`)
			.bind(value ? 1 : 0, ...rowids),
		env.DB.prepare(
			`UPDATE item_statuses SET mutation_id = ?, updated_at = ?
			 WHERE item_id IN (SELECT id FROM items WHERE rowid IN (${placeholders}))`,
		).bind(mutation.id, appliedAt, ...rowids),
		...items.map((item) =>
			env.DB.prepare(
				`INSERT OR IGNORE INTO engagement_events
				 (id, event_key, item_id, feed_key, event_type, client_family, occurred_at)
				 VALUES (?, ?, ?, ?, ?, 'pigeon', ?)`,
			).bind(
				crypto.randomUUID(),
				`mutation:${mutation.id}:${item.id}:${eventType}`,
				item.id,
				item.feed_key,
				eventType,
				appliedAt,
			),
		),
	];
}

async function feedbackMutationStatements(
	env: Env,
	mutation: ClientMutation,
	appliedAt: string,
): Promise<D1PreparedStatement[]> {
	const [item] = await resolveItems(env.DB, mutation.itemIds);
	return [
		env.DB.prepare(
			`INSERT INTO engagement_events
			 (id, event_key, item_id, feed_key, event_type, client_family, occurred_at)
			 VALUES (?, ?, ?, ?, ?, 'pigeon', ?)`,
		).bind(
			crypto.randomUUID(),
			`mutation:${mutation.id}:feedback`,
			item.id,
			item.feed_key,
			mutation.feedback,
			appliedAt,
		),
	];
}

async function resolveItems(db: D1Database, itemIDs: string[]): Promise<ItemTarget[]> {
	const items: ItemTarget[] = [];
	for (const itemID of itemIDs) {
		const rowid = parseGoogleReaderItemRowid(itemID);
		const item = rowid === null
			? await db.prepare('SELECT rowid, id, feed_key FROM items WHERE id = ?').bind(itemID).first<ItemTarget>()
			: await db.prepare('SELECT rowid, id, feed_key FROM items WHERE rowid = ?').bind(rowid).first<ItemTarget>();
		if (!item) throw new Error(`Unknown item ${itemID}`);
		items.push(item);
	}
	return items;
}

async function resolveFeed(db: D1Database, feedID: string): Promise<FeedTarget> {
	const rowidMatch = feedID.match(/^feed\/(\d+)$/);
	const feed = rowidMatch
		? await db.prepare('SELECT rowid, feed_key FROM feeds WHERE rowid = ?').bind(Number(rowidMatch[1])).first<FeedTarget>()
		: await db.prepare('SELECT rowid, feed_key FROM feeds WHERE feed_key = ?').bind(feedID).first<FeedTarget>();
	if (!feed) throw new Error(`Unknown feed ${feedID}`);
	return feed;
}

async function receiptFor(db: D1Database, mutationID: string): Promise<{ appliedAt: string } | null> {
	const receipt = await db.prepare(
		`SELECT result_json FROM mutation_receipts
		 WHERE account_id = 'default' AND mutation_id = ?`,
	)
		.bind(mutationID)
		.first<MutationReceiptRow>();
	if (!receipt) return null;
	try {
		const parsed = JSON.parse(receipt.result_json) as { appliedAt?: unknown };
		return { appliedAt: typeof parsed.appliedAt === 'string' ? parsed.appliedAt : '' };
	} catch {
		return { appliedAt: '' };
	}
}

function optionalScope(value: unknown): ClientMutation['scope'] {
	if (value === undefined) return 'single';
	if (value === 'single' || value === 'all' || value === 'above' || value === 'below' || value === 'older') {
		return value;
	}
	throw new Error('mutation scope is invalid');
}

function uniqueStrings(value: unknown, name: string, maxLength: number): string[] {
	if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
	const strings = value.map((entry) => requiredString(entry, name, maxLength));
	return [...new Set(strings)];
}

function requiredString(value: unknown, name: string, maxLength: number): string {
	if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
		throw new Error(`${name} is invalid`);
	}
	return value;
}

function isMutationKind(value: string): value is MutationKind {
	return [
		'set_read',
		'set_starred',
		'set_read_batch',
		'feedback',
		'rename_feed',
		'move_feed',
		'unsubscribe_feed',
	].includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
