/** YouTube helpers; the video-id rules mirror `extractYouTubeVideoId` in src/youtube.ts. */

const PAGE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
const SHORT_HOSTS = new Set(['youtu.be']);

export function youtubeVideoId(value: string | null | undefined): string | null {
	if (!value) return null;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
	if (url.username || url.password || url.port) return null;
	const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
	const parts = url.pathname.split('/').filter(Boolean);
	let candidate: string | null = null;
	if (SHORT_HOSTS.has(hostname)) {
		candidate = parts.length === 1 ? parts[0] ?? null : null;
	} else if (PAGE_HOSTS.has(hostname)) {
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

/** schema.org `duration` (ISO 8601, e.g. `PT1H2M3S`) in whole seconds; null for P0D or junk. */
export function parseIsoDuration(value: unknown): number | null {
	if (typeof value !== 'string') return null;
	const match = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(value.trim());
	if (!match || value.trim().toUpperCase() === 'PT' || value.trim().toUpperCase() === 'P') return null;
	const [, days, hours, minutes, seconds] = match.map((part) => (part === undefined ? 0 : Number(part)));
	const total = Math.round(days * 86_400 + hours * 3_600 + minutes * 60 + seconds);
	return total > 0 ? total : null;
}
