import { GEIST_SERIF_PATH, GEIST_SERIF_WOFF2_BASE64 } from './browser-font-geist-serif';

export { GEIST_SERIF_PATH };

/** The family name the web app's CSS uses for the bundled face. */
export const GEIST_SERIF_FAMILY = 'Geist Serif';

/**
 * The @font-face rule for the app shell and the article frame. Geist Serif ships only Regular. Declaring
 * just weight 400, upright, lets the browser synthesize bold and italic from it, so <strong> and <em>
 * keep their emphasis. A 100-900 range would claim real bold and render <strong> at Regular.
 */
export const GEIST_SERIF_FONT_FACE = `@font-face{font-family:'${GEIST_SERIF_FAMILY}';src:url('${GEIST_SERIF_PATH}') format('woff2');font-weight:400;font-style:normal;font-display:swap}`;

let geistSerifBytes: Uint8Array | null = null;

// A plain loop: Uint8Array.from with a map callback took ~3 ms cold for this font, a third of the
// Free plan's 10 ms CPU budget; this takes well under 1 ms.
function decodeBase64(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

/** Serves the vendored font at its versioned path. Decoded once per isolate; public and immutable. */
export function handleBrowserFontRequest(request: Request, path: string): Response | null {
	if (path !== GEIST_SERIF_PATH || (request.method !== 'GET' && request.method !== 'HEAD')) return null;
	if (!geistSerifBytes) geistSerifBytes = decodeBase64(GEIST_SERIF_WOFF2_BASE64);
	return new Response(request.method === 'HEAD' ? null : geistSerifBytes, {
		headers: {
			'Content-Type': 'font/woff2',
			'Content-Length': String(geistSerifBytes.byteLength),
			'Cache-Control': 'public, max-age=31536000, immutable',
			'X-Content-Type-Options': 'nosniff',
		},
	});
}
