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
			response.body?.cancel().catch(() => undefined);
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
	const [a, b, c] = octets;

	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 0 && (c === 0 || c === 2)) ||
		(a === 192 && b === 168) ||
		(a === 198 && (b === 18 || b === 19)) ||
		a >= 224
	);
}

function isBlockedIpv6(hostname: string): boolean {
	const hextets = parseIpv6(hostname.toLowerCase().split('%', 1)[0]);
	if (!hextets) return true;
	const [h0, h1, h2, h3, h4, h5, h6, h7] = hextets;
	const embeddedIpv4 = `${h6 >> 8}.${h6 & 0xff}.${h7 >> 8}.${h7 & 0xff}`;
	// Unique local fc00::/7 and link-local fe80::/10.
	if ((h0 & 0xfe00) === 0xfc00 || (h0 & 0xffc0) === 0xfe80) return true;
	// IPv4-compatible ::/96 (includes :: and ::1) and IPv4-mapped ::ffff:0:0/96.
	if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && (h5 === 0 || h5 === 0xffff)) {
		return isBlockedIpv4(embeddedIpv4);
	}
	// NAT64 well-known prefix 64:ff9b::/96 translates to the embedded IPv4 address.
	if (h0 === 0x64 && h1 === 0xff9b && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0) {
		return isBlockedIpv4(embeddedIpv4);
	}
	// Local-use NAT64 64:ff9b:1::/48 can map to arbitrary internal IPv4 space.
	if (h0 === 0x64 && h1 === 0xff9b && h2 === 1) return true;
	return false;
}

function parseIpv6(address: string): number[] | null {
	let source = address;
	const dotted = source.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
	if (dotted) {
		const octets = dotted[2].split('.').map(Number);
		if (octets.some((octet) => octet > 255)) return null;
		source = `${dotted[1]}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
	}
	const halves = source.split('::');
	if (halves.length > 2) return null;
	const parseGroups = (part: string) => (part ? part.split(':') : []);
	const head = parseGroups(halves[0]);
	const tail = halves.length === 2 ? parseGroups(halves[1]) : [];
	const missing = 8 - head.length - tail.length;
	if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
	const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
	if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null;
	return groups.map((group) => Number.parseInt(group, 16));
}
