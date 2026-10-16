import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { renderBrowserServiceWorker } from '../src/browser-service-worker';
import worker from '../src/index';
import type { Env } from '../src/types';

test('public SW has scope for exact /app and no embedded account secrets', async () => {
 const response = await worker.fetch(new Request('https://pigeon.example/app/sw.js'), {} as Env);
 assert.equal(response.status, 200); assert.equal(response.headers.get('Service-Worker-Allowed'), '/app');
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
  await waiting!; const target = new URL(opened!); assert.equal(target.origin, 'https://pigeon.example'); assert.equal(target.pathname, '/app');
  assert.equal(target.searchParams.get('article'), 'id/evil?x=1#two');
  assert.equal(target.searchParams.get('notificationAction'), ['read','star'].includes(action) ? action : null);
 }
});

test('SW caches only successful public app HTML, uses offline navigation fallback and ignores private/API requests', async () => {
 const listeners: Record<string, Function> = {}; const saved = new Map<string, Response>(); let mode = 'html'; const fetched: any[] = []; const deleted: string[] = [];
 const cache = { put: async (url: string, response: Response) => { saved.set(url, response); }, match: async (url: string) => saved.get(url)?.clone() };
 runInNewContext(renderBrowserServiceWorker(), { URL, Response, caches: { open: async () => cache, keys: async () => ['pigeon-public-shell-old','another-app','pigeon-public-shell-v1'], delete: async (name: string) => { deleted.push(name); } },
  fetch: async (url: string, init: any) => { fetched.push({ url, init }); if (mode === 'offline') throw new Error('offline');
   return mode === 'html' ? new Response('<html>public app shell</html>', { headers: { 'Content-Type': 'text/html' } })
    : mode === 'private' ? new Response('private', { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'private' } })
    : mode === 'json' ? Response.json({ private: true }) : new Response('failure', { status: 500, headers: { 'Content-Type': 'text/html' } }); },
  self: { location: { origin: 'https://pigeon.example' }, addEventListener: (name: string, callback: Function) => { listeners[name] = callback; }, skipWaiting: async () => {}, clients: { claim: async () => {} } } });
 let waiting: Promise<any>;
 listeners.install({ waitUntil: (promise: Promise<any>) => { waiting = promise; } }); await waiting!;
 assert.equal(saved.size, 1); assert.equal(fetched[0].url, 'https://pigeon.example/app'); assert.equal(fetched[0].init.credentials, 'omit'); assert.equal(fetched[0].init.redirect, 'error');
 listeners.activate({ waitUntil: (promise: Promise<any>) => { waiting = promise; } }); await waiting!; assert.deepEqual(deleted, ['pigeon-public-shell-old']);
 function navigate(path: string, overrides: any = {}) {
  let response: Promise<Response> | undefined;
  listeners.fetch({ request: { method: 'GET', mode: 'navigate', url: 'https://pigeon.example' + path, headers: new Headers(), ...overrides }, respondWith: (promise: Promise<Response>) => { response = promise; } });
  return response;
 }
 for (const path of ['/api/v1/sync','/reader/api/0/stream/items/contents','/app/status','/application']) assert.equal(navigate(path), undefined);
 assert.equal(navigate('/app', { method: 'POST' }), undefined); assert.equal(navigate('/app', { headers: new Headers({ Authorization: 'private-token' }) }), undefined);
 assert.equal(navigate('/app', { mode: 'cors' }), undefined);
 mode = 'offline'; const offline = await navigate('/app?article=12'); assert.equal(await offline!.text(), '<html>public app shell</html>');
 for (const value of ['private','json','error']) { mode = value; await navigate('/app'); assert.equal(await saved.get('https://pigeon.example/app')!.clone().text(), '<html>public app shell</html>'); }
 saved.clear(); mode = 'offline'; assert.equal((await navigate('/app/'))!.status, 503);
});
