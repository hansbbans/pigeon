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
 * - `segments` (1..8 000) are sorted by `start`. `start` and the optional
 *   `duration` are seconds, rounded to milliseconds. `text` is plain text,
 *   truncated to 4 000 UTF-8 bytes.
 * - `chapters` (optional, 0..300) are sorted by `start`; omitted when empty.
 *
 * `item_transcripts.text` holds the plain text (chapter titles and segment
 * text, one per line) for search; `content_sha256` the hex SHA-256 of the
 * stored JSON, so a repeat upload is detected without comparing the JSON.
 *
 * CPU: the Worker has 10 ms per request on the Free plan. Caps keep a
 * worst-case PUT (JSON parse, one linear validation pass, serialize, hash)
 * a few milliseconds; test/item-transcripts.test.ts times it. Contract: docs/superpowers/plans/2026-11-03-read-it-later-05-transcripts.md.
 */

import { boundedBytes, failure, jsonHeaders, PayloadTooLarge } from './browser-reading-api';
import { truncateUtf8 } from './content-size';
import { findItemByAnyId } from './item-identity';
import { toISO8601 } from './timestamps';
import type { Env } from './types';
import { extractYouTubeVideoId } from './youtube';

export const TRANSCRIPT_FORMAT_VERSION = 1;
/** The stored JSON. About three hours of grouped captions fit with room to spare. */
export const MAX_TRANSCRIPT_JSON_BYTES = 192_000;
/** A request may carry whitespace or keys that the canonical form drops. */
export const MAX_TRANSCRIPT_REQUEST_BYTES = 256_000;
export const MAX_TRANSCRIPT_SEGMENTS = 2_000;
export const MAX_TRANSCRIPT_CHAPTERS = 200;
export const MAX_SEGMENT_TEXT_BYTES = 4_000;
const MAX_CHAPTER_TITLE_BYTES = 300;
/** A week of video: anything later is not a real timestamp. */
const MAX_SECONDS = 604_800;
const REQUEST_DEADLINE_MS = 5_000;
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
	/** Hex SHA-256 of `json`. */
	sha256: string;
}

class TranscriptError extends Error {
	constructor(message: string, readonly status: number, readonly code: string) {
		super(message);
	}
}

/**
 * Validates a client's transcript and returns its canonical form. Unknown keys
 * are dropped, blank segments are dropped, overlong text is truncated, and
 * out-of-order segments and chapters are sorted (an already sorted list, the
 * normal case, is only scanned). Throws a 400 for a malformed document and a
 * 413 (transcript_too_large) for too many segments or chapters or too many bytes.
 */
export async function parseTranscriptDocument(value: unknown): Promise<ParsedTranscript> {
	if (!isRecord(value)) throw invalid('The transcript must be a JSON object');
	if (value.version !== TRANSCRIPT_FORMAT_VERSION) throw invalid('version must be 1');
	let language: string | undefined;
	if (value.language !== undefined && value.language !== null) {
		if (typeof value.language !== 'string' || value.language.length > 64 || !LANGUAGE_PATTERN.test(value.language.trim())) {
			throw invalid('language must be a BCP 47 language tag');
		}
		language = value.language.trim();
	}
	if (!Array.isArray(value.segments)) throw invalid('segments must be an array');
	if (value.segments.length > MAX_TRANSCRIPT_SEGMENTS) throw tooLarge(`A transcript has at most ${MAX_TRANSCRIPT_SEGMENTS} segments`);
	const segments: TranscriptSegment[] = [];
	let segmentsSorted = true;
	for (let index = 0; index < value.segments.length; index += 1) {
		const raw: unknown = value.segments[index];
		if (!isRecord(raw)) throw invalid(`segments[${index}] must be an object`);
		const start = seconds(raw.start, `segments[${index}].start`);
		if (typeof raw.text !== 'string') throw invalid(`segments[${index}].text must be a string`);
		const text = plainText(raw.text, MAX_SEGMENT_TEXT_BYTES);
		if (!text) continue;
		const duration = raw.duration === undefined || raw.duration === null ? undefined : seconds(raw.duration, `segments[${index}].duration`);
		if (segments.length > 0 && segments[segments.length - 1].start > start) segmentsSorted = false;
		segments.push(duration === undefined ? { start, text } : { start, duration, text });
	}
	if (segments.length === 0) throw invalid('A transcript needs at least one segment with text');
	if (!segmentsSorted) segments.sort((a, b) => a.start - b.start);

	const chapters: TranscriptChapter[] = [];
	if (value.chapters !== undefined && value.chapters !== null) {
		if (!Array.isArray(value.chapters)) throw invalid('chapters must be an array');
		if (value.chapters.length > MAX_TRANSCRIPT_CHAPTERS) throw tooLarge(`A transcript has at most ${MAX_TRANSCRIPT_CHAPTERS} chapters`);
		let chaptersSorted = true;
		for (let index = 0; index < value.chapters.length; index += 1) {
			const raw: unknown = value.chapters[index];
			if (!isRecord(raw)) throw invalid(`chapters[${index}] must be an object`);
			const start = seconds(raw.start, `chapters[${index}].start`);
			if (typeof raw.title !== 'string') throw invalid(`chapters[${index}].title must be a string`);
			const title = plainText(raw.title, MAX_CHAPTER_TITLE_BYTES);
			if (!title) continue;
			if (chapters.length > 0 && chapters[chapters.length - 1].start > start) chaptersSorted = false;
			chapters.push({ start, title });
		}
		if (!chaptersSorted) chapters.sort((a, b) => a.start - b.start);
	}

	const document: TranscriptDocument = {
		version: TRANSCRIPT_FORMAT_VERSION,
		...(language ? { language } : {}),
		segments,
		...(chapters.length > 0 ? { chapters } : {}),
	};
	const json = JSON.stringify(document);
	// UTF-8 is never shorter than UTF-16 code units, so a long string is over without encoding it.
	if (json.length > MAX_TRANSCRIPT_JSON_BYTES) throw tooLarge(`A stored transcript is at most ${MAX_TRANSCRIPT_JSON_BYTES} bytes`);
	const encoded = new TextEncoder().encode(json);
	if (encoded.byteLength > MAX_TRANSCRIPT_JSON_BYTES) throw tooLarge(`A stored transcript is at most ${MAX_TRANSCRIPT_JSON_BYTES} bytes`);
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoded));
	const sha256 = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
	const text = [...chapters.map((chapter) => chapter.title), ...segments.map((segment) => segment.text)].join('\n');
	return { document, json, text, bytes: encoded.byteLength, sha256 };
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
		const item = await findItemByAnyId<TranscriptItemRow>(env.DB, rawId, 'id, media_kind, original_url');
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
	const parsed = await parseTranscriptDocument(await readJsonBody(request));
	const language = parsed.document.language ?? null;
	// One batch, compared by hash: the sync event is written only when the
	// stored document changes, so a repeat upload adds no sync_changes row (see
	// the sync compaction notes). Clients learn of a new transcript from the
	// article's `hasTranscript` field; YouTube items carry small bodies.
	const [event] = await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO sync_changes (entity_type, entity_id)
			 SELECT 'article', ?
			 WHERE NOT EXISTS (SELECT 1 FROM item_transcripts WHERE item_id = ? AND content_sha256 = ?)`,
		).bind(itemId, itemId, parsed.sha256),
		env.DB.prepare(
			`INSERT INTO item_transcripts (item_id, language, html, text, content_sha256) VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(item_id) DO UPDATE SET
			   language = excluded.language, html = excluded.html, text = excluded.text,
			   content_sha256 = excluded.content_sha256, created_at = datetime('now')
			 WHERE item_transcripts.content_sha256 IS NOT excluded.content_sha256`,
		).bind(itemId, language, parsed.json, parsed.text, parsed.sha256),
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

async function readJsonBody(request: Request): Promise<unknown> {
	let bytes: Uint8Array;
	try {
		bytes = await boundedBytes(request, MAX_TRANSCRIPT_REQUEST_BYTES, AbortSignal.timeout(REQUEST_DEADLINE_MS));
	} catch (error) {
		if (error instanceof PayloadTooLarge) throw tooLarge(`Request body must be at most ${MAX_TRANSCRIPT_REQUEST_BYTES} bytes`);
		throw invalid('Could not read the request body');
	}
	try {
		return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
	} catch {
		throw invalid('Request body must be valid JSON');
	}
}

/** Whitespace collapsed and trimmed, then cut to `maxBytes` of UTF-8 on a character boundary. */
function plainText(value: string, maxBytes: number): string {
	// Collapsing never lengthens text, and UTF-8 needs at least one byte per code unit:
	// cutting the raw string first bounds the work for absurd inputs.
	const collapsed = value.slice(0, maxBytes * 2).replace(/[\uD800-\uDBFF]$/, '').replace(/\s+/g, ' ').trim();
	return collapsed.length * 3 <= maxBytes ? collapsed : truncateUtf8(collapsed, maxBytes).trim();
}

function seconds(value: unknown, name: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_SECONDS) {
		throw invalid(`${name} must be a number of seconds`);
	}
	return Math.round(value * 1000) / 1000;
}

function tooLarge(message: string): TranscriptError {
	return new TranscriptError(message, 413, 'transcript_too_large');
}

function invalid(message: string): TranscriptError {
	return new TranscriptError(message, 400, 'invalid_transcript');
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
