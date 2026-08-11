import { scoreRecommendation, type ScoringEventType, type SignalSummary } from './scoring';
import type { Env } from './types';

export type RecommendationView = 'for-you' | 'unread' | 'starred';

interface RecommendationRow {
	rowid: number;
	id: string;
	feed_key: string;
	source: string;
	title: string;
	html_content: string;
	text_content: string | null;
	original_url: string | null;
	received_at: string;
	is_read: number;
	is_starred: number;
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
		        i.subject AS title, i.html_content, i.text_content, i.original_url,
		        i.received_at, i.is_read, i.is_starred
		   FROM items i
		   JOIN feeds f ON f.feed_key = i.feed_key
		  WHERE f.is_active = 1 ${where}
		  ORDER BY i.received_at DESC, i.rowid DESC
		  LIMIT ?`,
	)
		.bind(Math.max(limit, 100))
		.all<RecommendationRow>();

	if (candidates.length === 0) {
		return Response.json({ generatedAt: new Date().toISOString(), view, items: [] });
	}

	const { results: signalRows } = await env.DB.prepare(
		`SELECT item_id, feed_key, event_type, COUNT(*) AS count,
		        SUM(COALESCE(duration_seconds, 0)) AS duration_seconds,
		        MAX(COALESCE(scroll_depth, 0)) AS max_scroll_depth
		   FROM engagement_events
		  WHERE event_type <> 'bulk_mark_all_read'
		  GROUP BY item_id, feed_key, event_type`,
	).all<SignalRow>();

	const feedSignals = new Map<string, SignalSummary>();
	const itemSignals = new Map<string, SignalSummary>();
	for (const row of signalRows) {
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

	const now = new Date().toISOString();
	const items = candidates.map((candidate) => {
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
			html: candidate.html_content,
			text: candidate.text_content,
			originalURL: candidate.original_url,
			receivedAt: candidate.received_at,
			isRead: candidate.is_read === 1,
			isStarred: candidate.is_starred === 1,
			...scoring,
		};
	});

	items.sort((left, right) => {
		if (view === 'for-you' && right.score !== left.score) {
			return right.score - left.score;
		}
		return right.receivedAt.localeCompare(left.receivedAt) || left.id.localeCompare(right.id);
	});

	return Response.json({ generatedAt: now, view, items: items.slice(0, limit) });
}
