import { requireApiAuth } from './api-auth';
import { assertSafeFeedUrl, fetchBoundedFeedResource } from './feed-network';
import { discoverFeeds } from './feed-discovery';
import type { Env } from './types';
import {
	canonicalizeYouTubeFeedUrl,
	isYouTubeChannelId,
	youtubeChannelFeedUrl,
} from './youtube';

const YOUTUBE_API_URL = 'https://www.googleapis.com/youtube/v3/search';
const YOUTUBE_API_MAX_RESULTS = 8;
const YOUTUBE_API_MAX_BYTES = 512_000;
const YOUTUBE_API_TIMEOUT_MS = 8_000;
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1_000;
const SEARCH_CACHE_MAX_ENTRIES = 64;
const HANDLE_PATTERN = /^@?([A-Za-z0-9._-]{2,30})$/;
const CHANNEL_SEARCH_UNAVAILABLE_MESSAGE = 'YouTube channel search is temporarily unavailable.';
const HANDLE_SEARCH_HINT = 'Search by @handle or paste a channel link.';

export interface YouTubeChannelSearchResult {
	id: string;
	title: string;
	description: string;
	channelUrl: string;
	feedUrl: string;
	thumbnailUrl: string | null;
}

export interface YouTubeChannelSearchResponse {
	channels: YouTubeChannelSearchResult[];
	mode: 'search' | 'handle';
	message: string | null;
}

interface SearchCacheEntry {
	expiresAt: number;
	value: YouTubeChannelSearchResponse;
}

interface YouTubeSearchApiItem {
	id?: {
		kind?: unknown;
		channelId?: unknown;
	};
	snippet?: {
		title?: unknown;
		description?: unknown;
		thumbnails?: unknown;
	};
}

interface YouTubeSearchApiResponse {
	items?: unknown;
}

const searchCache = new Map<string, SearchCacheEntry>();

/**
 * Authenticated channel lookup used by Add Feed. A configured API key enables
 * broad official search; without one, an exact handle is resolved through
 * YouTube's published channel Atom alternate link.
 */
export async function handleYouTubeChannelSearch(
	request: Request,
	env: Env,
): Promise<Response> {
	const authError = await requireApiAuth(request, env.API_PASSWORD);
	if (authError) return authError;

	const query = normalizeQuery(new URL(request.url).searchParams.get('q'));
	if (!query || query.length < 2 || query.length > 100) {
		return jsonResponse(
			{
				channels: [],
				mode: 'search',
				message: 'Search query must be between 2 and 100 characters.',
			},
			400,
		);
	}

	const apiKey = typeof env.YOUTUBE_API_KEY === 'string' ? env.YOUTUBE_API_KEY.trim() : '';
	const handle = HANDLE_PATTERN.exec(query)?.[1]?.toLowerCase() ?? null;
	const mode = apiKey ? 'search' : 'handle';
	const cacheKey = `${mode}:${query.toLowerCase()}`;
	const cached = readCachedResult(cacheKey);
	if (cached) return jsonResponse(cached);

	let result: YouTubeChannelSearchResponse;
	if (apiKey) {
		result = await searchWithYouTubeApi(query, apiKey);
	} else if (handle) {
		result = await searchHandle(handle);
	} else {
		result = {
			channels: [],
			mode: 'handle',
			message: HANDLE_SEARCH_HINT,
		};
	}

	if (result.message !== CHANNEL_SEARCH_UNAVAILABLE_MESSAGE) {
		writeCachedResult(cacheKey, result);
	}
	return jsonResponse(result, result.message === CHANNEL_SEARCH_UNAVAILABLE_MESSAGE ? 503 : 200);
}

/** Clear process-local results between isolated tests or key rotations. */
export function clearYouTubeChannelSearchCache(): void {
	searchCache.clear();
}

async function searchWithYouTubeApi(
	query: string,
	apiKey: string,
): Promise<YouTubeChannelSearchResponse> {
	const apiUrl = new URL(YOUTUBE_API_URL);
	apiUrl.searchParams.set('part', 'snippet');
	apiUrl.searchParams.set('type', 'channel');
	apiUrl.searchParams.set('q', query);
	apiUrl.searchParams.set('maxResults', String(YOUTUBE_API_MAX_RESULTS));

	try {
		const resource = await fetchBoundedFeedResource(apiUrl, {
			headers: {
				Accept: 'application/json',
				'User-Agent': 'Pigeon RSS Reader/1.0',
				'x-goog-api-key': apiKey,
			},
			maxBytes: YOUTUBE_API_MAX_BYTES,
			timeoutMs: YOUTUBE_API_TIMEOUT_MS,
			maxRedirects: 0,
		});
		if (!resource.response.ok) return unavailableSearchResult();

		const parsed = JSON.parse(resource.text) as YouTubeSearchApiResponse;
		if (!Array.isArray(parsed.items)) return unavailableSearchResult();

		const channels: YouTubeChannelSearchResult[] = [];
		const seenIds = new Set<string>();
		for (const rawItem of parsed.items.slice(0, YOUTUBE_API_MAX_RESULTS)) {
			const item = asSearchApiItem(rawItem);
			const id = typeof item?.id?.channelId === 'string' ? item.id.channelId : null;
			if (!id || !isYouTubeChannelId(id) || seenIds.has(id)) continue;
			seenIds.add(id);

			const snippet = item?.snippet;
			channels.push({
				id,
				title: typeof snippet?.title === 'string' ? snippet.title : '',
				description: typeof snippet?.description === 'string' ? snippet.description : '',
				channelUrl: youtubeChannelUrl(id),
				feedUrl: youtubeChannelFeedUrl(id).href,
				thumbnailUrl: safeThumbnailUrl(snippet?.thumbnails),
			});
		}

		return {
			channels,
			mode: 'search',
			message: channels.length > 0 ? null : 'No YouTube channels found.',
		};
	} catch {
		// Keep upstream URLs, response bodies, and credentials out of the API response.
		return unavailableSearchResult();
	}
}

async function searchHandle(handle: string): Promise<YouTubeChannelSearchResponse> {
	try {
		const discovery = await discoverFeeds(`https://www.youtube.com/@${handle}`);
		for (const candidate of discovery.candidates) {
			const canonicalFeed = canonicalizeYouTubeFeedUrl(candidate.url);
			const channelId = canonicalFeed?.searchParams.get('channel_id') ?? null;
			if (!canonicalFeed || !channelId || !isYouTubeChannelId(channelId)) continue;

			return {
				channels: [
					{
						id: channelId,
						title: candidate.title,
						description: '',
						channelUrl: youtubeHandleUrl(handle),
						feedUrl: canonicalFeed.href,
						thumbnailUrl: null,
					},
				],
				mode: 'handle',
				message: null,
			};
		}

		return noHandleMatchResult();
	} catch (error) {
		return isNoHandleMatchError(error) ? noHandleMatchResult() : unavailableHandleResult();
	}
}

function normalizeQuery(value: string | null): string | null {
	if (typeof value !== 'string') return null;
	const normalized = value.trim();
	return normalized || null;
}

function asSearchApiItem(value: unknown): YouTubeSearchApiItem | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const item = value as Record<string, unknown>;
	const id = item.id;
	const snippet = item.snippet;
	return {
		id: id && typeof id === 'object' && !Array.isArray(id) ? (id as YouTubeSearchApiItem['id']) : undefined,
		snippet:
			snippet && typeof snippet === 'object' && !Array.isArray(snippet)
				? (snippet as YouTubeSearchApiItem['snippet'])
				: undefined,
	};
}

function safeThumbnailUrl(value: unknown): string | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const thumbnails = value as Record<string, unknown>;
	for (const key of ['maxres', 'high', 'medium', 'default']) {
		const candidate = thumbnails[key];
		if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
		const url = (candidate as Record<string, unknown>).url;
		if (typeof url !== 'string') continue;
		try {
			const parsed = assertSafeFeedUrl(url);
			if (
				parsed.protocol === 'https:' &&
				['i.ytimg.com', 'yt3.ggpht.com', 'yt3.googleusercontent.com'].includes(parsed.hostname)
			) {
				return parsed.href;
			}
		} catch {
			// Invalid or untrusted thumbnail URLs are represented as null.
		}
	}
	return null;
}

function youtubeChannelUrl(channelId: string): string {
	return `https://www.youtube.com/channel/${channelId}`;
}

function youtubeHandleUrl(handle: string): string {
	return `https://www.youtube.com/@${handle}`;
}

function isNoHandleMatchError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /HTTP (?:404|410)\b|No supported feed was found|did not return a supported feed/i.test(message);
}

function unavailableSearchResult(): YouTubeChannelSearchResponse {
	return { channels: [], mode: 'search', message: CHANNEL_SEARCH_UNAVAILABLE_MESSAGE };
}

function unavailableHandleResult(): YouTubeChannelSearchResponse {
	return { channels: [], mode: 'handle', message: CHANNEL_SEARCH_UNAVAILABLE_MESSAGE };
}

function noHandleMatchResult(): YouTubeChannelSearchResponse {
	return { channels: [], mode: 'handle', message: 'No YouTube channel found for that handle.' };
}

function readCachedResult(key: string): YouTubeChannelSearchResponse | null {
	const entry = searchCache.get(key);
	if (!entry) return null;
	if (entry.expiresAt <= Date.now()) {
		searchCache.delete(key);
		return null;
	}
	return entry.value;
}

function writeCachedResult(key: string, value: YouTubeChannelSearchResponse): void {
	if (searchCache.size >= SEARCH_CACHE_MAX_ENTRIES && !searchCache.has(key)) {
		const oldestKey = searchCache.keys().next().value;
		if (oldestKey) searchCache.delete(oldestKey);
	}
	searchCache.delete(key);
	searchCache.set(key, { expiresAt: Date.now() + SEARCH_CACHE_TTL_MS, value });
}

function jsonResponse(value: YouTubeChannelSearchResponse, status = 200): Response {
	const body = status >= 400 ? { ...value, error: value.message ?? 'Request failed.' } : value;
	return Response.json(body, {
		status,
		headers: {
			'Cache-Control': status >= 400 ? 'no-store' : 'private, max-age=60',
		},
	});
}
