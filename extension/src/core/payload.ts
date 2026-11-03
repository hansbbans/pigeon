/**
 * The `POST /api/v1/saved` body and the size rules that keep a save from
 * failing because of its size. Contract:
 * docs/superpowers/plans/2026-11-03-read-it-later-03-core.md ("Content object").
 */

/** html (plus text) the Worker stores per item; over it the body is dropped (`contentTooLarge`). */
export const MAX_SAVED_HTML_BYTES = 900_000;
/** The Worker answers 413 above 2 000 000 bytes; keep headroom for headers and rounding. */
export const MAX_REQUEST_BYTES = 1_950_000;

export type MediaKind = 'text' | 'video';

/** Extraction output as the Worker accepts it. Absent fields leave stored values alone. */
export interface SavedContent {
	html?: string;
	/** Plain text of the extraction, used for search. html plus text share the 900 KB budget. */
	text?: string;
	title?: string;
	wordCount?: number;
	author?: string;
	published?: string;
	image?: string;
	site?: string;
	mediaKind?: MediaKind;
	durationSeconds?: number;
}

export interface SaveRequestBody {
	url: string;
	title?: string;
	content?: SavedContent;
}

/** What the page script hands back. `content` is absent when extraction failed. */
export interface PageExtraction {
	url: string;
	title?: string;
	content?: SavedContent;
	/** Why there is no content, for logs. */
	error?: string;
}

const encoder = new TextEncoder();

export function utf8Bytes(value: string): number {
	return encoder.encode(value).byteLength;
}

/** Cuts a string to at most `maxBytes` UTF-8 bytes without splitting a character. */
export function truncateUtf8(value: string, maxBytes: number): string {
	if (maxBytes <= 0) return '';
	if (value.length * 3 <= maxBytes) return value;
	const bytes = encoder.encode(value);
	if (bytes.byteLength <= maxBytes) return value;
	let end = maxBytes;
	// Step back over continuation bytes (10xxxxxx) to a character boundary.
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return new TextDecoder().decode(bytes.subarray(0, end));
}

export function requestBytes(body: SaveRequestBody): number {
	return utf8Bytes(JSON.stringify(body));
}

function cleanTitle(value: string | undefined): string | undefined {
	const collapsed = value?.replace(/\s+/g, ' ').trim();
	return collapsed ? collapsed : undefined;
}

/** A bare link: the Worker stores it as pending and another client extracts it later. */
export function linkOnlyRequest(url: string, title?: string): SaveRequestBody {
	const cleaned = cleanTitle(title);
	return cleaned ? { url, title: cleaned } : { url };
}

/**
 * Fits an extraction into the Worker's limits:
 * - text shrinks to whatever html leaves of the 900 KB budget;
 * - html over the budget (the page script normally trims first) is not sent:
 *   a text item then saves as a bare link, a video keeps its metadata;
 * - if JSON escaping still pushes the request over 2 MB, text goes, then content.
 * Returns null when nothing usable is left (a text item without html).
 */
export function fitContent(content: SavedContent): SavedContent | null {
	const fitted: SavedContent = { ...content };
	const htmlBytes = fitted.html ? utf8Bytes(fitted.html) : 0;
	if (htmlBytes > MAX_SAVED_HTML_BYTES) delete fitted.html;
	if (fitted.html !== undefined && !fitted.html.trim()) delete fitted.html;
	if (fitted.text !== undefined) {
		const budget = MAX_SAVED_HTML_BYTES - (fitted.html ? htmlBytes : 0);
		const text = fitted.text.trim() ? truncateUtf8(fitted.text, budget) : '';
		if (text) fitted.text = text;
		else delete fitted.text;
	}
	if (!fitted.html && fitted.mediaKind !== 'video') return null;
	return fitted;
}

/**
 * The requests to try, in order: the full save, then (if the Worker rejects
 * the content) the bare link. A save without content has one attempt.
 */
export function buildSaveAttempts(url: string, title: string | undefined, content: SavedContent | undefined): SaveRequestBody[] {
	const bare = linkOnlyRequest(url, cleanTitle(content?.title) ?? title);
	const fitted = content ? fitContent(content) : null;
	if (!fitted) return [bare];
	const full: SaveRequestBody = { ...linkOnlyRequest(url, title), content: fitted };
	if (requestBytes(full) > MAX_REQUEST_BYTES && full.content?.text) {
		const { text: _dropped, ...rest } = fitted;
		full.content = rest;
	}
	if (requestBytes(full) > MAX_REQUEST_BYTES) return [bare];
	return [full, bare];
}
