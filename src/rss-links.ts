const URL_ATTRIBUTE_PATTERN = /\b(href|src)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;

function decodeHtmlEntities(value: string): string {
	return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (entity, body: string) => {
		const normalized = body.toLowerCase();
		if (normalized === 'amp') return '&';
		if (normalized === 'quot') return '"';
		if (normalized === 'apos') return "'";
		if (normalized === 'lt') return '<';
		if (normalized === 'gt') return '>';
		if (normalized.startsWith('#x')) {
			const codePoint = parseInt(normalized.slice(2), 16);
			return Number.isInteger(codePoint) && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
		}
		if (normalized.startsWith('#')) {
			const codePoint = parseInt(normalized.slice(1), 10);
			return Number.isInteger(codePoint) && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
		}
		return entity;
	});
}

function escapeHtmlAttribute(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

function normalizeUrlInput(value: string): string {
	return decodeHtmlEntities(value).trim();
}

export function unwrapFeedBlitzUrl(value: string): string {
	const normalized = normalizeUrlInput(value);
	const embeddedTarget = normalized.match(/~(https?:\/\/.+)$/i)?.[1];
	if (!embeddedTarget) {
		return normalized;
	}

	try {
		return new URL(embeddedTarget).toString();
	} catch {
		return normalized;
	}
}

function resolveUrl(value: string, baseUrl?: string): string | null {
	const normalized = unwrapFeedBlitzUrl(value);
	try {
		return new URL(normalized, baseUrl).toString();
	} catch {
		return null;
	}
}

function resolveHttpUrl(value: string, baseUrl?: string): string | null {
	const resolved = resolveUrl(value, baseUrl);
	if (!resolved) {
		return null;
	}

	try {
		const url = new URL(resolved);
		return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
	} catch {
		return null;
	}
}

function parseAbsoluteHttpUrl(value: string): string | null {
	const normalized = normalizeUrlInput(value);
	try {
		const url = new URL(normalized);
		return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
	} catch {
		return null;
	}
}

function isFeedBlitzUrl(value: string): boolean {
	try {
		return new URL(value).hostname === 'feeds.feedblitz.com';
	} catch {
		return false;
	}
}

function normalizeComparableHostname(hostname: string): string {
	return hostname.toLowerCase().replace(/\.+$/, '').replace(/^www\./, '');
}

function isSameSiteUrl(value: string, siteUrl: string): boolean {
	try {
		const url = new URL(value);
		const site = new URL(siteUrl);
		return normalizeComparableHostname(url.hostname) === normalizeComparableHostname(site.hostname);
	} catch {
		return false;
	}
}

function isLikelyArticleUrl(value: string, siteUrl?: string): boolean {
	try {
		const url = new URL(value);
		if (isFeedBlitzUrl(url.toString())) {
			return false;
		}
		if (url.hash === '#comments' || url.hash === '#respond' || /\/feed\/?$/.test(url.pathname)) {
			return false;
		}
		if (siteUrl) {
			if (!isSameSiteUrl(url.toString(), siteUrl)) {
				return false;
			}
		}
		return (url.pathname !== '/' && url.pathname !== '') || url.search !== '';
	} catch {
		return false;
	}
}

function stripHtml(value: string): string {
	return decodeHtmlEntities(value.replace(/<[^>]+>/g, ' '))
		.replace(/\s+/g, ' ')
		.trim()
		.toLowerCase();
}

function readAttribute(tag: string, attributeName: string): string | null {
	const match = tag.match(new RegExp(`\\b${attributeName}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, 'i'));
	if (!match) {
		return null;
	}
	const raw = match[1];
	return raw.startsWith('"') || raw.startsWith("'") ? raw.slice(1, -1) : raw;
}

function normalizeComparisonText(value: string): string {
	return stripHtml(value)
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

function tokenizeComparableText(value: string): string[] {
	return normalizeComparisonText(value).split(/\s+/).filter(Boolean);
}

function isExactOrNearTitleMatch(candidateText: string, title: string): boolean {
	const normalizedCandidate = normalizeComparisonText(candidateText);
	const normalizedTitle = normalizeComparisonText(title);
	if (!normalizedCandidate || !normalizedTitle) {
		return false;
	}
	if (normalizedCandidate === normalizedTitle) {
		return true;
	}
	if (
		normalizedCandidate.includes(normalizedTitle) ||
		(normalizedTitle.length >= 24 && normalizedTitle.includes(normalizedCandidate))
	) {
		return true;
	}

	const titleTokens = tokenizeComparableText(title);
	const candidateTokens = tokenizeComparableText(candidateText);
	if (titleTokens.length < 3 || candidateTokens.length < 3) {
		return false;
	}

	const candidateTokenSet = new Set(candidateTokens);
	const sharedCount = titleTokens.filter((token) => candidateTokenSet.has(token)).length;
	return sharedCount === titleTokens.length;
}

function hasUrlSlugTitleMatch(value: string, title: string): boolean {
	try {
		const url = new URL(value);
		const segments = url.pathname.split('/').filter(Boolean);
		const slugSource = segments.length > 0 ? segments[segments.length - 1] : url.search;
		const slugTokens = tokenizeComparableText(slugSource.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' '));
		const titleTokens = tokenizeComparableText(title);
		if (slugTokens.length === 0 || titleTokens.length < 2) {
			return false;
		}

		const slugTokenSet = new Set(slugTokens);
		const sharedCount = titleTokens.filter((token) => slugTokenSet.has(token)).length;
		return sharedCount >= Math.min(2, titleTokens.length) && sharedCount / titleTokens.length >= 0.6;
	} catch {
		return false;
	}
}

function hasSelfReferentialContext(value: string): boolean {
	return /\b(?:the post|appeared first on|original post|permalink)\b/i.test(value);
}

function extractAnchorCandidates(html: string): Array<{ href: string; text: string; context: string }> {
	const candidates: Array<{ href: string; text: string; context: string }> = [];
	for (const match of html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)) {
		const href = readAttribute(match[0], 'href');
		if (!href) {
			continue;
		}
		const start = match.index ?? 0;
		const end = start + match[0].length;
		const contextSnippet = html.slice(Math.max(0, start - 96), Math.min(html.length, end + 96));
		candidates.push({
			href,
			text: stripHtml(match[0]),
			context: stripHtml(contextSnippet),
		});
	}
	return candidates;
}

function selectSiteReferenceUrl(feedSiteUrl?: string, feedSourceUrl?: string): string | undefined {
	for (const candidate of [feedSiteUrl, feedSourceUrl]) {
		if (!candidate || isFeedBlitzUrl(candidate)) {
			continue;
		}
		return candidate;
	}

	return undefined;
}

export function resolveRssItemUrl(input: {
	itemGuid?: string;
	itemLink?: string;
	content: string;
	title: string;
	feedSiteUrl?: string;
	feedSourceUrl: string;
}): string | null {
	const baseUrl = input.feedSiteUrl || input.feedSourceUrl;
	const itemUrl = input.itemLink ? resolveHttpUrl(input.itemLink, baseUrl) : null;
	const hasFeedBlitzItemLink = input.itemLink ? isFeedBlitzUrl(normalizeUrlInput(input.itemLink)) : false;
	if (itemUrl && !hasFeedBlitzItemLink) {
		return itemUrl;
	}
	if (itemUrl && hasFeedBlitzItemLink && !isFeedBlitzUrl(itemUrl) && isLikelyArticleUrl(itemUrl)) {
		return itemUrl;
	}

	if (!hasFeedBlitzItemLink) {
		return itemUrl;
	}

	const guidUrl = input.itemGuid ? parseAbsoluteHttpUrl(input.itemGuid) : null;
	if (guidUrl && !isFeedBlitzUrl(guidUrl) && isLikelyArticleUrl(guidUrl)) {
		return guidUrl;
	}

	const siteReferenceUrl = selectSiteReferenceUrl(input.feedSiteUrl, input.feedSourceUrl);
	const candidates = extractAnchorCandidates(input.content)
		.map((candidate) => ({
			...candidate,
			url: resolveHttpUrl(candidate.href, baseUrl),
		}))
		.filter(
			(candidate): candidate is { href: string; text: string; context: string; url: string } => Boolean(candidate.url),
		)
		.filter((candidate) => isLikelyArticleUrl(candidate.url, siteReferenceUrl));

	const titledCandidate = candidates.find(
		(candidate) => isExactOrNearTitleMatch(candidate.text, input.title),
	);
	if (titledCandidate) {
		return titledCandidate.url;
	}

	const selfReferentialCandidate = candidates.find(
		(candidate) => hasSelfReferentialContext(candidate.context) && hasUrlSlugTitleMatch(candidate.url, input.title),
	);
	if (selfReferentialCandidate) {
		return selfReferentialCandidate.url;
	}

	return null;
}

export function rewriteRssContentLinks(html: string, baseUrl: string): string {
	if (!html.trim()) {
		return html;
	}

	return html.replace(URL_ATTRIBUTE_PATTERN, (match, attributeName: string, rawValue: string) => {
		const quote = rawValue.startsWith('"') || rawValue.startsWith("'") ? rawValue[0] : '"';
		const unquotedValue = rawValue.startsWith('"') || rawValue.startsWith("'") ? rawValue.slice(1, -1) : rawValue;
		const resolved = resolveUrl(unquotedValue, baseUrl);
		if (!resolved) {
			return match;
		}
		return `${attributeName}=${quote}${escapeHtmlAttribute(resolved)}${quote}`;
	});
}
