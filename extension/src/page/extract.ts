/**
 * Runs inside the tab (injected on demand under activeTab), so the DOM is the
 * rendered page: loaded images, logged-in and paywalled content. Defuddle
 * gets a clone of it (as src/browser-readability.ts does) because it rewrites
 * image attributes in the document it is given, and the user's page must stay
 * untouched. A detached clone has no computed styles, so Defuddle's
 * mobile-CSS and hidden-element steps fall back to its markup heuristics.
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
	const defuddle = new Defuddle(doc.cloneNode(true) as Document, { url });
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
	// Cutting something like one giant <pre> can leave next to nothing; a bare link is better then.
	if (fitted.trimmed && fitted.keptChars < MIN_TEXT_CHARS) return null;
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

function isInRawText(node: Node): boolean {
	return node.parentNode?.nodeType === 1 && RAW_TEXT_TAGS.has((node.parentNode as Element).localName);
}

/**
 * The longest prefix of `value` whose escaped html plus text fit `budget`,
 * cut at a character boundary (never inside a surrogate pair) and, when one
 * is near, at whitespace.
 */
export function fitTextPrefix(value: string, budget: number): string {
	const weight = (part: string) => utf8Bytes(escapeText(part)) + utf8Bytes(part);
	if (budget <= 0) return '';
	if (weight(value) <= budget) return value;
	let low = 0;
	let high = value.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (weight(value.slice(0, mid)) <= budget) low = mid;
		else high = mid - 1;
	}
	let end = low;
	const code = value.charCodeAt(end - 1);
	if (end > 0 && code >= 0xd800 && code <= 0xdbff) end--;
	const space = value.slice(Math.max(0, end - 200), end).search(/\s\S*$/);
	if (space >= 0) end = Math.max(0, end - 200) + space;
	return value.slice(0, end);
}

/**
 * Serializes the leading children whose html plus text fit `budget`. A child
 * that straddles the limit is entered and cut inside (a text node at a
 * character boundary), so the result stays well formed. Measuring from the front means
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
		if (node.nodeType === 3 && !isInRawText(node)) {
			const kept = fitTextPrefix(node.nodeValue ?? '', budget - used);
			html += escapeText(kept);
			text += kept;
		} else if (node.nodeType === 1 && node.childNodes.length > 0 && !RAW_TEXT_TAGS.has((node as Element).localName)) {
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
export interface FittedContent {
	html: string;
	text: string;
	trimmed: boolean;
	/** Characters of article text kept (without the trim note). */
	keptChars: number;
}

export function fitToBudget(doc: Document, template: HTMLTemplateElement, budget = EXTRACTION_BUDGET_BYTES): FittedContent {
	const whole = () => {
		const text = plainText(template);
		return { html: template.innerHTML, text, trimmed: false, keptChars: text.length };
	};
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
	const keptText = collapse(kept.text);
	return { html: kept.html + TRIM_NOTICE, text: collapse(`${keptText} ${noticeText}`), trimmed: true, keptChars: keptText.length };
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
			// An id-less VideoObject may describe the previous video after in-page navigation.
			const ids = [record['@id'], record.url, record.embedUrl].filter((id): id is string => typeof id === 'string');
			const matches = ids.some((id) => id.includes(videoId));
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
