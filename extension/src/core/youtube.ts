/**
 * YouTube helpers, bundled straight from the Worker's own modules
 * (src/youtube.ts) so the extension and the server agree on video ids.
 */

import { extractYouTubeVideoId, parseYouTubeDuration } from '../../../src/youtube';

export const youtubeVideoId = extractYouTubeVideoId;

/** schema.org `duration` in whole seconds; null for P0D (premieres, live) or junk. */
export function parseIsoDuration(value: unknown): number | null {
	if (typeof value !== 'string') return null;
	const seconds = parseYouTubeDuration(value.trim().toUpperCase());
	return seconds !== null && seconds > 0 ? seconds : null;
}
