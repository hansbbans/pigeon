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

/**
 * Recognize only official YouTube URL shapes before constructing an embed.
 * Self-contained: the browser client emits it via toString(), so the reader
 * makes the same decision without permitting arbitrary iframe destinations.
 */
export function extractYouTubeVideoId(originalUrl: string | undefined | null): string | null {
	if (!originalUrl) return null;

	let url: URL;
	try {
		url = new URL(originalUrl);
	} catch {
		return null;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
	if (url.username || url.password || url.port) return null;

	const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
	const pageHosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
	const shortHosts = new Set(['youtu.be']);
	if (!pageHosts.has(hostname) && !shortHosts.has(hostname)) return null;

	const parts = url.pathname.split('/').filter(Boolean);
	let candidate: string | null = null;
	if (shortHosts.has(hostname)) {
		candidate = parts.length === 1 ? parts[0] ?? null : null;
	} else {
		switch (parts[0]?.toLowerCase()) {
			case 'watch':
				candidate = parts.length === 1 ? url.searchParams.get('v') : null;
				break;
			case 'shorts':
			case 'embed':
			case 'live':
			case 'v':
				candidate = parts.length === 2 ? parts[1] ?? null : null;
				break;
		}
	}

	return candidate && /^[A-Za-z0-9_-]{11}$/.test(candidate) ? candidate : null;
}

export type MediaKind = 'text' | 'video';

/**
 * Items from a YouTube channel feed that link to a video are videos. Other
 * feeds that merely link to YouTube (link blogs) stay text: their length is
 * the commentary the reader reads.
 */
export function mediaKindForFeedItem(feedSourceUrl: string | null | undefined, itemUrl: string | null | undefined): MediaKind {
	const fromYouTubeFeed = Boolean(feedSourceUrl && canonicalizeYouTubeFeedUrl(feedSourceUrl));
	return fromYouTubeFeed && extractYouTubeVideoId(itemUrl) ? 'video' : 'text';
}
