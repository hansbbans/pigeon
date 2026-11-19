import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderBrowserAppHtml } from '../src/browser-app';
import { ALLO_FONT_FACE, ALLO_OBLIQUE_PATH, ALLO_PATH, GEIST_SERIF_FONT_FACE, GEIST_SERIF_PATH } from '../src/browser-fonts';
import { ALLO_OBLIQUE_WOFF2_BASE64, ALLO_VERSION, ALLO_WOFF2_BASE64 } from '../src/browser-font-allo';
import { GEIST_SERIF_VERSION, GEIST_SERIF_WOFF2_BASE64 } from '../src/browser-font-geist-serif';
import app from '../src/index';

test('serves vendored Geist Serif as an immutable public woff2', async () => {
	assert.equal(GEIST_SERIF_PATH, `/app/fonts/geist-serif-${GEIST_SERIF_VERSION}.woff2`);
	for (let round = 0; round < 3; round++) {
		const response = await app.fetch(new Request(`https://pigeon.example${GEIST_SERIF_PATH}`), {} as Env);
		assert.equal(response.status, 200);
		assert.equal(response.headers.get('Content-Type'), 'font/woff2');
		assert.equal(response.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
		const bytes = new Uint8Array(await response.arrayBuffer());
		assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), 'wOF2');
		assert.equal(bytes.byteLength, Number(response.headers.get('Content-Length')));
		assert.equal(Buffer.from(bytes).toString('base64'), GEIST_SERIF_WOFF2_BASE64);
	}
	const head = await app.fetch(new Request(`https://pigeon.example${GEIST_SERIF_PATH}`, { method: 'HEAD' }), {} as Env);
	assert.equal(head.status, 200);
	assert.equal(await head.text(), '');
});

test('other font paths and methods are not found', async () => {
	for (const request of [
		new Request('https://pigeon.example/app/fonts/geist-serif-0.0.0.woff2'),
		new Request('https://pigeon.example/app/fonts/'),
		new Request(`https://pigeon.example${GEIST_SERIF_PATH}`, { method: 'POST' }),
	]) {
		const response = await app.fetch(request, {} as Env);
		assert.equal(response.status, 404, `${request.method} ${request.url}`);
	}
});

test('the app shell declares Geist Serif at weight 400 so bold and italic are synthesized', () => {
	const html = renderBrowserAppHtml('https://pigeon.example');
	assert.ok(html.includes(GEIST_SERIF_FONT_FACE));
	assert.match(GEIST_SERIF_FONT_FACE, /font-weight:400;font-style:normal/);
	assert.match(html, /--reading-font: 'Geist Serif'/);
	assert.match(html, /<option value="geist">Geist Serif<\/option>/);
});

test('serves vendored Allo upright and oblique as immutable public woff2', async () => {
	assert.equal(ALLO_PATH, `/app/fonts/allo-${ALLO_VERSION}.woff2`);
	assert.equal(ALLO_OBLIQUE_PATH, `/app/fonts/allo-oblique-${ALLO_VERSION}.woff2`);
	for (const [path, base64] of [
		[ALLO_PATH, ALLO_WOFF2_BASE64],
		[ALLO_OBLIQUE_PATH, ALLO_OBLIQUE_WOFF2_BASE64],
	]) {
		const response = await app.fetch(new Request(`https://pigeon.example${path}`), {} as Env);
		assert.equal(response.status, 200, path);
		assert.equal(response.headers.get('Content-Type'), 'font/woff2');
		assert.equal(response.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
		const bytes = new Uint8Array(await response.arrayBuffer());
		assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), 'wOF2');
		assert.equal(Buffer.from(bytes).toString('base64'), base64);
	}
	const missing = await app.fetch(new Request('https://pigeon.example/app/fonts/allo-0.0.0.woff2'), {} as Env);
	assert.equal(missing.status, 404);
});

test('the app shell declares Allo as a variable upright with a Regular oblique and offers it as a typeface', () => {
	const html = renderBrowserAppHtml('https://pigeon.example');
	assert.ok(html.includes(ALLO_FONT_FACE));
	assert.match(ALLO_FONT_FACE, /font-weight:100 900;font-style:normal/);
	assert.match(ALLO_FONT_FACE, /font-weight:400;font-style:italic/);
	assert.match(html, /<option value="allo">Allo<\/option>/);
});
