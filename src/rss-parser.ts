/**
 * Liberal, deterministic parser for the feed formats Pigeon accepts.
 *
 * Publishers routinely send incorrect content types, mixed-case attributes,
 * empty feeds, and malformed dates. Format detection therefore uses the body
 * first and treats dates as optional instead of inventing a current timestamp.
 */

import { XMLParser } from 'fast-xml-parser';

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

const xmlParser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: '@_',
	textNodeName: '#text',
	parseAttributeValue: false,
	trimValues: true,
	processEntities: true,
	removeNSPrefix: false,
});

export function parseFeed(feedText: string, options: ParseFeedOptions = {}): ParsedFeed {
	const text = feedText.replace(/^\uFEFF/, '').trim();
	if (!text) {
		throw new Error('Feed is empty');
	}

	const contentType = options.contentType?.toLowerCase() ?? '';
	if (text.startsWith('{') || text.startsWith('[') || contentType.includes('json')) {
		return parseJsonFeed(text, options.sourceUrl);
	}

	let document: FeedRecord;
	try {
		document = asRecord(xmlParser.parse(text));
	} catch (error) {
		throw new Error(`Malformed XML feed: ${errorMessage(error)}`);
	}

	const atom = asOptionalRecord(findKey(document, ['feed']));
	if (atom) {
		return parseAtomFeed(atom, options.sourceUrl);
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
		const authors = arrayValue(item.authors);
		const firstAuthor = authors.length > 0 ? asRecord(authors[0]) : undefined;
		const legacyAuthor = asOptionalRecord(item.author);
		const author = firstAuthor
			? textValue(firstAuthor.name)
			: legacyAuthor
				? textValue(legacyAuthor.name)
				: undefined;

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

function parseAtomFeed(feed: FeedRecord, sourceUrl?: string): ParsedFeed {
	const feedLink = extractAtomLink(findKey(feed, ['link']), sourceUrl);
	const baseUrl = feedLink ?? sourceUrl;
	const entries = arrayValue(findKey(feed, ['entry']));
	const items = entries.map((rawEntry) => {
		const entry = asRecord(rawEntry);
		const link = extractAtomLink(findKey(entry, ['link']), baseUrl);
		const authorRecord = asOptionalRecord(findKey(entry, ['author']));

		return {
			guid: textValue(findKey(entry, ['id'])) ?? link ?? '',
			title: textValue(findKey(entry, ['title'])) ?? 'Untitled',
			link,
			pubDate: normalizeDate(textValue(findKey(entry, ['published', 'updated']))),
			content: textValue(findKey(entry, ['content', 'summary'])) ?? '',
			author: authorRecord ? textValue(findKey(authorRecord, ['name'])) : undefined,
			attachments: parseAtomAttachments(findKey(entry, ['link']), baseUrl),
		};
	});

	return {
		title: textValue(findKey(feed, ['title'])) ?? 'Untitled Feed',
		link: feedLink,
		items,
		format: 'atom',
	};
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
