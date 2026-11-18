import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { renderBrowserServiceWorker } from '../src/browser-service-worker';
import worker from '../src/index';
import type { Env } from '../src/types';

test('public SW may control the root (push stays on /app) and embeds no account secrets', async () => {
 const response = await worker.fetch(new Request('https://pigeon.example/app/sw.js'), {} as Env);
 assert.equal(response.status, 200); assert.equal(response.headers.get('Service-Worker-Allowed'), '/');
 assert.match(response.headers.get('Content-Type')!, /javascript/); assert.equal(response.headers.get('Cache-Control'), 'no-cache');
 const script = await response.text(); assert.equal(script, renderBrowserServiceWorker());
 assert.doesNotMatch(script, /API_PASSWORD|GoogleLogin/);
});

test('push renders notification; clicks and actions safely open exact article for app confirmation', async () => {
 const listeners: Record<string, Function> = {}; let notification: any; let opened: string | undefined;
 runInNewContext(renderBrowserServiceWorker(), { URL, self: { location: { origin: 'https://pigeon.example' },
  addEventListener: (name: string, callback: Function) => { listeners[name] = callback; },
  registration: { showNotification: async (title: string, options: any) => { notification = { title, ...options }; } },
  clients: { openWindow: async (url: string) => { opened = url; } } } });
 let waiting: Promise<void>;
 listeners.push({ data: { json: () => ({ title: 'Newsletter', body: 'Private subject', articleId: 'id/evil?x=1#two' }) }, waitUntil: (promise: Promise<void>) => { waiting = promise; } });
 await waiting!; assert.equal(notification.title, 'Newsletter'); assert.equal(notification.body, 'Private subject');
 for (const action of ['', 'read', 'star', 'malicious']) {
  listeners.notificationclick({ action, notification: { ...notification, close() {} }, waitUntil: (promise: Promise<void>) => { waiting = promise; } });
  await waiting!; const target = new URL(opened!); assert.equal(target.origin, 'https://pigeon.example'); assert.equal(target.pathname, '/');
  assert.equal(target.searchParams.get('article'), 'id/evil?x=1#two');
  assert.equal(target.searchParams.get('notificationAction'), ['read','star'].includes(action) ? action : null);
 }
});

test('SW caches only successful public app HTML, uses offline navigation fallback and ignores private/API requests', async () => {
 const listeners: Record<string, Function> = {}; const saved = new Map<string, Response>(); let mode = 'html'; const fetched: any[] = []; const deleted: string[] = [];
 const cache = { put: async (url: string, response: Response) => { saved.set(url, response); }, match: async (url: string) => saved.get(url)?.clone() };
 runInNewContext(renderBrowserServiceWorker(), { URL, Response, caches: { open: async () => cache, keys: async () => ['pigeon-public-shell-old','another-app','pigeon-public-shell-v1','pigeon-public-shell-v2'], delete: async (name: string) => { deleted.push(name); } },
  fetch: async (url: string, init: any) => { fetched.push({ url, init }); if (mode === 'offline') throw new Error('offline');
   return mode === 'html' ? new Response('<html>public app shell</html>', { headers: { 'Content-Type': 'text/html' } })
    : mode === 'private' ? new Response('private', { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'private' } })
    : mode === 'json' ? Response.json({ private: true }) : new Response('failure', { status: 500, headers: { 'Content-Type': 'text/html' } }); },
  self: { location: { origin: 'https://pigeon.example' }, addEventListener: (name: string, callback: Function) => { listeners[name] = callback; }, skipWaiting: async () => {}, clients: { claim: async () => {} } } });
 let waiting: Promise<any>;
 listeners.install({ waitUntil: (promise: Promise<any>) => { waiting = promise; } }); await waiting!;
 assert.equal(saved.size, 1); assert.equal(fetched[0].url, 'https://pigeon.example/'); assert.equal(fetched[0].init.credentials, 'omit'); assert.equal(fetched[0].init.redirect, 'error'); assert.equal(fetched[0].init.cache, 'no-cache');
 listeners.activate({ waitUntil: (promise: Promise<any>) => { waiting = promise; } }); await waiting!; assert.deepEqual(deleted, ['pigeon-public-shell-old', 'pigeon-public-shell-v1'], 'the v1 cache held the shell under /app');
 function navigate(path: string, overrides: any = {}) {
  let response: Promise<Response> | undefined;
  listeners.fetch({ request: { method: 'GET', mode: 'navigate', url: 'https://pigeon.example' + path, headers: new Headers(), ...overrides }, respondWith: (promise: Promise<Response>) => { response = promise; } });
  return response;
 }
 for (const path of ['/api/v1/sync','/reader/api/0/stream/items/contents','/app/status','/application','/feeds','/health','/index.html']) assert.equal(navigate(path), undefined);
 for (const path of ['/', '/app']) { assert.equal(navigate(path, { method: 'POST' }), undefined); assert.equal(navigate(path, { headers: new Headers({ Authorization: 'private-token' }) }), undefined);
  assert.equal(navigate(path, { mode: 'cors' }), undefined); }
 mode = 'offline';
 for (const path of ['/?article=12', '/app?article=12', '/app/']) assert.equal(await (await navigate(path))!.text(), '<html>public app shell</html>', path + ' opens the saved shell offline');
 for (const value of ['private','json','error']) { mode = value; await navigate('/'); assert.equal(await saved.get('https://pigeon.example/')!.clone().text(), '<html>public app shell</html>'); }
 assert.deepEqual([...saved.keys()], ['https://pigeon.example/'], 'one shell, saved under the root');
 saved.clear(); mode = 'offline'; assert.equal((await navigate('/'))!.status, 503); assert.equal((await navigate('/app/'))!.status, 503);
});

test('the service worker saves the shell the Worker actually serves at /', async () => {
	const listeners: Record<string, Function> = {};
	const saved = new Map<string, Response>();
	const env = { BASE_URL: 'https://pigeon.example' } as never;
	runInNewContext(renderBrowserServiceWorker(), {
		URL, Response,
		caches: {
			open: async () => ({
				put: async (url: string, response: Response) => { saved.set(url, response); },
				match: async (url: string) => saved.get(url)?.clone(),
			}),
			keys: async () => [],
			delete: async () => {},
		},
		fetch: async (url: string) => worker.fetch(new Request(url), env),
		self: {
			location: { origin: 'https://pigeon.example' },
			addEventListener: (name: string, callback: Function) => { listeners[name] = callback; },
			skipWaiting: async () => {},
			clients: { claim: async () => {} },
		},
	});
	let installing: Promise<unknown> | undefined;
	listeners.install({ waitUntil: (promise: Promise<unknown>) => { installing = promise; } });
	await installing;
	const shell = await worker.fetch(new Request('https://pigeon.example/'), env);
	assert.equal(saved.size, 1, `shell not saved; / is served with Cache-Control: ${shell.headers.get('Cache-Control')}`);
	assert.match(await saved.get('https://pigeon.example/')!.clone().text(), /<!doctype html>/i);
});

test('the app is served at the root and still at /app, with the same shell', async () => {
	const env = { BASE_URL: 'https://pigeon.example' } as never;
	const root = await worker.fetch(new Request('https://pigeon.example/'), env);
	assert.equal(root.status, 200);
	assert.match(root.headers.get('Content-Type')!, /text\/html/);
	const rootHtml = await root.text();
	for (const path of ['/app', '/app/', '/?article=12']) {
		const response = await worker.fetch(new Request('https://pigeon.example' + path), env);
		assert.equal(response.status, 200, path);
		assert.equal(await response.text(), rootHtml, path);
	}
	const etag = root.headers.get('ETag')!;
	const revalidated = await worker.fetch(new Request('https://pigeon.example/', { headers: { 'If-None-Match': etag } }), env);
	assert.equal(revalidated.status, 304);
});

test('notification clicks open the article under the push registration scope', async () => {
 for (const [scope, expected] of [['https://pigeon.example/app', '/app'], ['https://pigeon.example/', '/'], ['https://evil.example/app', '/'], [undefined, '/']] as const) {
  const listeners: Record<string, Function> = {}; let opened: string | undefined;
  runInNewContext(renderBrowserServiceWorker(), { URL, self: { location: { origin: 'https://pigeon.example' },
   addEventListener: (name: string, callback: Function) => { listeners[name] = callback; },
   registration: { scope, showNotification: async () => {} },
   clients: { openWindow: async (url: string) => { opened = url; } } } });
  let waiting: Promise<void>;
  listeners.notificationclick({ action: 'read', notification: { data: { articleId: '42' }, close() {} }, waitUntil: (promise: Promise<void>) => { waiting = promise; } });
  await waiting!;
  const target = new URL(opened!);
  assert.equal(target.origin, 'https://pigeon.example');
  assert.equal(target.pathname, expected, String(scope));
  assert.equal(target.search, '?article=42&notificationAction=read');
 }
});
