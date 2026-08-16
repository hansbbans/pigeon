import type { Env } from './types';

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
		'Pigeon ranks unread stories with freshness plus confirmed reading and feedback activity stored on your Pigeon server. Bulk read actions are neutral.',
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
		'Confirmed signal history stays on your Pigeon server until you delete an entry or reset all preferences. Export and delete controls are available here.',
};

export async function handlePersonalization(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	if (request.method === 'GET') {
		const { results } = await env.DB.prepare(
			`SELECT e.id, e.item_id, e.event_type, e.feed_key, e.occurred_at,
			        i.subject AS title, COALESCE(f.custom_title, f.display_name) AS source
			   FROM engagement_events e
			   LEFT JOIN items i ON i.id = e.item_id
			   LEFT JOIN feeds f ON f.feed_key = e.feed_key
			  WHERE e.event_type <> 'bulk_mark_all_read'
			  ORDER BY e.occurred_at DESC, e.id DESC
			  LIMIT 500`,
		).all<HistoryRow>();
		const payload = {
			exportedAt: new Date().toISOString(),
			policy: POLICY,
			history: results.map((row) => ({
				id: row.id,
				itemId: row.item_id,
				type: row.event_type,
				feedKey: row.feed_key,
				occurredAt: row.occurred_at,
				title: row.title,
				source: row.source,
			})),
		};
		if (url.searchParams.get('download') === '1') {
			return new Response(JSON.stringify(payload, null, 2), {
				headers: {
					'Cache-Control': 'no-store',
					'Content-Disposition': 'attachment; filename="pigeon-personalization.json"',
					'Content-Type': 'application/json; charset=utf-8',
				},
			});
		}
		return Response.json(payload, { headers: { 'Cache-Control': 'no-store' } });
	}

	if (request.method === 'DELETE') {
		if (url.searchParams.get('all') === '1') {
			await env.DB.prepare('DELETE FROM engagement_events').run();
			return Response.json({ deleted: 'all' });
		}
		const id = url.searchParams.get('id');
		if (!id || id.length > 200) return Response.json({ error: 'A valid history id is required' }, { status: 400 });
		await env.DB.prepare('DELETE FROM engagement_events WHERE id = ?').bind(id).run();
		return Response.json({ deleted: id });
	}

	return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, DELETE' } });
}
