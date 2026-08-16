export type RefreshOutcome =
	| 'success'
	| 'not_modified'
	| 'unchanged'
	| 'rate_limited'
	| 'http_error'
	| 'parse_error'
	| 'network_error'
	| 'rejected'
	| 'lease_lost';

export interface RefreshScheduleInput {
	feedKey: string;
	fetchIntervalMinutes: number | null | undefined;
	consecutiveFailures: number | null | undefined;
	outcome: RefreshOutcome;
	retryAfterAt?: string | null;
	cacheUntilAt?: string | null;
}

export interface HostFeed {
	feed_key: string;
	source_url: string;
}

const MIN_INTERVAL_MINUTES = 15;
const MAX_INTERVAL_MINUTES = 24 * 60;
const MAX_BACKOFF_MINUTES = 24 * 60;

export function computeNextFetchAt(now: Date, input: RefreshScheduleInput): string {
	if (input.retryAfterAt && input.outcome === 'rate_limited') {
		const retryAt = new Date(input.retryAfterAt);
		if (!Number.isNaN(retryAt.getTime()) && retryAt.getTime() > now.getTime()) {
			return new Date(
				Math.min(retryAt.getTime(), now.getTime() + MAX_BACKOFF_MINUTES * 60_000),
			).toISOString();
		}
	}

	const baseMinutes = clamp(
		Math.round(input.fetchIntervalMinutes ?? 60),
		MIN_INTERVAL_MINUTES,
		MAX_INTERVAL_MINUTES,
	);
	const isSuccess = ['success', 'not_modified', 'unchanged'].includes(input.outcome);
	const failureCount = isSuccess ? 0 : Math.max(1, (input.consecutiveFailures ?? 0) + 1);
	const backoffMultiplier = isSuccess ? 1 : 2 ** Math.min(failureCount - 1, 8);
	const minutes = Math.min(baseMinutes * backoffMultiplier, MAX_BACKOFF_MINUTES);
	const jitter = deterministicJitter(input.feedKey);
	const delayMinutes = Math.min(minutes * jitter, MAX_BACKOFF_MINUTES);
	let nextTime = now.getTime() + Math.round(delayMinutes * 60_000);
	if (isSuccess && input.cacheUntilAt) {
		const cacheUntil = new Date(input.cacheUntilAt).getTime();
		if (Number.isFinite(cacheUntil)) {
			nextTime = Math.max(nextTime, Math.min(cacheUntil, now.getTime() + 86_400_000));
		}
	}
	return new Date(nextTime).toISOString();
}

export function parseRetryAfter(value: string | null, now: Date): string | null {
	if (!value) return null;
	const seconds = Number(value.trim());
	if (Number.isFinite(seconds) && seconds >= 0) {
		return new Date(now.getTime() + Math.min(seconds, 86_400) * 1_000).toISOString();
	}
	const date = new Date(value);
	if (Number.isNaN(date.getTime()) || date.getTime() <= now.getTime()) return null;
	return new Date(Math.min(date.getTime(), now.getTime() + 86_400_000)).toISOString();
}

export function parseCacheControlMaxAge(value: string | null, now: Date): string | null {
	if (!value) return null;
	const directive = value.match(/(?:^|,)\s*(?:s-maxage|max-age)\s*=\s*"?(\d+)"?/i);
	if (!directive) return null;
	const seconds = Number(directive[1]);
	if (!Number.isFinite(seconds) || seconds < 0) return null;
	return new Date(now.getTime() + Math.min(seconds, 86_400) * 1_000).toISOString();
}

export function shouldUseConditionalRequest(
	now: Date,
	lastFullFetchAt: string | null | undefined,
	hasValidator: boolean,
): boolean {
	if (!hasValidator || !lastFullFetchAt) return false;
	const lastFullFetch = new Date(lastFullFetchAt).getTime();
	if (!Number.isFinite(lastFullFetch)) return false;
	return now.getTime() - lastFullFetch < 7 * 86_400_000;
}

export function selectFeedsFairly<T extends HostFeed>(feeds: T[], limit: number): T[] {
	const queues = new Map<string, T[]>();
	for (const feed of feeds) {
		const host = safeHost(feed.source_url);
		const queue = queues.get(host) ?? [];
		queue.push(feed);
		queues.set(host, queue);
	}

	const selected: T[] = [];
	const hosts = [...queues.keys()].sort();
	while (selected.length < limit) {
		let selectedThisRound = false;
		for (const host of hosts) {
			const next = queues.get(host)?.shift();
			if (!next) continue;
			selected.push(next);
			selectedThisRound = true;
			if (selected.length === limit) break;
		}
		if (!selectedThisRound) break;
	}
	return selected;
}

export function safeHost(url: string): string {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return `invalid:${stableHash(url)}`;
	}
}

export function redactRefreshError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message
		.replace(/https?:\/\/[^\s)]+/gi, '[feed URL]')
		.replace(/([?&](?:token|key|auth|password|secret)=)[^&\s]+/gi, '$1[redacted]')
		.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email redacted]')
		.slice(0, 240);
}

function deterministicJitter(feedKey: string): number {
	return 0.9 + (stableHash(feedKey) % 201) / 1_000;
}

function stableHash(value: string): number {
	let hash = 2166136261;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(Math.max(value, minimum), maximum);
}
