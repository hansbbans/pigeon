import type { Env } from './types';
import { handleIncomingEmail } from './email-handler';
import { generateAtomFeed } from './feed';
import { generateOpml } from './opml';
import { handleGreaderRequest } from './greader';
import { handleCronTrigger } from './cron-handler';
import { handleSubscribe } from './subscribe';
import { renderBrowserAppHtml } from './browser-app';
import { handleStatusRequest } from './status';

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		if (path === '/health') {
			return new Response('ok');
		}

		if (path === '/feeds/opml') {
			return handleOpml(env);
		}

		if (path === '/feeds/subscribe' && request.method === 'POST') {
			return handleSubscribe(request, env);
		}

		if (path === '/feeds') {
			return handleFeedList(env);
		}

		if (path === '/app' || path === '/app/') {
			return new Response(renderBrowserAppHtml(env.BASE_URL), {
				headers: { 'Content-Type': 'text/html; charset=utf-8' },
			});
		}

		if (path === '/app/status') {
			return handleStatusRequest(request, env);
		}

		if (path.startsWith('/feed/')) {
			return handleFeed(request, url, env);
		}

		if (path === '/accounts/ClientLogin' || path.startsWith('/reader/api/0/')) {
			return handleGreaderRequest(request, env);
		}

		// FreshRSS-style paths (Reeder appends /api/greader.php)
		if (path.startsWith('/api/greader.php/')) {
			const rewritten = new Request(
				new URL(path.slice('/api/greader.php'.length) + url.search, url.origin),
				request,
			);
			return handleGreaderRequest(rewritten, env);
		}

		return new Response('Not found', { status: 404 });
	},

	async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
		await handleIncomingEmail(message, env);
	},

	async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
		await handleCronTrigger(env);
	},
} satisfies ExportedHandler<Env>;

async function handleFeed(request: Request, url: URL, env: Env): Promise<Response> {
	const feedKey = url.pathname.slice('/feed/'.length);
	if (!feedKey) {
		return new Response('Feed key required', { status: 400 });
	}

	// Get feed metadata
	const feed = await env.DB.prepare(
		'SELECT feed_key, display_name, from_email, custom_title, last_item_at FROM feeds WHERE feed_key = ? AND is_active = 1',
	)
		.bind(feedKey)
		.first<{
			feed_key: string;
			display_name: string;
			from_email: string | null;
			custom_title: string | null;
			last_item_at: string | null;
		}>();

	if (!feed) {
		return new Response('Feed not found', { status: 404 });
	}

	// ETag / conditional GET
	const etag = `"${feed.last_item_at || 'empty'}"`;
	const ifNoneMatch = request.headers.get('If-None-Match');
	if (ifNoneMatch === etag) {
		return new Response(null, { status: 304 });
	}

	// Get items
	const limit = Math.min(
		parseInt(url.searchParams.get('limit') || env.ITEMS_PER_FEED || '50'),
		100,
	);

	const { results: items } = await env.DB.prepare(
		'SELECT id, subject, html_content, text_content, from_name, from_email, received_at FROM items WHERE feed_key = ? ORDER BY received_at DESC LIMIT ?',
	)
		.bind(feedKey, limit)
		.all<{
			id: string;
			subject: string;
			html_content: string;
			text_content: string | null;
			from_name: string | null;
			from_email: string | null;
			received_at: string;
		}>();

	const xml = generateAtomFeed(feed, items, env.BASE_URL);

	return new Response(xml, {
		headers: {
			'Content-Type': 'application/atom+xml; charset=utf-8',
			'Cache-Control': 'public, max-age=300',
			'ETag': etag,
			'Access-Control-Allow-Origin': '*',
		},
	});
}

async function handleFeedList(env: Env): Promise<Response> {
	const { results } = await env.DB.prepare(
		`SELECT feed_key, display_name, from_email, source_type, source_url, icon_url, item_count, last_item_at, custom_title, category
		 FROM feeds WHERE is_active = 1 ORDER BY last_item_at DESC`,
	).all<{
		feed_key: string;
		display_name: string;
		from_email: string | null;
		source_type: string;
		source_url: string | null;
		icon_url: string | null;
		item_count: number;
		last_item_at: string | null;
		custom_title: string | null;
		category: string | null;
	}>();

	const feeds = results.map((f) => ({
		feed_key: f.feed_key,
		title: f.custom_title || f.display_name,
		source_type: f.source_type,
		source_url: f.source_url,
		from_email: f.from_email,
		icon_url: f.icon_url,
		item_count: f.item_count,
		last_item_at: f.last_item_at,
		category: f.category,
		feed_url: `${env.BASE_URL}/feed/${f.feed_key}`,
	}));

	return new Response(JSON.stringify({ feeds }, null, 2), {
		headers: { 'Content-Type': 'application/json' },
	});
}

async function handleOpml(env: Env): Promise<Response> {
	const { results } = await env.DB.prepare(
		`SELECT feed_key, display_name, custom_title, category
		 FROM feeds WHERE is_active = 1 ORDER BY display_name`,
	).all<{
		feed_key: string;
		display_name: string;
		custom_title: string | null;
		category: string | null;
	}>();

	const opml = generateOpml(results, env.BASE_URL);

	return new Response(opml, {
		headers: {
			'Content-Type': 'text/x-opml; charset=utf-8',
			'Content-Disposition': 'attachment; filename="pigeon-feeds.opml"',
		},
	});
}
