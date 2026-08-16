import { assertSafeFeedUrl, normalizeContentType } from './feed-network';

const MAX_IMAGE_BYTES = 8 * 1_024 * 1_024;
const MAX_IMAGE_REDIRECTS = 5;
const IMAGE_TIMEOUT_MS = 20_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ALLOWED_IMAGE_TYPES = new Set([
	'image/avif',
	'image/gif',
	'image/heic',
	'image/heif',
	'image/jpeg',
	'image/png',
	'image/webp',
]);

export async function handleImageProxy(
	request: Request,
	fetcher: typeof fetch = fetch,
): Promise<Response> {
	const rawUrl = new URL(request.url).searchParams.get('url');
	if (!rawUrl) return new Response('Missing image URL', { status: 400 });

	let currentUrl: URL;
	try {
		currentUrl = assertSafeFeedUrl(rawUrl);
	} catch {
		return new Response('Unsafe image URL', { status: 400 });
	}

	try {
		for (let redirectCount = 0; ; redirectCount += 1) {
			const response = await fetcher(currentUrl, {
				redirect: 'manual',
				headers: {
					Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/heic,image/heif',
					'User-Agent': 'Pigeon Image Proxy/1.0',
				},
				signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
			});

			if (REDIRECT_STATUSES.has(response.status)) {
				if (redirectCount >= MAX_IMAGE_REDIRECTS) {
					response.body?.cancel().catch(() => undefined);
					return new Response('Too many image redirects', { status: 502 });
				}
				const location = response.headers.get('Location');
				if (!location) return new Response('Invalid image redirect', { status: 502 });
				try {
					currentUrl = assertSafeFeedUrl(new URL(location, currentUrl));
				} catch {
					return new Response('Unsafe image redirect', { status: 400 });
				}
				continue;
			}

			if (!response.ok) {
				response.body?.cancel().catch(() => undefined);
				return new Response('Image server error', { status: 502 });
			}
			const contentType = normalizeContentType(response.headers.get('Content-Type'));
			if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
				response.body?.cancel().catch(() => undefined);
				return new Response('Unsupported image type', { status: 415 });
			}
			const bytes = await readBoundedBytes(response, MAX_IMAGE_BYTES);
			return new Response(bytes, {
				headers: {
					'Cache-Control': 'private, max-age=86400',
					'Content-Length': bytes.byteLength.toString(),
					'Content-Type': contentType,
					'X-Content-Type-Options': 'nosniff',
				},
			});
		}
	} catch (error) {
		if (error instanceof Error && error.message === 'Image response is too large') {
			return new Response(error.message, { status: 413 });
		}
		return new Response('Image proxy unavailable', { status: 502 });
	}
}

async function readBoundedBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
	const declaredLength = Number(response.headers.get('Content-Length'));
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		response.body?.cancel().catch(() => undefined);
		throw new Error('Image response is too large');
	}
	if (!response.body) return new Uint8Array();

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let byteLength = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			byteLength += value.byteLength;
			if (byteLength > maxBytes) {
				await reader.cancel('Image response is too large');
				throw new Error('Image response is too large');
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const bytes = new Uint8Array(byteLength);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}
