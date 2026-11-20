import {
	ARTICLE_METADATA_SQL,
	articlePayload,
	encodeCursor,
	loadFeedPayloads,
	type ArticleSyncRow,
} from './sync-api';
import type { Env } from './types';

/**
 * The unread-first library listing that rebuilds an app's offline library.
 *
 * Replaying the whole change log to rebuild meant thousands of requests and
 * hundreds of megabytes of bodies the app then pruned. The listing returns
 * the current state instead: feeds, then metadata (no bodies) for the
 * articles an offline reader keeps: unread, starred, Read It Later, and
 * recently read. Bodies come from `POST /api/v1/library/articles`.
 *
 * The first page pins the change log's position before reading any rows, and
 * every page reports it as an `/api/v1/sync` cursor. Syncing from there
 * re-delivers anything that changed while the listing ran, so pages may be
 * taken minutes apart. Pages are keyed by item rowid, so a continuation
 * stays valid while new items arrive.
 */
export const LIBRARY_DEFAULT_LIMIT = 200;
export const LIBRARY_MAX_LIMIT = 500;
export const LIBRARY_RECENT_READ_DAYS = 7;

const CONTINUATION_PREFIX = 'l1:';

interface ListingPosition {
	snapshotSequence: number;
	afterRowid: number;
}

export async function handleLibraryListing(request: Request, env: Env, now: Date = new Date()): Promise<Response> {
	const url = new URL(request.url);
	let position: ListingPosition | null;
	try {
		position = decodeContinuation(url.searchParams.get('continuation'));
	} catch (error) {
		return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
	}
	const limit = parseLimit(url.searchParams.get('limit'));
	const isFirstPage = position === null;
	const snapshotSequence = position?.snapshotSequence ?? await currentSequence(env);
	const afterRowid = position?.afterRowid ?? 0;
	const recentCutoff = new Date(now.getTime() - LIBRARY_RECENT_READ_DAYS * 24 * 60 * 60 * 1000).toISOString();

	const [feeds, { results }] = await Promise.all([
		isFirstPage ? loadFeedPayloads(env, 'all') : Promise.resolve([]),
		env.DB.prepare(
			`${ARTICLE_METADATA_SQL}
			 WHERE i.rowid > ?
			   AND (i.is_read = 0 OR i.is_starred = 1 OR f.source_type = 'saved' OR i.received_at >= ?)
			 ORDER BY i.rowid ASC
			 LIMIT ?`,
		)
			.bind(afterRowid, recentCutoff, limit + 1)
			.all<ArticleSyncRow>(),
	]);

	const rows = results.slice(0, limit);
	const lastRowid = rows.at(-1)?.rowid;
	const continuation = results.length > limit && lastRowid !== undefined
		? encodeContinuation({ snapshotSequence, afterRowid: lastRowid })
		: null;

	return Response.json({
		snapshotCursor: encodeCursor(snapshotSequence),
		continuation,
		feeds,
		articles: rows.map((row) => articlePayload(row, { includeBody: false })),
	});
}

async function currentSequence(env: Env): Promise<number> {
	const row = await env.DB.prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM sync_changes')
		.first<{ sequence: number }>();
	return row?.sequence ?? 0;
}

function encodeContinuation(position: ListingPosition): string {
	return `${CONTINUATION_PREFIX}${position.snapshotSequence}:${position.afterRowid}`;
}

function decodeContinuation(value: string | null): ListingPosition | null {
	if (value === null || value === '') return null;
	const match = /^l1:(\d+):(\d+)$/.exec(value);
	if (!match) throw new Error('Invalid library continuation');
	const snapshotSequence = Number(match[1]);
	const afterRowid = Number(match[2]);
	if (!Number.isSafeInteger(snapshotSequence) || !Number.isSafeInteger(afterRowid)) {
		throw new Error('Invalid library continuation');
	}
	return { snapshotSequence, afterRowid };
}

function parseLimit(value: string | null): number {
	const parsed = Number.parseInt(value ?? String(LIBRARY_DEFAULT_LIMIT), 10);
	if (!Number.isFinite(parsed)) return LIBRARY_DEFAULT_LIMIT;
	return Math.min(Math.max(parsed, 1), LIBRARY_MAX_LIMIT);
}
