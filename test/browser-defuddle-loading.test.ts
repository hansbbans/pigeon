import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderBrowserAppHtml } from '../src/browser-app';
import { createScriptLoader } from '../src/browser-app-client';
import { DEFUDDLE_SOURCE, DEFUDDLE_VERSION } from '../src/browser-defuddle-source';
import app from '../src/index';

test('serves vendored Defuddle with immutable caching and no auth', async () => {
	const response = await app.fetch(new Request(`https://pigeon.example/app/defuddle.js?v=${DEFUDDLE_VERSION}`), {} as Env);
	assert.equal(response.status, 200);
	assert.equal(response.headers.get('Content-Type'), 'text/javascript; charset=utf-8');
	assert.equal(response.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
	assert.equal(await response.text(), DEFUDDLE_SOURCE);
});

test('app shell does not inline Defuddle but references its versioned URL', () => {
	const html = renderBrowserAppHtml('https://pigeon.example');
	const distinctive = DEFUDDLE_SOURCE.slice(20_000, 20_200);
	assert.ok(!html.includes(distinctive), 'Defuddle must not be inlined');
	assert.ok(html.includes(`/app/defuddle.js?v=${DEFUDDLE_VERSION}`));
});

function fakeDocument(outcome: 'load' | 'error' | 'never') {
	const appended: any[] = [];
	const doc = {
		createElement(tag: string) { return { tag, src: '', async: false, onload: null as any, onerror: null as any }; },
		head: { appendChild(element: any) {
			appended.push(element);
			if (outcome === 'load') queueMicrotask(() => element.onload?.());
			if (outcome === 'error') queueMicrotask(() => element.onerror?.());
			return element;
		} },
	};
	return { doc, appended };
}

test('script loader injects once and resolves true on load', async () => {
	const { doc, appended } = fakeDocument('load');
	const load = createScriptLoader(doc, '/app/defuddle.js?v=1', 10_000);
	assert.equal(await load(), true);
	assert.equal(await load(), true);
	assert.equal(appended.length, 1);
	assert.equal(appended[0].src, '/app/defuddle.js?v=1');
	assert.equal(appended[0].async, true);
});

test('script loader resolves false on error without throwing and does not retry', async () => {
	const { doc, appended } = fakeDocument('error');
	const load = createScriptLoader(doc, '/app/defuddle.js?v=1', 10_000);
	assert.equal(await load(), false);
	assert.equal(await load(), false);
	assert.equal(appended.length, 1);
});

test('script loader resolves false after the timeout', async () => {
	const { doc } = fakeDocument('never');
	const load = createScriptLoader(doc, '/app/defuddle.js?v=1', 20);
	assert.equal(await load(), false);
});

test('script loader resolves false when the document cannot take the script', async () => {
	const load = createScriptLoader({ createElement: () => ({}), head: null }, '/app/defuddle.js?v=1', 10_000);
	assert.equal(await load(), false);
});
