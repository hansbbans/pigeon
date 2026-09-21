import { requireApiAuth } from './api-auth';
import { handleEngagementIngestion } from './engagement';
import { ensureDatabaseSchema } from './migrations';
import { handleIncrementalSync } from './sync-api';
import { handleMutationBatch } from './mutation-api';
import { handleImageProxy } from './image-proxy';
import { handlePersonalization } from './personalization-api';
import { handleStaleFeeds } from './stale-feeds-api';
import type { Env } from './types';

export async function handleNativeApiRequest(request: Request, env: Env): Promise<Response> {
	const authError = await requireApiAuth(request, env.API_PASSWORD);
	if (authError) {
		return authError;
	}
	const path = new URL(request.url).pathname;
	// Keep the public Worker on the cheap side of the 10 ms Free-plan CPU
	// limit. The ranking implementation runs in the dedicated helper Worker
	// and its SQLite-backed Durable Object; the original request and response
	// stay opaque at this boundary.
	if (path === '/api/v1/recommendations') {
		if (request.method !== 'GET') {
			return new Response('Not found', { status: 404 });
		}
		return forwardRecommendations(request, env);
	}
	if (path === '/api/v1/image-proxy' && request.method === 'GET') {
		return handleImageProxy(request);
	}

	try {
		await ensureDatabaseSchema(env);
	} catch (error) {
		console.error('[Migrations] Native reader request failed because database migration failed', error);
		return new Response('Database migration failed', { status: 503 });
	}

	if (path === '/api/v1/engagement' && request.method === 'POST') {
		return handleEngagementIngestion(request, env);
	}
	if (path === '/api/v1/sync' && request.method === 'GET') {
		return handleIncrementalSync(request, env);
	}
	if (path === '/api/v1/mutations' && request.method === 'POST') {
		return handleMutationBatch(request, env);
	}
	if (path === '/api/v1/personalization') {
		return handlePersonalization(request, env);
	}
	if (path === '/api/v1/stale-feeds') {
		return handleStaleFeeds(request, env);
	}

	return new Response('Not found', { status: 404 });
}

async function forwardRecommendations(request: Request, env: Env): Promise<Response> {
	if (!env.RECOMMENDATIONS) {
		return new Response('Recommendation service unavailable', { status: 503 });
	}

	try {
		const stub = env.RECOMMENDATIONS.getByName('default');
		const forwardedRequest = new Request(request);
		// The public Worker has already authenticated this request. Do not pass
		// caller credentials into the internal helper boundary.
		forwardedRequest.headers.delete('authorization');
		forwardedRequest.headers.delete('cookie');
		return await stub.fetch(forwardedRequest);
	} catch (error) {
		console.error(
			'[Recommendations] Durable Object request failed',
			error instanceof Error ? error.message : String(error),
		);
		return new Response('Recommendation service unavailable', { status: 503 });
	}
}
