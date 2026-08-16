import type { Env } from './types';

const MAX_BULK_FEEDS = 100;

interface StaleFeedRow {
	feed_key: string;
	rowid: number;
	title: string;
	source_type: string;
	source_url: string | null;
	site_url: string | null;
	last_article_at: string | null;
	last_success_at: string | null;
	last_http_status: number | null;
	stale_archived: number;
}

export async function handleStaleFeeds(request: Request, env: Env): Promise<Response> {
	if (request.method === 'GET') return listStaleFeeds(request, env);
	if (request.method === 'POST') return updateArchiveState(request, env);
	return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, POST' } });
}

async function listStaleFeeds(request: Request, env: Env): Promise<Response> {
	const rawDays = Number.parseInt(new URL(request.url).searchParams.get('days') ?? '90', 10);
	const days = Number.isFinite(rawDays) ? Math.min(Math.max(rawDays, 30), 730) : 90;
	const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
	const { results } = await env.DB.prepare(
		`SELECT f.feed_key, f.rowid, COALESCE(f.custom_title, f.display_name) AS title,
		        f.source_type, f.source_url, f.site_url,
		        MAX(i.received_at) AS last_article_at,
		        f.last_success_at, f.last_http_status, f.stale_archived
		   FROM feeds f
		   LEFT JOIN items i ON i.feed_key = f.feed_key
		  WHERE f.is_active = 1
		  GROUP BY f.feed_key
		 HAVING datetime(COALESCE(MAX(i.received_at), f.first_seen_at)) <= datetime(?)
		     OR f.stale_archived = 1
		  ORDER BY f.stale_archived ASC, COALESCE(MAX(i.received_at), f.first_seen_at) ASC, title COLLATE NOCASE
		  LIMIT 500`,
	).bind(cutoff).all<StaleFeedRow>();
	return Response.json({
		cutoff,
		feeds: results.map((feed) => ({
			feedKey: feed.feed_key,
			streamId: `feed/${feed.rowid}`,
			title: feed.title,
			sourceType: feed.source_type,
			sourceURL: feed.source_url,
			siteURL: feed.site_url,
			lastArticleAt: feed.last_article_at,
			lastSuccessAt: feed.last_success_at,
			httpStatus: feed.last_http_status,
			archived: feed.stale_archived === 1,
		})),
	}, { headers: { 'Cache-Control': 'no-store' } });
}

async function updateArchiveState(request: Request, env: Env): Promise<Response> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: 'Request body must be valid JSON' }, { status: 400 });
	}
	if (!isRecord(body) || (body.action !== 'archive' && body.action !== 'unarchive') || !Array.isArray(body.feedKeys)) {
		return Response.json({ error: 'action and feedKeys are required' }, { status: 400 });
	}
	const feedKeys = [...new Set(body.feedKeys)].filter((value): value is string =>
		typeof value === 'string' && value.length > 0 && value.length <= 200
	);
	if (feedKeys.length === 0 || feedKeys.length > MAX_BULK_FEEDS || feedKeys.length !== body.feedKeys.length) {
		return Response.json({ error: `feedKeys must contain 1-${MAX_BULK_FEEDS} unique valid keys` }, { status: 400 });
	}
	const archived = body.action === 'archive' ? 1 : 0;
	await env.DB.batch(feedKeys.map((feedKey) =>
		env.DB.prepare('UPDATE feeds SET stale_archived = ? WHERE feed_key = ? AND is_active = 1').bind(archived, feedKey)
	));
	return Response.json({ action: body.action, feedKeys });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
