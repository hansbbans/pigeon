/**
 * Small, credential-free helpers for the public YouTube URLs Pigeon accepts.
 *
 * These checks intentionally use exact host allow-lists while discovering a
 * channel's published Atom feed and normalizing its entries.
 */

const YOUTUBE_PAGE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
const YOUTUBE_CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{22}$/;
const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

export const YOUTUBE_FEED_PATH = '/feeds/videos.xml';
export const YOUTUBE_DISCOVERY_HTML_BYTES = 2_000_000;

export function isYouTubePageHost(hostname: string): boolean {
	return YOUTUBE_PAGE_HOSTS.has(hostname.toLowerCase().replace(/\.$/, ''));
}

export function isYouTubeChannelId(value: string): boolean {
	return YOUTUBE_CHANNEL_ID_PATTERN.test(value);
}

export function isYouTubeVideoId(value: string): boolean {
	return YOUTUBE_VIDEO_ID_PATTERN.test(value);
}

export function youtubeChannelFeedUrl(channelId: string): URL {
	if (!isYouTubeChannelId(channelId)) {
		throw new Error('Invalid YouTube channel ID');
	}

	const url = new URL(`https://www.youtube.com${YOUTUBE_FEED_PATH}`);
	url.searchParams.set('channel_id', channelId);
	return url;
}

/**
 * Returns the canonical official Atom feed URL for a direct YouTube feed
 * URL, or null for other YouTube pages. Playlist URLs are deliberately not
 * rewritten because this workflow supports published channel Atom feeds.
 */
export function canonicalizeYouTubeFeedUrl(input: string | URL): URL | null {
	const url = toUrl(input);
	if (!url || !isYouTubePageHost(url.hostname) || url.pathname !== YOUTUBE_FEED_PATH) {
		return null;
	}

	const channelId = url.searchParams.get('channel_id');
	if (!channelId || !isYouTubeChannelId(channelId)) {
		return null;
	}

	return youtubeChannelFeedUrl(channelId);
}

/**
 * Extract a channel ID from the stable /channel/ form or a direct Atom feed.
 * Handles, /user/, and /c/ pages need bounded HTML discovery because their
 * channel IDs are not encoded in the URL.
 */
export function extractYouTubeChannelId(input: string | URL): string | null {
	const url = toUrl(input);
	if (!url || !isYouTubePageHost(url.hostname)) {
		return null;
	}

	const canonicalFeed = canonicalizeYouTubeFeedUrl(url);
	if (canonicalFeed) {
		return canonicalFeed.searchParams.get('channel_id');
	}

	const parts = url.pathname.split('/').filter(Boolean);
	if (parts[0]?.toLowerCase() !== 'channel' || !parts[1]) {
		return null;
	}

	let channelId: string;
	try {
		channelId = decodeURIComponent(parts[1]);
	} catch {
		return null;
	}
	return isYouTubeChannelId(channelId) ? channelId : null;
}

export function isYouTubeChannelPageUrl(input: string | URL): boolean {
	const url = toUrl(input);
	if (!url || !isYouTubePageHost(url.hostname)) {
		return false;
	}

	const [firstSegment] = url.pathname.split('/').filter(Boolean);
	return ['channel', 'user', 'c'].includes(firstSegment?.toLowerCase() ?? '') ||
		(firstSegment?.startsWith('@') ?? false);
}

/** Parse an HTTP(S) URL while rejecting credentials and nonstandard ports. */
function toUrl(input: string | URL): URL | null {
	try {
		const url = input instanceof URL ? new URL(input.href) : new URL(input);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
		if (url.username || url.password || url.port) return null;
		return url;
	} catch {
		return null;
	}
}
