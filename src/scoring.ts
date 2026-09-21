export type ScoringEventType =
	| 'explicit_open'
	| 'active_reading'
	| 'scroll_depth'
	| 'outbound_link'
	| 'star'
	| 'unstar'
	| 'more_like_this'
	| 'not_interested'
	| 'read'
	| 'unread'
	| 'bulk_mark_all_read';

export type EventCounts = Partial<Record<ScoringEventType, number>>;

export type SignalSummary = EventCounts & {
	activeReadingSeconds?: number;
	maxScrollDepth?: number;
	evidenceCount?: number;
};

export interface ScoringInput {
	receivedAt: string;
	now: string;
	isStarred: boolean;
	sampleCount: number;
	feedSignals: SignalSummary;
	itemSignals: SignalSummary;
	topic?: TopicScoreInput;
}

export interface TopicScoreInput {
	monitoredMatches?: readonly string[];
	learnedMatches?: readonly string[];
	learnedNegativeMatches?: readonly string[];
	monitoredBoost?: number;
	learnedBoost?: number;
}

export interface ScoreResult {
	score: number;
	confidence: number;
	sampleCount: number;
	explanation: string;
	learningState: string;
}

const SIGNAL_WEIGHTS: Record<ScoringEventType, number> = {
	explicit_open: 1,
	active_reading: 0,
	scroll_depth: 0,
	outbound_link: 10,
	star: 12,
	unstar: -2,
	more_like_this: 14,
	not_interested: -36,
	read: 0.5,
	unread: 0,
	bulk_mark_all_read: 0,
};

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(Math.max(value, minimum), maximum);
}

function totalSignalWeight(signals: SignalSummary): number {
	const transitionWeight = (Object.entries(SIGNAL_WEIGHTS) as Array<[ScoringEventType, number]>).reduce(
		(total, [eventType, weight]) => {
			const count = Math.min(Math.max(Number(signals[eventType]) || 0, 0), eventType === 'bulk_mark_all_read' ? 0 : 1);
			return total + count * weight;
		},
		0,
	);
	const activeReadingSeconds = signals.activeReadingSeconds ?? (signals.active_reading ?? 0) * 30;
	const activeReadingWeight = Math.min(Math.max(activeReadingSeconds, 0), 1_800) / 30;
	const scrollWeight = clamp(signals.maxScrollDepth ?? (signals.scroll_depth ?? 0), 0, 1) * 5;
	return transitionWeight + activeReadingWeight + scrollWeight;
}

function recencyScore(receivedAt: string, now: string): number {
	const receivedMillis = Date.parse(receivedAt);
	const nowMillis = Date.parse(now);
	if (!Number.isFinite(receivedMillis) || !Number.isFinite(nowMillis)) {
		return 0;
	}

	const ageHours = Math.max(0, (nowMillis - receivedMillis) / 3_600_000);
	return 35 * Math.exp(-ageHours / (24 * 7));
}

function hasSignal(signals: SignalSummary, eventType: ScoringEventType): boolean {
	return (signals[eventType] ?? 0) > 0;
}

function buildExplanation(
	input: ScoringInput,
	sourceAffinity: number,
	itemAffinity: number,
	freshness: number,
): string {
	if (hasSignal(input.itemSignals, 'not_interested')) {
		return 'You marked this story as not interested.';
	}
	const monitoredMatches = input.topic?.monitoredMatches ?? [];
	if (monitoredMatches.length > 0) {
		return `Matches your monitored topic${monitoredMatches.length === 1 ? '' : 's'}: ${monitoredMatches.join(', ')}.`;
	}
	if (hasSignal(input.itemSignals, 'more_like_this')) {
		return 'You asked for more stories like this.';
	}
	if (hasSignal(input.itemSignals, 'outbound_link')) {
		return 'You opened this story at its original source.';
	}
	if (hasSignal(input.itemSignals, 'active_reading')) {
		return 'You spent time reading this story.';
	}
	if (hasSignal(input.itemSignals, 'star')) {
		return 'You starred this story.';
	}
	const learnedMatches = input.topic?.learnedMatches ?? [];
	if (learnedMatches.length > 0) {
		return `Matches topics you have engaged with: ${learnedMatches.join(', ')}.`;
	}
	const learnedNegativeMatches = input.topic?.learnedNegativeMatches ?? [];
	if (learnedNegativeMatches.length > 0) {
		return `A weaker match for topics you have marked down: ${learnedNegativeMatches.join(', ')}.`;
	}
	if (hasSignal(input.feedSignals, 'not_interested')) {
		return 'You marked other stories from this source as not interested.';
	}
	if (hasSignal(input.feedSignals, 'more_like_this')) {
		return 'You asked for more stories from this source.';
	}
	if (hasSignal(input.feedSignals, 'outbound_link')) {
		return 'You often continue to the original source for stories like this.';
	}
	if (hasSignal(input.feedSignals, 'active_reading')) {
		return 'You tend to spend time reading stories from this source.';
	}
	if (sourceAffinity > 1.5) {
		return 'This source matches what you have been reading and saving.';
	}
	if (sourceAffinity < -1.5) {
		return 'Your recent feedback makes this source a weaker match.';
	}
	if (freshness > 24) {
		return 'It is fresh, with a small boost from your reading history.';
	}
	if (itemAffinity > 0) {
		return 'Your reading history gives this story a modest boost.';
	}
	return 'Starting with recency while Pigeon learns your preferences.';
}

function learningState(sampleCount: number): string {
	if (sampleCount === 0) {
		return 'Starting with recency';
	}
	if (sampleCount < 5) {
		return `Learning from ${sampleCount} signal${sampleCount === 1 ? '' : 's'}`;
	}
	return `Personalized from ${sampleCount} signals`;
}

/**
 * Transparent first-generation ranking. The constants are deliberately small,
 * deterministic, and easy to explain; this is not an external AI service.
 */
export function scoreRecommendation(input: ScoringInput): ScoreResult {
	// Source history is deliberately a small tie-breaker. It should never
	// overpower a relevant topic from another publisher.
	const sourceAffinity = clamp(totalSignalWeight(input.feedSignals) * 0.25, -3, 3);
	const itemAffinity = clamp(totalSignalWeight(input.itemSignals) * 0.75, -24, 18);
	const freshness = recencyScore(input.receivedAt, input.now);
	const starBoost = input.isStarred ? 15 : 0;
	const monitoredBoost = clamp(Number(input.topic?.monitoredBoost) || 0, 0, 45);
	const learnedBoost = clamp(Number(input.topic?.learnedBoost) || 0, -32, 40);
	const score = Math.round(clamp(
		15 + freshness + sourceAffinity + itemAffinity + monitoredBoost + learnedBoost + starBoost,
		0,
		100,
	));
	const sampleCount = Math.max(0, Math.floor(input.sampleCount));
	const confidence = clamp(1 - Math.exp(-sampleCount / 6), 0, 1);

	return {
		score,
		confidence,
		sampleCount,
		explanation: buildExplanation(input, sourceAffinity, itemAffinity, freshness),
		learningState: learningState(sampleCount),
	};
}
