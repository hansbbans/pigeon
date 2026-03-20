const AUTH_PREFIX = 'GoogleLogin auth=pigeon/';

export async function generateApiToken(password: string): Promise<string> {
	const data = new TextEncoder().encode(password);
	const hash = await crypto.subtle.digest('SHA-256', data);
	return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function requireApiAuth(
	request: Request,
	password: string,
): Promise<Response | null> {
	const auth = request.headers.get('Authorization');
	if (!auth?.startsWith(AUTH_PREFIX)) {
		return new Response('Unauthorized', { status: 401 });
	}

	const token = auth.slice(AUTH_PREFIX.length);
	const expected = await generateApiToken(password);
	if (token !== expected) {
		return new Response('Unauthorized', { status: 401 });
	}

	return null;
}
