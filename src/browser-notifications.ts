/**
 * Opt-in notification panel. mount({container,authenticatedJson,getSubscriptions,getSessionIdentity})
 * getSessionIdentity(): {token:string,generation:number|string}; generation changes on every session transition.
 * getSubscriptions(): current GReader subscriptions (title,url) or normalized {title,feedKey}.
 * Returns {refresh(),destroy()}. Destroy synchronously on logout/switch. No permission request during mount/refresh.
 */
export function renderBrowserNotificationsScript(): string {
 return String.raw`(function () {
 'use strict';
 function node(tag, text) { var value = document.createElement(tag); if (text !== undefined) value.textContent = text; return value; }
 function sameIdentity(a, b) { return !!a && !!b && a.token === b.token && a.generation === b.generation; }
 function decodeKey(value) { return Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')), function (c) { return c.charCodeAt(0); }); }
 function feedKey(feed) {
  if (typeof feed.feedKey === 'string' && feed.feedKey.length > 0 && feed.feedKey.length <= 200) return feed.feedKey;
  try { var url = new URL(feed.url); var match = url.pathname.match(/^\/feed\/([^/]+)$/); return match ? decodeURIComponent(match[1]) : null; } catch (_) { return null; }
 }
 async function hash(token) { var value = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)); return Array.from(new Uint8Array(value), function (byte) { return byte.toString(16).padStart(2,'0'); }).join(''); }
 function mount(adapter) {
  if (!adapter || !adapter.container || typeof adapter.authenticatedJson !== 'function' || typeof adapter.getSessionIdentity !== 'function' || typeof adapter.getSubscriptions !== 'function') throw new Error('Notification settings require a signed-in session adapter.');
  var identity = Object.assign({}, adapter.getSessionIdentity()); var destroyed = false; var busy = false; var ready = false; var key = null; var record = null; var capabilities = null; var selected = new Set(); var status = ''; var supported = false; var controller = new AbortController();
  function guard() {
   if (destroyed || !identity || !identity.token || !sameIdentity(identity, adapter.getSessionIdentity())) { destroyed = true; controller.abort(); throw new Error('The signed-in account changed. Reopen notification settings.'); }
  }
  function getRecord() { guard(); try { var raw = localStorage.getItem(key); var value = raw ? JSON.parse(raw) : null; return value && value.version === 1 ? value : null; } catch (_) { throw new Error('Browser storage is unavailable. Allow site storage before enabling notifications.'); } }
  function save(value) { guard(); try { if (value) localStorage.setItem(key, JSON.stringify(value)); else localStorage.removeItem(key); record = value; } catch (_) { throw new Error('Could not save browser notification settings. Free site storage and retry.'); } guard(); }
  async function checked(promise) { guard(); var value = await promise; guard(); return value; }
  async function api(path, init) { guard(); return checked(adapter.authenticatedJson(path, Object.assign({}, init || {}, { signal: controller.signal }))); }
  function choices() {
   guard(); var feeds = adapter.getSubscriptions() || []; var seen = new Set();
   return feeds.map(function (feed) { return { key: feedKey(feed), title: feed.title || 'Untitled feed' }; }).filter(function (feed) { if (!feed.key || seen.has(feed.key)) return false; seen.add(feed.key); return true; });
  }
  function showError(error) { if (!destroyed && sameIdentity(identity, adapter.getSessionIdentity())) { status = error.message || 'Could not update notifications. Retry when online.'; render(); } }
  async function registration() {
   guard(); return checked(navigator.serviceWorker.register('/app/sw.js', { scope: '/app' }));
  }
  function render() {
   guard(); var container = adapter.container; container.replaceChildren();
   container.appendChild(node('h3','Background notifications'));
   var info = node('p', 'Choose feeds to hear about while Pigeon is closed. Delivery is best effort, usually after the hourly refresh; each cycle sends the latest new unread article.'); container.appendChild(info);
   if (!supported) { container.appendChild(node('p', 'This browser does not support background notifications here. On iPhone or iPad, open Pigeon as a supported Home Screen web app.')); return; }
   if (ready && (!capabilities || !capabilities.enabled)) container.appendChild(node('p', 'Background push is not configured on this Pigeon server.'));
   if (Notification.permission === 'denied') container.appendChild(node('p', 'Notifications are blocked. Allow them in this site’s browser settings, then retry.'));
   var list = node('div'); var available = choices();
   available.forEach(function (feed) {
    var label = node('label'); label.style.display = 'block'; var input = node('input'); input.type = 'checkbox'; input.value = feed.key; input.checked = selected.has(feed.key); input.disabled = busy;
    input.addEventListener('change', function () { if (destroyed) return; try { guard(); if (input.checked) selected.add(feed.key); else selected.delete(feed.key); status = selected.size ? 'Save your selected feeds to update delivery.' : 'No feeds selected. Notifications stay paused until you select and save feeds.'; render(); } catch (_) {} });
    label.appendChild(input); label.appendChild(node('span',' ' + feed.title)); list.appendChild(label);
   }); container.appendChild(list);
   if (!available.length) container.appendChild(node('p','Subscribe to a feed before enabling notifications.'));
   else if (!selected.size) container.appendChild(node('p','No feeds selected. No article notifications will be sent.'));
   var enable = node('button', record && record.id && !record.pendingDelete ? 'Save notification feeds' : 'Enable notifications'); enable.type = 'button'; enable.dataset.action = 'enable';
   enable.disabled = busy || !ready || !capabilities || !capabilities.enabled || Notification.permission === 'denied' || !!(record && record.pendingDelete);
   enable.addEventListener('click', function () { if (!busy) void enableFromClick().catch(showError); }); container.appendChild(enable);
   var disable = node('button', record && record.pendingDelete ? 'Finish disabling notifications' : 'Disable notifications'); disable.type = 'button'; disable.dataset.action = 'disable'; disable.disabled = busy || !ready || !record;
   disable.addEventListener('click', function () { if (!busy) void disableFromClick().catch(showError); }); container.appendChild(disable);
   var retry = node('button','Refresh notification status'); retry.type = 'button'; retry.dataset.action = 'refresh'; retry.disabled = busy;
   retry.addEventListener('click', function () { if (!busy) void refresh().catch(showError); }); container.appendChild(retry);
   var message = node('p', status || (record && record.id ? 'Background notifications are enabled for this browser.' : 'Notifications are off for this browser.')); message.setAttribute('role','status'); message.setAttribute('aria-live','polite'); container.appendChild(message);
  }
  async function refresh() {
   guard(); if (busy) return; busy = true; ready = false; capabilities = null;
   try {
    supported = !!window.isSecureContext && typeof Notification !== 'undefined' && !!navigator.serviceWorker && typeof PushManager !== 'undefined';
    key = 'pigeon.browser.push.v1.' + await checked(hash(identity.token));
    record = getRecord(); selected = new Set(record && record.feedKeys || []);
    capabilities = await api('/api/v1/browser/push/capabilities');
    if (!capabilities || typeof capabilities.enabled !== 'boolean' || capabilities.enabled && typeof capabilities.publicKey !== 'string') throw new Error('The server returned invalid notification capabilities.');
    var browserSubscription = null;
    if (supported && record && record.id) { var existingRegistration = await checked(navigator.serviceWorker.getRegistration('/app')); if (existingRegistration) browserSubscription = await checked(existingRegistration.pushManager.getSubscription()); }
    ready = true; status = record && record.pendingDelete ? 'Disabling is incomplete. Finish disabling when online.' : record && record.uncertain ? 'Registration was not confirmed. Enable again to safely retry this browser subscription.' : record && record.pendingSave ? 'Feed changes were not confirmed. Save notification feeds again when online.' : record && record.id && (!browserSubscription || !record.subscription || browserSubscription.endpoint !== record.subscription.endpoint) ? 'The saved browser subscription is missing. Save notification feeds to restore delivery.' : '';
   } finally { busy = false; if (!destroyed && sameIdentity(identity, adapter.getSessionIdentity())) render(); }
  }
  async function enableFromClick() {
   guard(); if (!ready || !supported || !capabilities || !capabilities.enabled) return;
   if (selected.size > 100) throw new Error('Choose at most 100 feeds for notifications.');
   var available = new Set(choices().map(function (feed) { return feed.key; })); var feedKeys = Array.from(selected).filter(function (value) { return available.has(value); });
   var created = null; var committed = false;
   // Save choices before a permission request or network mutation so storage failure cannot silently lose consent/state.
   save(Object.assign({}, record || {}, { version: 1, feedKeys: feedKeys, pendingSave: true }));
   busy = true; status = 'Enabling notifications…'; render();
   try {
    // This is invoked directly by the explicit button click; refresh never asks for permission.
    var permission = Notification.permission === 'granted' ? 'granted' : await checked(Notification.requestPermission());
    if (permission !== 'granted') throw new Error(permission === 'denied' ? 'Notifications were blocked. Allow this site in browser settings to retry.' : 'Permission was not granted. Notifications remain off.');
    var reg = await registration(); var subscription = await checked(reg.pushManager.getSubscription());
    if (subscription && record && record.uncertain && record.subscription && subscription.endpoint === record.subscription.endpoint) { await checked(subscription.unsubscribe()); subscription = null; }
    if (subscription && !(record && record.id && record.subscription && subscription.endpoint === record.subscription.endpoint)) throw new Error('This browser already has a subscription from another sign-in or missing settings. Disable it from that sign-in or reset this site’s notification permission before retrying.');
    if (subscription && record.publicKey && record.publicKey !== capabilities.publicKey) { await checked(subscription.unsubscribe()); subscription = null; }
    if (!subscription) { subscription = await checked(reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodeKey(capabilities.publicKey) })); created = subscription; }
    var wire = subscription.toJSON();
    save(Object.assign({}, record, { subscription: wire, publicKey: capabilities.publicKey, uncertain: !record.id, pendingDelete: false }));
    var updating = !!record.id; var payload = { subscription: wire, feedKeys: feedKeys };
    if (updating) { payload.id = record.id; payload.managementToken = record.managementToken; }
    var result = await api('/api/v1/browser/push/subscription', { method: updating ? 'PUT' : 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify(payload) });
    if (!result || typeof result.id !== 'string' || !updating && typeof result.managementToken !== 'string') throw new Error('The server did not confirm this browser subscription.');
    var confirmed = Object.assign({}, record, { id: result.id, managementToken: updating ? record.managementToken : result.managementToken, uncertain: false, pendingDelete: false, pendingSave: false });
    committed = true;
    try { save(confirmed); } catch (error) {
     // Keep credentials in memory so Disable can undo a confirmed server write even when local storage fills.
     record = confirmed; throw new Error('The server enabled notifications, but browser settings could not be saved. Disable them now or free site storage and save again.');
    }
    status = feedKeys.length ? 'Saved. Notifications are enabled for ' + feedKeys.length + ' selected feeds in this browser.' : 'Saved. No feeds selected; article notifications are paused.';
   } catch (error) {
    if (!committed && created && !destroyed && sameIdentity(identity, adapter.getSessionIdentity())) {
     try { await checked(created.unsubscribe()); } catch (_) {}
     // An unconfirmed POST may have reached the server. Retain endpoint metadata for an explicit safe retry.
     if (record && record.subscription) { try { save(Object.assign({}, record, { uncertain: true })); } catch (_) {} }
    }
    throw error;
   } finally { busy = false; if (!destroyed && sameIdentity(identity, adapter.getSessionIdentity())) render(); }
  }
  async function disableFromClick() {
   guard(); if (!record) return; busy = true; status = 'Disabling notifications…';
   try {
    try { save(Object.assign({}, record, { pendingDelete: true })); } catch (_) { record = Object.assign({}, record, { pendingDelete: true }); }
    render();
    var reg = supported ? await checked(navigator.serviceWorker.getRegistration('/app')) : null;
    var subscription = reg ? await checked(reg.pushManager.getSubscription()) : null;
    if (subscription && record.subscription && subscription.endpoint === record.subscription.endpoint) {
     await checked(subscription.unsubscribe()); var remaining = await checked(reg.pushManager.getSubscription());
     if (remaining && remaining.endpoint === subscription.endpoint) throw new Error('This browser did not stop its subscription. Retry disabling notifications.');
    }
    if (record.id && record.managementToken) await api('/api/v1/browser/push/subscription', { method:'DELETE', headers: { 'Content-Type':'application/json' }, body: JSON.stringify({ id: record.id, managementToken: record.managementToken }) });
    save(null); selected.clear(); status = 'Notifications are off for this browser.';
   } finally { busy = false; if (!destroyed && sameIdentity(identity, adapter.getSessionIdentity())) render(); }
  }
  var handle = { refresh: refresh, destroy: function () { destroyed = true; controller.abort(); adapter.container.replaceChildren(); } };
  void refresh().catch(showError); return handle;
 }
 window.PigeonNotifications = { mount: mount };
})();`;
}
