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
import { ARTICLE_AUTHOR_SQL } from './article-author';

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
	content_pruned_at: string | null;
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
// Freshness alone tops out at 50. For You requires evidence of relevance.
export const FOR_YOU_SCORE_THRESHOLD = 50;
const PER_FEED_CANDIDATE_LIMIT = 25;
const MAX_FEED_SLICES = 40;
const MAX_D1_COMPOUND_SELECT_TERMS = 5;
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

function parseLimit(raw: string | null, defaultLimit = 30): number {
	const parsed = Number.parseInt(raw ?? String(defaultLimit), 10);
	return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 50) : defaultLimit;
}

const MAX_RECOMMENDATION_CANDIDATES = CANDIDATE_POOL_SIZE + PER_FEED_CANDIDATE_LIMIT * MAX_FEED_SLICES;

interface RecommendationSnapshotEntry {
	id: string;
	score: number;
	confidence: number;
	sampleCount: number;
	explanation: string;
	learningState: string;
	matchedTopics: string[];
	topicStrength: number;
}

interface RecommendationSnapshot {
	now: string;
	entries: RecommendationSnapshotEntry[];
	expiresAt: number;
	bytes: number;
}

const MAX_SESSION_BYTES = 8_000_000;
const MAX_SESSIONS = 8;
const SESSION_TTL_MS = 5 * 60_000;
const SESSION_STORAGE_PREFIX = 'recommendations:snapshots:';
const SESSION_INDEX_KEY = `${SESSION_STORAGE_PREFIX}index`;
// Even non-ASCII JSON remains below the SQLite DO's 2 MB value limit.
const SESSION_CHUNK_CHARS = 200_000;
const MAX_SESSION_CHUNKS = Math.ceil(MAX_SESSION_BYTES / SESSION_CHUNK_CHARS);
const SNAPSHOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type SessionStorage = Pick<DurableObjectStorage, 'kv' | 'transactionSync'>;
interface StoredSession {
	id: string;
	expiresAt: number;
	bytes: number;
	parts: number;
}

function snapshotPayload(snapshot: Pick<RecommendationSnapshot, 'now' | 'entries'>): string {
	return JSON.stringify({ now: snapshot.now, entries: snapshot.entries });
}

function validSnapshotEntry(value: unknown): value is RecommendationSnapshotEntry {
	if (!value || typeof value !== 'object') return false;
	const entry = value as RecommendationSnapshotEntry;
	return typeof entry.id === 'string' && typeof entry.explanation === 'string'
		&& typeof entry.learningState === 'string'
		&& [entry.score, entry.confidence, entry.sampleCount, entry.topicStrength]
			.every((number) => typeof number === 'number' && Number.isFinite(number))
		&& Array.isArray(entry.matchedTopics) && entry.matchedTopics.every((topic) => typeof topic === 'string')
		&& Object.keys(entry).length === 8;
}

/** Per-object, bounded metadata only. Article bodies never enter this store. */
export class RecommendationSessions {
	private snapshots = new Map<string, RecommendationSnapshot>();
	private persisted = new Map<string, StoredSession>();
	private bytes = 0;

	constructor(private readonly options: {
		clock?: () => number;
		ttlMs?: number;
		maxSessions?: number;
		maxBytes?: number;
		storage?: SessionStorage;
	} = {}) {
		if (options.storage) this.restore();
	}

	private get now(): number { return (this.options.clock ?? Date.now)(); }
	private get maxBytes(): number { return this.options.maxBytes ?? MAX_SESSION_BYTES; }
	private get maxSessions(): number { return this.options.maxSessions ?? MAX_SESSIONS; }
	private get ttlMs(): number { return this.options.ttlMs ?? SESSION_TTL_MS; }

	private chunkKey(id: string, part: number): string {
		return `${SESSION_STORAGE_PREFIX}${id}:${part}`;
	}

	private restore(): void {
		const storage = this.options.storage!;
		const index = storage.kv.get<{ version: number; sessions: StoredSession[] }>(SESSION_INDEX_KEY);
		if (index === undefined) return;
		if (!index || index.version !== 1 || !Array.isArray(index.sessions)
			|| index.sessions.length > this.maxSessions
			|| index.sessions.some((record) => !record || !SNAPSHOT_ID_PATTERN.test(record.id)
				|| !Number.isSafeInteger(record.expiresAt) || !Number.isSafeInteger(record.bytes)
				|| record.bytes <= 0 || record.bytes > this.maxBytes
				|| !Number.isSafeInteger(record.parts) || record.parts < 1 || record.parts > MAX_SESSION_CHUNKS)
			|| new Set(index.sessions.map((record) => record.id)).size !== index.sessions.length
			|| index.sessions.reduce((sum, record) => sum + record.bytes, 0) > this.maxBytes) {
			// Invalid/version-incompatible metadata cannot be used as a cursor.
			// This namespace has at most 8 * 40 chunks and one manifest.
			storage.transactionSync(() => {
				for (const [key] of storage.kv.list({ prefix: SESSION_STORAGE_PREFIX, limit: MAX_SESSIONS * MAX_SESSION_CHUNKS + 1 })) {
					storage.kv.delete(key);
				}
				storage.kv.put(SESSION_INDEX_KEY, { version: 1, sessions: [] });
			});
			return;
		}
		this.persisted = new Map(index.sessions.map((record) => [record.id, record]));
		for (const record of index.sessions) {
			if (record.expiresAt <= this.now || record.expiresAt > this.now + this.ttlMs) continue;
			const chunks: string[] = [];
			let chars = 0;
			for (let part = 0; part < record.parts; part += 1) {
				const chunk = storage.kv.get<unknown>(this.chunkKey(record.id, part));
				if (typeof chunk !== 'string' || chunk.length > SESSION_CHUNK_CHARS) break;
				chars += chunk.length;
				if (chars > record.bytes) break;
				chunks.push(chunk);
			}
			if (chunks.length !== record.parts) continue;
			const payload = chunks.join('');
			if (new TextEncoder().encode(payload).byteLength !== record.bytes) continue;
			try {
				const snapshot = JSON.parse(payload) as RecommendationSnapshot;
				if (typeof snapshot.now !== 'string' || !Number.isFinite(Date.parse(snapshot.now))
					|| !Array.isArray(snapshot.entries) || snapshot.entries.length > MAX_RECOMMENDATION_CANDIDATES
					|| !snapshot.entries.every(validSnapshotEntry)
					|| snapshotPayload(snapshot) !== payload) continue;
				this.snapshots.set(record.id, { ...snapshot, bytes: record.bytes, expiresAt: record.expiresAt });
				this.bytes += record.bytes;
			} catch { /* Corrupt snapshots expire through the normal 410 recovery. */ }
		}
		this.persist(this.snapshots);
	}

	private persist(next: Map<string, RecommendationSnapshot>): void {
		const storage = this.options.storage;
		if (!storage) return;
		const removed = [...this.persisted.values()].filter((record) => !next.has(record.id));
		const added = [...next].filter(([id]) => !this.persisted.has(id));
		if (!removed.length && !added.length) return;
		const records = new Map(this.persisted);
		storage.transactionSync(() => {
			for (const record of removed) {
				for (let part = 0; part < record.parts; part += 1) storage.kv.delete(this.chunkKey(record.id, part));
				records.delete(record.id);
			}
			for (const [id, snapshot] of added) {
				const payload = snapshotPayload(snapshot);
				const parts = Math.ceil(payload.length / SESSION_CHUNK_CHARS);
				for (let part = 0; part < parts; part += 1) {
					storage.kv.put(this.chunkKey(id, part), payload.slice(part * SESSION_CHUNK_CHARS, (part + 1) * SESSION_CHUNK_CHARS));
				}
				records.set(id, { id, parts, bytes: snapshot.bytes, expiresAt: snapshot.expiresAt });
			}
			storage.kv.put(SESSION_INDEX_KEY, { version: 1, sessions: [...records.values()] });
		});
		this.persisted = records;
	}

	private prune(): void {
		const next = new Map([...this.snapshots].filter(([, snapshot]) => snapshot.expiresAt > this.now));
		if (next.size === this.snapshots.size) return;
		this.persist(next);
		this.snapshots = next;
		this.bytes = [...next.values()].reduce((sum, snapshot) => sum + snapshot.bytes, 0);
	}

	create(now: string, ranked: RecommendationSnapshotEntry[]): string | null {
		this.prune();
		if (ranked.length > MAX_RECOMMENDATION_CANDIDATES) return null;
		const entries = ranked.map(({ id, score, confidence, sampleCount, explanation, learningState, matchedTopics, topicStrength }) =>
			({ id, score, confidence, sampleCount, explanation, learningState, matchedTopics, topicStrength }));
		const bytes = new TextEncoder().encode(snapshotPayload({ now, entries })).byteLength;
		if (bytes > this.maxBytes || this.maxSessions < 1) return null;
		const next = new Map(this.snapshots);
		let nextBytes = this.bytes;
		while (next.size >= this.maxSessions || nextBytes + bytes > this.maxBytes) {
			const oldest = next.keys().next().value as string | undefined;
			if (!oldest) return null;
			nextBytes -= next.get(oldest)!.bytes;
			next.delete(oldest);
		}
		const id = crypto.randomUUID();
		next.set(id, { now, entries, bytes, expiresAt: this.now + this.ttlMs });
		// Commit new metadata and evictions before exposing the cursor. Failed
		// transactions leave both memory and existing persisted sessions intact.
		this.persist(next);
		this.snapshots = next;
		this.bytes = nextBytes + bytes;
		return id;
	}

	get(id: string): RecommendationSnapshot | undefined {
		this.prune();
		return this.snapshots.get(id);
	}
}

// Direct/local callers reuse sessions for the same environment. Production
// passes the Durable Object's own store, keeping account/object state separate.
const defaultSessions = new WeakMap<object, RecommendationSessions>();
function sessionsForEnvironment(env: Env): RecommendationSessions {
	let sessions = defaultSessions.get(env);
	if (!sessions) {
		sessions = new RecommendationSessions();
		defaultSessions.set(env, sessions);
	}
	return sessions;
}

function parseContinuation(raw: string | null): { id: string; offset: number } | 'legacy' | null {
	if (raw === null) return null;
	const legacy = /^v1:([1-9]\d*):(.+)$/.exec(raw);
	if (legacy && Number(legacy[1]) <= MAX_RECOMMENDATION_CANDIDATES
		&& /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(legacy[2])
		&& Number.isFinite(Date.parse(legacy[2]))
		&& new Date(legacy[2]).toISOString().replace('.000Z', 'Z') === legacy[2].replace('.000Z', 'Z')) return 'legacy';
	const match = /^v2:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):([1-9]\d*)$/.exec(raw);
	const offset = Number(match?.[2]);
	if (!match || !Number.isSafeInteger(offset) || offset >= MAX_RECOMMENDATION_CANDIDATES) {
		throw new Error('Invalid recommendation continuation');
	}
	return { id: match[1], offset };
}

function expiredContinuation(): Response {
	return Response.json({
		error: 'Recommendation continuation expired; reload recommendations',
		code: 'recommendation_continuation_expired',
	}, { status: 410 });
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
	${ARTICLE_AUTHOR_SQL} AS author, i.subject AS title, i.original_url,
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
	if (feedRows.results.length === 0) return initial.results;
	// D1 allows at most five compound SELECT terms. Eight bounded statements
	// retain all forty indexed publisher slices within the request query budget.
	const feedCandidatePages = await Promise.all(
		chunkValues(feedRows.results, MAX_D1_COMPOUND_SELECT_TERMS).map((feeds) =>
			env.DB.prepare(feeds.map(() =>
				`SELECT * FROM (
					SELECT ${CANDIDATE_COLUMNS}
					   FROM items i
					   JOIN feeds f ON f.feed_key = i.feed_key
					  WHERE f.is_active = 1 AND i.feed_key = ? ${where}
					  ORDER BY i.received_at DESC, i.rowid DESC
					  LIMIT ${PER_FEED_CANDIDATE_LIMIT}
				)`,
			).join(' UNION ALL '))
				.bind(...feeds.map(({ feed_key }) => feed_key))
				.all<RecommendationCandidate>(),
		),
	);
	const unique = new Map<string, RecommendationCandidate>();
	for (const candidate of initial.results) unique.set(candidate.id, candidate);
	for (const candidate of feedCandidatePages.flatMap((page) => page.results)) unique.set(candidate.id, candidate);
	return [...unique.values()];
}

async function loadRecommendationContent(
	env: Env,
	itemIds: string[],
): Promise<Map<string, { html: string; text: string | null; isBodyPruned: boolean }>> {
	const content = new Map<string, { html: string; text: string | null; isBodyPruned: boolean }>();
	if (itemIds.length === 0) {
		return content;
	}

	const uniqueItemIds = [...new Set(itemIds)];
	const pages = await Promise.all(
		chunkValues(uniqueItemIds, MAX_IN_QUERY_BIND_PARAMS).map((itemIdChunk) => {
			const placeholders = itemIdChunk.map(() => '?').join(',');
			return env.DB.prepare(
				`SELECT id, html_content, text_content, content_pruned_at
				   FROM items
				  WHERE id IN (${placeholders})`,
			)
				.bind(...itemIdChunk)
				.all<RecommendationContentRow>();
		}),
	);

	for (const row of pages.flatMap((page) => page.results)) {
		content.set(row.id, { html: row.html_content, text: row.text_content, isBodyPruned: row.content_pruned_at != null });
	}
	return content;
}

interface RecommendationPageRow extends RecommendationCandidate, RecommendationContentRow {
	ordinal: number;
	eligible_count: number;
}

function snapshotMembershipPages(entries: RecommendationSnapshotEntry[], offset: number): Array<{ offset: number; length: number; membership: string }> {
	const pages: Array<{ offset: number; length: number; membership: string }> = [];
	const encoder = new TextEncoder();
	const maxBytes = 900_000;
	let start = offset;
	let values: string[] = [];
	let bytes = 2;
	for (let index = offset; index < entries.length; index += 1) {
		const value = JSON.stringify(entries[index].id);
		const valueBytes = encoder.encode(value).byteLength;
		if (valueBytes + 2 > maxBytes) throw new Error('Recommendation identifier exceeds database parameter limit');
		if (values.length > 0 && bytes + 1 + valueBytes > maxBytes) {
			pages.push({ offset: start, length: values.length, membership: `[${values.join(',')}]` });
			start = index;
			values = [];
			bytes = 2;
		}
		bytes += valueBytes + (values.length > 0 ? 1 : 0);
		values.push(value);
	}
	if (values.length > 0) pages.push({ offset: start, length: values.length, membership: `[${values.join(',')}]` });
	return pages;
}

async function loadForYouPage(env: Env, entries: RecommendationSnapshotEntry[], offset: number, limit: number) {
	const items: Array<RecommendationSnapshotEntry & {
		readerId: string; feedKey: string; source: string; author: string | null; title: string;
		originalURL: string | null; receivedAt: string; isRead: boolean; isStarred: boolean;
		html: string; text: string | null; isBodyPruned: boolean;
	}> = [];
	let nextOffset = offset;
	let hasMore = false;
	const membershipPages = snapshotMembershipPages(entries, offset);
	for (let pageIndex = 0; pageIndex < membershipPages.length; pageIndex += 1) {
		const page = membershipPages[pageIndex];
		const capacity = limit - items.length;
		// One row read owns eligibility, metadata, and body. A deletion between
		// earlier ranking/count reads and this statement cannot create a phantom
		// story with an empty body. JSON ordinals preserve the snapshot's order.
		const { results } = await env.DB.prepare(
			`WITH eligible_ids AS (
				SELECT CAST(snapshot_item.key AS INTEGER) AS ordinal, i.id
				FROM json_each(?) snapshot_item
				JOIN items i ON i.id = snapshot_item.value
				JOIN feeds f ON f.feed_key = i.feed_key
				WHERE f.is_active = 1 ${candidateWhere('for-you')}
			 )
			 SELECT eligible_ids.ordinal, ${CANDIDATE_COLUMNS}, i.html_content, i.text_content, i.content_pruned_at,
			        (SELECT COUNT(*) FROM eligible_ids) AS eligible_count
			 FROM eligible_ids
			 JOIN items i ON i.id = eligible_ids.id
			 JOIN feeds f ON f.feed_key = i.feed_key
			 ORDER BY eligible_ids.ordinal
			 LIMIT ?`,
		).bind(page.membership, capacity).all<RecommendationPageRow>();
		for (const row of results) {
			const entry = entries[page.offset + row.ordinal];
			items.push({ ...entry, readerId: toGoogleItemId(row.rowid), feedKey: row.feed_key, source: row.source,
				author: row.author, title: row.title, originalURL: row.original_url, receivedAt: row.received_at,
				isRead: row.is_read === 1, isStarred: row.is_starred === 1,
				html: row.html_content, text: row.text_content, isBodyPruned: row.content_pruned_at != null });
		}
		if (results.length === capacity) {
			nextOffset = page.offset + results.at(-1)!.ordinal + 1;
			// Tail membership uses the same SQL snapshot, so undoing a read
			// between the earlier count and this page cannot hide unseen stories.
			hasMore = results[0].eligible_count > capacity || pageIndex + 1 < membershipPages.length;
			break;
		}
		nextOffset = page.offset + page.length;
	}
	return { items, nextOffset, hasMore };
}

async function continueRecommendations(env: Env, sessions: RecommendationSessions, cursor: { id: string; offset: number }, limit: number): Promise<Response> {
	const snapshot = sessions.get(cursor.id);
	if (!snapshot) return expiredContinuation();
	if (cursor.offset >= snapshot.entries.length) {
		return Response.json({ error: 'Invalid recommendation continuation', code: 'invalid_recommendation_continuation' }, { status: 400 });
	}
	// The total is advisory across concurrent changes. Actual page membership
	// and its continuation come from the same atomic row read below.
	const eligiblePages = await Promise.all(chunkValues(snapshot.entries.map((entry) => entry.id), MAX_IN_QUERY_BIND_PARAMS).map((ids) =>
		env.DB.prepare(`SELECT i.id FROM items i JOIN feeds f ON f.feed_key = i.feed_key
		 WHERE f.is_active = 1 ${candidateWhere('for-you')} AND i.id IN (${ids.map(() => '?').join(',')})`)
			.bind(...ids).all<{ id: string }>()));
	const eligible = new Set(eligiblePages.flatMap((page) => page.results.map((row) => row.id)));
	const page = await loadForYouPage(env, snapshot.entries, cursor.offset, limit);
	return Response.json({
		generatedAt: snapshot.now, view: 'for-you', totalCount: eligible.size,
		continuation: page.hasMore ? `v2:${cursor.id}:${page.nextOffset}` : null,
		items: page.items,
	});
}

export async function handleRecommendations(request: Request, env: Env, sessions = sessionsForEnvironment(env)): Promise<Response> {
	const url = new URL(request.url);
	const view = parseView(url.searchParams.get('view'));
	const limit = parseLimit(url.searchParams.get('limit'), view === 'for-you' ? 50 : 30);
	let cursor: ReturnType<typeof parseContinuation> = null;
	try {
		if (view === 'for-you') cursor = parseContinuation(url.searchParams.get('continuation'));
	} catch {
		return Response.json({ error: 'Invalid recommendation continuation', code: 'invalid_recommendation_continuation' }, { status: 400 });
	}
	if (cursor === 'legacy') return expiredContinuation();
	if (cursor) return continueRecommendations(env, sessions, cursor, limit);
	const now = new Date().toISOString();
	const candidates = await loadRecommendationCandidates(env, view, limit);

	if (candidates.length === 0) {
		return Response.json({ generatedAt: now, view, ...(view === 'for-you' ? { continuation: null, totalCount: 0 } : {}), items: [] });
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

	// Qualify before paging; never fill a page with weak exploration picks.
	if (view === 'for-you') {
		const qualified = ranked.filter((item) => item.score > FOR_YOU_SCORE_THRESHOLD);
		const page = await loadForYouPage(env, qualified, 0, limit);
		let continuation: string | null = null;
		if (page.hasMore) {
			const sessionId = sessions.create(now, qualified);
			if (!sessionId) {
				return Response.json({ error: 'Recommendation snapshot is too large', code: 'recommendation_snapshot_too_large' }, { status: 503 });
			}
			continuation = `v2:${sessionId}:${page.nextOffset}`;
		}
		return Response.json({ generatedAt: now, view, continuation, totalCount: qualified.length, items: page.items });
	}
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
				isBodyPruned: content?.isBodyPruned ?? false,
			};
		}),
	});
}
