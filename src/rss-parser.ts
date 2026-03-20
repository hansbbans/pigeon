/**
 * RSS/Atom feed parser using fast-xml-parser
 * Handles both RSS 2.0 and Atom formats
 */

import { XMLParser } from 'fast-xml-parser';

export interface ParsedFeed {
	title: string;
	link?: string;
	items: ParsedItem[];
}

export interface ParsedItem {
	guid: string; // Unique identifier (used as message_id for dedup)
	title: string;
	link?: string;
	pubDate?: string; // ISO 8601 string
	content: string; // HTML content (description or content:encoded)
	author?: string;
}

const parser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: '@_',
	textNodeName: '#text',
	parseAttributeValue: true,
	trimValues: true,
});

/**
 * Parse RSS 2.0 or Atom feed from XML text
 * @throws Error if feed is malformed or unsupported format
 */
export function parseRssFeed(xmlText: string): ParsedFeed {
	const parsed = parser.parse(xmlText);

	// Detect Atom feed
	if (parsed.feed && parsed.feed.entry) {
		return parseAtomFeed(parsed.feed);
	}

	// Detect RSS 2.0 feed
	if (parsed.rss && parsed.rss.channel) {
		return parseRss2Feed(parsed.rss.channel);
	}

	throw new Error('Unsupported feed format (expected RSS 2.0 or Atom)');
}

/**
 * Parse Atom feed format
 */
function parseAtomFeed(feed: any): ParsedFeed {
	const title = feed.title?.['#text'] || feed.title || 'Untitled Feed';
	const link = extractAtomLink(feed.link);

	const entries = Array.isArray(feed.entry) ? feed.entry : [feed.entry];
	const items: ParsedItem[] = entries
		.filter((entry: any) => entry) // Filter out undefined entries
		.map((entry: any) => {
			const guid = entry.id || extractAtomLink(entry.link) || '';
			const itemTitle = entry.title?.['#text'] || entry.title || 'Untitled';
			const itemLink = extractAtomLink(entry.link);
			const pubDate = entry.updated || entry.published;
			const content =
				entry.content?.['#text'] || entry.content || entry.summary?.['#text'] || entry.summary || '';
			const author = entry.author?.name || entry.author?.['#text'] || undefined;

			return {
				guid,
				title: itemTitle,
				link: itemLink,
				pubDate: pubDate ? normalizeDate(pubDate) : undefined,
				content,
				author,
			};
		});

	return { title, link, items };
}

/**
 * Parse RSS 2.0 feed format
 */
function parseRss2Feed(channel: any): ParsedFeed {
	const title = channel.title || 'Untitled Feed';
	const link = channel.link;

	const entries = Array.isArray(channel.item) ? channel.item : [channel.item];
	const items: ParsedItem[] = entries
		.filter((item: any) => item) // Filter out undefined items
		.map((item: any) => {
			const guid = item.guid?.['#text'] || item.guid || item.link || '';
			const itemTitle = item.title || 'Untitled';
			const itemLink = item.link;
			const pubDate = item.pubDate || item['dc:date'];
			const content =
				item['content:encoded'] || item.description || item.summary || '';
			const author = item.author || item['dc:creator'] || undefined;

			return {
				guid,
				title: itemTitle,
				link: itemLink,
				pubDate: pubDate ? normalizeDate(pubDate) : undefined,
				content,
				author,
			};
		});

	return { title, link, items };
}

/**
 * Extract href from Atom link (can be object or array)
 */
function extractAtomLink(link: any): string | undefined {
	if (!link) return undefined;
	if (typeof link === 'string') return link;
	if (link['@_href']) return link['@_href'];
	if (Array.isArray(link)) {
		const alternate = link.find((l) => l['@_rel'] === 'alternate' || !l['@_rel']);
		return alternate?.['@_href'];
	}
	return undefined;
}

/**
 * Normalize various date formats to ISO 8601 UTC
 */
function normalizeDate(dateStr: string): string {
	try {
		const date = new Date(dateStr);
		if (isNaN(date.getTime())) {
			// Invalid date - return current time
			return new Date().toISOString();
		}
		return date.toISOString();
	} catch {
		return new Date().toISOString();
	}
}
