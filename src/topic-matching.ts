/**
 * Small, deterministic topic matching primitives used by recommendations.
 *
 * This intentionally uses token and phrase overlap instead of an embedding
 * service. It is cheap to run in a Worker and, because matches are made on
 * complete tokens, a topic such as "AI" does not match the word "paid".
 */

export const MAX_TOPIC_EXCERPT_CHARS = 2_000;
const MAX_TOPIC_FEATURES_PER_ARTICLE = 240;
const MAX_TOPIC_PROFILE_ENTRIES = 1_200;

const TOKEN_PATTERN = /[\p{L}\p{N}]+/gu;

// These words are common in newsletter wrappers and article labels. They add
// little preference information and otherwise make unrelated stories look
// like they share a topic.
const STOP_WORDS = new Set([
	'a', 'about', 'after', 'again', 'against', 'all', 'also', 'am', 'an', 'and', 'any', 'are', 'as', 'at',
	'be', 'because', 'been', 'before', 'being', 'between', 'both', 'but', 'by', 'can', 'could', 'did', 'do',
	'does', 'doing', 'down', 'during', 'each', 'few', 'for', 'from', 'further', 'had', 'has', 'have', 'having',
	'he', 'her', 'here', 'hers', 'herself', 'him', 'himself', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it',
	'its', 'itself', 'just', 'me', 'more', 'most', 'my', 'myself', 'no', 'nor', 'not', 'of', 'on', 'once', 'only',
	'or', 'other', 'our', 'ours', 'ourselves', 'out', 'over', 'own', 'same', 'she', 'should', 'so', 'some', 'such',
	'than', 'that', 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there', 'these', 'they', 'this',
	'those', 'through', 'to', 'too', 'under', 'until', 'up', 'very', 'was', 'we', 'were', 'what', 'when', 'where',
	'which', 'while', 'who', 'whom', 'why', 'will', 'with', 'would', 'you', 'your', 'yours', 'yourself', 'yourselves',
]);

const BOILERPLATE_WORDS = new Set([
	'advertisement', 'advertising', 'archive', 'click', 'continue', 'copyright', 'daily', 'digest', 'edition',
	'email', 'forward', 'issue', 'latest', 'link', 'newsletter', 'powered', 'read', 'reply', 'roundup', 'share',
	'sponsor', 'sponsored', 'subscribe', 'unsubscribe', 'update', 'updates', 'view', 'weekly', 'welcome',
	'article', 'body', 'content', 'detail', 'source', 'subject',
	'item', 'number', 'story', 'topic',
	'best', 'guide', 'look', 'make', 'makes', 'need', 'new', 'now', 'people', 'today', 'time', 'use', 'used', 'using', 'way', 'ways', 'year', 'years',
]);

const SHORT_TOPIC_WORDS = new Set([
	'ai', 'ar', 'api', 'cpu', 'css', 'd1', 'gpu', 'ios', 'ipados', 'llm', 'mac', 'ml', 'rss', 'sql', 'tv', 'ui', 'ux',
	'vr', 'web', 'xcode',
]);

const ALIAS_GROUPS: readonly (readonly string[])[] = [
	['ai', 'artificial intelligence'],
	['ml', 'machine learning'],
	['llm', 'large language model'],
	['swiftui', 'swift ui'],
	['ios', 'iphone', 'ipados'],
];

const ALIAS_TO_CANONICAL = new Map<string, string>();
const ALIAS_TOKEN_FORMS: Array<{ tokens: string[]; canonical: string }> = [];
for (const group of ALIAS_GROUPS) {
	const canonical = group[0];
	for (const alias of group) {
		ALIAS_TO_CANONICAL.set(alias, canonical);
		if (alias !== canonical) {
			ALIAS_TOKEN_FORMS.push({
				tokens: alias.match(TOKEN_PATTERN)?.map((token) => token.toLowerCase()) ?? [],
				canonical,
			});
		}
	}
}
ALIAS_TOKEN_FORMS.sort((left, right) => right.tokens.length - left.tokens.length);

export interface TopicArticleText {
	title: string | null | undefined;
	text?: string | null;
}

export interface TopicMatch {
	key: string;
	label: string;
}

export interface TopicLearningEvent {
	itemId: string;
	eventType: string;
	occurredAt: string;
	title: string | null;
	text: string | null;
}

export interface TopicProfileEntry {
	key: string;
	label: string;
	weight: number;
}

export interface TopicProfile {
	entries: Map<string, TopicProfileEntry>;
	evidenceCount: number;
}

export interface TopicScore {
	monitoredMatches: string[];
	learnedMatches: string[];
	learnedNegativeMatches: string[];
	monitoredBoost: number;
	learnedBoost: number;
	evidenceCount: number;
}

function canonicalToken(token: string): string {
	let normalized = token.normalize('NFKC').toLowerCase();
	if (normalized === 'a.i') normalized = 'ai';
	if (normalized.length >= 4 && normalized.endsWith('ies')) {
		normalized = `${normalized.slice(0, -3)}y`;
	} else if (
		normalized.length >= 4 && normalized.endsWith('s') &&
		!normalized.endsWith('ss') &&
		!new Set(['alias', 'analysis', 'business', 'news', 'series', 'status']).has(normalized)
	) {
		normalized = normalized.slice(0, -1);
	}
	return ALIAS_TO_CANONICAL.get(normalized) ?? normalized;
}

function rawTokens(value: string): string[] {
	return value.normalize('NFKC').toLowerCase().match(TOKEN_PATTERN) ?? [];
}

function canonicalTokens(value: string): string[] {
	const raw = rawTokens(value);
	const result: string[] = [];
	for (let index = 0; index < raw.length; index += 1) {
		const token = canonicalToken(raw[index]);
		const alias = ALIAS_TOKEN_FORMS.find(({ tokens }) =>
			tokens.length <= raw.length - index &&
			tokens.every((aliasToken, offset) => canonicalToken(raw[index + offset]) === canonicalToken(aliasToken)),
		);
		if (alias) {
			result.push(alias.canonical);
			index += alias.tokens.length - 1;
			continue;
		}
		result.push(token);
	}
	return result;
}

function stripMarkup(value: string): string {
	return value
		.replace(/<[^>]*>/g, ' ')
		.replace(/&nbsp;|&#160;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&quot;|&#34;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/\s+/g, ' ')
		.trim();
}

function articleText(article: TopicArticleText): string {
	const title = stripMarkup(String(article.title ?? '')).slice(0, 400);
	const text = stripMarkup(String(article.text ?? '')).slice(0, MAX_TOPIC_EXCERPT_CHARS);
	return `${title} ${text}`.trim();
}

function isUsefulTopicToken(token: string): boolean {
	return token.length >= 3 && !STOP_WORDS.has(token) && !BOILERPLATE_WORDS.has(token) || SHORT_TOPIC_WORDS.has(token);
}

function addNgramFeatures(tokens: string[], features: Set<string>): void {
	for (let index = 0; index < tokens.length; index += 1) {
		features.add(tokens[index]);
		for (let width = 2; width <= 3 && index + width <= tokens.length; width += 1) {
			features.add(tokens.slice(index, index + width).join(' '));
		}
	}
}

/** Return all meaningful single-token and contiguous phrase features. */
export function extractTopicFeatures(article: TopicArticleText): Set<string> {
	const tokens = canonicalTokens(articleText(article)).filter(isUsefulTopicToken);
	const features = new Set<string>();
	addNgramFeatures(tokens, features);
	return new Set([...features].slice(0, MAX_TOPIC_FEATURES_PER_ARTICLE));
}

/** Return canonical tokens without stop-word filtering for user-entered matches. */
function queryTokens(topic: string): string[] {
	return canonicalTokens(topic);
}

function queryForms(topic: string): string[] {
	const canonical = queryTokens(topic);
	if (canonical.length === 0) return [];
	const key = canonical.join(' ');
	const forms = new Set<string>([key]);
	for (const group of ALIAS_GROUPS) {
		const canonicalAlias = group[0];
		const groupKeys = new Set(group.flatMap((alias) => queryTokens(alias).join(' ')));
		if (groupKeys.has(key) || key === canonicalAlias) {
			for (const alias of group) forms.add(queryTokens(alias).join(' '));
		}
	}
	return [...forms].filter(Boolean);
}

function containsTokenSequence(tokens: string[], query: string[]): boolean {
	if (query.length === 0 || query.length > tokens.length) return false;
	for (let start = 0; start <= tokens.length - query.length; start += 1) {
		if (query.every((token, offset) => tokens[start + offset] === token)) return true;
	}
	return false;
}

/** Match user-entered topics against complete tokens and aliases. */
export function matchMonitoredTopics(article: TopicArticleText, monitoredTopics: string[]): TopicMatch[] {
	const tokens = canonicalTokens(articleText(article));
	const matches: TopicMatch[] = [];
	for (const topic of monitoredTopics) {
		const forms = queryForms(topic);
		if (forms.some((form) => containsTokenSequence(tokens, form.split(' ')))) {
			matches.push({ key: forms[0] ?? topic.toLowerCase(), label: topic });
		}
	}
	return matches;
}

function topicLabel(key: string): string {
	return key
		.split(' ')
		.map((token) => token.length <= 3 ? token.toUpperCase() : token)
		.join(' ');
}

function eventWeight(eventType: string): number {
	switch (eventType) {
		case 'more_like_this': return 9;
		case 'star': return 8;
		case 'outbound_link': return 4;
		case 'active_reading': return 2;
		case 'read': return 0.5;
		case 'not_interested': return -10;
		case 'unstar': return -3;
		default: return 0;
	}
}

function ageDecay(occurredAt: string, now: string): number {
	const occurredMillis = Date.parse(occurredAt);
	const nowMillis = Date.parse(now);
	if (!Number.isFinite(occurredMillis) || !Number.isFinite(nowMillis)) return 0.25;
	const ageDays = Math.max(0, (nowMillis - occurredMillis) / 86_400_000);
	return Math.exp(-ageDays / 45);
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(Math.max(value, minimum), maximum);
}

/**
 * Build a topic profile from deliberate item-level events. Events for one
 * item/type are counted once, then the total item contribution is capped so a
 * noisy sender or repeated heartbeats cannot overwhelm the profile.
 */
export function buildTopicProfile(events: TopicLearningEvent[], now: string): TopicProfile {
	const byItem = new Map<string, Map<string, TopicLearningEvent>>();
	for (const event of events) {
		if (eventWeight(event.eventType) === 0 || !event.itemId) continue;
		const itemEvents = byItem.get(event.itemId) ?? new Map<string, TopicLearningEvent>();
		if (!itemEvents.has(event.eventType)) itemEvents.set(event.eventType, event);
		byItem.set(event.itemId, itemEvents);
	}

	const itemContributions: Array<{ features: Map<string, number>; weight: number }> = [];
	for (const itemEvents of byItem.values()) {
		const first = itemEvents.values().next().value as TopicLearningEvent | undefined;
		if (!first) continue;
		const headlineFeatures = extractTopicFeatures({ title: first.title });
		const bodyFeatures = extractTopicFeatures({ title: null, text: first.text });
		const features = new Map<string, number>();
		for (const feature of headlineFeatures) features.set(feature, 2.5);
		for (const feature of bodyFeatures) {
			features.set(feature, Math.max(features.get(feature) ?? 0, 0.35));
		}
		if (features.size === 0) continue;
		let itemWeight = 0;
		for (const event of itemEvents.values()) {
			itemWeight += eventWeight(event.eventType) * ageDecay(event.occurredAt, now);
		}
		itemWeight = clamp(itemWeight, -12, 12);
		if (itemWeight === 0) continue;
		itemContributions.push({ features, weight: itemWeight });
	}

	const entries = new Map<string, TopicProfileEntry>();
	for (const contribution of itemContributions) {
		const featureWeightTotal = [...contribution.features.values()].reduce((total, weight) => total + weight, 0);
		const normalization = Math.sqrt(Math.max(featureWeightTotal, 1));
		for (const [feature, featureWeight] of contribution.features) {
			const isPhrase = feature.includes(' ');
			const perFeatureWeight = contribution.weight * featureWeight * (isPhrase ? 1.25 : 1) / normalization;
			const existing = entries.get(feature);
			const nextWeight = clamp((existing?.weight ?? 0) + perFeatureWeight, -18, 18);
			entries.set(feature, {
				key: feature,
				label: existing?.label ?? topicLabel(feature),
				weight: nextWeight,
			});
		}
	}

	const boundedEntries = new Map(
		[...entries.entries()]
			.sort((left, right) => Math.abs(right[1].weight) - Math.abs(left[1].weight) || left[0].localeCompare(right[0]))
			.slice(0, MAX_TOPIC_PROFILE_ENTRIES),
	);
	return {
		entries: boundedEntries,
		evidenceCount: Math.min(itemContributions.length, 24),
	};
}

export function scoreTopics(
	article: TopicArticleText,
	monitoredTopics: string[],
	profile: TopicProfile,
): TopicScore {
	const monitoredMatches = matchMonitoredTopics(article, monitoredTopics);
	const features = extractTopicFeatures(article);
	const learnedMatches: string[] = [];
	const learnedNegativeMatches: string[] = [];
	let learnedBoost = 0;
	for (const feature of features) {
		const entry = profile.entries.get(feature);
		if (!entry) continue;
		if (entry.weight >= 0.5) {
			learnedMatches.push(entry.label);
		} else if (entry.weight <= -0.5) {
			learnedNegativeMatches.push(entry.label);
		}
		learnedBoost += entry.weight;
	}

	return {
		monitoredMatches: monitoredMatches.map((match) => match.label),
		learnedMatches: [...new Set(learnedMatches)].slice(0, 4),
		learnedNegativeMatches: [...new Set(learnedNegativeMatches)].slice(0, 4),
		monitoredBoost: monitoredMatches.length > 0 ? Math.min(45, 40 + (monitoredMatches.length - 1) * 5) : 0,
		learnedBoost: clamp(learnedBoost, -32, 40),
		evidenceCount: profile.evidenceCount,
	};
}

/** A small overlap metric used as a diversity penalty, not as a topic score. */
export function tokenOverlapSimilarity(left: string, right: string): number {
	const leftTokens = new Set(extractTopicFeatures({ title: left }).values());
	const rightTokens = new Set(extractTopicFeatures({ title: right }).values());
	if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
	let intersection = 0;
	for (const token of leftTokens) if (rightTokens.has(token)) intersection += 1;
	return intersection / (leftTokens.size + rightTokens.size - intersection);
}
