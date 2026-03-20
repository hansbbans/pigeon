import { requireApiAuth } from './api-auth';
import type { Env } from './types';

export async function handleStatusRequest(
	request: Request,
	env: Env,
): Promise<Response> {
	const authErr = await requireApiAuth(request, env.API_PASSWORD);
	if (authErr) {
		return authErr;
	}

	return Response.json({
		status: 'ok',
	});
}
