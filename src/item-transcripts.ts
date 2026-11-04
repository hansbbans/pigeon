/**
 * YouTube transcripts, stored on request (Read It Later step 5).
 *
 * Clients fetch a transcript themselves (iOS from the phone, the web through
 * the YouTube proxy in browser-reading-api.ts), then store it here so every
 * client can show it. The Worker never fetches or parses YouTube data for
 * storage: it validates the client's document and re-serializes it.
 *
 * Stored format, `item_transcripts.html` (the column holds this JSON document,
 * not HTML; the name predates the format and v16 is shared with other steps):
 *
 *   {"version":1,"language":"en",
 *    "segments":[{"start":4,"duration":2.5,"text":"This is a 3."}, ...],
 *    "chapters":[{"start":0,"title":"Introduction"}, ...]}
 *
 * - `version` is always 1. A future format gets a new number; readers skip
 *   versions they do not know.
 * - `language` (optional) is the caption track's BCP 47 code.
 * - `segments` (1..20 000) are sorted by `start`. `start` and the optional
 *   `duration` are seconds, rounded to milliseconds. `text` is plain text.
 * - `chapters` (optional, 0..500) are sorted by `start`; omitted when empty.
 *
 * `item_transcripts.text` holds the plain text (chapter titles and segment
 * text, one per line) for search. Contract: docs/superpowers/plans/2026-11-03-read-it-later-05-transcripts.md.
 */

import { truncateUtf8 } from './content-size';
import { hasStoredItemId, parseGoogleReaderItemRowid } from './item-identity';
import { toISO8601 } from './timestamps';
import type { Env } from './types';
import { extractYouTubeVideoId } from './youtube';

export const TRANSCRIPT_FORMAT_VERSION = 1;
/** The stored JSON; together with the plain text (never longer) it stays under the 900 KB body budget. */
export const MAX_TRANSCRIPT_JSON_BYTES = 450_000;
/** A request may carry extra whitespace or keys that the canonical form drops. */
export const MAX_TRANSCRIPT_REQUEST_BYTES = 1_000_000;
export const MAX_TRANSCRIPT_SEGMENTS = 20_000;
export const MAX_TRANSCRIPT_CHAPTERS = 500;
const MAX_SEGMENT_TEXT_LENGTH = 5_000;
const MAX_CHAPTER_TITLE_BYTES = 300;
/** A week of video: anything later is not a real timestamp. */
const MAX_SECONDS = 604_800;
const LANGUAGE_PATTERN = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,4}$/;

export interface TranscriptSegment {
	start: number;
	duration?: number;
	text: string;
}

export interface TranscriptChapter {
	start: number;
	title: string;
}

export interface TranscriptDocument {
	version: 1;
	language?: string;
	segments: TranscriptSegment[];
	chapters?: TranscriptChapter[];
}

export interface ParsedTranscript {
	document: TranscriptDocument;
	/** Canonical JSON, the stored form. */
	json: string;
	/** Plain text for search. */
	text: string;
	bytes: number;
}

class TranscriptError extends Error {
	constructor(message: string, readonly status: number, readonly code: string) {
		super(message);
	}
}

/**
 * Validates a client's transcript and returns its canonical form. Unknown keys
 * are dropped; out-of-order segments and chapters are sorted; blank segments
 * are dropped. Throws a 400 for a malformed document, a 413 when too large.
 */
export function parseTranscriptDocument(value: unknown): ParsedTranscript {
	if (!isRecord(value)) throw invalid('The transcript must be a JSON object');
	if (value.version !== TRANSCRIPT_FORMAT_VERSION) throw invalid('version must be 1');
	let language: string | undefined;
	if (value.language !== undefined && value.language !== null) {
		if (typeof value.language !== 'string' || !LANGUAGE_PATTERN.test(value.language.trim())) {
			throw invalid('language must be a BCP 47 language tag');
		}
		language = value.language.trim();
	}
	if (!Array.isArray(value.segments)) throw invalid('segments must be an array');
	if (value.segments.length > MAX_TRANSCRIPT_SEGMENTS) {
		throw new TranscriptError(`A transcript has at most ${MAX_TRANSCRIPT_SEGMENTS} segments`, 413, 'transcript_too_large');
	}
	const segments: TranscriptSegment[] = [];
	for (const [index, raw] of value.segments.entries()) {
		if (!isRecord(raw)) throw invalid(`segments[${index}] must be an object`);
		const start = seconds(raw.start, `segments[${index}].start`);
		if (typeof raw.text !== 'string') throw invalid(`segments[${index}].text must be a string`);
		const text = raw.text.replace(/\s+/g, ' ').trim();
		if (text.length > MAX_SEGMENT_TEXT_LENGTH) throw invalid(`segments[${index}].text is too long`);
		if (!text) continue;
		const duration = raw.duration === undefined || raw.duration === null ? undefined : seconds(raw.duration, `segments[${index}].duration`);
		segments.push(duration === undefined ? { start, text } : { start, duration, text });
	}
	if (segments.length === 0) throw invalid('A transcript needs at least one segment with text');
	segments.sort((a, b) => a.start - b.start);

	const chapters: TranscriptChapter[] = [];
	if (value.chapters !== undefined && value.chapters !== null) {
		if (!Array.isArray(value.chapters)) throw invalid('chapters must be an array');
		if (value.chapters.length > MAX_TRANSCRIPT_CHAPTERS) throw invalid(`A transcript has at most ${MAX_TRANSCRIPT_CHAPTERS} chapters`);
		for (const [index, raw] of value.chapters.entries()) {
			if (!isRecord(raw)) throw invalid(`chapters[${index}] must be an object`);
			const start = seconds(raw.start, `chapters[${index}].start`);
			if (typeof raw.title !== 'string') throw invalid(`chapters[${index}].title must be a string`);
			const title = truncateUtf8(raw.title.replace(/\s+/g, ' ').trim(), MAX_CHAPTER_TITLE_BYTES);
			if (title) chapters.push({ start, title });
		}
		chapters.sort((a, b) => a.start - b.start);
	}

	const document: TranscriptDocument = {
		version: TRANSCRIPT_FORMAT_VERSION,
		...(language ? { language } : {}),
		segments,
		...(chapters.length > 0 ? { chapters } : {}),
	};
	const json = JSON.stringify(document);
	const bytes = new TextEncoder().encode(json).byteLength;
	if (bytes > MAX_TRANSCRIPT_JSON_BYTES) {
		throw new TranscriptError(`A stored transcript is at most ${MAX_TRANSCRIPT_JSON_BYTES} bytes`, 413, 'transcript_too_large');
	}
	const text = [...chapters.map((chapter) => chapter.title), ...segments.map((segment) => segment.text)].join('\n');
	return { document, json, text, bytes };
}

interface TranscriptItemRow {
	id: string;
	media_kind: string | null;
	original_url: string | null;
}

/**
 * GET, PUT and POST /api/v1/items/:id/transcript (auth and schema checked by
 * the caller). :id is the item UUID or any Google Reader item id form.
 */
export async function handleItemTranscriptRequest(request: Request, env: Env, rawId: string): Promise<Response> {
	if (request.method !== 'GET' && request.method !== 'PUT' && request.method !== 'POST') {
		return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, PUT, POST' } });
	}
	try {
		const item = await findItem(env.DB, rawId);
		if (!item) throw new TranscriptError('Item not found', 404, 'item_not_found');
		if (request.method === 'GET') return await readTranscript(env, item.id);
		if (item.media_kind !== 'video' && !extractYouTubeVideoId(item.original_url)) {
			throw new TranscriptError('Transcripts are stored only for YouTube videos', 422, 'not_a_video');
		}
		return await storeTranscript(request, env, item.id);
	} catch (error) {
		if (error instanceof TranscriptError) return failure(error.message, error.status, error.code);
		console.error('[Transcripts] Request failed', error instanceof Error ? error.message : String(error));
		return failure('Could not handle the transcript', 503, 'transcript_unavailable');
	}
}

async function readTranscript(env: Env, itemId: string): Promise<Response> {
	const row = await env.DB.prepare('SELECT html, created_at FROM item_transcripts WHERE item_id = ?')
		.bind(itemId).first<{ html: string; created_at: string }>();
	if (!row) throw new TranscriptError('This item has no transcript', 404, 'transcript_not_found');
	// The stored JSON is canonical and bounded; splice it in without parsing it again.
	const body = `{"itemId":${JSON.stringify(itemId)},"updatedAt":${JSON.stringify(toISO8601(row.created_at))},"transcript":${row.html}}`;
	return new Response(body, { headers: jsonHeaders() });
}

async function storeTranscript(request: Request, env: Env, itemId: string): Promise<Response> {
	const parsed = parseTranscriptDocument(await readJsonBody(request));
	const language = parsed.document.language ?? null;
	// One batch: the sync event is written only when the stored document
	// changes, so a repeat upload adds no sync_changes row (see the sync
	// compaction notes). Clients learn of a new transcript from the article's
	// `hasTranscript` field; YouTube items carry small bodies.
	const [event] = await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO sync_changes (entity_type, entity_id)
			 SELECT 'article', ?
			 WHERE NOT EXISTS (SELECT 1 FROM item_transcripts WHERE item_id = ? AND html = ?)`,
		).bind(itemId, itemId, parsed.json),
		env.DB.prepare(
			`INSERT INTO item_transcripts (item_id, language, html, text) VALUES (?, ?, ?, ?)
			 ON CONFLICT(item_id) DO UPDATE SET
			   language = excluded.language, html = excluded.html, text = excluded.text, created_at = datetime('now')
			 WHERE item_transcripts.html IS NOT excluded.html`,
		).bind(itemId, language, parsed.json, parsed.text),
	]);
	return Response.json({
		itemId,
		updated: Number(event?.meta?.changes ?? 0) > 0,
		...(language ? { language } : {}),
		segmentCount: parsed.document.segments.length,
		chapterCount: parsed.document.chapters?.length ?? 0,
		bytes: parsed.bytes,
	}, { headers: jsonHeaders() });
}

async function findItem(db: D1Database, rawId: string): Promise<TranscriptItemRow | null> {
	let id: string;
	try {
		id = decodeURIComponent(rawId);
	} catch {
		return null;
	}
	if (hasStoredItemId(id)) {
		return db.prepare('SELECT id, media_kind, original_url FROM items WHERE id = ?').bind(id).first<TranscriptItemRow>();
	}
	const rowid = parseGoogleReaderItemRowid(id);
	if (rowid === null) return null;
	return db.prepare('SELECT id, media_kind, original_url FROM items WHERE rowid = ?').bind(rowid).first<TranscriptItemRow>();
}

async function readJsonBody(request: Request): Promise<unknown> {
	const declared = Number(request.headers.get('Content-Length') ?? '0');
	if (Number.isFinite(declared) && declared > MAX_TRANSCRIPT_REQUEST_BYTES) throw tooLargeRequest();
	// Count bytes as they arrive: a chunked request has no Content-Length to trust.
	const decoder = new TextDecoder();
	let text = '';
	let received = 0;
	const reader = request.body?.getReader();
	while (reader) {
		const { done, value } = await reader.read();
		if (done) break;
		received += value.byteLength;
		if (received > MAX_TRANSCRIPT_REQUEST_BYTES) {
			await reader.cancel().catch(() => undefined);
			throw tooLargeRequest();
		}
		text += decoder.decode(value, { stream: true });
	}
	text += decoder.decode();
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw invalid('Request body must be valid JSON');
	}
}

function seconds(value: unknown, name: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_SECONDS) {
		throw invalid(`${name} must be a number of seconds`);
	}
	return Math.round(value * 1000) / 1000;
}

function tooLargeRequest(): TranscriptError {
	return new TranscriptError(`Request body must be at most ${MAX_TRANSCRIPT_REQUEST_BYTES} bytes`, 413, 'transcript_too_large');
}

function invalid(message: string): TranscriptError {
	return new TranscriptError(message, 400, 'invalid_transcript');
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonHeaders(): Record<string, string> {
	return { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
}

function failure(error: string, status: number, code: string): Response {
	return Response.json({ error, code }, { status, headers: jsonHeaders() });
}
