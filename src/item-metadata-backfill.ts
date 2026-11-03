/**
 * Hourly backfills for reading-length metadata on items stored before v16.
 *
 * Both jobs run at the end of the cron within the shared D1 query budget and
 * a small CPU budget: word counts read at most BACKFILL_BYTE_BUDGET body
 * characters per run, and durations make one YouTube API call per run.
 * Each write bumps content_version and fires the article sync trigger once,
 * so clients pick the value up through their normal refresh.
 */

import { fetchBoundedFeedResource } from './feed-network';
import type { RefreshQueryBudget } from './rss-fetcher';
import { WORD_COUNT_SOURCE_LIMIT, countItemWords } from './word-count';
import { extractYouTubeVideoId, mediaKindForUrl } from './youtube';

export const BACKFILL_CANDIDATE_LIMIT = 100;
// Keeps the scan to a few milliseconds next to the feed refreshes.
export const BACKFILL_BYTE_BUDGET = 500_000;
export const YOUTUBE_DURATION_BATCH = 50;

const YOUTUBE_VIDEOS_API_URL = 'https://www.googleapis.com/youtube/v3/videos';
const YOUTUBE_API_MAX_BYTES = 200_000;
const YOUTUBE_API_TIMEOUT_MS = 5_000;

interface WordCountCandidate {
	id: string;
	original_url: string | null;
	html_len: number | null;
	text_len: number | null;
}

interface WordCountBody {
	id: string;
	html: string | null;
	text: string | null;
}

export async function runWordCountBackfill(db: D1Database, budget: RefreshQueryBudget): Promise<number> {
	if (!budget.reserve(3)) return 0;
	const { results: candidates } = await db.prepare(
		`SELECT id, original_url, length(html_content) AS html_len, length(text_content) AS text_len
		 FROM items
		 WHERE word_count IS NULL AND content_pruned_at IS NULL
		 ORDER BY received_at DESC
		 LIMIT ?`,
	).bind(BACKFILL_CANDIDATE_LIMIT).all<WordCountCandidate>();

	const chosen: WordCountCandidate[] = [];
	let bytes = 0;
	for (const candidate of candidates) {
		const length = Math.min(candidate.html_len || candidate.text_len || 0, WORD_COUNT_SOURCE_LIMIT);
		if (chosen.length > 0 && bytes + length > BACKFILL_BYTE_BUDGET) break;
		chosen.push(candidate);
		bytes += length;
	}
	if (chosen.length === 0) {
		budget.refund(2);
		return 0;
	}

	const { results: bodies } = await db.prepare(
		`SELECT id,
		        substr(html_content, 1, ?) AS html,
		        CASE WHEN html_content = '' THEN substr(text_content, 1, ?) END AS text
		 FROM items
		 WHERE id IN (SELECT value FROM json_each(?))`,
	).bind(WORD_COUNT_SOURCE_LIMIT, WORD_COUNT_SOURCE_LIMIT, JSON.stringify(chosen.map(({ id }) => id))).all<WordCountBody>();

	const urlById = new Map(chosen.map((candidate) => [candidate.id, candidate.original_url]));
	const updates = bodies.map((body) => ({
		id: body.id,
		w: countItemWords(body.html, body.text),
		m: mediaKindForUrl(urlById.get(body.id)),
	}));
	if (updates.length === 0) {
		budget.refund(1);
		return 0;
	}
	const result = await db.prepare(
		`UPDATE items
		 SET word_count = json_extract(u.value, '$.w'),
		     media_kind = COALESCE(items.media_kind, json_extract(u.value, '$.m')),
		     content_version = items.content_version + 1
		 FROM json_each(?) AS u
		 WHERE items.id = json_extract(u.value, '$.id') AND items.word_count IS NULL`,
	).bind(JSON.stringify(updates)).run();
	return result.meta?.changes ?? 0;
}

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
}

interface YouTubeVideosResponse {
	items?: Array<{ id?: unknown; contentDetails?: { duration?: unknown } }>;
}

export async function runYouTubeDurationBackfill(
	db: D1Database,
	budget: RefreshQueryBudget,
	apiKey: string | undefined,
): Promise<number> {
	const key = apiKey?.trim();
	if (!key || !budget.reserve(2)) return 0;
	const { results: candidates } = await db.prepare(
		`SELECT id, original_url
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
		url.searchParams.set('maxResults', String(YOUTUBE_DURATION_BATCH));
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
	// hides the label and stops the retry.
	const updates = candidates.map((candidate) => {
		const videoId = extractYouTubeVideoId(candidate.original_url);
		return { id: candidate.id, d: (videoId && durations.get(videoId)) ?? 0 };
	});
	const result = await db.prepare(
		`UPDATE items
		 SET duration_seconds = json_extract(u.value, '$.d'),
		     content_version = items.content_version + 1
		 FROM json_each(?) AS u
		 WHERE items.id = json_extract(u.value, '$.id') AND items.duration_seconds IS NULL`,
	).bind(JSON.stringify(updates)).run();
	return result.meta?.changes ?? 0;
}
