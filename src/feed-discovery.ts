import { requireApiAuth } from './api-auth';
import {
	assertSafeFeedUrl,
	fetchBoundedFeedResource,
	isHtmlContent,
	MAX_DISCOVERY_HTML_BYTES,
	MAX_FEED_BYTES,
} from './feed-network';
import { parseFeed, type FeedFormat } from './rss-parser';
import type { Env } from './types';

const DISCOVERY_USER_AGENT = 'Pigeon RSS Reader/1.0';
const MAX_DISCOVERY_CANDIDATES = 12;
const DISCOVERY_CONCURRENCY = 4;

export type FeedDiscoverySource = 'direct' | 'alternate' | 'fallback';

export interface FeedDiscoveryCandidate {
	url: string;
	title: string;
	format: FeedFormat;
	site_url: string | null;
	source: FeedDiscoverySource;
	score: number;
	aliases: string[];
}

export interface FeedDiscoveryResult {
	input_url: string;
	page_url: string | null;
	candidates: FeedDiscoveryCandidate[];
	failures: Array<{ url: string; reason: string }>;
}

interface CandidateUrl {
	url: URL;
	title?: string;
	source: Exclude<FeedDiscoverySource, 'direct'>;
	score: number;
}

export async function discoverFeeds(input: string): Promise<FeedDiscoveryResult> {
	const inputUrl = normalizeDiscoveryInput(input);
	const initial = await fetchBoundedFeedResource(inputUrl, {
		headers: { Accept: feedAcceptHeader(), 'User-Agent': DISCOVERY_USER_AGENT },
		maxBytes: MAX_FEED_BYTES,
		maxHtmlBytes: MAX_DISCOVERY_HTML_BYTES,
	});

	if (!initial.response.ok) {
		throw new Error(`Discovery URL returned HTTP ${initial.response.status}`);
	}

	try {
		const parsed = parseFeed(initial.text, {
			sourceUrl: initial.finalUrl.href,
			contentType: initial.contentType,
		});
		return {
			input_url: inputUrl.href,
			page_url: parsed.link ?? null,
			candidates: [
				candidateFromParsedFeed(
					initial.finalUrl,
					parsed,
					'direct',
					200,
					redirectAliases(inputUrl, initial.redirects, initial.finalUrl),
				),
			],
			failures: [],
		};
	} catch (error) {
		if (!isHtmlContent(initial.contentType, initial.text)) {
			throw new Error(`URL did not return a supported feed: ${errorMessage(error)}`);
		}
	}

	const candidateUrls = collectCandidateUrls(initial.text, initial.finalUrl).slice(
		0,
		MAX_DISCOVERY_CANDIDATES,
	);
	const candidates: FeedDiscoveryCandidate[] = [];
	const failures: Array<{ url: string; reason: string }> = [];

	await forEachConcurrent(candidateUrls, DISCOVERY_CONCURRENCY, async (candidateUrl) => {
		try {
			const resource = await fetchBoundedFeedResource(candidateUrl.url, {
				headers: { Accept: feedAcceptHeader(), 'User-Agent': DISCOVERY_USER_AGENT },
				maxBytes: MAX_FEED_BYTES,
				maxHtmlBytes: MAX_DISCOVERY_HTML_BYTES,
			});
			if (!resource.response.ok) {
				throw new Error(`HTTP ${resource.response.status}`);
			}
			const parsed = parseFeed(resource.text, {
				sourceUrl: resource.finalUrl.href,
				contentType: resource.contentType,
			});
			candidates.push(
				candidateFromParsedFeed(
					resource.finalUrl,
					parsed,
					candidateUrl.source,
					candidateUrl.score,
					redirectAliases(candidateUrl.url, resource.redirects, resource.finalUrl),
					candidateUrl.title,
				),
			);
		} catch (error) {
			failures.push({ url: candidateUrl.url.href, reason: redactedFailure(error) });
		}
	});

	const uniqueCandidates = deduplicateCandidates(candidates).sort(
		(left, right) => right.score - left.score || left.url.localeCompare(right.url),
	);
	if (uniqueCandidates.length === 0) {
		throw new Error('No supported feed was found at this website');
	}

	return {
		input_url: inputUrl.href,
		page_url: initial.finalUrl.href,
		candidates: uniqueCandidates,
		failures: failures.slice(0, MAX_DISCOVERY_CANDIDATES),
	};
}

export async function handleFeedDiscovery(request: Request, env: Env): Promise<Response> {
	const authError = await requireApiAuth(request, env.API_PASSWORD);
	if (authError) return authError;

	let body: { url?: unknown };
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: 'Invalid JSON' }, { status: 400 });
	}

	if (typeof body.url !== 'string' || body.url.trim() === '') {
		return Response.json({ error: 'Missing url field' }, { status: 400 });
	}

	try {
		return Response.json(await discoverFeeds(body.url));
	} catch (error) {
		return Response.json({ error: redactedFailure(error) }, { status: 400 });
	}
}

export function collectCandidateUrls(html: string, pageUrl: URL): CandidateUrl[] {
	const discovered: CandidateUrl[] = [];
	const seen = new Set<string>();
	const linkPattern = /<link\b([^>]*)>/gi;
	let match: RegExpExecArray | null;
	while ((match = linkPattern.exec(html)) !== null) {
		const attributes = parseHtmlAttributes(match[1]);
		const relationships = (attributes.rel ?? '')
			.toLowerCase()
			.split(/\s+/)
			.filter(Boolean);
		const type = (attributes.type ?? '').toLowerCase();
		if (!relationships.includes('alternate') || !isFeedMimeType(type) || !attributes.href) continue;
		addCandidate(discovered, seen, attributes.href, pageUrl, {
			title: attributes.title,
			source: 'alternate',
			score: alternateScore(type),
		});
	}

	for (const [path, score] of [
		['/feed/', 60],
		['/index.xml', 55],
		['/rss.xml', 50],
		['/atom.xml', 45],
	] as const) {
		addCandidate(discovered, seen, path, pageUrl, { source: 'fallback', score });
	}

	return discovered;
}

function addCandidate(
	candidates: CandidateUrl[],
	seen: Set<string>,
	href: string,
	pageUrl: URL,
	metadata: Omit<CandidateUrl, 'url'>,
): void {
	try {
		const url = assertSafeFeedUrl(new URL(decodeHtmlEntities(href), pageUrl));
		if (seen.has(url.href)) return;
		seen.add(url.href);
		candidates.push({ url, ...metadata });
	} catch {
		// A broken or unsafe alternate link should not invalidate other candidates.
	}
}

function parseHtmlAttributes(source: string): Record<string, string> {
	const attributes: Record<string, string> = {};
	const attributePattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
	let match: RegExpExecArray | null;
	while ((match = attributePattern.exec(source)) !== null) {
		attributes[match[1].toLowerCase()] = decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? '');
	}
	return attributes;
}

function candidateFromParsedFeed(
	url: URL,
	parsed: ReturnType<typeof parseFeed>,
	source: FeedDiscoverySource,
	score: number,
	aliases: string[],
	discoveredTitle?: string,
): FeedDiscoveryCandidate {
	return {
		url: url.href,
		title: parsed.title === 'Untitled Feed' && discoveredTitle ? discoveredTitle : parsed.title,
		format: parsed.format,
		site_url: parsed.link ?? null,
		source,
		score,
		aliases,
	};
}

function deduplicateCandidates(candidates: FeedDiscoveryCandidate[]): FeedDiscoveryCandidate[] {
	const byUrl = new Map<string, FeedDiscoveryCandidate>();
	for (const candidate of candidates) {
		const existing = byUrl.get(candidate.url);
		if (!existing || candidate.score > existing.score) {
			byUrl.set(candidate.url, candidate);
		} else {
			existing.aliases = [...new Set([...existing.aliases, ...candidate.aliases])].sort();
		}
	}
	return [...byUrl.values()];
}

function redirectAliases(input: URL, redirects: URL[], finalUrl: URL): string[] {
	return [...new Set([input.href, ...redirects.map((url) => url.href)])]
		.filter((url) => url !== finalUrl.href)
		.sort();
}

function normalizeDiscoveryInput(input: string): URL {
	const trimmed = input.trim();
	if (!trimmed) throw new Error('Feed URL is required');
	const withScheme = /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
	return assertSafeFeedUrl(withScheme);
}

function isFeedMimeType(type: string): boolean {
	return (
		type.includes('rss') ||
		type.includes('atom') ||
		type.includes('rdf') ||
		type.includes('feed+json') ||
		type === 'application/json' ||
		type === 'text/xml' ||
		type === 'application/xml'
	);
}

function alternateScore(type: string): number {
	if (type.includes('rss')) return 120;
	if (type.includes('atom')) return 115;
	if (type.includes('json')) return 110;
	return 100;
}

function feedAcceptHeader(): string {
	return 'application/rss+xml, application/atom+xml, application/feed+json, application/rdf+xml, application/xml, text/xml, text/html;q=0.8, */*;q=0.1';
}

function decodeHtmlEntities(value: string): string {
	return value
		.replaceAll('&amp;', '&')
		.replaceAll('&quot;', '"')
		.replaceAll('&#39;', "'")
		.replaceAll('&lt;', '<')
		.replaceAll('&gt;', '>');
}

function redactedFailure(error: unknown): string {
	const message = errorMessage(error).replace(/https?:\/\/[^\s)]+/gi, '[feed URL]');
	return message.slice(0, 240);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function forEachConcurrent<T>(
	values: T[],
	concurrency: number,
	operation: (value: T) => Promise<void>,
): Promise<void> {
	let nextIndex = 0;
	const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
		while (nextIndex < values.length) {
			const index = nextIndex;
			nextIndex += 1;
			await operation(values[index]);
		}
	});
	await Promise.all(workers);
}
