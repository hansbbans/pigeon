import { scoreRecommendation, type ScoringEventType, type SignalSummary } from './scoring';
import type { Env } from './types';

export type RecommendationView = 'for-you' | 'unread' | 'starred';

interface RecommendationCandidate {
	rowid: number;
	id: string;
	feed_key: string;
	source: string;
	title: string;
	original_url: string | null;
	received_at: string;
	is_read: number;
	is_starred: number;
}

interface RecommendationContentRow {
	id: string;
	html_content: string;
	text_content: string | null;
}

interface SignalRow {
	item_id: string | null;
	feed_key: string | null;
	event_type: string;
	count: number;
	duration_seconds: number | null;
	max_scroll_depth: number | null;
}

const VALID_VIEWS: readonly RecommendationView[] = ['for-you', 'unread', 'starred'];
const SCORING_EVENT_TYPES: readonly ScoringEventType[] = [
	'explicit_open',
	'active_reading',
	'scroll_depth',
	'outbound_link',
	'star',
	'unstar',
	'more_like_this',
	'not_interested',
	'read',
	'unread',
	'bulk_mark_all_read',
];

const CANDIDATE_POOL_SIZE = 100;
const MAX_IN_QUERY_BIND_PARAMS = 100;

function isScoringEventType(value: string): value is ScoringEventType {
	return SCORING_EVENT_TYPES.includes(value as ScoringEventType);
}

function parseView(raw: string | null): RecommendationView {
	return VALID_VIEWS.includes(raw as RecommendationView) ? (raw as RecommendationView) : 'for-you';
}

function parseLimit(raw: string | null): number {
	const parsed = Number.parseInt(raw ?? '30', 10);
	return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 50) : 30;
}

function toGoogleItemId(rowid: number): string {
	return `tag:google.com,2005:reader/item/${rowid.toString(16).padStart(16, '0')}`;
}

function chunkValues<T>(values: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < values.length; i += size) {
		chunks.push(values.slice(i, i + size));
	}
	return chunks;
}

const PER_ITEM_EVENT_CAPS: Record<ScoringEventType, number> = {
	explicit_open: 1,
	active_reading: 1,
	scroll_depth: 1,
	outbound_link: 1,
	star: 1,
	unstar: 1,
	more_like_this: 1,
	not_interested: 1,
	read: 1,
	unread: 1,
	bulk_mark_all_read: 0,
};

function evidenceForRow(eventType: ScoringEventType, count: number, durationSeconds: number, maxScrollDepth: number): number {
	if (eventType === 'bulk_mark_all_read') return 0;
	if (eventType === 'active_reading') return durationSeconds >= 10 ? 1 : 0;
	if (eventType === 'scroll_depth') return maxScrollDepth >= 0.25 ? 1 : 0;
	return Math.min(Math.max(count, 0), PER_ITEM_EVENT_CAPS[eventType]);
}

function addSignal(map: Map<string, SignalSummary>, key: string, row: SignalRow, eventType: ScoringEventType): void {
	const signals = map.get(key) ?? {};
	const count = Math.min(Math.max(Number(row.count) || 0, 0), PER_ITEM_EVENT_CAPS[eventType]);
	signals[eventType] = (signals[eventType] ?? 0) + count;
	if (eventType === 'active_reading') {
		signals.activeReadingSeconds = (signals.activeReadingSeconds ?? 0) + Math.min(Math.max(Number(row.duration_seconds) || 0, 0), 300);
	}
	if (eventType === 'scroll_depth') {
		signals.maxScrollDepth = Math.max(signals.maxScrollDepth ?? 0, Math.min(Math.max(Number(row.max_scroll_depth) || 0, 0), 1));
	}
	signals.evidenceCount = (signals.evidenceCount ?? 0) + evidenceForRow(
		eventType,
		Number(row.count) || 0,
		Number(row.duration_seconds) || 0,
		Number(row.max_scroll_depth) || 0,
	);
	map.set(key, signals);
}

async function loadSignalsForFeeds(
	env: Env,
	feedKeys: string[],
): Promise<{ feedSignals: Map<string, SignalSummary>; itemSignals: Map<string, SignalSummary> }> {
	const feedSignals = new Map<string, SignalSummary>();
	const itemSignals = new Map<string, SignalSummary>();
	if (feedKeys.length === 0) {
		return { feedSignals, itemSignals };
	}

	const uniqueFeedKeys = [...new Set(feedKeys)];
	const signalPages = await Promise.all(
		chunkValues(uniqueFeedKeys, MAX_IN_QUERY_BIND_PARAMS).map((feedKeyChunk) => {
			const placeholders = feedKeyChunk.map(() => '?').join(',');
			return env.DB.prepare(
				`SELECT item_id, feed_key, event_type, COUNT(*) AS count,
				        SUM(COALESCE(duration_seconds, 0)) AS duration_seconds,
				        MAX(COALESCE(scroll_depth, 0)) AS max_scroll_depth
				   FROM engagement_events
				  WHERE event_type <> 'bulk_mark_all_read'
				    AND feed_key IN (${placeholders})
				  GROUP BY item_id, feed_key, event_type`,
			)
				.bind(...feedKeyChunk)
				.all<SignalRow>();
		}),
	);

	for (const row of signalPages.flatMap((page) => page.results)) {
		if (!isScoringEventType(row.event_type) || row.event_type === 'bulk_mark_all_read') {
			continue;
		}
		if (row.feed_key) {
			addSignal(feedSignals, row.feed_key, row, row.event_type);
		}
		if (row.item_id) {
			addSignal(itemSignals, row.item_id, row, row.event_type);
		}
	}

	return { feedSignals, itemSignals };
}

async function loadRecommendationContent(
	env: Env,
	itemIds: string[],
): Promise<Map<string, { html: string; text: string | null }>> {
	const content = new Map<string, { html: string; text: string | null }>();
	if (itemIds.length === 0) {
		return content;
	}

	const uniqueItemIds = [...new Set(itemIds)];
	const pages = await Promise.all(
		chunkValues(uniqueItemIds, MAX_IN_QUERY_BIND_PARAMS).map((itemIdChunk) => {
			const placeholders = itemIdChunk.map(() => '?').join(',');
			return env.DB.prepare(
				`SELECT id, html_content, text_content
				   FROM items
				  WHERE id IN (${placeholders})`,
			)
				.bind(...itemIdChunk)
				.all<RecommendationContentRow>();
		}),
	);

	for (const row of pages.flatMap((page) => page.results)) {
		content.set(row.id, { html: row.html_content, text: row.text_content });
	}
	return content;
}

export async function handleRecommendations(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const view = parseView(url.searchParams.get('view'));
	const limit = parseLimit(url.searchParams.get('limit'));

	const where = view === 'for-you'
		? `AND i.is_read = 0
		   AND NOT EXISTS (
		     SELECT 1 FROM engagement_events excluded
		      WHERE excluded.item_id = i.id AND excluded.event_type = 'not_interested'
		   )`
		: view === 'unread'
			? 'AND i.is_read = 0'
			: 'AND i.is_starred = 1';
	const { results: candidates } = await env.DB.prepare(
		`SELECT i.rowid, i.id, i.feed_key,
		        COALESCE(f.custom_title, f.display_name) AS source,
		        i.subject AS title, i.original_url,
		        i.received_at, i.is_read, i.is_starred
		   FROM items i
		   JOIN feeds f ON f.feed_key = i.feed_key
		  WHERE f.is_active = 1 ${where}
		  ORDER BY i.received_at DESC, i.rowid DESC
		  LIMIT ?`,
	)
		.bind(Math.max(limit, CANDIDATE_POOL_SIZE))
		.all<RecommendationCandidate>();

	if (candidates.length === 0) {
		return Response.json({ generatedAt: new Date().toISOString(), view, items: [] });
	}

	const { feedSignals, itemSignals } = await loadSignalsForFeeds(
		env,
		candidates.map((candidate) => candidate.feed_key),
	);

	const now = new Date().toISOString();
	const ranked = candidates.map((candidate) => {
		const candidateFeedSignals = feedSignals.get(candidate.feed_key) ?? {};
		const candidateItemSignals = itemSignals.get(candidate.id) ?? {};
		const scoring = scoreRecommendation({
			receivedAt: candidate.received_at,
			now,
			isStarred: candidate.is_starred === 1,
			feedSignals: candidateFeedSignals,
			itemSignals: candidateItemSignals,
			// Each item/event kind contributes at most one confidence sample. Reading
			// heartbeats contribute duration, not repeated evidence.
			sampleCount: candidateFeedSignals.evidenceCount ?? 0,
		});

		return {
			id: candidate.id,
			readerId: toGoogleItemId(candidate.rowid),
			feedKey: candidate.feed_key,
			source: candidate.source,
			title: candidate.title,
			originalURL: candidate.original_url,
			receivedAt: candidate.received_at,
			isRead: candidate.is_read === 1,
			isStarred: candidate.is_starred === 1,
			...scoring,
		};
	});

	ranked.sort((left, right) => {
		if (view === 'for-you' && right.score !== left.score) {
			return right.score - left.score;
		}
		return right.receivedAt.localeCompare(left.receivedAt) || left.id.localeCompare(right.id);
	});

	const selected = ranked.slice(0, limit);
	const contentById = await loadRecommendationContent(
		env,
		selected.map((item) => item.id),
	);

	return Response.json({
		generatedAt: now,
		view,
		items: selected.map((item) => {
			const content = contentById.get(item.id);
			return {
				...item,
				html: content?.html ?? '',
				text: content?.text ?? null,
			};
		}),
	});
}
