import { ALLO_OBLIQUE_PATH, ALLO_OBLIQUE_WOFF2_BASE64, ALLO_PATH, ALLO_WOFF2_BASE64 } from './browser-font-allo';
import { GEIST_SERIF_PATH, GEIST_SERIF_WOFF2_BASE64 } from './browser-font-geist-serif';

export { ALLO_OBLIQUE_PATH, ALLO_PATH, GEIST_SERIF_PATH };

/** The family name the web app's CSS uses for the bundled face. */
export const GEIST_SERIF_FAMILY = 'Geist Serif';
export const ALLO_FAMILY = 'Allo';

/**
 * The @font-face rule for the app shell and the article frame. Geist Serif ships only Regular. Declaring
 * just weight 400, upright, lets the browser synthesize bold and italic from it, so <strong> and <em>
 * keep their emphasis. A 100-900 range would claim real bold and render <strong> at Regular.
 */
export const GEIST_SERIF_FONT_FACE = `@font-face{font-family:'${GEIST_SERIF_FAMILY}';src:url('${GEIST_SERIF_PATH}') format('woff2');font-weight:400;font-style:normal;font-display:swap}`;

/**
 * Allo's upright is a real variable font, so the 100-900 range is honest: <strong> and headings get drawn
 * weights, not synthesized ones. The oblique is the static Regular, declared at 400 only, so bold italic is
 * synthesized from it rather than rendered at Regular.
 */
export const ALLO_FONT_FACE = `@font-face{font-family:'${ALLO_FAMILY}';src:url('${ALLO_PATH}') format('woff2');font-weight:100 900;font-style:normal;font-display:swap}@font-face{font-family:'${ALLO_FAMILY}';src:url('${ALLO_OBLIQUE_PATH}') format('woff2');font-weight:400;font-style:italic;font-display:swap}`;

const FONTS = new Map<string, { base64: string; bytes: Uint8Array | null }>([
	[GEIST_SERIF_PATH, { base64: GEIST_SERIF_WOFF2_BASE64, bytes: null }],
	[ALLO_PATH, { base64: ALLO_WOFF2_BASE64, bytes: null }],
	[ALLO_OBLIQUE_PATH, { base64: ALLO_OBLIQUE_WOFF2_BASE64, bytes: null }],
]);

// A plain loop: Uint8Array.from with a map callback took ~3 ms cold for this font, a third of the
// Free plan's 10 ms CPU budget; this takes well under 1 ms.
function decodeBase64(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

/** Serves a vendored font at its versioned path. Each is decoded once per isolate, on first request; public and immutable. */
export function handleBrowserFontRequest(request: Request, path: string): Response | null {
	const font = FONTS.get(path);
	if (!font || (request.method !== 'GET' && request.method !== 'HEAD')) return null;
	if (!font.bytes) font.bytes = decodeBase64(font.base64);
	return new Response(request.method === 'HEAD' ? null : font.bytes, {
		headers: {
			'Content-Type': 'font/woff2',
			'Content-Length': String(font.bytes.byteLength),
			'Cache-Control': 'public, max-age=31536000, immutable',
			'X-Content-Type-Options': 'nosniff',
		},
	});
}
