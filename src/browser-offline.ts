/**
 * Browser-owned IndexedDB library, emitted separately so the UI can opt in.
 * Adapter: create({ token, getSessionKey, authenticatedJson(path, init), onProgress?, onError?, storageFactory? }).
 * getSessionKey MUST change on logout/account switch, including switch-away-and-back.
 * JSON adapter uses the current auth header. Token is hashed, never persisted.
 * confirmState(readerId,kind,value) records ONLY a confirmed server acknowledgement;
 * it sends no API action and preserves every queued desired-state overlay.
 * Injectable storage: async factory(hash, guard) => {get,all,batch,enqueue,close}; enqueue(mutation) must atomically assign order
 * and persist mutation with its UUID. batch accepts
 * {store,key,value} (put), or {store,key,delete:true}; it must be atomic and guard its transaction.
 */
export function renderBrowserOfflineScript(): string {
 return String.raw`(function () {
 'use strict';
 var STORES = ['meta', 'feeds', 'articles', 'bodies', 'statuses', 'positions', 'outbox'];
 function offlineError(code, message) { var error = new Error(message); error.code = code; return error; }
 async function accountHash(token) {
  if (typeof token !== 'string' || !token) throw offlineError('session', 'Sign in before using offline storage.');
  var result = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(result), function (byte) { return byte.toString(16).padStart(2, '0'); }).join('');
 }
 function openDatabase(hash, guard) {
  return new Promise(function (resolve, reject) {
   guard();
   if (!window.indexedDB) { reject(offlineError('storage', 'IndexedDB is unavailable in this browser.')); return; }
   var request = indexedDB.open('pigeon.offline.v1.' + hash, 1);
   request.onupgradeneeded = function () { STORES.forEach(function (name) { request.result.createObjectStore(name); }); };
   request.onerror = function () { reject(request.error || offlineError('storage', 'Could not open offline storage.')); };
   request.onblocked = function () { reject(offlineError('blocked', 'Another tab is blocking offline storage. Close it and retry.')); };
   request.onsuccess = function () {
    var db = request.result; var active = new Set(); var closed = false;
    try { guard(); } catch (error) { db.close(); reject(error); return; }
    function transaction(names, mode, work) {
     return new Promise(function (done, fail) {
      var tx; var value;
      try { guard(); if (closed) throw offlineError('session', 'Offline storage is closed.'); tx = db.transaction(names, mode); active.add(tx);
       work(tx, function (result) { value = result; });
      } catch (error) { if (tx) { active.delete(tx); try { tx.abort(); } catch (_) {} } fail(error); return; }
      tx.oncomplete = function () { active.delete(tx); try { guard(); done(value); } catch (error) { fail(error); } };
      tx.onabort = tx.onerror = function () { active.delete(tx); fail(tx.error || offlineError('storage', 'Offline storage operation failed.')); };
     });
    }
    function close() { closed = true; active.forEach(function (tx) { try { tx.abort(); } catch (_) {} }); db.close(); }
    db.onversionchange = close;
    resolve({
     get: function (store, key) { return transaction([store], 'readonly', function (tx, result) { var req = tx.objectStore(store).get(key); req.onsuccess = function () { result(req.result); }; }); },
     all: function (store) { return transaction([store], 'readonly', function (tx, result) { var req = tx.objectStore(store).getAll(); req.onsuccess = function () { result(req.result); }; }); },
     enqueue: function (mutation) {
      return transaction(['meta','outbox'], 'readwrite', function (tx, result) {
       var request = tx.objectStore('meta').get('nextMutationOrder');
       request.onsuccess = function () {
        try {
         guard(); var saved = Object.assign({}, mutation, { order: (request.result || 0) + 1 });
         tx.objectStore('meta').put(saved.order, 'nextMutationOrder');
         var write = tx.objectStore('outbox').put(saved, saved.id);
         write.onsuccess = function () { try { guard(); result(saved); } catch (_) { try { tx.abort(); } catch (_) {} } };
        } catch (_) { try { tx.abort(); } catch (_) {} }
       };
      });
     },
     scan: function (store, visit) {
      return transaction([store], 'readonly', function (tx) {
       var request = tx.objectStore(store).openCursor();
       request.onsuccess = function () {
        try { guard(); var cursor = request.result; if (cursor) { visit(cursor.value); cursor.continue(); } }
        catch (_) { try { tx.abort(); } catch (_) {} }
       };
      });
     },
     batch: function (changes) {
      if (!changes.length) { guard(); return Promise.resolve(); }
      return transaction(Array.from(new Set(changes.map(function (change) { return change.store; }))), 'readwrite', function (tx) {
       changes.forEach(function (change) { guard(); var store = tx.objectStore(change.store); var req = change.delete ? store.delete(change.key) : store.put(change.value, change.key); req.onsuccess = function () { try { guard(); } catch (_) { try { tx.abort(); } catch (_) {} } }; });
      });
     }, close: close
    });
   };
  });
 }
 function put(store, key, value) { return { store: store, key: key, value: value }; }
 function remove(store, key) { return { store: store, key: key, delete: true }; }
 function decimal(readerId) {
  var match = String(readerId || '').match(/^tag:google.com,2005:reader\/item\/([0-9a-f]{16})$/i);
  if (match) return BigInt('0x' + match[1]).toString(10);
  if (/^[1-9][0-9]*$/.test(String(readerId))) return String(readerId);
  throw offlineError('identity', 'This article does not have a valid reader ID.');
 }
 async function hasAccount(hash, factory) {
  if (!/^[a-f0-9]{64}$/.test(hash)) return false;
  var storage = await (factory || openDatabase)(hash, function () {});
  try { return !!await storage.get('meta', 'enabled'); } finally { storage.close(); }
 }
 async function create(adapter) {
  if (!adapter || typeof adapter.getSessionKey !== 'function' || typeof adapter.authenticatedJson !== 'function') throw offlineError('adapter', 'Offline storage requires a session and authenticated API adapter.');
  var session = adapter.getSessionKey(); var closed = false; var storage; var queue = Promise.resolve(); var controller = new AbortController();
  function guard() {
   if (closed || !session || adapter.getSessionKey() !== session) {
    closed = true; controller.abort(); if (storage) storage.close(); throw offlineError('session', 'The signed-in account changed. Reopen offline storage for the current account.');
   }
  }
  function report(error) {
   if (adapter.onError) adapter.onError({ code: error.name === 'QuotaExceededError' ? 'quota' : (error.code || 'storage'), message: error.name === 'QuotaExceededError' ? 'Offline storage is full. Free older read articles and retry.' : error.message });
   return error;
  }
  function notify(progress) { guard(); if (adapter.onProgress) adapter.onProgress(progress); guard(); }
  async function read(store, key) { guard(); var value = await storage.get(store, key); guard(); return value; }
  async function all(store) { guard(); var value = await storage.all(store); guard(); return value; }
  async function write(changes) { guard(); await storage.batch(changes); guard(); }
  async function network(path, init) { guard(); var result = await adapter.authenticatedJson(path, Object.assign({}, init || {}, { signal: controller.signal })); guard(); return result; }
  function operation(work) {
   var result = queue.then(async function () { guard(); var value = await work(); guard(); return value; }).catch(function (error) { throw report(error); });
   queue = result.catch(function () {}); return result;
  }
  guard(); var hash = await accountHash(adapter.token); guard();
  try {
   storage = await (adapter.storageFactory || openDatabase)(hash, guard); guard();
   await write([put('meta', 'enabled', true)]);
  } catch (error) { if (storage) storage.close(); throw report(error); }
  function normalize(payload) {
   var readerId = payload.readerId; var id = decimal(readerId);
   return { id: payload.id, decimalId: id, readerId: readerId, feedKey: payload.feedKey, title: payload.title || '', author: payload.author || '', source: payload.source || '', originalURL: payload.originalURL || null,
    receivedAt: payload.receivedAt, isRead: !!payload.isRead, isStarred: !!payload.isStarred, isBodyPruned: !!payload.isBodyPruned,
    preview: String(payload.text || '').slice(0, 600), savedAt: new Date().toISOString() };
  }
  async function pending() { return (await all('outbox')).sort(function (a, b) { return a.order - b.order; }); }
  function overlay(article, outbox) {
   var value = Object.assign({}, article);
   outbox.forEach(function (mutation) { if (mutation.nativeId === article.id) value[mutation.kind === 'set_read' ? 'isRead' : 'isStarred'] = mutation.value; });
   return value;
  }
  async function resolve(readerId) {
   var id = decimal(readerId); var articles = await all('articles');
   return articles.find(function (article) { return article.decimalId === id; });
  }
  async function applyPage(page) {
   if (!page || !Array.isArray(page.changes) || page.changes.length > 200 || typeof page.cursor !== 'string' || !/^v1:\d+$/.test(page.cursor)) throw offlineError('sync', 'Invalid offline sync response.');
   var changes = []; var local = new Map();
   for (var change of page.changes) {
    if (!change || !['feed','article','status'].includes(change.entityType) || typeof change.entityId !== 'string') throw offlineError('sync', 'Invalid sync change.');
    var store = change.entityType === 'feed' ? 'feeds' : change.entityType === 'article' ? 'articles' : 'statuses';
    if (change.operation === 'delete') {
     changes.push(remove(store, change.entityId));
     if (store === 'articles') { changes.push(remove('bodies', change.entityId), remove('positions', change.entityId)); local.set(change.entityId, null); }
     continue;
    }
    var payload = change.payload;
    if (!payload || typeof payload !== 'object') throw offlineError('sync', 'Missing sync payload.');
    if (store === 'feeds') changes.push(put('feeds', change.entityId, Object.assign({}, payload, { id: change.entityId })));
    else if (store === 'articles') {
     var article = normalize(payload); local.set(article.id, article);
     changes.push(put('articles', article.id, article), put('bodies', article.id, { id: article.id, html: payload.html || '', text: payload.text || '' }));
    } else {
     changes.push(put('statuses', change.entityId, payload));
     var existing = local.has(change.entityId) ? local.get(change.entityId) : await read('articles', change.entityId);
     if (existing) { var updated = Object.assign({}, existing, { isRead: !!payload.isRead, isStarred: !!payload.isStarred }); local.set(change.entityId, updated); changes.push(put('articles', change.entityId, updated)); }
    }
   }
   changes.push(put('meta', 'cursor', page.cursor), put('meta', 'lastSync', new Date().toISOString()));
   await write(changes);
  }
  function asGreader(article, body, feed) {
   var categories = [];
   if (article.isRead) categories.push('user/-/state/com.google/read');
   if (article.isStarred) categories.push('user/-/state/com.google/starred');
   (feed && feed.folders || []).forEach(function (folder) { categories.push('user/-/label/' + folder); });
   return { id: article.readerId, nativeId: article.id, decimalId: article.decimalId, title: article.title, author: article.author, published: Math.floor(new Date(article.receivedAt).getTime()/1000), categories: categories,
    origin: { title: feed && feed.title || article.source, streamId: feed && feed.streamId || '' }, alternate: article.originalURL ? [{ href: article.originalURL }] : [],
    summary: { content: body && body.html || '<p>This article body has not been saved offline.</p>' }, contentVersion: body && body.contentVersion, offlineSaved: !!body, isBodyPruned: article.isBodyPruned };
  }
  async function doReplay() {
   var applied = 0;
   while (true) {
    var outbox = await pending(); if (!outbox.length) return { applied: applied, pending: 0 };
    // Never send a later state for the same field until its predecessor is acknowledged.
    var fields = new Set(); var batch = outbox.filter(function (mutation) { var field = mutation.nativeId + ':' + mutation.kind; if (fields.has(field)) return false; fields.add(field); return true; }).slice(0, 5);
    var response = await network('/api/v1/mutations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mutations: batch.map(function (mutation) { return { id: mutation.id, kind: mutation.kind, itemIds: [mutation.nativeId], value: mutation.value }; }) }) });
    if (!response || !Array.isArray(response.results)) throw offlineError('replay', 'Invalid mutation receipt response.');
    var results = new Map(response.results.map(function (result) { return [result.mutationId, result]; })); var writes = []; var acknowledged = 0; var updatedArticles = new Map();
    for (var mutation of batch) {
     var receipt = results.get(mutation.id);
     if (!receipt || !['applied','already_applied'].includes(receipt.status)) continue;
     writes.push(remove('outbox', mutation.id)); acknowledged++; applied++;
     var article = updatedArticles.get(mutation.nativeId) || await read('articles', mutation.nativeId);
     if (article) { article[mutation.kind === 'set_read' ? 'isRead' : 'isStarred'] = mutation.value; updatedArticles.set(article.id, article); writes.push(put('articles', article.id, article)); }
    }
    await write(writes); var remaining = (await pending()).length;
    notify({ phase: 'replay', applied: applied, pending: remaining });
    // Keep partial failures visible; retry uses the same UUIDs on the next replay call.
    if (acknowledged !== batch.length) return { applied: applied, pending: remaining, partial: true };
   }
  }
  var library = {
   accountHash: hash,
   close: function () { closed = true; controller.abort(); storage.close(); },
   sync: function () { return operation(async function () {
    var pages = 0; var count = 0; var cursor = await read('meta', 'cursor') || 'v1:0';
    while (true) {
     var page = await network('/api/v1/sync?limit=200&cursor=' + encodeURIComponent(cursor));
     if (page.hasMore && page.cursor === cursor) throw offlineError('sync', 'Offline sync did not advance. Retry later.');
     await applyPage(page); cursor = page.cursor; pages++; count += page.changes.length;
     notify({ phase: 'sync', pages: pages, changes: count, cursor: cursor, hasMore: !!page.hasMore });
     if (!page.hasMore) return { pages: pages, changes: count, cursor: cursor };
    }
   }); },
   replay: function () { return operation(doReplay); },
   confirmState: function (readerId, kind, value) { return operation(async function () {
    if (!['set_read','set_starred'].includes(kind) || typeof value !== 'boolean') throw offlineError('mutation', 'Only acknowledged read and star state can be saved.');
    var article = await resolve(readerId); if (!article) return { saved: false };
    var field = kind === 'set_read' ? 'isRead' : 'isStarred';
    article[field] = value;
    var status = await read('statuses', article.id) || { itemId: article.id, isRead: article.isRead, isStarred: article.isStarred };
    status[field] = value;
    await write([put('articles', article.id, article), put('statuses', article.id, status)]);
    return { saved: true, nativeId: article.id };
   }); },
   queueMutation: function (readerId, kind, value) { return operation(async function () {
    if (!['set_read','set_starred'].includes(kind) || typeof value !== 'boolean') throw offlineError('mutation', 'Only read and star state can be queued offline.');
    var article = await resolve(readerId); if (!article) throw offlineError('identity', 'Save this article before changing it offline.');
    var mutation = { id: crypto.randomUUID(), kind: kind, nativeId: article.id, readerId: article.readerId, value: value, queuedAt: new Date().toISOString() };
    if (typeof storage.enqueue !== 'function') throw offlineError('storage', 'Offline storage does not support atomic mutation enqueue.');
    guard(); var saved = await storage.enqueue(mutation); guard(); return saved;
   }); },
   feeds: function () { return operation(function () { return all('feeds'); }); },
   query: function (options) { return operation(async function () {
    var query = options || {}; var outbox = await pending(); var feeds = await all('feeds'); var byFeed = new Map(feeds.map(function (feed) { return [feed.feedKey, feed]; }));
    var articles = await all('articles'); var matching = []; var needle = String(query.q || '').trim().toLocaleLowerCase(); var stream = query.stream || 'all';
    if (!['all','reading-list','unread','read','starred','user/-/state/com.google/reading-list','user/-/state/com.google/read','user/-/state/com.google/starred'].includes(stream) && !/^feed\/[1-9][0-9]*$/.test(stream) && !(stream.indexOf('user/-/label/') === 0 && stream.slice('user/-/label/'.length).length > 0)) throw offlineError('query', 'This view is not supported in the locally saved library.');
    if (needle.length > 200 || query.filter && !['all','read','unread'].includes(query.filter) || query.sort && !['newest','oldest'].includes(query.sort)) throw offlineError('query', 'Unsupported offline search, filter or sort.');
    for (var saved of articles) {
     var article = overlay(saved, outbox); var feed = byFeed.get(article.feedKey);
     if (feed && feed.isActive === false) continue;
     if (stream === 'unread' && article.isRead) continue;
     if ((stream === 'read' || stream === 'user/-/state/com.google/read') && !article.isRead) continue;
     if ((stream === 'starred' || stream === 'user/-/state/com.google/starred') && !article.isStarred) continue;
     if (stream.indexOf('feed/') === 0 && (!feed || feed.streamId !== stream)) continue;
     if (stream.indexOf('user/-/label/') === 0 && (!feed || !(feed.folders || []).includes(stream.slice('user/-/label/'.length)))) continue;
     if (query.filter === 'unread' && article.isRead || query.filter === 'read' && !article.isRead) continue;
     if (query.since && article.receivedAt < query.since || query.before && article.receivedAt >= query.before) continue;
     var searchable = [article.title, article.author, feed && feed.title || article.source, article.preview].join(' ').toLocaleLowerCase();
     if (needle && !searchable.includes(needle)) { var body = await read('bodies', article.id); if (!body || !String(body.text || '').toLocaleLowerCase().includes(needle)) continue; }
     matching.push(article);
    }
    matching.sort(function (a, b) { var difference = new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime() || (BigInt(a.decimalId) > BigInt(b.decimalId) ? 1 : -1); return query.sort === 'oldest' ? difference : -difference; });
    var offset = Math.max(0, Number(query.offset) || 0); var limit = Math.min(200, Math.max(1, Number(query.limit) || 50));
    return { itemIds: matching.slice(offset, offset + limit).map(function (article) { return article.decimalId; }), total: matching.length, hasMore: offset + limit < matching.length, offline: true, coverage: 'locally-saved' };
   }); },
   contents: function (readerIds) { return operation(async function () {
    var outbox = await pending(); var output = []; var feeds = new Map((await all('feeds')).map(function (feed) { return [feed.feedKey, feed]; }));
    for (var id of readerIds) { var article = await resolve(id); if (article) output.push(asGreader(overlay(article, outbox), await read('bodies', article.id), feeds.get(article.feedKey))); }
    return { items: output, offline: true };
   }); },
   storeBodies: function (items) { return operation(async function () {
    if (!Array.isArray(items) || items.length > 200) throw offlineError('storage', 'Save article bodies in batches of at most 200.');
    var writes = [];
    for (var item of items) {
     var article = await resolve(item.id); if (!article) continue; // native mapping must come from sync first
     var html = item.content && item.content.content || item.summary && item.summary.content || '';
     writes.push(put('bodies', article.id, { id: article.id, html: html, text: item.offlineText || html.replace(/<[^>]*>/g, ' '), contentVersion: item.contentVersion == null ? undefined : String(item.contentVersion) }));
    }
    await write(writes); return { saved: writes.length };
   }); },
   savePosition: function (readerId, position) { return operation(async function () {
    if (!Number.isFinite(position) || position < 0 || position > 1) throw offlineError('position', 'Reader position must be between 0 and 1.');
    var article = await resolve(readerId); if (article) await write([put('positions', article.id, position)]);
   }); },
   getPosition: function (readerId) { return operation(async function () { var article = await resolve(readerId); return article ? await read('positions', article.id) || 0 : 0; }); },
   stats: function () { return operation(async function () {
    var articles = await all('articles'); var outbox = await pending(); var bytes = 0; var bodyCount = 0;
    function measure(body) { bodyCount++; bytes += new TextEncoder().encode(body.html || '').length + new TextEncoder().encode(body.text || '').length; }
    guard(); if (storage.scan) { await storage.scan('bodies', measure); guard(); } else (await all('bodies')).forEach(measure);
    var estimate = null; guard(); if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.estimate) { estimate = await navigator.storage.estimate(); guard(); }
    return { articles: articles.length, savedBodies: bodyCount, feeds: (await all('feeds')).length, pending: outbox.length, bodyBytes: bytes, cursor: await read('meta','cursor') || 'v1:0', lastSync: await read('meta','lastSync') || null, estimate: estimate, coverage: 'locally-saved' };
   }); },
   freeOlderReadUnstarred: function (before) { return operation(function () { if (!Number.isFinite(new Date(before).getTime())) throw offlineError('storage', 'Choose a valid cleanup date.'); return freeBodies(before); }); },
   clearCache: function () { return operation(async function () { if ((await pending()).length) throw offlineError('pending', 'Sync pending edits before clearing the offline cache.'); return freeBodies(null); }); }
  };
  async function freeBodies(before) {
   var outbox = await pending(); var protectedIds = new Set(outbox.map(function (mutation) { return mutation.nativeId; })); var articles = await all('articles'); var changes = [];
   for (var article of articles) { var current = overlay(article, outbox); if (!current.isRead || current.isStarred || protectedIds.has(article.id) || before && current.receivedAt >= before) continue; if (await read('bodies', article.id)) changes.push(remove('bodies', article.id)); }
   await write(changes); return { freed: changes.length, protected: articles.length - changes.length };
  }
  return library;
 }
 window.PigeonOffline = { accountHash: accountHash, hasAccount: hasAccount, create: create };
})();`;
}
