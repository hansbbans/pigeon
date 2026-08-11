interface ExtractOriginalUrlOptions {
	subject: string;
	htmlContent?: string | null;
	textContent?: string | null;
	fromAddress?: string | null;
}

interface Candidate {
	url: string;
	text: string;
	source: 'canonical' | 'og' | 'view-in-browser' | 'anchor' | 'text';
	score: number;
}

const CANONICAL_REL = /\bcanonical\b/i;
const MINIMUM_CONFIDENCE_SCORE = 250;
const VIEW_IN_BROWSER_TEXT = /\b(view in browser|view online|read online|read on (?:the )?web|open in browser)\b/i;
const SUBJECT_TOKEN_SPLIT = /[^a-z0-9]+/g;
const BAD_TEXT = /\b(unsubscribe|manage subscription|manage account|email preferences|privacy|terms|login|log in|sign in|share|comment|comments|reply|like|liked|restack|podcast|listen|download app|read in app|open app|follow us|linkedin|facebook|instagram|twitter|x\.com)\b/i;
const BAD_URL =
	/(?:mailto:|tel:|read-in-app|redirect=app-store|[?&](?:action=share|comments?=true|submitLike=true|triggerShare=true)|\/(?:account|comments?|manage|preferences|profile|settings|share|subscribe|unsubscribe)(?:[/?#]|$)|\/(?:login|oauth|podcast|listen)(?:[/?#]|$))/i;
const BAD_HOST = /(?:facebook\.com|twitter\.com|x\.com|linkedin\.com|instagram\.com|youtube\.com|tiktok\.com)$/i;

export function extractOriginalUrl(options: ExtractOriginalUrlOptions): string | null {
	const subject = decodeHtmlEntities(options.subject || '').trim();
	if (!subject) {
		return null;
	}

	const candidates: Candidate[] = [];
	const html = options.htmlContent || '';
	const text = options.textContent || '';
	const senderDomain = extractSenderDomain(options.fromAddress);

	if (html) {
		candidates.push(...extractMetaCandidates(html, subject, senderDomain));
		candidates.push(...extractAnchorCandidates(html, subject, senderDomain));
	}

	if (text) {
		candidates.push(...extractTextCandidates(text, subject, senderDomain));
	}

	const viable = candidates
		.filter((candidate) => candidate.score >= MINIMUM_CONFIDENCE_SCORE)
		.sort((left, right) => right.score - left.score);

	return viable[0]?.url ?? null;
}

export const extractOriginalUrlFromEmail = extractOriginalUrl;

function extractMetaCandidates(html: string, subject: string, senderDomain: string | null): Candidate[] {
	const candidates: Candidate[] = [];

	for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
		const attrs = parseTagAttributes(tag);
		const rel = attrs.rel || '';
		if (!CANONICAL_REL.test(rel)) {
			continue;
		}
		const url = normalizeCandidateUrl(attrs.href);
		if (!url) {
			continue;
		}
			candidates.push(buildCandidate(url, '', 'canonical', subject, senderDomain));
	}

	for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
		const attrs = parseTagAttributes(tag);
		const property = (attrs.property || attrs.name || '').toLowerCase();
		if (property !== 'og:url') {
			continue;
		}
		const url = normalizeCandidateUrl(attrs.content);
		if (!url) {
			continue;
		}
			candidates.push(buildCandidate(url, '', 'og', subject, senderDomain));
	}

	return candidates;
}

function extractAnchorCandidates(html: string, subject: string, senderDomain: string | null): Candidate[] {
	const candidates: Candidate[] = [];

	for (const match of html.matchAll(/<a\b[^>]*href\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)[^>]*>[\s\S]*?<\/a>/gi)) {
		const anchor = match[0];
		const openTag = anchor.match(/^<a\b[^>]*>/i)?.[0];
		if (!openTag) {
			continue;
		}
		const attrs = parseTagAttributes(openTag);
		const url = normalizeCandidateUrl(attrs.href);
		if (!url) {
			continue;
		}
		const text = decodeHtmlEntities(stripHtml(anchor)).trim();
		const source = VIEW_IN_BROWSER_TEXT.test(text) ? 'view-in-browser' : 'anchor';
			candidates.push(buildCandidate(url, text, source, subject, senderDomain));
	}

	return dedupeCandidates(candidates);
}

function extractTextCandidates(textContent: string, subject: string, senderDomain: string | null): Candidate[] {
	const candidates: Candidate[] = [];

	for (const match of textContent.matchAll(/https?:\/\/[^\s<>"')]+/gi)) {
		const url = normalizeCandidateUrl(match[0]);
		if (!url) {
			continue;
		}
			candidates.push(buildCandidate(url, '', 'text', subject, senderDomain));
	}

	return dedupeCandidates(candidates);
}

function dedupeCandidates(candidates: Candidate[]): Candidate[] {
	const bestByUrl = new Map<string, Candidate>();

	for (const candidate of candidates) {
		const existing = bestByUrl.get(candidate.url);
		if (!existing || candidate.score > existing.score) {
			bestByUrl.set(candidate.url, candidate);
		}
	}

	return [...bestByUrl.values()];
}

function buildCandidate(
	urlString: string,
	text: string,
	source: Candidate['source'],
	subject: string,
	senderDomain: string | null,
): Candidate {
	const url = new URL(urlString);
	const normalizedText = normalizeComparisonText(text);
	const normalizedSubject = normalizeComparisonText(subject);
	const subjectWords = subjectWordSet(normalizedSubject);
	const pathWords = subjectWordSet(normalizeComparisonText(`${url.hostname} ${url.pathname}`));
	let score = 0;

	if (source === 'canonical') score += 1000;
	if (source === 'og') score += 950;
	if (source === 'view-in-browser') score += 650;
	if (source === 'anchor') score += 150;
	if (source === 'text') score += 25;

	if (normalizedText && normalizedText === normalizedSubject) score += 500;
	if (normalizedText && normalizedText.length >= 24 && (normalizedText.includes(normalizedSubject) || normalizedSubject.includes(normalizedText))) {
		score += 325;
	}

	if (VIEW_IN_BROWSER_TEXT.test(normalizedText)) {
		score += 250;
	}

	const overlappingTextWords = countWordOverlap(subjectWords, subjectWordSet(normalizedText));
	score += Math.min(overlappingTextWords * 80, 400);

	const overlappingPathWords = countWordOverlap(subjectWords, pathWords);
	score += Math.min(overlappingPathWords * 30, 180);

	if (url.pathname !== '/' && url.pathname !== '') {
		score += 40;
	}

	if (senderDomain && url.hostname === senderDomain) {
		score += 80;
	}

	if (isLikelyBadCandidate(url, normalizedText) && score < 700) {
		score -= 1000;
	}

	return { url: url.toString(), text, source, score };
}

function isLikelyBadCandidate(url: URL, normalizedText: string): boolean {
	if (!/^https?:$/.test(url.protocol)) {
		return true;
	}

	if (BAD_HOST.test(url.hostname)) {
		return true;
	}

	if (BAD_URL.test(`${url.hostname}${url.pathname}${url.search}`)) {
		return true;
	}

	if (normalizedText && BAD_TEXT.test(normalizedText) && !VIEW_IN_BROWSER_TEXT.test(normalizedText)) {
		return true;
	}

	return false;
}

function normalizeCandidateUrl(value: string | undefined): string | null {
	if (!value) {
		return null;
	}

	const decoded = decodeHtmlEntities(value).trim();
	if (!decoded) {
		return null;
	}

	let url: URL;
	try {
		url = new URL(decoded);
	} catch {
		return null;
	}

	if (!/^https?:$/.test(url.protocol)) {
		return null;
	}

	const redirected = unwrapRedirectUrl(url) ?? url;
	return redirected.toString();
}

function unwrapRedirectUrl(url: URL): URL | null {
	for (const key of ['url', 'u', 'redirect', 'redirect_url', 'redirect_uri', 'destination', 'dest', 'next']) {
		const nested = url.searchParams.get(key);
		if (!nested) {
			continue;
		}
		try {
			const parsed = new URL(decodeHtmlEntities(nested));
			if (/^https?:$/.test(parsed.protocol)) {
				return parsed;
			}
		} catch {
			// Ignore malformed nested redirects.
		}
	}

	if (url.hostname === 'substack.com' && url.pathname.startsWith('/redirect/2/')) {
		const token = url.pathname.slice('/redirect/2/'.length).split('/')[0];
		try {
			const payload = JSON.parse(decodeBase64Url(token)) as { e?: string };
			if (payload.e) {
				const parsed = new URL(payload.e);
				if (/^https?:$/.test(parsed.protocol)) {
					return parsed;
				}
			}
		} catch {
			// Ignore invalid Substack redirect payloads.
		}
	}

	return null;
}

function parseTagAttributes(tag: string): Record<string, string> {
	const attrs: Record<string, string> = {};

	for (const match of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
		const [, rawName, doubleQuoted, singleQuoted, bare] = match;
		attrs[rawName.toLowerCase()] = decodeHtmlEntities(doubleQuoted ?? singleQuoted ?? bare ?? '');
	}

	return attrs;
}

function stripHtml(value: string): string {
	return value.replace(/<[^>]+>/g, ' ');
}

function normalizeComparisonText(value: string): string {
	return decodeHtmlEntities(value)
		.toLowerCase()
		.replace(/&/g, ' and ')
		.replace(/[’'"]/g, '')
		.replace(SUBJECT_TOKEN_SPLIT, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function subjectWordSet(value: string): Set<string> {
	return new Set(value.split(' ').filter((token) => token.length >= 4));
}

function countWordOverlap(left: Set<string>, right: Set<string>): number {
	let count = 0;
	for (const token of left) {
		if (right.has(token)) {
			count += 1;
		}
	}
	return count;
}

function extractSenderDomain(fromAddress: string | null | undefined): string | null {
	if (!fromAddress || !fromAddress.includes('@')) {
		return null;
	}

	return fromAddress.split('@')[1]?.toLowerCase() || null;
}

function decodeBase64Url(input: string): string {
	const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
	const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
	return atob(padded);
}

function decodeHtmlEntities(value: string): string {
	return value
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
		.replace(/&#([0-9]+);/g, (_, decimal: string) => safeCodePoint(parseInt(decimal, 10)));
}

function safeCodePoint(value: number): string {
	if (!Number.isFinite(value) || value <= 0 || value > 0x10ffff) {
		return '';
	}

	try {
		return String.fromCodePoint(value);
	} catch {
		return '';
	}
}
