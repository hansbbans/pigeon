import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { renderBrowserServiceWorker } from '../src/browser-service-worker';
import worker from '../src/index';
import type { Env } from '../src/types';

test('public SW has scope for exact /app, no private cache/fetch or embedded account secrets', async () => {
 const response = await worker.fetch(new Request('https://pigeon.example/app/sw.js'), {} as Env);
 assert.equal(response.status, 200); assert.equal(response.headers.get('Service-Worker-Allowed'), '/app');
 assert.match(response.headers.get('Content-Type')!, /javascript/); assert.equal(response.headers.get('Cache-Control'), 'no-cache');
 const script = await response.text(); assert.equal(script, renderBrowserServiceWorker());
 assert.doesNotMatch(script, /\bfetch\s*\(|caches\.|API_PASSWORD|GoogleLogin|Authorization/);
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
