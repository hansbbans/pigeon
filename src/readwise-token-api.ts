import type { Env } from './types';
import { requireApiAuth } from './api-auth';
import { ensureDatabaseSchema } from './migrations';

/**
 * Server-side backup of the user's Readwise Reader access token so clients
 * (the iOS app after a fresh install, the browser app) can restore it after
 * signing in. Stored in the `_meta` key/value table; the token is never logged.
 */
export const READWISE_TOKEN_META_KEY = 'readwise_token';
export const READWISE_TOKEN_MAX_LENGTH = 512;

export async function handleReadwiseTokenRequest(request: Request, env: Env): Promise<Response> {
	const authError = await requireApiAuth(request, env.API_PASSWORD);
	if (authError) return authError;

	const method = request.method.toUpperCase();
	if (method !== 'GET' && method !== 'PUT' && method !== 'DELETE') {
		return new Response('Method not allowed', {
			status: 405,
			headers: { Allow: 'GET, PUT, DELETE', 'Cache-Control': 'no-store' },
		});
	}

	try {
		await ensureDatabaseSchema(env);
	} catch (error) {
		console.error('[ReadwiseToken] Database migration failed', error);
		return jsonResponse({ error: 'Database migration failed' }, 503);
	}

	if (method === 'GET') {
		const row = await env.DB.prepare('SELECT value FROM _meta WHERE key = ?')
			.bind(READWISE_TOKEN_META_KEY)
			.first<{ value: string | null }>();
		const token = row?.value?.trim() ? row.value : null;
		return jsonResponse({ token });
	}

	if (method === 'DELETE') {
		await env.DB.prepare('DELETE FROM _meta WHERE key = ?').bind(READWISE_TOKEN_META_KEY).run();
		return jsonResponse({ token: null });
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return jsonResponse({ error: 'Request body must be JSON' }, 400);
	}
	const raw = body && typeof body === 'object' ? (body as { token?: unknown }).token : undefined;
	if (typeof raw !== 'string') {
		return jsonResponse({ error: 'token must be a string' }, 400);
	}
	const token = raw.trim();
	if (!token) {
		return jsonResponse({ error: 'token must not be empty' }, 400);
	}
	if (token.length > READWISE_TOKEN_MAX_LENGTH) {
		return jsonResponse({ error: `token must be at most ${READWISE_TOKEN_MAX_LENGTH} characters` }, 400);
	}

	await env.DB.prepare(
		'INSERT INTO _meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
	)
		.bind(READWISE_TOKEN_META_KEY, token)
		.run();
	return jsonResponse({ token });
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
	});
}
