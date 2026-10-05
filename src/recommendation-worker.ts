import { DurableObject } from 'cloudflare:workers';

import { ensureDatabaseSchema } from './migrations';
import { handleRecommendations, RecommendationSessions } from './recommendations';
import type { Env } from './types';

/**
 * Runs the existing recommendation implementation behind a Durable Object so
 * CPU-heavy topic extraction and ranking do not consume the
 * public Worker's 10 ms Free-plan HTTP budget.
 *
 * Each fresh load reads current D1 state. Bounded, short-lived metadata
 * snapshots preserve page order; continuations still recheck eligibility.
 */
export class RecommendationEngine extends DurableObject<Env> {
	private readonly recommendationSessions: RecommendationSessions;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.recommendationSessions = new RecommendationSessions({ storage: ctx.storage });
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (request.method !== 'GET' || url.pathname !== '/api/v1/recommendations') {
			return new Response('Not found', { status: 404 });
		}

		try {
			await ensureDatabaseSchema(this.env);
			return await handleRecommendations(request, this.env, this.recommendationSessions);
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
