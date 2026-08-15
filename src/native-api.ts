import { requireApiAuth } from './api-auth';
import { handleEngagementIngestion } from './engagement';
import { ensureDatabaseSchema } from './migrations';
import { handleRecommendations } from './recommendations';
import { handleIncrementalSync } from './sync-api';
import { handleMutationBatch } from './mutation-api';
import { handleImageProxy } from './image-proxy';
import { handlePersonalization } from './personalization-api';
import type { Env } from './types';

export async function handleNativeApiRequest(request: Request, env: Env): Promise<Response> {
	const authError = await requireApiAuth(request, env.API_PASSWORD);
	if (authError) {
		return authError;
	}
	const path = new URL(request.url).pathname;
	if (path === '/api/v1/image-proxy' && request.method === 'GET') {
		return handleImageProxy(request);
	}

	try {
		await ensureDatabaseSchema(env);
	} catch (error) {
		console.error('[Migrations] Native reader request failed because database migration failed', error);
		return new Response('Database migration failed', { status: 503 });
	}

	if (path === '/api/v1/recommendations' && request.method === 'GET') {
		return handleRecommendations(request, env);
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

	return new Response('Not found', { status: 404 });
}
