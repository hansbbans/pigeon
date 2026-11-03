/**
 * Hourly YouTube duration backfill for feed items marked as video.
 *
 * Runs at the end of the cron within the shared D1 query budget and makes one
 * YouTube API call per run. Each write bumps content_version and fires the
 * article sync trigger once; video items carry short descriptions, so the
 * resent bodies stay small.
 */

import { fetchBoundedFeedResource } from './feed-network';
import type { RefreshQueryBudget } from './rss-fetcher';
import { extractYouTubeVideoId } from './youtube';

export const YOUTUBE_DURATION_BATCH = 50;
// Premieres and live streams report P0D until they finish; keep asking for
// a week before settling on "unknown".
export const ZERO_DURATION_RETRY_MS = 7 * 24 * 60 * 60 * 1000;

const YOUTUBE_VIDEOS_API_URL = 'https://www.googleapis.com/youtube/v3/videos';
const YOUTUBE_API_MAX_BYTES = 200_000;
const YOUTUBE_API_TIMEOUT_MS = 5_000;

/** Seconds in an ISO 8601 YouTube duration ("PT1H2M3S", "P0D"), or null. */
export function parseYouTubeDuration(iso: string): number | null {
	const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso);
	if (!match || iso === 'P' || iso.endsWith('T')) return null;
	const [, days, hours, minutes, seconds] = match.map((part) => Number(part ?? 0));
	return days * 86_400 + hours * 3_600 + minutes * 60 + seconds;
}

interface VideoCandidate {
	id: string;
	original_url: string | null;
	received_at: string;
}

interface YouTubeVideosResponse {
	items?: Array<{ id?: unknown; contentDetails?: { duration?: unknown } }>;
}

export async function runYouTubeDurationBackfill(
	db: D1Database,
	budget: RefreshQueryBudget,
	apiKey: string | undefined,
	now: Date = new Date(),
): Promise<number> {
	const key = apiKey?.trim();
	if (!key || !budget.reserve(2)) return 0;
	const { results: candidates } = await db.prepare(
		`SELECT id, original_url, received_at
		 FROM items
		 WHERE media_kind = 'video' AND duration_seconds IS NULL
		 ORDER BY received_at DESC
		 LIMIT ?`,
	).bind(YOUTUBE_DURATION_BATCH).all<VideoCandidate>();
	if (candidates.length === 0) {
		budget.refund(1);
		return 0;
	}

	const videoIds = [...new Set(candidates.map((candidate) => extractYouTubeVideoId(candidate.original_url)).filter(
		(videoId): videoId is string => videoId !== null,
	))];
	const durations = new Map<string, number>();
	if (videoIds.length > 0) {
		const url = new URL(YOUTUBE_VIDEOS_API_URL);
		url.searchParams.set('part', 'contentDetails');
		url.searchParams.set('id', videoIds.join(','));
		try {
			const resource = await fetchBoundedFeedResource(url, {
				headers: { Accept: 'application/json', 'x-goog-api-key': key },
				maxBytes: YOUTUBE_API_MAX_BYTES,
				timeoutMs: YOUTUBE_API_TIMEOUT_MS,
				maxRedirects: 0,
			});
			if (!resource.response.ok) throw new Error(`HTTP ${resource.response.status}`);
			const parsed = JSON.parse(resource.text) as YouTubeVideosResponse;
			if (!Array.isArray(parsed.items)) throw new Error('missing items');
			for (const item of parsed.items) {
				const duration = typeof item.contentDetails?.duration === 'string'
					? parseYouTubeDuration(item.contentDetails.duration)
					: null;
				if (typeof item.id === 'string' && duration !== null) durations.set(item.id, duration);
			}
		} catch (error) {
			// Write nothing so the next run retries instead of storing unknowns.
			console.warn('[Cron] YouTube duration lookup failed', error instanceof Error ? error.message : String(error));
			budget.refund(1);
			return 0;
		}
	}

	// A video the API no longer returns (deleted, private) stores 0, which
	// hides the label and stops the retry. A zero duration from a recent item
	// is a premiere or live stream, so leave it for a later run.
	const updates = candidates.flatMap((candidate) => {
		const videoId = extractYouTubeVideoId(candidate.original_url);
		const duration = videoId ? durations.get(videoId) : undefined;
		const recent = now.getTime() - Date.parse(candidate.received_at) < ZERO_DURATION_RETRY_MS;
		if (duration === 0 && recent) return [];
		return [{ id: candidate.id, d: duration ?? 0 }];
	});
	if (updates.length === 0) {
		budget.refund(1);
		return 0;
	}
	const result = await db.prepare(
		`UPDATE items
		 SET duration_seconds = json_extract(u.value, '$.d'),
		     content_version = items.content_version + 1
		 FROM json_each(?) AS u
		 WHERE items.id = json_extract(u.value, '$.id') AND items.duration_seconds IS NULL`,
	).bind(JSON.stringify(updates)).run();
	return result.meta?.changes ?? 0;
}
