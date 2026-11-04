import { assertSafeFeedUrl, normalizeContentType } from './feed-network';

const SOURCE_BYTES = 5_000_000;
const SOURCE_JSON_BYTES = 8_000_000;
const INPUT_BYTES = 8_192;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const READWISE_ENDPOINT = 'https://readwise.io/api/v3/save/';

/** Authenticated GET /api/v1/browser/reader-source?url=<public HTTP(S) URL>.
 * Returns {url: final URL, html}, no-store. Browser must parse inertly and sanitize
 * extraction output before rendering. Limits: 5 MB source / 8 MB serialized JSON,
 * five redirects and one 15-second deadline across all requests/body reads.
 */
export async function handleBrowserReaderSource(request: Request, fetcher: typeof fetch = fetch): Promise<Response> {
	if (request.method !== 'GET') return methodError('GET');
	const params = new URL(request.url).searchParams;
	if ([...params.keys()].some((key) => key !== 'url') || params.getAll('url').length !== 1) return failure('A single url is required', 400);
	let url: URL;
	try { url = safeURL(params.get('url')); } catch { return failure('A public HTTP(S) URL is required', 400); }
	const signal = AbortSignal.timeout(TIMEOUT_MS);
	try {
		for (let redirects = 0; ; redirects++) {
			const response = await fetcher(url, {
				method: 'GET', redirect: 'manual', signal,
				headers: { Accept: 'text/html,application/xhtml+xml;q=0.9', 'User-Agent': 'Pigeon Reader/1.0' },
			});
			if (REDIRECTS.has(response.status)) {
				cancelBody(response);
				if (redirects >= MAX_REDIRECTS) return failure('Too many article redirects', 502);
				const location = response.headers.get('Location');
				if (!location) return failure('Invalid article redirect', 502);
				try { url = safeURL(new URL(location, url).href); } catch { return failure('Unsafe article redirect', 400); }
				continue;
			}
			if (!response.ok) { cancelBody(response); return failure('Article server unavailable', 502); }
			const type = normalizeContentType(response.headers.get('Content-Type'));
			if (type !== 'text/html' && type !== 'application/xhtml+xml') { cancelBody(response); return failure('Article must be HTML', 415); }
			const html = await boundedText(response, SOURCE_BYTES, signal);
			if (!html.trim()) return failure('Article returned no content', 422);
			const body = JSON.stringify({ url: url.href, html });
			if (new TextEncoder().encode(body).byteLength > SOURCE_JSON_BYTES) throw new PayloadTooLarge();
			return new Response(body, { headers: jsonHeaders() });
		}
	} catch (error) {
		if (error instanceof PayloadTooLarge) return failure('Article response is too large', 413);
		return failure('Could not fetch article', 502);
	}
}

/** Authenticated POST /api/v1/browser/readwise/save, JSON {url, token}.
 * Transient token only: never stored/logged/echoed. Public HTTP(S) URL <=4096,
 * token <=1024 printable ASCII characters, request <=8192 bytes.
 * POSTs only to fixed Readwise endpoint, no redirects, 15-second deadline.
 * 200/201 -> {saved:true}; Readwise 401/403 -> 422 with
 * code:"readwise_authentication_failed" (not a Pigeon session-auth failure).
 */
export async function handleBrowserReadwiseSave(request: Request, fetcher: typeof fetch = fetch): Promise<Response> {
	if (request.method !== 'POST') return methodError('POST');
	if (normalizeContentType(request.headers.get('Content-Type')) !== 'application/json') return failure('JSON body required', 415);
	const signal = AbortSignal.timeout(TIMEOUT_MS);
	let url: URL;
	let token: string;
	try {
		const value: unknown = JSON.parse(await boundedText(request, INPUT_BYTES, signal));
		if (!value || typeof value !== 'object' || Array.isArray(value)
			|| Object.keys(value).some((key) => key !== 'url' && key !== 'token')) throw new Error();
		const body = value as { url?: unknown; token?: unknown };
		url = safeURL(body.url);
		if (typeof body.token !== 'string' || !body.token || body.token.length > 1024 || !/^[\x21-\x7e]+$/.test(body.token)) throw new Error();
		token = body.token;
	} catch (error) {
		if (error instanceof PayloadTooLarge) return failure('Save request is too large', 413);
		return failure('A valid url and token are required', 400);
	}
	try {
		const response = await fetcher(READWISE_ENDPOINT, {
			method: 'POST', redirect: 'manual', signal,
			headers: { Authorization: `Token ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
			body: JSON.stringify({ url: url.href }),
		});
		// Upstream body can contain secrets or unexpectedly large data; never read it.
		cancelBody(response);
		if (response.status === 200 || response.status === 201) return Response.json({ saved: true }, { headers: jsonHeaders() });
		if (response.status === 401 || response.status === 403) return failure('Readwise token was rejected', 422, 'readwise_authentication_failed');
		if (response.status === 429) return failure('Readwise rate limit reached; try again later', 429, 'readwise_rate_limited');
		return failure('Could not save to Readwise', 502);
	} catch { return failure('Could not save to Readwise', 502); }
}

const YOUTUBE_PROXY_RESPONSE_BYTES = 4_000_000;
const YOUTUBE_PROXY_REQUEST_BYTES = 16_384;
const YOUTUBE_PROXY_TIMEOUT_MS = 10_000;
/** Paths Defuddle's YouTube extractor calls: InnerTube player and next (POST JSON), caption tracks (GET). */
const YOUTUBE_PROXY_PATHS = new Map([
	['/youtubei/v1/player', 'POST'],
	['/youtubei/v1/next', 'POST'],
	['/api/timedtext', 'GET'],
]);
const YOUTUBE_PROXY_TYPES = new Set(['application/json', 'text/xml', 'application/xml', 'text/plain']);
const YOUTUBE_UPSTREAM_AGENT = /^(?:Mozilla\/5\.0|com\.google\.(?:android|ios)\.youtube\/)[\x20-\x7e]{0,200}$/;
const ACCEPT_LANGUAGE = /^[A-Za-z0-9*,;=.\- ]{1,100}$/;

/** Authenticated GET or POST /api/v1/browser/youtube-proxy?url=<YouTube API URL>.
 * Best-effort transcript source for the web client, which runs Defuddle's
 * YouTube extractor with a fetch routed here (YouTube sends no CORS headers).
 * Only https youtube.com / *.youtube.com on the default port, and only the
 * three paths in YOUTUBE_PROXY_PATHS with their one method. No redirects,
 * no caller credentials or cookies forwarded; POST bodies are JSON <= 16 KB.
 * Optional X-Pigeon-Upstream-User-Agent (a browser or YouTube app agent; the
 * browser itself cannot set User-Agent) and X-Pigeon-Upstream-Language become
 * the upstream User-Agent and Accept-Language. The upstream body passes
 * through unparsed (<= 4 MB, one 10-second deadline) as a 200 when the
 * upstream answered 2xx; any other upstream answer, or a larger one, is a 502
 * with code "youtube_unavailable".
 * YouTube may refuse Cloudflare addresses: clients treat every failure as
 * "transcript unavailable here".
 */
export async function handleBrowserYouTubeProxy(request: Request, fetcher: typeof fetch = fetch): Promise<Response> {
	const params = new URL(request.url).searchParams;
	if ([...params.keys()].some((key) => key !== 'url') || params.getAll('url').length !== 1) return failure('A single url is required', 400);
	let url: URL;
	try { url = youtubeProxyURL(params.get('url')); } catch { return failure('Only YouTube transcript endpoints can be fetched', 400, 'youtube_url_rejected'); }
	const method = YOUTUBE_PROXY_PATHS.get(url.pathname)!;
	if (request.method !== method) return methodError(method);
	const signal = AbortSignal.timeout(YOUTUBE_PROXY_TIMEOUT_MS);
	const headers: Record<string, string> = { Accept: method === 'POST' ? 'application/json' : 'text/xml,application/xml;q=0.9,*/*;q=0.5' };
	const agent = request.headers.get('X-Pigeon-Upstream-User-Agent');
	headers['User-Agent'] = agent && YOUTUBE_UPSTREAM_AGENT.test(agent) ? agent : 'Mozilla/5.0';
	const language = request.headers.get('X-Pigeon-Upstream-Language');
	if (language && ACCEPT_LANGUAGE.test(language)) headers['Accept-Language'] = language;
	let body: Uint8Array | undefined;
	if (method === 'POST') {
		if (normalizeContentType(request.headers.get('Content-Type')) !== 'application/json') return failure('JSON body required', 415);
		try { body = await boundedBytes(request, YOUTUBE_PROXY_REQUEST_BYTES, signal); } catch (error) { return error instanceof PayloadTooLarge ? failure('Request body is too large', 413) : failure('Could not read the request body', 400); }
		headers['Content-Type'] = 'application/json';
	}
	try {
		const response = await fetcher(url, { method, redirect: 'manual', signal, headers, ...(body ? { body } : {}) });
		if (response.status < 200 || response.status > 299) {
			cancelBody(response);
			return failure('YouTube did not return the transcript data', 502, 'youtube_unavailable', { upstreamStatus: response.status });
		}
		const type = normalizeContentType(response.headers.get('Content-Type'));
		if (!YOUTUBE_PROXY_TYPES.has(type)) { cancelBody(response); return failure('YouTube returned an unexpected response', 502, 'youtube_unavailable'); }
		let bytes: Uint8Array;
		try { bytes = await boundedBytes(response, YOUTUBE_PROXY_RESPONSE_BYTES, signal); } catch (error) {
			// An oversize answer is YouTube's problem, not the caller's request.
			if (error instanceof PayloadTooLarge) return failure('YouTube returned more data than the proxy passes on', 502, 'youtube_unavailable');
			throw error;
		}
		return new Response(bytes, { headers: {
			...jsonHeaders(), 'Content-Type': `${type}; charset=utf-8`, 'Content-Security-Policy': "default-src 'none'; sandbox",
		} });
	} catch (error) {
		return failure('Could not reach YouTube', 502, 'youtube_unreachable');
	}
}

function youtubeProxyURL(value: unknown): URL {
	const url = safeURL(value);
	const host = url.hostname;
	if (url.protocol !== 'https:' || url.port !== '') throw new Error();
	if (host !== 'youtube.com' && !(host.endsWith('.youtube.com') && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+youtube\.com$/.test(host))) throw new Error();
	if (!YOUTUBE_PROXY_PATHS.has(url.pathname)) throw new Error();
	return url;
}

function safeURL(value: unknown): URL {
	if (typeof value !== 'string' || value.length > 4096 || !value || /[\u0000-\u001f\u007f]/.test(value)) throw new Error();
	return assertSafeFeedUrl(value);
}

/** Thrown by boundedBytes when a body exceeds its limit. */
export class PayloadTooLarge extends Error {}

async function boundedText(source: Response | Request, limit: number, signal: AbortSignal): Promise<string> {
	return new TextDecoder().decode(await boundedBytes(source, limit, signal));
}

/**
 * Reads a request or response body as bytes, failing fast with PayloadTooLarge
 * past `limit` (declared or counted) and with an Error once `signal` aborts.
 */
export async function boundedBytes(source: Response | Request, limit: number, signal: AbortSignal): Promise<Uint8Array> {
	if (signal.aborted) { cancelBody(source); throw new Error('Request deadline exceeded'); }
	const declared = Number(source.headers.get('Content-Length'));
	if (Number.isFinite(declared) && declared > limit) { cancelBody(source); throw new PayloadTooLarge(); }
	if (!source.body) return new Uint8Array(0);
	const reader = source.body.getReader();
	const chunks: Uint8Array[] = [];
	let count = 0;
	let rejectAbort: (reason: unknown) => void = () => {};
	const abort = new Promise<never>((_, reject) => { rejectAbort = reject; });
	const onAbort = () => { void reader.cancel().catch(() => undefined); rejectAbort(new Error('Request deadline exceeded')); };
	signal.addEventListener('abort', onAbort, { once: true });
	try {
		if (signal.aborted) throw new Error('Request deadline exceeded');
		while (true) {
			const { done, value } = await Promise.race([reader.read(), abort]);
			if (signal.aborted) throw new Error('Request deadline exceeded');
			if (done) break;
			count += value.byteLength;
			if (count > limit) { await reader.cancel(); throw new PayloadTooLarge(); }
			chunks.push(value);
		}
	} finally { signal.removeEventListener('abort', onAbort); reader.releaseLock(); }
	const bytes = new Uint8Array(count);
	let offset = 0;
	for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
	return bytes;
}

function cancelBody(source: Response | Request) { void source.body?.cancel().catch(() => undefined); }
/** JSON API response headers: no caching, no sniffing. */
export function jsonHeaders() { return { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }; }
/** `{ error, code?, ...extra }` JSON error response. */
export function failure(error: string, status: number, code?: string, extra: Record<string, unknown> = {}) { return Response.json({ error, ...(code ? { code } : {}), ...extra }, { status, headers: jsonHeaders() }); }
function methodError(method: string) { return new Response('Method not allowed', { status: 405, headers: { Allow: method, 'Cache-Control': 'no-store' } }); }
