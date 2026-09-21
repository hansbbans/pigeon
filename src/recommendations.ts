import { scoreRecommendation, type ScoringEventType, type SignalSummary } from './scoring';
import {
	buildTopicProfile,
	extractTopicFeatures,
	MAX_TOPIC_EXCERPT_CHARS,
	scoreTopics,
	type TopicLearningEvent,
} from './topic-matching';
import { loadMonitoredTopics } from './topic-preferences';
import {
	htmlToBoundedText,
	MAX_RSS_TEXT_CONTENT_SIZE,
} from './rss-fetcher';
import type { Env } from './types';

export type RecommendationView = 'for-you' | 'unread' | 'starred';

interface RecommendationCandidate {
	rowid: number;
	id: string;
	feed_key: string;
	source: string;
	title: string;
	author: string | null;
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
const PER_FEED_CANDIDATE_LIMIT = 25;
const MAX_FEED_SLICES = 40;
const MAX_SIGNAL_HISTORY_ROWS = 2_000;
const MAX_TOPIC_HISTORY_ROWS = 600;
// Topic matching only consumes the first MAX_TOPIC_EXCERPT_CHARS of text. Keep
// enough source for markup-heavy entries to reach that excerpt without parsing
// an entire article for every candidate in a recommendation request.
const MAX_TOPIC_HTML_SOURCE_SIZE = MAX_TOPIC_EXCERPT_CHARS * 4;
const MAX_IN_QUERY_BIND_PARAMS = 100;
const TOPIC_LEARNING_EVENT_TYPES = ['more_like_this', 'star', 'not_interested', 'unstar', 'outbound_link'] as const;

interface RankedRecommendation {
	id: string;
	feedKey: string;
	source: string;
	title: string;
	receivedAt: string;
	score: number;
	sampleCount: number;
	explanation: string;
	matchedTopics?: string[];
	topicStrength?: number;
}

function compareCandidateRecency(left: RecommendationCandidate, right: RecommendationCandidate): number {
	return right.received_at.localeCompare(left.received_at) || left.id.localeCompare(right.id);
}

function compareRankedRecency(left: RankedRecommendation, right: RankedRecommendation): number {
	return right.receivedAt.localeCompare(left.receivedAt) || left.id.localeCompare(right.id);
}

function hasStrongTopicMatch(candidate: RankedRecommendation): boolean {
	return (candidate.topicStrength ?? 0) >= 12 || (candidate.matchedTopics?.length ?? 0) > 0;
}

export function selectDiverseRecommendations<T extends RankedRecommendation>(
	ranked: T[],
	limit: number,
): T[] {
	if (limit <= 0 || ranked.length === 0) return [];
	if (ranked.length <= limit) return ranked.slice(0, limit);
	const perFeedLimit = Math.max(2, Math.ceil(limit * 0.35));
	const exploration = limit >= 5
		? ranked.slice(limit).find((candidate) => candidate.sampleCount === 0 && !hasStrongTopicMatch(candidate))
		: undefined;
	const selected: T[] = [];
	const feedCounts = new Map<string, number>();
	const target = exploration ? limit - 1 : limit;
	const remaining = ranked.filter((candidate) => candidate.id !== exploration?.id);
	const titleFeatures = new Map<string, Set<string>>(
		remaining.map((candidate) => [candidate.id, extractTopicFeatures({ title: candidate.title })]),
	);
	const utilityById = new Map<string, number>(remaining.map((candidate) => [candidate.id, candidate.score]));
	const similarityBetween = (left: T, right: T): number => {
		const leftFeatures = titleFeatures.get(left.id) ?? new Set<string>();
		const rightFeatures = titleFeatures.get(right.id) ?? new Set<string>();
		let intersection = 0;
		for (const feature of leftFeatures) if (rightFeatures.has(feature)) intersection += 1;
		const similarity = leftFeatures.size === 0 || rightFeatures.size === 0
			? 0
			: intersection / (leftFeatures.size + rightFeatures.size - intersection);
		return similarity;
	};

	while (selected.length < target && remaining.length > 0) {
		const previous = selected.at(-1);
		const alternativeAvailable = remaining.some((candidate) => {
			if (candidate.feedKey === previous?.feedKey) return false;
			return (feedCounts.get(candidate.feedKey) ?? 0) < perFeedLimit || hasStrongTopicMatch(candidate);
		});
		let bestIndex = -1;
		let bestUtility = Number.NEGATIVE_INFINITY;
		for (let index = 0; index < remaining.length; index += 1) {
			const candidate = remaining[index];
			const feedCount = feedCounts.get(candidate.feedKey) ?? 0;
			const strongTopic = hasStrongTopicMatch(candidate);
			if (feedCount >= perFeedLimit && !strongTopic && alternativeAvailable) continue;

			let utility = utilityById.get(candidate.id) ?? candidate.score;
			if (previous?.feedKey === candidate.feedKey && alternativeAvailable && !strongTopic) {
				utility -= 5;
			}
			if (utility > bestUtility) {
				bestUtility = utility;
				bestIndex = index;
			}
		}

		if (bestIndex < 0) break;
		const [chosen] = remaining.splice(bestIndex, 1);
		selected.push(chosen);
		feedCounts.set(chosen.feedKey, (feedCounts.get(chosen.feedKey) ?? 0) + 1);
		if (selected.length < target) {
			for (const candidate of remaining) {
				const utility = utilityById.get(candidate.id) ?? candidate.score;
				utilityById.set(candidate.id, utility - similarityBetween(candidate, chosen) * 10);
			}
		}
	}

	// A soft cap is preferable to returning too few stories when one publisher
	// is all that exists. Strong topic matches can always pass the cap.
	for (const candidate of remaining) {
		if (selected.length >= target) break;
		if (selected.some((item) => item.id === candidate.id)) continue;
		selected.push(candidate);
		feedCounts.set(candidate.feedKey, (feedCounts.get(candidate.feedKey) ?? 0) + 1);
	}
	if (exploration) {
		selected.push({
			...exploration,
			explanation: `A fresh exploration pick from ${exploration.source} to keep recommendations varied.`,
		});
	}
	return selected.slice(0, limit);
}

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

function addSignal(
	map: Map<string, SignalSummary>,
	key: string,
	row: SignalRow,
	eventType: ScoringEventType,
	maxCount = PER_ITEM_EVENT_CAPS[eventType],
): void {
	const signals = map.get(key) ?? {};
	const count = Math.min(Math.max(Number(row.count) || 0, 0), maxCount);
	signals[eventType] = Math.min((signals[eventType] ?? 0) + count, maxCount);
	if (eventType === 'active_reading') {
		signals.activeReadingSeconds = (signals.activeReadingSeconds ?? 0) + Math.min(Math.max(Number(row.duration_seconds) || 0, 0), 300);
	}
	if (eventType === 'scroll_depth') {
		signals.maxScrollDepth = Math.max(signals.maxScrollDepth ?? 0, Math.min(Math.max(Number(row.max_scroll_depth) || 0, 0), 1));
	}
	signals.evidenceCount = Math.min(24, (signals.evidenceCount ?? 0) + evidenceForRow(
		eventType,
		Number(row.count) || 0,
		Number(row.duration_seconds) || 0,
		Number(row.max_scroll_depth) || 0,
	));
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
				`WITH recent_feed_events AS (
					SELECT item_id, feed_key, event_type, duration_seconds, scroll_depth
					  FROM engagement_events
					 WHERE event_type <> 'bulk_mark_all_read'
					   AND feed_key IN (${placeholders})
					 ORDER BY occurred_at DESC, id DESC
					 LIMIT ${MAX_SIGNAL_HISTORY_ROWS}
				)
				SELECT item_id, feed_key, event_type, COUNT(*) AS count,
				       SUM(COALESCE(duration_seconds, 0)) AS duration_seconds,
				       MAX(COALESCE(scroll_depth, 0)) AS max_scroll_depth
				  FROM recent_feed_events
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
			addSignal(feedSignals, row.feed_key, row, row.event_type, 3);
		}
		if (row.item_id) {
			addSignal(itemSignals, row.item_id, row, row.event_type);
		}
	}

	return { feedSignals, itemSignals };
}

interface TopicLearningRow {
	item_id: string | null;
	event_type: string;
	occurred_at: string;
	title: string | null;
	text_source: string | null;
	text_source_is_html: number;
}

function boundPlainText(value: string | null): string | null {
	const normalized = (value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_RSS_TEXT_CONTENT_SIZE);
	return normalized || null;
}

async function loadTopicProfile(env: Env, now: string) {
	const eventTypes = TOPIC_LEARNING_EVENT_TYPES.map((eventType) => `'${eventType}'`).join(', ');
	const { results } = await env.DB.prepare(
		`WITH recent_topic_events AS (
			SELECT e.item_id, e.event_type, e.occurred_at
			  FROM engagement_events e
			 WHERE e.event_type IN (${eventTypes})
			 ORDER BY e.occurred_at DESC, e.id DESC
			 LIMIT ${MAX_TOPIC_HISTORY_ROWS}
		)
			SELECT e.item_id, e.event_type, e.occurred_at,
			       i.subject AS title,
			       CASE WHEN NULLIF(TRIM(i.text_content), '') IS NULL
			            THEN substr(COALESCE(i.html_content, ''), 1, ${MAX_TOPIC_HTML_SOURCE_SIZE})
			            ELSE substr(i.text_content, 1, ${MAX_TOPIC_EXCERPT_CHARS})
			       END AS text_source,
			       CASE WHEN NULLIF(TRIM(i.text_content), '') IS NULL THEN 1 ELSE 0 END AS text_source_is_html
		  FROM recent_topic_events e
		  LEFT JOIN items i ON i.id = e.item_id`,
	).all<TopicLearningRow>();

	const events: TopicLearningEvent[] = results.flatMap((row) => row.item_id
		? [{
			itemId: row.item_id,
			eventType: row.event_type,
			occurredAt: row.occurred_at,
			title: row.title,
			text: row.text_source_is_html === 1
				? htmlToBoundedText(row.text_source ?? '')
				: boundPlainText(row.text_source),
		}]
		: []);
	return buildTopicProfile(events, now);
}

interface CandidateExcerptRow {
	id: string;
	text_source: string | null;
	text_source_is_html: number;
}

async function loadCandidateExcerpts(env: Env, itemIds: string[]): Promise<Map<string, string>> {
	const excerpts = new Map<string, string>();
	const uniqueItemIds = [...new Set(itemIds)];
	if (uniqueItemIds.length === 0) return excerpts;

	const pages = await Promise.all(
		chunkValues(uniqueItemIds, MAX_IN_QUERY_BIND_PARAMS).map((itemIdChunk) => {
			const placeholders = itemIdChunk.map(() => '?').join(',');
			return env.DB.prepare(
				`SELECT id,
				        CASE WHEN NULLIF(TRIM(text_content), '') IS NULL
				             THEN substr(COALESCE(html_content, ''), 1, ${MAX_TOPIC_HTML_SOURCE_SIZE})
				             ELSE substr(text_content, 1, ${MAX_TOPIC_EXCERPT_CHARS})
				        END AS text_source,
				        CASE WHEN NULLIF(TRIM(text_content), '') IS NULL THEN 1 ELSE 0 END AS text_source_is_html
				   FROM items
				  WHERE id IN (${placeholders})`,
			)
				.bind(...itemIdChunk)
				.all<CandidateExcerptRow>();
		}),
	);
	for (const row of pages.flatMap((page) => page.results)) {
		excerpts.set(
			row.id,
			(row.text_source_is_html === 1
				? htmlToBoundedText(row.text_source ?? '')
				: boundPlainText(row.text_source)) ?? '',
		);
	}
	return excerpts;
}

function candidateWhere(view: RecommendationView): string {
	return view === 'for-you'
		? `AND i.is_read = 0
		   AND NOT EXISTS (
		     SELECT 1 FROM engagement_events excluded
		      WHERE excluded.item_id = i.id AND excluded.event_type = 'not_interested'
		   )`
		: view === 'unread'
			? 'AND i.is_read = 0'
			: 'AND i.is_starred = 1';
}

const CANDIDATE_COLUMNS = `i.rowid, i.id, i.feed_key,
	COALESCE(f.custom_title, f.display_name) AS source,
	i.from_name AS author, i.subject AS title, i.original_url,
	i.received_at, i.is_read, i.is_starred`;

async function loadRecommendationCandidates(
	env: Env,
	view: RecommendationView,
	limit: number,
): Promise<RecommendationCandidate[]> {
	const where = candidateWhere(view);
	const poolLimit = Math.max(limit, CANDIDATE_POOL_SIZE);
	const initial = await env.DB.prepare(
		`SELECT ${CANDIDATE_COLUMNS}
		   FROM items i
		   JOIN feeds f ON f.feed_key = i.feed_key
		  WHERE f.is_active = 1 ${where}
		  ORDER BY i.received_at DESC, i.rowid DESC
		  LIMIT ?`,
	)
		.bind(poolLimit)
		.all<RecommendationCandidate>();

	// The fast global slice is enough for the common case. When it fills, add a
	// small indexed slice per active feed so a quiet publisher older than the
	// newest 100 items can still compete for a relevant topic.
	if (view !== 'for-you' || initial.results.length < CANDIDATE_POOL_SIZE) return initial.results;
	const feedRows = await env.DB.prepare(
		`SELECT feed_key
		   FROM feeds
		  WHERE is_active = 1
		  ORDER BY COALESCE(last_item_at, first_seen_at, '') DESC, feed_key
		  LIMIT ?`,
	)
		.bind(MAX_FEED_SLICES)
		.all<{ feed_key: string }>();
	const feedCandidates = await Promise.all(feedRows.results.map(({ feed_key }) =>
		env.DB.prepare(
			`SELECT ${CANDIDATE_COLUMNS}
			   FROM items i
			   JOIN feeds f ON f.feed_key = i.feed_key
			  WHERE f.is_active = 1 AND i.feed_key = ? ${where}
			  ORDER BY i.received_at DESC, i.rowid DESC
			  LIMIT ${PER_FEED_CANDIDATE_LIMIT}`,
		)
			.bind(feed_key)
			.all<RecommendationCandidate>(),
	));

	const unique = new Map<string, RecommendationCandidate>();
	for (const candidate of initial.results) unique.set(candidate.id, candidate);
	for (const page of feedCandidates) {
		for (const candidate of page.results) unique.set(candidate.id, candidate);
	}
	return [...unique.values()];
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
	const now = new Date().toISOString();
	const candidates = await loadRecommendationCandidates(env, view, limit);

	if (candidates.length === 0) {
		return Response.json({ generatedAt: now, view, items: [] });
	}

	const [signalSummary, topicProfile, monitoredTopics] = await Promise.all([
		loadSignalsForFeeds(env, candidates.map((candidate) => candidate.feed_key)),
		loadTopicProfile(env, now),
		loadMonitoredTopics(env),
	]);
	const hasTopicSignals = monitoredTopics.length > 0 || topicProfile.entries.size > 0;
	const topicItemIds = !hasTopicSignals
		? []
		: view === 'for-you'
			? candidates.map((candidate) => candidate.id)
			: candidates.slice().sort(compareCandidateRecency).slice(0, limit).map((candidate) => candidate.id);
	const excerptsById = await loadCandidateExcerpts(env, topicItemIds);
	const { feedSignals, itemSignals } = signalSummary;
	const ranked = candidates.map((candidate) => {
		const candidateFeedSignals = feedSignals.get(candidate.feed_key) ?? {};
		const candidateItemSignals = itemSignals.get(candidate.id) ?? {};
		const topic = scoreTopics(
			{ title: candidate.title, text: excerptsById.get(candidate.id) ?? null },
			monitoredTopics,
			topicProfile,
		);
		const feedSampleCount = candidateFeedSignals.evidenceCount ?? 0;
		const hasTopicEvidence = topic.monitoredMatches.length > 0
			|| topic.learnedMatches.length > 0
			|| topic.learnedNegativeMatches.length > 0;
		const scoring = scoreRecommendation({
			receivedAt: candidate.received_at,
			now,
			isStarred: candidate.is_starred === 1,
			feedSignals: candidateFeedSignals,
			itemSignals: candidateItemSignals,
			// Each item/event kind contributes at most one confidence sample. Reading
			// heartbeats contribute duration, not repeated evidence.
			sampleCount: feedSampleCount > 0
				? feedSampleCount
				: hasTopicEvidence
					? Math.min(24, topic.evidenceCount + (topic.monitoredMatches.length > 0 ? 1 : 0))
					: 0,
			topic,
		});

		return {
			id: candidate.id,
			readerId: toGoogleItemId(candidate.rowid),
			feedKey: candidate.feed_key,
			source: candidate.source,
			author: candidate.author,
			title: candidate.title,
			originalURL: candidate.original_url,
			receivedAt: candidate.received_at,
			isRead: candidate.is_read === 1,
			isStarred: candidate.is_starred === 1,
			matchedTopics: [...new Set([...topic.monitoredMatches, ...topic.learnedMatches])],
			topicStrength: topic.monitoredBoost + Math.max(topic.learnedBoost, 0),
			...scoring,
		};
	});

	ranked.sort((left, right) => {
		if (view === 'for-you' && right.score !== left.score) {
			return right.score - left.score;
		}
		return compareRankedRecency(left, right);
	});

	const selected = view === 'for-you'
		? selectDiverseRecommendations(ranked, limit)
		: ranked.slice(0, limit);
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
