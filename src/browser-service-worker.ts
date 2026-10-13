/** Public service-worker script. It never receives account tokens or caches private responses. */
export function renderBrowserServiceWorker(): string {
 return `"use strict";
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
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
