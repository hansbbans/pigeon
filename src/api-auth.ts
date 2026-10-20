const AUTH_PREFIX = 'GoogleLogin auth=pigeon/';

export async function generateApiToken(password: string): Promise<string> {
	const data = new TextEncoder().encode(password);
	const hash = await crypto.subtle.digest('SHA-256', data);
	return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Compares every byte regardless of where the first difference is. */
export function constantTimeEqual(a: string, b: string): boolean {
	const left = new TextEncoder().encode(a);
	const right = new TextEncoder().encode(b);
	const length = Math.max(left.length, right.length);
	let diff = left.length ^ right.length;
	for (let i = 0; i < length; i++) {
		diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
	}
	return diff === 0;
}

export async function requireApiAuth(
	request: Request,
	password: string,
): Promise<Response | null> {
	// An unset password would otherwise make SHA-256("") a valid token.
	if (!password) {
		return new Response('Unauthorized', { status: 401 });
	}

	const auth = request.headers.get('Authorization');
	if (!auth?.startsWith(AUTH_PREFIX)) {
		return new Response('Unauthorized', { status: 401 });
	}

	const token = auth.slice(AUTH_PREFIX.length);
	const expected = await generateApiToken(password);
	if (!constantTimeEqual(token, expected)) {
		return new Response('Unauthorized', { status: 401 });
	}

	return null;
}
