import type { Env } from './types';
import { apiTimestamp } from './timestamps';
import {
	loadMonitoredTopics,
	MONITORED_TOPICS_META_KEY,
	normalizeMonitoredTopics,
	readBoundedJson,
	saveMonitoredTopics,
} from './topic-preferences';

interface HistoryRow {
	id: string;
	item_id: string;
	event_type: string;
	feed_key: string | null;
	occurred_at: string;
	title: string | null;
	source: string | null;
}

const POLICY = {
	plainLanguageSummary:
		'Pigeon ranks unread stories with freshness, topics you monitor, and confirmed reading and feedback activity stored on your Pigeon server. Topic matches can transfer across sources; source history is only a small tie-breaker. Bulk read actions are neutral.',
	confirmedSignals: [
		{ name: 'More like this', effect: 'Strong positive' },
		{ name: 'Not interested', effect: 'Strong negative' },
		{ name: 'Star and continue to source', effect: 'Positive' },
		{ name: 'Active reading and scroll depth', effect: 'Modest positive' },
		{ name: 'Single-story read', effect: 'Very small positive' },
		{ name: 'Bulk read actions', effect: 'Neutral' },
	],
	confirmationRule:
		'Only actions accepted by the server become ranking signals. Pending, failed, cancelled, and duplicate offline actions do not add confirmed evidence.',
	retention:
		'Confirmed signal history and monitored topics stay on your Pigeon server until you delete an entry or reset all preferences. Export and delete controls are available here.',
};

export interface PersonalizationSnapshot {
	exportedAt: string;
	monitoredTopics: string[];
	policy: typeof POLICY;
	history: Array<{
		id: string;
		itemId: string;
		type: string;
		feedKey: string | null;
		occurredAt: string;
		title: string | null;
		source: string | null;
	}>;
}

const HISTORY_SCREEN_LIMIT = 500;
const EXPORT_PAGE_SIZE = 250;

type HistoryEntry = PersonalizationSnapshot['history'][number];
type HistoryCursor = { occurredAt: string; id: string };

interface HistoryPage {
	entries: HistoryEntry[];
	/** Where the next page starts, or undefined after the last page. */
	next?: HistoryCursor;
}

async function loadHistoryPage(env: Env, limit: number, cursor?: HistoryCursor): Promise<HistoryPage> {
	const statement = env.DB.prepare(
		`SELECT e.id, e.item_id, e.event_type, e.feed_key, e.occurred_at,
		        i.subject AS title, COALESCE(f.custom_title, f.display_name) AS source
		   FROM engagement_events e
		   LEFT JOIN items i ON i.id = e.item_id
		   LEFT JOIN feeds f ON f.feed_key = e.feed_key
		  WHERE e.event_type <> 'bulk_mark_all_read'
		  ${cursor ? 'AND (e.occurred_at, e.id) < (?, ?)' : ''}
		  ORDER BY e.occurred_at DESC, e.id DESC
		  LIMIT ?`,
	);
	const { results } = await (cursor
		? statement.bind(cursor.occurredAt, cursor.id, limit)
		: statement.bind(limit)).all<HistoryRow>();
	const last = results.at(-1);
	return {
		// The app decodes occurredAt as an ISO 8601 date, so an event without a
		// readable time is left out rather than failing the whole response.
		entries: results.flatMap((row) => {
			const occurredAt = apiTimestamp(row.occurred_at);
			return occurredAt ? [{
				id: row.id,
				itemId: row.item_id,
				type: row.event_type,
				feedKey: row.feed_key,
				occurredAt,
				title: row.title,
				source: row.source,
			}] : [];
		}),
		// Page on the stored values, which are what the query orders by.
		next: last && results.length === limit ? { occurredAt: last.occurred_at, id: last.id } : undefined,
	};
}

async function buildSnapshot(env: Env, historyLimit = HISTORY_SCREEN_LIMIT): Promise<{ snapshot: PersonalizationSnapshot; next?: HistoryCursor }> {
	const [history, monitoredTopics] = await Promise.all([
		loadHistoryPage(env, historyLimit),
		loadMonitoredTopics(env),
	]);

	return {
		snapshot: {
			exportedAt: new Date().toISOString(),
			monitoredTopics,
			policy: POLICY,
			history: history.entries,
		},
		next: history.next,
	};
}

function streamExport(env: Env, snapshot: PersonalizationSnapshot, firstNext: HistoryCursor | undefined): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const { history, ...metadata } = snapshot;
	let page: HistoryPage | null = { entries: history, next: firstNext };
	let cursor: HistoryCursor | undefined;
	let hasEntries = false;
	let cancelled = false;
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(`${JSON.stringify(metadata).slice(0, -1)},"history":[`));
		},
		async pull(controller) {
			const { entries, next } = page ?? await loadHistoryPage(env, EXPORT_PAGE_SIZE, cursor);
			if (cancelled) return;
			if (entries.length > 0) {
				const serialized = JSON.stringify(entries).slice(1, -1);
				controller.enqueue(encoder.encode(`${hasEntries ? ',' : ''}${serialized}`));
				hasEntries = true;
			}
			if (!next) {
				controller.enqueue(encoder.encode(']}'));
				controller.close();
				return;
			}
			cursor = next;
			page = null;
		},
		cancel() { cancelled = true; },
	});
}

export async function handlePersonalization(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	if (request.method === 'GET') {
		const isDownload = url.searchParams.get('download') === '1';
		const { snapshot, next } = await buildSnapshot(env, isDownload ? EXPORT_PAGE_SIZE : HISTORY_SCREEN_LIMIT);
		if (isDownload) {
			return new Response(streamExport(env, snapshot, next), {
				headers: {
					'Cache-Control': 'no-store',
					'Content-Disposition': 'attachment; filename="pigeon-personalization.json"',
					'Content-Type': 'application/json; charset=utf-8',
				},
			});
		}
		return Response.json(snapshot, { headers: { 'Cache-Control': 'no-store' } });
	}

	if (request.method === 'PUT') {
		let body: unknown;
		try {
			body = await readBoundedJson(request);
		} catch (error) {
			return Response.json(
				{ error: error instanceof Error ? error.message : 'Request body is invalid' },
				{ status: 400 },
			);
		}
		if (typeof body !== 'object' || body === null || Array.isArray(body) || !('monitoredTopics' in body)) {
			return Response.json({ error: 'Request body must contain a monitoredTopics array' }, { status: 400 });
		}
		let monitoredTopics: string[];
		try {
			monitoredTopics = normalizeMonitoredTopics((body as { monitoredTopics: unknown }).monitoredTopics);
		} catch (error) {
			return Response.json(
				{ error: error instanceof Error ? error.message : 'monitoredTopics is invalid' },
				{ status: 400 },
			);
		}
		try {
			await saveMonitoredTopics(env, monitoredTopics);
			return Response.json((await buildSnapshot(env)).snapshot, { headers: { 'Cache-Control': 'no-store' } });
		} catch (error) {
			console.error('[Personalization] Could not save monitored topics', error instanceof Error ? error.message : String(error));
			return Response.json({ error: 'Could not save monitored topics' }, { status: 503 });
		}
	}

	if (request.method === 'DELETE') {
		if (url.searchParams.get('all') === '1') {
			await env.DB.batch([
				env.DB.prepare('DELETE FROM engagement_events'),
				env.DB.prepare('DELETE FROM _meta WHERE key = ?').bind(MONITORED_TOPICS_META_KEY),
			]);
			return Response.json({ deleted: 'all' });
		}
		const id = url.searchParams.get('id');
		if (!id || id.length > 200) return Response.json({ error: 'A valid history id is required' }, { status: 400 });
		await env.DB.prepare('DELETE FROM engagement_events WHERE id = ?').bind(id).run();
		return Response.json({ deleted: id });
	}

	return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, PUT, DELETE' } });
}
