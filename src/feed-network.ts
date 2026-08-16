import { detectFeedFormat } from './rss-parser';

export const MAX_FEED_BYTES = 5_000_000;
export const MAX_DISCOVERY_HTML_BYTES = 1_000_000;
export const MAX_FEED_REDIRECTS = 5;
export const FEED_FETCH_TIMEOUT_MS = 15_000;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ALLOWED_PORTS = new Set(['', '80', '443']);
const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];
const BINARY_CONTENT_PREFIXES = [
	'image/',
	'audio/',
	'video/',
	'font/',
	'application/zip',
	'application/gzip',
	'application/x-rar',
	'application/x-7z',
	'application/octet-stream',
	'application/pdf',
];

export interface BoundedFetchOptions {
	headers?: HeadersInit;
	maxBytes?: number;
	maxHtmlBytes?: number;
	maxRedirects?: number;
	timeoutMs?: number;
}

export interface BoundedFetchResult {
	response: Response;
	text: string;
	finalUrl: URL;
	redirects: URL[];
	contentType: string;
	byteLength: number;
}

export async function fetchBoundedFeedResource(
	input: string | URL,
	options: BoundedFetchOptions = {},
): Promise<BoundedFetchResult> {
	let currentUrl = assertSafeFeedUrl(input);
	const redirects: URL[] = [];
	const maxRedirects = options.maxRedirects ?? MAX_FEED_REDIRECTS;
	const timeoutMs = options.timeoutMs ?? FEED_FETCH_TIMEOUT_MS;

	for (let redirectCount = 0; ; redirectCount += 1) {
		const response = await fetch(currentUrl, {
			headers: options.headers,
			redirect: 'manual',
			signal: AbortSignal.timeout(timeoutMs),
		});

		if (REDIRECT_STATUSES.has(response.status)) {
			if (redirectCount >= maxRedirects) {
				throw new Error(`Feed redirected more than ${maxRedirects} times`);
			}
			const location = response.headers.get('Location');
			if (!location) {
				throw new Error(`Feed returned HTTP ${response.status} without a Location header`);
			}
			currentUrl = assertSafeFeedUrl(new URL(location, currentUrl));
			redirects.push(currentUrl);
			continue;
		}

		const contentType = normalizeContentType(response.headers.get('Content-Type'));
		if (response.ok && isObviouslyBinaryContentType(contentType)) {
			response.body?.cancel().catch(() => undefined);
			throw new Error(`Feed returned unsupported content type ${contentType}`);
		}

		const responseLimit =
			options.maxHtmlBytes !== undefined &&
			(contentType.includes('text/html') || contentType.includes('application/xhtml'))
				? options.maxHtmlBytes
				: (options.maxBytes ?? MAX_FEED_BYTES);
		const { text, byteLength } = await readResponseText(response, responseLimit);
		return { response, text, finalUrl: currentUrl, redirects, contentType, byteLength };
	}
}

export function assertSafeFeedUrl(input: string | URL): URL {
	let url: URL;
	try {
		url = input instanceof URL ? new URL(input.href) : new URL(input);
	} catch {
		throw new Error('Invalid feed URL');
	}

	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error('Feed URL must use HTTP or HTTPS');
	}
	if (url.username || url.password) {
		throw new Error('Feed URL must not contain credentials');
	}
	if (!ALLOWED_PORTS.has(url.port)) {
		throw new Error('Feed URL uses an unsupported port');
	}

	const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
	if (!hostname || isBlockedHostname(hostname)) {
		throw new Error('Feed URL points to a private or internal address');
	}

	url.hostname = hostname;
	url.hash = '';
	return url;
}

export function isHtmlContent(contentType: string, text: string): boolean {
	if (contentType.includes('text/html') || contentType.includes('application/xhtml')) return true;
	const prefix = text.trimStart().slice(0, 256).toLowerCase();
	return prefix.startsWith('<!doctype html') || prefix.startsWith('<html') || prefix.includes('<head');
}

export function isProbablyFeedContent(contentType: string, text: string): boolean {
	if (isObviouslyBinaryContentType(contentType) || isHtmlContent(contentType, text)) return false;
	return detectFeedFormat(text, contentType) !== null;
}

export function normalizeContentType(value: string | null): string {
	return value?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

async function readResponseText(response: Response, maxBytes: number): Promise<{ text: string; byteLength: number }> {
	const declaredLength = Number(response.headers.get('Content-Length'));
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		response.body?.cancel().catch(() => undefined);
		throw new Error(`Feed response exceeds ${maxBytes} bytes`);
	}

	if (!response.body) return { text: '', byteLength: 0 };

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let byteLength = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			byteLength += value.byteLength;
			if (byteLength > maxBytes) {
				await reader.cancel('Feed response exceeded byte limit');
				throw new Error(`Feed response exceeds ${maxBytes} bytes`);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const combined = new Uint8Array(byteLength);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { text: new TextDecoder().decode(combined), byteLength };
}

function isObviouslyBinaryContentType(contentType: string): boolean {
	return BINARY_CONTENT_PREFIXES.some((prefix) => contentType.startsWith(prefix));
}

function isBlockedHostname(hostname: string): boolean {
	if (hostname === 'localhost' || BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
		return true;
	}

	const unwrapped = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
	if (unwrapped.includes(':')) return isBlockedIpv6(unwrapped);
	return isBlockedIpv4(unwrapped);
}

function isBlockedIpv4(hostname: string): boolean {
	if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return false;
	const octets = hostname.split('.').map(Number);
	if (octets.some((octet) => octet > 255)) return true;
	const [a, b] = octets;

	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 0) ||
		(a === 192 && b === 168) ||
		(a === 198 && (b === 18 || b === 19)) ||
		a >= 224
	);
}

function isBlockedIpv6(hostname: string): boolean {
	const normalized = hostname.toLowerCase().split('%', 1)[0];
	if (normalized === '::' || normalized === '::1') return true;
	if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
	if (/^fe[89ab]/.test(normalized)) return true;
	if (normalized.startsWith('::ffff:')) {
		const mappedAddress = normalized.slice('::ffff:'.length);
		if (mappedAddress.includes('.')) return isBlockedIpv4(mappedAddress);
		const mappedHex = mappedAddress.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
		if (mappedHex) {
			const high = Number.parseInt(mappedHex[1], 16);
			const low = Number.parseInt(mappedHex[2], 16);
			return isBlockedIpv4(
				`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`,
			);
		}
		return true;
	}
	return false;
}
