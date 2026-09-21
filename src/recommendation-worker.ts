import { DurableObject } from 'cloudflare:workers';

import { ensureDatabaseSchema } from './migrations';
import { handleRecommendations } from './recommendations';
import type { Env } from './types';

/**
 * Runs the existing recommendation implementation behind a Durable Object so
 * CPU-heavy topic extraction and diversity selection do not consume the
 * public Worker's 10 ms Free-plan HTTP budget.
 *
 * The object deliberately keeps no recommendation cache. Every request reads
 * the current D1 state, so engagement and monitored-topic changes remain
 * visible immediately and the public API keeps its existing semantics.
 */
export class RecommendationEngine extends DurableObject<Env> {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (request.method !== 'GET' || url.pathname !== '/api/v1/recommendations') {
			return new Response('Not found', { status: 404 });
		}

		try {
			await ensureDatabaseSchema(this.env);
			return await handleRecommendations(request, this.env);
		} catch (error) {
			console.error(
				'[Recommendations] Durable Object handler failed',
				error instanceof Error ? error.message : String(error),
			);
			return new Response('Recommendation service unavailable', { status: 503 });
		}
	}
}

// The helper Worker has no public route. The Durable Object is reachable only
// through the authenticated binding in the main Worker.
export default {
	fetch(): Response {
		return new Response('Not found', { status: 404 });
	},
} satisfies ExportedHandler<Env>;
