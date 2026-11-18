/** Public service-worker script. It never receives account tokens or caches private responses. */
export function renderBrowserServiceWorker(): string {
 return `"use strict";
// v2: the shell moved from /app to /. Activation deletes the v1 cache and its /app entry.
const SHELL_CACHE = 'pigeon-public-shell-v2';
const SHELL_URL = new URL('/', self.location.origin).href;
// '/app' and '/app/' still open the app (older installs and bookmarks), from the same shell.
const SHELL_PATHS = ['/', '/app', '/app/'];
async function fetchPublicShell() {
 // 'no-cache' revalidates on every load, so an unchanged shell costs a 304; 'no-store' downloaded it whole each time.
 const response = await fetch(SHELL_URL, { credentials: 'omit', cache: 'no-cache', redirect: 'error' });
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
 if (request.method !== 'GET' || request.mode !== 'navigate' || url.origin !== self.location.origin || !SHELL_PATHS.includes(url.pathname) || request.headers.has('Authorization')) return;
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
  // Open under this registration's scope. Push lives on the /app registration, and iOS Home Screen
  // installs keep the /app scope they were installed with: a '/' link would open Safari, signed out.
  // Browser tabs rewrite /app to / themselves.
  const scope = self.registration && self.registration.scope ? new URL(self.registration.scope) : null;
  const url = new URL(scope && scope.origin === self.location.origin ? scope.pathname : '/', self.location.origin); url.searchParams.set('article', id);
  if (event.action === 'read' || event.action === 'star') url.searchParams.set('notificationAction', event.action);
  // Actions open the authenticated app for confirmation; no mutations or account tokens in the SW.
  await self.clients.openWindow(url.href);
 })());
});
`;
}
