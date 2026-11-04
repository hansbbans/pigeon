/**
 * Runs inside the tab (injected on demand under activeTab). Defuddle reads the
 * live, rendered page, so mobile CSS, hidden elements and loaded images count.
 * It cleans a clone of the document; on the live page it only normalizes
 * `srcSet` casing and swaps lazy-image placeholders for their <noscript>
 * sources (as in Obsidian Web Clipper, which also passes the live document).
 *
 * Takes the document and the Defuddle class as arguments so tests can run it
 * under jsdom.
 */

import { MAX_SAVED_HTML_BYTES, utf8Bytes, type PageExtraction, type SavedContent } from '../core/payload';
import { parseIsoDuration, youtubeVideoId } from '../core/youtube';

interface DefuddleResult {
	content?: string;
	title?: string;
	author?: string;
	published?: string;
	image?: string;
	site?: string;
	wordCount?: number;
	schemaOrgData?: unknown;
}

interface DefuddleInstance {
	parse(): DefuddleResult;
	/** Private in Defuddle 0.19: what parse() returns when extraction failed (the whole body). */
	_fallbackResponse?: (...args: unknown[]) => DefuddleResult;
	_parseErrors?: Set<unknown>;
}

export interface DefuddleConstructor {
	new (doc: Document, options?: { url?: string }): DefuddleInstance;
}

/** html plus text must fit the Worker's 900 KB body budget; keep a little headroom. */
export const EXTRACTION_BUDGET_BYTES = MAX_SAVED_HTML_BYTES - 10_000;
const MIN_TEXT_CHARS = 80;
const TRIM_NOTICE = '<p><em>Pigeon kept the first part of this page; the whole page was too large to store. Open the original for the rest.</em></p>';

export function extractPage(doc: Document, Defuddle: DefuddleConstructor, url = doc.location.href): PageExtraction {
	const pageTitle = doc.title?.trim() || undefined;
	try {
		const videoId = youtubeVideoId(url);
		const content = videoId ? extractYouTube(doc, Defuddle, url, videoId) : extractArticle(doc, Defuddle, url);
		if (!content) return { url, title: pageTitle, error: 'No readable content found' };
		return { url, title: pageTitle, content };
	} catch (error) {
		return { url, title: pageTitle, error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Defuddle catches its own errors and then returns the whole page body; that
 * counts as a failure. Errors in optional steps (a schema.org retry, the
 * hidden-content probe) leave a good result, which is kept. Bumping Defuddle:
 * check that `_fallbackResponse` still exists (test/extract.test.ts does).
 */
function runDefuddle(doc: Document, Defuddle: DefuddleConstructor, url: string): DefuddleResult | null {
	const defuddle = new Defuddle(doc, { url });
	let usedFallback = false;
	const fallback = defuddle._fallbackResponse;
	if (typeof fallback === 'function') {
		defuddle._fallbackResponse = (...args: unknown[]) => {
			usedFallback = true;
			return fallback.apply(defuddle, args);
		};
	}
	const result = defuddle.parse();
	if (typeof fallback === 'function' ? usedFallback : (defuddle._parseErrors?.size ?? 0) > 0) return null;
	return result ?? null;
}

function extractArticle(doc: Document, Defuddle: DefuddleConstructor, url: string): SavedContent | null {
	const result = runDefuddle(doc, Defuddle, url);
	if (!result || typeof result.content !== 'string') return null;
	const fragment = parseFragment(doc, result.content);
	const text = plainText(fragment);
	if (text.length < MIN_TEXT_CHARS && !fragment.content.querySelector('img, picture, video')) return null;
	const fitted = fitToBudget(doc, fragment);
	const content: SavedContent = { html: fitted.html, text: fitted.text, mediaKind: 'text' };
	assignMetadata(content, result, url);
	return content;
}

/**
 * YouTube: no article text. Defuddle's YouTube extractor (parse(), never
 * parseAsync(), so no transcript fetch) gives title, channel, thumbnail and
 * the description; the duration comes from schema.org or the player.
 */
function extractYouTube(doc: Document, Defuddle: DefuddleConstructor, url: string, videoId: string): SavedContent {
	// Read before parse(): ld+json is the duration's best source.
	const durationFromPage = durationFromStructuredData(doc, videoId);
	let result: DefuddleResult | null = null;
	try {
		result = runDefuddle(doc, Defuddle, url);
	} catch {
		result = null;
	}
	const meta = (selector: string) => doc.querySelector(selector)?.getAttribute('content')?.trim() || undefined;
	// YouTube leaves og:* (and Defuddle's title, image and date, which fall back to them)
	// from the first page loaded when you navigate inside the site; trust them only for this video.
	const fresh = (meta('meta[property="og:url"]') ?? '').includes(videoId) || durationFromPage !== null;
	const content: SavedContent = { mediaKind: 'video' };
	if (result?.content) {
		const fragment = parseFragment(doc, result.content);
		// The embed is Pigeon's own player's job; keep the description.
		for (const frame of Array.from(fragment.content.querySelectorAll('iframe'))) frame.remove();
		const text = plainText(fragment);
		if (text) {
			const fitted = fitToBudget(doc, fragment);
			content.html = fitted.html;
			content.text = fitted.text;
		}
	}
	const title = (fresh ? result?.title?.trim() || meta('meta[property="og:title"]') : undefined) || doc.title;
	content.title = title.replace(/^\(\d+\)\s+/, '').replace(/\s+-\s+YouTube\s*$/i, '').trim() || undefined;
	const channel = result?.author?.trim() || meta('[itemprop="author"] [itemprop="name"]') || undefined;
	if (channel) {
		content.author = channel;
		content.site = channel;
	} else {
		content.site = 'YouTube';
	}
	const freshImage = fresh ? absoluteHttpUrl(result?.image || meta('meta[property="og:image"]'), url) : undefined;
	content.image = freshImage ?? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
	if (fresh && result?.published) content.published = result.published;
	const duration = durationFromPage ?? durationFromSchema(result?.schemaOrgData, videoId) ?? durationFromPlayer(doc);
	if (duration !== null) content.durationSeconds = duration;
	return content;
}

function assignMetadata(content: SavedContent, result: DefuddleResult, url: string): void {
	const title = result.title?.trim();
	if (title) content.title = title;
	const author = result.author?.trim();
	if (author) content.author = author;
	const site = result.site?.trim();
	if (site) content.site = site;
	const published = result.published?.trim();
	if (published) content.published = published;
	const image = absoluteHttpUrl(result.image, url);
	if (image) content.image = image;
	if (typeof result.wordCount === 'number' && Number.isFinite(result.wordCount) && result.wordCount > 0) {
		content.wordCount = Math.round(result.wordCount);
	}
}

function parseFragment(doc: Document, html: string): HTMLTemplateElement {
	// A template's content is inert: no image loads, no scripts.
	const template = doc.createElement('template');
	template.innerHTML = html;
	return template;
}

const BLOCK_TAGS = new Set([
	'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'details', 'div', 'dl', 'dt', 'figcaption', 'figure', 'footer',
	'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary',
	'table', 'td', 'th', 'tr', 'ul',
]);
/** Elements whose text is not escaped when serialized; never cut inside them. */
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext']);

/** Text with a space at block boundaries, so words in adjacent paragraphs stay apart. */
function textOf(node: Node): string {
	if (node.nodeType === 3) return node.nodeValue ?? '';
	if (node.nodeType !== 1 && node.nodeType !== 11) return '';
	const element = node as Element;
	const tag = node.nodeType === 1 ? element.localName : '';
	if (RAW_TEXT_TAGS.has(tag) && tag !== 'textarea') return '';
	let text = '';
	for (const child of Array.from(node.childNodes)) text += textOf(child);
	return BLOCK_TAGS.has(tag) ? ` ${text} ` : text;
}

function collapse(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

function plainText(template: HTMLTemplateElement): string {
	return collapse(textOf(template.content));
}

function escapeText(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/ /g, '&nbsp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The node's HTML serialization (as innerHTML would write it). */
function markupOf(node: Node): string {
	switch (node.nodeType) {
		case 1:
			return (node as Element).outerHTML;
		case 3: {
			const parent = node.parentNode?.nodeType === 1 ? (node.parentNode as Element).localName : '';
			return RAW_TEXT_TAGS.has(parent) ? node.nodeValue ?? '' : escapeText(node.nodeValue ?? '');
		}
		case 8:
			return `<!--${node.nodeValue ?? ''}-->`;
		default:
			return '';
	}
}

/**
 * Serializes the leading children whose html plus text fit `budget`. A child
 * that straddles the limit is entered and cut inside, so the result ends on
 * an element boundary and stays well formed. Measuring from the front means
 * the dropped tail is never serialized, and the page's DOM is not changed.
 */
function serializeWithin(nodes: ArrayLike<ChildNode>, budget: number): { html: string; text: string } {
	let html = '';
	let text = '';
	let used = 0;
	for (const node of Array.from(nodes)) {
		const markup = markupOf(node);
		const nodeText = textOf(node);
		const weight = utf8Bytes(markup) + utf8Bytes(nodeText);
		if (used + weight <= budget) {
			html += markup;
			text += nodeText;
			used += weight;
			continue;
		}
		if (node.nodeType === 1 && node.childNodes.length > 0 && !RAW_TEXT_TAGS.has((node as Element).localName)) {
			const element = node as Element;
			const shell = (element.cloneNode(false) as Element).outerHTML;
			const close = `</${element.localName}>`;
			const room = budget - used - utf8Bytes(shell);
			if (shell.endsWith(close) && room > 1024) {
				const inner = serializeWithin(element.childNodes, room);
				html += shell.slice(0, shell.length - close.length) + inner.html + close;
				const wrapped = BLOCK_TAGS.has(element.localName) ? ` ${inner.text} ` : inner.text;
				text += wrapped;
			}
		}
		break;
	}
	return { html, text };
}

/**
 * Keeps html plus text under the budget: first drops inline data: images,
 * then keeps the beginning of the article and adds a note that it was cut.
 */
export function fitToBudget(doc: Document, template: HTMLTemplateElement, budget = EXTRACTION_BUDGET_BYTES): { html: string; text: string; trimmed: boolean } {
	const whole = () => ({ html: template.innerHTML, text: plainText(template), trimmed: false });
	let result = whole();
	if (utf8Bytes(result.html) + utf8Bytes(result.text) <= budget) return result;
	for (const media of Array.from(template.content.querySelectorAll('[src^="data:"], [srcset*="data:"]'))) {
		if ((media.getAttribute('src')?.length ?? 0) > 1024 || (media.getAttribute('srcset')?.length ?? 0) > 1024) media.remove();
	}
	result = whole();
	if (utf8Bytes(result.html) + utf8Bytes(result.text) <= budget) return result;
	const notice = parseFragment(doc, TRIM_NOTICE);
	const noticeText = plainText(notice);
	const kept = serializeWithin(template.content.childNodes, budget - utf8Bytes(TRIM_NOTICE) - utf8Bytes(noticeText) - 2);
	return { html: kept.html + TRIM_NOTICE, text: collapse(`${kept.text} ${noticeText}`), trimmed: true };
}

function absoluteHttpUrl(value: string | undefined | null, base: string): string | undefined {
	if (!value) return undefined;
	try {
		const url = new URL(value.trim(), base);
		return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
	} catch {
		return undefined;
	}
}

function durationFromStructuredData(doc: Document, videoId: string): number | null {
	for (const script of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
		try {
			const duration = durationFromSchema(JSON.parse(script.textContent ?? ''), videoId);
			if (duration !== null) return duration;
		} catch {
			// Invalid JSON-LD; try the next block.
		}
	}
	// Microdata goes stale after YouTube's in-page navigation; trust it only for this video.
	const microdataId = doc.querySelector('meta[itemprop="videoId"]')?.getAttribute('content')
		?? doc.querySelector('link[itemprop="url"]')?.getAttribute('href');
	if (!microdataId?.includes(videoId)) return null;
	return parseIsoDuration(doc.querySelector('meta[itemprop="duration"]')?.getAttribute('content'));
}

/** Finds a VideoObject for this video (schema.org data can be stale after YouTube's in-page navigation). */
export function durationFromSchema(data: unknown, videoId: string): number | null {
	const stack: unknown[] = [data];
	let visited = 0;
	while (stack.length > 0 && visited++ < 500) {
		const value = stack.pop();
		if (Array.isArray(value)) {
			stack.push(...value);
			continue;
		}
		if (!value || typeof value !== 'object') continue;
		const record = value as Record<string, unknown>;
		const type = record['@type'];
		if (type === 'VideoObject' || (Array.isArray(type) && type.includes('VideoObject'))) {
			const ids = [record['@id'], record.url, record.embedUrl].filter((id): id is string => typeof id === 'string');
			const matches = ids.length === 0 || ids.some((id) => id.includes(videoId));
			const duration = parseIsoDuration(record.duration);
			if (matches && duration !== null) return duration;
		}
		if (Array.isArray(record['@graph'])) stack.push(...record['@graph']);
	}
	return null;
}

/** The player's own duration, unless an ad is playing in it. */
function durationFromPlayer(doc: Document): number | null {
	if (doc.querySelector('.ad-showing, .ad-interrupting')) return null;
	const video = doc.querySelector('video');
	const duration = video?.duration;
	return typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null;
}
