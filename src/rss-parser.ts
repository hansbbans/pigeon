/**
 * Liberal, deterministic parser for the feed formats Pigeon accepts.
 *
 * Publishers routinely send incorrect content types, mixed-case attributes,
 * empty feeds, and malformed dates. Format detection therefore uses the body
 * first and treats dates as optional instead of inventing a current timestamp.
 */

import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import { isYouTubeVideoId } from './youtube';

export type FeedFormat = 'rss2' | 'rss1' | 'atom' | 'json';

export interface ParsedFeed {
	title: string;
	link?: string;
	items: ParsedItem[];
	format: FeedFormat;
}

export interface ParsedItem {
	guid: string;
	title: string;
	link?: string;
	pubDate?: string;
	content: string;
	author?: string;
	attachments: ParsedAttachment[];
}

export interface ParsedAttachment {
	url: string;
	mimeType?: string;
	title?: string;
}

export interface ParseFeedOptions {
	sourceUrl?: string;
	contentType?: string | null;
}

type FeedRecord = Record<string, unknown>;

const ATOM_NAMESPACE = 'http://www.w3.org/2005/Atom';

const XML_OPTIONS = {
	ignoreAttributes: false,
	attributeNamePrefix: '@_',
	textNodeName: '#text',
	parseAttributeValue: false,
	trimValues: true,
	processEntities: true,
	removeNSPrefix: false,
};

class NamespaceScope {
	constructor(private readonly declarations = new Map<string, string>(), private readonly parent?: NamespaceScope) {}

	get(prefix: string): string | undefined {
		return this.declarations.has(prefix) ? this.declarations.get(prefix) : this.parent?.get(prefix);
	}
}

const EMPTY_NAMESPACES = new NamespaceScope();

function namespaceScope(record: FeedRecord, inherited = EMPTY_NAMESPACES): NamespaceScope {
	let declarations: Map<string, string> | undefined;
	for (const [key, value] of Object.entries(record)) {
		if (typeof value !== 'string') continue;
		const prefix = key === '@_xmlns' ? '' : key.startsWith('@_xmlns:') ? key.slice('@_xmlns:'.length) : undefined;
		if (prefix === undefined) continue;
		(declarations ??= new Map()).set(prefix, value);
	}
	return declarations ? new NamespaceScope(declarations, inherited) : inherited;
}

function createFeedXmlParser(xhtmlScopes: NamespaceScope[]): XMLParser {
	const scopes: NamespaceScope[] = [];
	const elementNamespaces: Array<string | undefined> = [];
	let atomRoot = false;
	const attributePrefixes: Array<string | undefined> = [];
	return new XMLParser({
		...XML_OPTIONS,
		jPath: false,
		// Stop XHTML before the ordinary object parser loses mixed-content order.
		transformTagName: (name) => ['feed', 'content', 'summary'].includes(name.split(':').at(-1) ?? '') ? name.split(':').at(-1)! : name,
		stopNodes: ['feed.*.content[type=xhtml]', 'feed.*.summary[type=xhtml]'],
		attributeValueProcessor(name, value, path) {
			if (typeof path !== 'string') attributePrefixes[path.getDepth()] = path.getCurrentNamespace();
			return value;
		},
		updateTag(tagName, path, attributes) {
			if (typeof path === 'string') return tagName;
			const stopped = path.getDepth() === 2 && (tagName === 'content' || tagName === 'summary') && attributes['@_type'] === 'xhtml';
			const depth = path.getDepth() + (stopped ? 1 : 0);
			const sourcePrefix = (stopped ? attributePrefixes[depth] : path.getCurrentNamespace()) ?? '';
			if (!tagName.includes(':') && sourcePrefix) tagName = `${sourcePrefix}:${tagName}`;
			if (depth === 0 || (depth > 1 && !atomRoot)) return tagName;
			const separator = tagName.indexOf(':');
			const prefix = separator < 0 ? '' : tagName.slice(0, separator);
			const localName = separator < 0 ? tagName : tagName.slice(separator + 1);
			const namespaces = namespaceScope(asRecord(attributes), scopes[depth - 1]);
			const uri = namespaces.get(prefix);
			if (depth === 1) atomRoot = localName.toLowerCase() === 'feed' && (!prefix || uri === ATOM_NAMESPACE);
			if (!atomRoot) return tagName;
			scopes[depth] = namespaces;
			elementNamespaces[depth] = uri;
			if (uri === ATOM_NAMESPACE) {
				if (stopped) {
					attributes['@___pigeon_xhtml_scope'] = String(xhtmlScopes.length);
					xhtmlScopes.push(namespaces);
				}
				return localName;
			}
			// Foreign default namespaces under an Atom parent must not masquerade
			// as Atom fields; prefixed extensions already keep distinct names.
			if (!prefix && elementNamespaces[depth - 1] === ATOM_NAMESPACE) return `foreign:${tagName}`;
			return tagName;
		},
	});
}

export function parseFeed(feedText: string, options: ParseFeedOptions = {}): ParsedFeed {
	const text = feedText.replace(/^\uFEFF/, '').trim();
	if (!text) {
		throw new Error('Feed is empty');
	}

	const contentType = options.contentType?.toLowerCase() ?? '';
	if (text.startsWith('{') || text.startsWith('[') || contentType.includes('json')) {
		return parseJsonFeed(text, options.sourceUrl);
	}

	const xhtmlScopes: NamespaceScope[] = [];
	let document: FeedRecord;
	try {
		document = asRecord(createFeedXmlParser(xhtmlScopes).parse(text));
	} catch (error) {
		throw new Error(`Malformed XML feed: ${errorMessage(error)}`);
	}

	const atom = asOptionalRecord(findKey(document, ['feed']));
	if (atom) {
		return parseAtomFeed(atom, options.sourceUrl, xhtmlScopes);
	}

	const rss = asOptionalRecord(findKey(document, ['rss']));
	const channel = rss ? asOptionalRecord(findKey(rss, ['channel'])) : undefined;
	if (channel) {
		return parseRss2Feed(channel, options.sourceUrl);
	}

	const rdf = asOptionalRecord(findKey(document, ['rdf:RDF', 'RDF']));
	if (rdf) {
		return parseRss1Feed(rdf, options.sourceUrl);
	}

	throw new Error('Unsupported feed format (expected RSS, RDF, Atom, or JSON Feed)');
}

/** Kept for existing callers and Google Reader compatibility tests. */
export function parseRssFeed(feedText: string, options: ParseFeedOptions = {}): ParsedFeed {
	return parseFeed(feedText, options);
}

export function detectFeedFormat(feedText: string, contentType?: string | null): FeedFormat | null {
	try {
		return parseFeed(feedText, { contentType }).format;
	} catch {
		return null;
	}
}

function parseJsonFeed(text: string, sourceUrl?: string): ParsedFeed {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new Error(`Malformed JSON feed: ${errorMessage(error)}`);
	}

	const feed = asRecord(value);
	const version = textValue(feed.version);
	if (!version?.startsWith('https://jsonfeed.org/version/')) {
		throw new Error('Unsupported JSON document (expected JSON Feed)');
	}

	const homePageUrl = resolveUrl(textValue(feed.home_page_url), sourceUrl);
	const feedUrl = resolveUrl(textValue(feed.feed_url), sourceUrl);
	const baseUrl = homePageUrl ?? feedUrl ?? sourceUrl;
	const items = arrayValue(feed.items).map((rawItem) => {
		const item = asRecord(rawItem);
		const link = resolveUrl(textValue(item.url) ?? textValue(item.external_url), baseUrl);
		const plainText = textValue(item.content_text);
		const content = textValue(item.content_html) ?? (plainText ? escapePlainText(plainText) : '');
		const author = item.authors != null || item.author != null
			? jsonAuthorName(item)
			: jsonAuthorName(feed);

		return {
			guid: textValue(item.id) ?? link ?? '',
			title: textValue(item.title) ?? 'Untitled',
			link,
			pubDate: normalizeDate(textValue(item.date_published) ?? textValue(item.date_modified)),
			content,
			author,
			attachments: parseJsonAttachments(item, baseUrl),
		};
	});

	return {
		title: textValue(feed.title) ?? 'Untitled Feed',
		link: homePageUrl,
		items,
		format: 'json',
	};
}

/** Preserve the existing single-name byline, choosing the first named author. */
function firstAuthorName(value: unknown): string | undefined {
	for (const author of arrayValue(value)) {
		const name = textValue(findKey(asRecord(author), ['name']));
		if (name) return name;
	}
	return undefined;
}

function jsonAuthorName(record: FeedRecord): string | undefined {
	// An explicit empty authors array overrides deprecated singular authors.
	if (record.authors != null) return firstAuthorName(record.authors);
	return textValue(asRecord(record.author).name);
}

function parseAtomFeed(feed: FeedRecord, sourceUrl?: string, xhtmlScopes: NamespaceScope[] = []): ParsedFeed {
	const feedLink = extractAtomLink(findKey(feed, ['link']), sourceUrl);
	const baseUrl = feedLink ?? sourceUrl;
	const entries = arrayValue(findKey(feed, ['entry']));
	const items = entries.map((rawEntry) => {
		const entry = asRecord(rawEntry);
		const videoId = textValue(findKey(entry, ['yt:videoId']));
		const link =
			extractAtomLink(findKey(entry, ['link']), baseUrl) ??
			(videoId && isYouTubeVideoId(videoId) ? `https://www.youtube.com/watch?v=${videoId}` : undefined);
		const source = asOptionalRecord(findKey(entry, ['source']));
		const author = firstAuthorName(findKey(entry, ['author']))
			?? firstAuthorName(source ? findKey(source, ['author']) : undefined)
			?? firstAuthorName(findKey(feed, ['author']));
		const mediaGroup = asOptionalRecord(findKey(entry, ['media:group', 'group']));
		const mediaTitle = mediaGroup ? textValue(findKey(mediaGroup, ['media:title', 'title'])) : undefined;
		const mediaDescription = mediaGroup
			? textValue(findKey(mediaGroup, ['media:description', 'description']))
			: undefined;
		const title = textValue(findKey(entry, ['title'])) ?? mediaTitle ?? 'Untitled';

		return {
			// YouTube's Atom IDs are already stable. Prefer the explicit video ID
			// when available so a missing/rewritten entry id cannot duplicate it.
			guid: videoId && isYouTubeVideoId(videoId)
				? `yt:video:${videoId}`
				: textValue(findKey(entry, ['id'])) ?? link ?? '',
			title,
			link,
			pubDate: normalizeDate(textValue(findKey(entry, ['published', 'updated']))),
			content:
				atomContentValue(findKey(entry, ['content', 'summary']), xhtmlScopes) ??
				(mediaDescription ? `<p>${escapePlainText(mediaDescription)}</p>` : ''),
			author,
			attachments: deduplicateAttachments([
				...parseAtomAttachments(findKey(entry, ['link']), baseUrl),
				...parseYouTubeMediaAttachments(mediaGroup, baseUrl, mediaTitle),
			]),
		};
	});

	return {
		title: textValue(findKey(feed, ['title'])) ?? 'Untitled Feed',
		link: feedLink,
		items,
		format: 'atom',
	};
}

function atomContentValue(value: unknown, xhtmlScopes: NamespaceScope[]): string | undefined {
	const content = textValue(value);
	if (content === undefined) return undefined;
	const type = attributeValue(asRecord(value), ['type'])?.toLowerCase() ?? 'text';
	if (type === 'xhtml') return serializeAtomXhtml(content, xhtmlScopes[Number(asRecord(value)['@___pigeon_xhtml_scope'])] ?? EMPTY_NAMESPACES);
	if (type === 'html' || type === 'text/html') return content;
	return type === 'text' || type.startsWith('text/') ? `<p>${escapePlainText(content)}</p>` : content;
}

function serializeAtomXhtml(content: string, inherited: NamespaceScope): string {
	// Parse just one bounded body at a time, never a second full feed tree.
	if (content.length > 1_000_000 || new TextEncoder().encode(content).byteLength > 1_000_000) throw new Error('Atom XHTML body exceeds parsing limit');
	const scopes: NamespaceScope[] = [inherited];
	let nodes = 0;
	const parser = new XMLParser({
		...XML_OPTIONS, preserveOrder: true, trimValues: false, parseTagValue: false,
		jPath: false,
		updateTag(name, path, attributes) {
			if (++nodes > 20_000) throw new Error('Atom XHTML body exceeds element limit');
			if (typeof path === 'string') return name;
			const depth = path.getDepth();
			const scope = namespaceScope(asRecord(attributes), scopes[depth - 1]);
			scopes[depth] = scope;
			const separator = name.indexOf(':');
			const prefix = separator < 0 ? '' : name.slice(0, separator);
			if (depth === 1 && (scope.get(prefix) !== 'http://www.w3.org/1999/xhtml' || (separator < 0 ? name : name.slice(separator + 1)) !== 'div')) throw new Error('Atom XHTML body must contain an XHTML div');
			if (['http://www.w3.org/1999/xhtml', 'http://www.w3.org/2000/svg', 'http://www.w3.org/1998/Math/MathML'].includes(scope.get(prefix) ?? '')) return separator < 0 ? name : name.slice(separator + 1);
			return name;
		},
	});
	const roots = parser.parse(content) as FeedRecord[];
	const root = roots.find((node) => Object.hasOwn(node, 'div'));
	if (!root || roots.filter((node) => Object.hasOwn(node, 'div')).length !== 1 || roots.some((node) => !Object.hasOwn(node, 'div') && !Object.hasOwn(node, '#text'))) throw new Error('Atom XHTML body must contain an XHTML div');
	return new XMLBuilder({ ...XML_OPTIONS, preserveOrder: true, suppressEmptyNode: false,
		unpairedTags: ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'],
		suppressUnpairedNode: true }).build(root.div);
}

function parseRss2Feed(channel: FeedRecord, sourceUrl?: string): ParsedFeed {
	const feedLink = resolveUrl(textValue(findKey(channel, ['link'])), sourceUrl);
	const baseUrl = feedLink ?? sourceUrl;
	const entries = arrayValue(findKey(channel, ['item']));

	return {
		title: textValue(findKey(channel, ['title'])) ?? 'Untitled Feed',
		link: feedLink,
		items: entries.map((rawItem) => parseRssItem(asRecord(rawItem), baseUrl)),
		format: 'rss2',
	};
}

function parseRss1Feed(rdf: FeedRecord, sourceUrl?: string): ParsedFeed {
	const channel = asOptionalRecord(findKey(rdf, ['channel'])) ?? {};
	const feedLink = resolveUrl(textValue(findKey(channel, ['link'])), sourceUrl);
	const baseUrl = feedLink ?? sourceUrl;
	const entries = arrayValue(findKey(rdf, ['item']));

	return {
		title: textValue(findKey(channel, ['title'])) ?? 'Untitled Feed',
		link: feedLink,
		items: entries.map((rawItem) => parseRssItem(asRecord(rawItem), baseUrl)),
		format: 'rss1',
	};
}

function parseRssItem(item: FeedRecord, baseUrl?: string): ParsedItem {
	const guidValue = findKey(item, ['guid', 'dc:identifier']);
	const link = resolveUrl(textValue(findKey(item, ['link'])), baseUrl);

	return {
		guid: textValue(guidValue) ?? attributeValue(item, ['rdf:about', 'about']) ?? link ?? '',
		title: textValue(findKey(item, ['title'])) ?? 'Untitled',
		link,
		pubDate: normalizeDate(textValue(findKey(item, ['pubDate', 'dc:date', 'date']))),
		content: textValue(findKey(item, ['content:encoded', 'description', 'summary'])) ?? '',
		author: textValue(findKey(item, ['author', 'dc:creator', 'creator'])),
		attachments: parseRssAttachments(item, baseUrl),
	};
}

function parseJsonAttachments(item: FeedRecord, baseUrl?: string): ParsedAttachment[] {
	return deduplicateAttachments(
		arrayValue(item.attachments).flatMap((rawAttachment) => {
			const attachment = asRecord(rawAttachment);
			const url = resolveUrl(textValue(attachment.url), baseUrl);
			if (!url) return [];
			return [{
				url,
				mimeType: textValue(attachment.mime_type),
				title: textValue(attachment.title),
			}];
		}),
	);
}

function parseAtomAttachments(value: unknown, baseUrl?: string): ParsedAttachment[] {
	return deduplicateAttachments(
		arrayValue(value).flatMap((rawLink) => {
			const link = asRecord(rawLink);
			if (attributeValue(link, ['rel'])?.toLowerCase() !== 'enclosure') return [];
			const url = resolveUrl(attributeValue(link, ['href']) ?? textValue(link), baseUrl);
			if (!url) return [];
			return [{
				url,
				mimeType: attributeValue(link, ['type']),
				title: attributeValue(link, ['title']),
			}];
		}),
	);
}

function parseYouTubeMediaAttachments(
	mediaGroup: FeedRecord | undefined,
	baseUrl?: string,
	title?: string,
): ParsedAttachment[] {
	if (!mediaGroup) return [];

	const thumbnailValues = arrayValue(findKey(mediaGroup, ['media:thumbnail', 'thumbnail']));
	return deduplicateAttachments(
		thumbnailValues.flatMap((rawThumbnail) => {
			const thumbnail = asRecord(rawThumbnail);
			const url = resolveUrl(
				attributeValue(thumbnail, ['url', 'href']) ?? textValue(thumbnail),
				baseUrl,
			);
			if (!url) return [];
			return [{
				url,
				mimeType: attributeValue(thumbnail, ['type']) ?? 'image/jpeg',
				title: title ? `${title} thumbnail` : 'Video thumbnail',
			}];
		}),
	);
}

function parseRssAttachments(item: FeedRecord, baseUrl?: string): ParsedAttachment[] {
	const candidates = [
		...arrayValue(findKey(item, ['enclosure'])),
		...arrayValue(findKey(item, ['media:content'])),
		...arrayValue(findKey(item, ['media:thumbnail'])),
	];
	return deduplicateAttachments(
		candidates.flatMap((rawAttachment) => {
			const attachment = asRecord(rawAttachment);
			const url = resolveUrl(
				attributeValue(attachment, ['url', 'href']) ?? textValue(attachment),
				baseUrl,
			);
			if (!url) return [];
			return [{
				url,
				mimeType: attributeValue(attachment, ['type', 'medium']),
				title: attributeValue(attachment, ['title', 'description']),
			}];
		}),
	);
}

function deduplicateAttachments(attachments: ParsedAttachment[]): ParsedAttachment[] {
	const seen = new Set<string>();
	return attachments.filter((attachment) => {
		if (seen.has(attachment.url)) return false;
		seen.add(attachment.url);
		return true;
	});
}

function extractAtomLink(value: unknown, baseUrl?: string): string | undefined {
	for (const candidate of arrayValue(value)) {
		if (typeof candidate === 'string') {
			return resolveUrl(candidate, baseUrl);
		}
		const link = asRecord(candidate);
		const rel = attributeValue(link, ['rel'])?.toLowerCase();
		if (!rel || rel === 'alternate') {
			const href = attributeValue(link, ['href']) ?? textValue(link);
			const resolved = resolveUrl(href, baseUrl);
			if (resolved) return resolved;
		}
	}
	return undefined;
}

function normalizeDate(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function resolveUrl(value: string | undefined, baseUrl?: string): string | undefined {
	if (!value) return undefined;
	try {
		return new URL(value, baseUrl).href;
	} catch {
		return undefined;
	}
}

function findKey(record: FeedRecord, candidates: string[]): unknown {
	for (const candidate of candidates) {
		const exact = Object.keys(record).find((key) => key.toLowerCase() === candidate.toLowerCase());
		if (exact !== undefined) return record[exact];
	}
	return undefined;
}

function attributeValue(record: FeedRecord, candidates: string[]): string | undefined {
	for (const candidate of candidates) {
		const value = findKey(record, [`@_${candidate}`, candidate]);
		const text = textValue(value);
		if (text) return text;
	}
	return undefined;
}

function textValue(value: unknown): string | undefined {
	if (typeof value === 'string') return value.trim() || undefined;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (!value || Array.isArray(value) || typeof value !== 'object') return undefined;

	const record = value as FeedRecord;
	return textValue(findKey(record, ['#text', '__cdata']));
}

function arrayValue(value: unknown): unknown[] {
	if (value === undefined || value === null) return [];
	return Array.isArray(value) ? value : [value];
}

function asRecord(value: unknown): FeedRecord {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as FeedRecord) : {};
}

function asOptionalRecord(value: unknown): FeedRecord | undefined {
	const record = asRecord(value);
	return Object.keys(record).length > 0 ? record : undefined;
}

function escapePlainText(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;')
		.replaceAll('\n', '<br>');
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
