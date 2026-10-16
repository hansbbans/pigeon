/** Public service-worker script. It never receives account tokens or caches private responses. */
export function renderBrowserServiceWorker(): string {
 return `"use strict";
const SHELL_CACHE = 'pigeon-public-shell-v1';
const SHELL_URL = new URL('/app', self.location.origin).href;
async function fetchPublicShell() {
 const response = await fetch(SHELL_URL, { credentials: 'omit', cache: 'no-store', redirect: 'error' });
 if (response.status === 200 && /text\\/html/i.test(response.headers.get('Content-Type') || '') && !/private|no-store/i.test(response.headers.get('Cache-Control') || '')) {
  try { const cache = await caches.open(SHELL_CACHE); await cache.put(SHELL_URL, response.clone()); } catch (_) {}
 }
 return response;
}
self.addEventListener('install', event => event.waitUntil((async () => {
 try { await fetchPublicShell(); } catch (_) {}
 await self.skipWaiting();
})()));
self.addEventListener('activate', event => event.waitUntil((async () => {
 const names = await caches.keys();
 await Promise.all(names.filter(name => name.startsWith('pigeon-public-shell-') && name !== SHELL_CACHE).map(name => caches.delete(name)));
 await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
 const request = event.request; const url = new URL(request.url);
 if (request.method !== 'GET' || request.mode !== 'navigate' || url.origin !== self.location.origin || !['/app','/app/'].includes(url.pathname) || request.headers.has('Authorization')) return;
 event.respondWith((async () => {
  try { return await fetchPublicShell(); } catch (_) {
   const cache = await caches.open(SHELL_CACHE); const saved = await cache.match(SHELL_URL);
   return saved || new Response('Pigeon is offline. Open it once online to save the app shell.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
 })());
});
self.addEventListener('push', event => {
 event.waitUntil((async () => {
  let payload; try { payload = event.data.json(); } catch { return; }
  if (!payload || typeof payload.articleId !== 'string' || payload.articleId.length > 512) return;
  await self.registration.showNotification(typeof payload.title === 'string' ? payload.title.slice(0,256) : 'Pigeon', {
   body: typeof payload.body === 'string' ? payload.body.slice(0,768) : 'A new article is ready.',
   tag: 'pigeon-new-article', data: { articleId: payload.articleId },
   actions: [{ action: 'read', title: 'Mark read…' }, { action: 'star', title: 'Star…' }]
  });
 })());
});
self.addEventListener('notificationclick', event => {
 event.notification.close();
 event.waitUntil((async () => {
  const id = event.notification.data && event.notification.data.articleId;
  if (typeof id !== 'string' || id.length > 512) return;
  const url = new URL('/app', self.location.origin); url.searchParams.set('article', id);
  if (event.action === 'read' || event.action === 'star') url.searchParams.set('notificationAction', event.action);
  // Actions open the authenticated app for confirmation; no mutations or account tokens in the SW.
  await self.clients.openWindow(url.href);
 })());
});
`;
}
