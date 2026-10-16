import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { renderBrowserOfflineScript } from '../src/browser-offline';

const copy = (value: any) => value === undefined ? undefined : structuredClone(value);
const plain = (value: any) => JSON.parse(JSON.stringify(value));
function fixture() {
 const databases = new Map<string, Map<string, Map<string, any>>>(); let generation = 'account:1'; let quota = false; let closed = 0; let response: (path: string, init: any) => Promise<any> = async () => page();
 const progress: any[] = []; const errors: any[] = []; const calls: { path: string; init: any }[] = [];
 const storageFactory = async (hash: string, guard: Function) => {
  let database = databases.get(hash); if (!database) { database = new Map(); databases.set(hash, database); }
  const table = (store: string) => { if (!database!.has(store)) database!.set(store, new Map()); return database!.get(store)!; };
  return {
   get: async (store: string, key: string) => { guard(); const value = copy(table(store).get(key)); await Promise.resolve(); guard(); return value; },
   all: async (store: string) => { guard(); const value = [...table(store).values()].map(copy); await Promise.resolve(); guard(); return value; },
   enqueue: async (mutation: any) => { guard(); if (quota) { const error = new Error('full'); error.name = 'QuotaExceededError'; throw error; } const order = (table('meta').get('nextMutationOrder') || 0) + 1; const saved = { ...copy(mutation), order }; table('meta').set('nextMutationOrder', order); table('outbox').set(saved.id, copy(saved)); await Promise.resolve(); guard(); return saved; },
   batch: async (changes: any[]) => { guard(); if (quota) { const error = new Error('full'); error.name = 'QuotaExceededError'; throw error; } const prepared = changes.map(copy); await Promise.resolve(); guard(); for (const change of prepared) { if (change.delete) table(change.store).delete(change.key); else table(change.store).set(change.key, copy(change.value)); } guard(); },
   close: () => { closed++; },
  };
 };
 const window: any = {};
 runInNewContext(renderBrowserOfflineScript(), { window, crypto: webcrypto, TextEncoder, TextDecoder, AbortController, URL, structuredClone, navigator: { storage: { estimate: async () => ({ usage: 1234, quota: 10000 }) } } });
 const api = window.PigeonOffline;
 const adapter = (token = 'private-auth-token') => ({ token, storageFactory, getSessionKey: () => generation,
  authenticatedJson: async (path: string, init: any) => { calls.push({ path, init }); return response(path, init); }, onProgress: (value: any) => progress.push(plain(value)), onError: (error: any) => errors.push(plain(error)) });
 return { api, adapter, databases, calls, progress, errors, setGeneration: (value: string) => { generation = value; }, setQuota: (value: boolean) => { quota = value; }, setResponse: (value: typeof response) => { response = value; }, closed: () => closed };
}
function article(id: number, options: any = {}) {
 return { sequence: id + 1, entityType: 'article', entityId: 'native-' + id, operation: 'upsert', payload: {
  id: 'native-' + id, readerId: 'tag:google.com,2005:reader/item/' + id.toString(16).padStart(16, '0'), feedKey: 'one', source: 'Newsletter', title: 'Article ' + id, author: 'A writer', html: '<p>Body ' + id + '</p>', text: 'Body ' + id, receivedAt: '2026-10-12T12:00:00.000Z', isRead: false, isStarred: false, ...options,
 } };
}
function page(changes: any[] = [
 { sequence: 1, entityType: 'feed', entityId: 'one', operation: 'upsert', payload: { feedKey: 'one', streamId: 'feed/1', title: 'Newsletter', folders: ['Design'], isActive: true } },
 article(1), article(2, { isRead: true }), article(3, { isStarred: true }),
], cursor = 'v1:4', hasMore = false) { return { changes, cursor, hasMore }; }

test('emitted offline module parses and account namespaces persist hashed identity without raw credentials', async () => {
 const state = fixture(); const library = await state.api.create(state.adapter()); await library.sync();
 const hash = await state.api.accountHash('private-auth-token'); assert.match(hash, /^[a-f0-9]{64}$/);
 assert.equal(await state.api.hasAccount(hash, state.adapter().storageFactory), true);
 assert.equal(await state.api.hasAccount(await state.api.accountHash('wrong-password-token'), state.adapter().storageFactory), false);
 const serialized = JSON.stringify([...state.databases].map(([key, db]) => [key, [...db].map(([store, values]) => [store, [...values]])]));
 assert.ok(!serialized.includes('private-auth-token')); library.close();
 const resumed = await state.api.create(state.adapter()); assert.equal((await resumed.stats()).articles, 3);
 state.setGeneration('other:2'); const other = await state.api.create(state.adapter('other-token'));
 assert.equal((await other.stats()).articles, 0); await assert.rejects(library.stats(), /account changed/);
});

test('sync stores bodies, both IDs, feeds and cursor; offline search/filter/sort queries only saved data', async () => {
 const state = fixture(); const library = await state.api.create(state.adapter()); await library.sync();
 assert.deepEqual(plain(await library.query({ filter: 'unread' })), { itemIds: ['3','1'], total: 2, hasMore: false, offline: true, coverage: 'locally-saved' });
 assert.deepEqual(plain((await library.query({ stream: 'feed/1', q: 'Body 2', sort: 'oldest' })).itemIds), ['2']);
 assert.deepEqual(plain((await library.query({ stream: 'user/-/label/Design', sort: 'oldest', limit: 2 })).itemIds), ['1','2']);
 assert.deepEqual(plain((await library.query({ stream: 'starred' })).itemIds), ['3']);
 const contents = await library.contents(['2','1']); assert.equal(contents.items[0].id, article(2).payload.readerId); assert.equal(contents.items[0].nativeId, 'native-2');
 assert.equal(contents.items[0].summary.content, '<p>Body 2</p>'); assert.equal(contents.items[0].origin.streamId, 'feed/1');
 await library.savePosition('1', 0.65); assert.equal(await library.getPosition('1'), 0.65);
 assert.equal((await library.stats()).cursor, 'v1:4'); assert.equal(state.progress[0].changes, 4);
});

test('sync resumes all pages with progress, rejects stalled pagination and commits cursor atomically with data', async () => {
 const state = fixture(); let step = 0;
 state.setResponse(async (path) => { assert.match(path, /limit=200/); return step++ === 0 ? page([article(1)], 'v1:2', true) : page([article(2)], 'v1:3'); });
 const library = await state.api.create(state.adapter()); const result = await library.sync(); assert.equal(result.pages, 2); assert.equal(state.progress.length, 2);
 assert.match(state.calls[1].path, /cursor=v1%3A2/);
 state.setResponse(async () => page([], 'v1:3', true)); await assert.rejects(library.sync(), /did not advance/);
 state.setResponse(async () => page([article(3)], 'v1:4')); state.setQuota(true);
 await assert.rejects(library.sync(), /full/); state.setQuota(false);
 assert.equal((await library.stats()).cursor, 'v1:3'); assert.equal((await library.stats()).articles, 2);
 assert.equal(state.errors.at(-1).code, 'quota');
});

test('durable desired state overlays fresh server sync, survives reopen, and invalid offline IDs are refused', async () => {
 const state = fixture(); const first = await state.api.create(state.adapter()); await first.sync();
 const mutation = await first.queueMutation('1', 'set_read', true); assert.match(mutation.id, /^[0-9a-f-]{36}$/);
 state.setResponse(async () => page([article(1, { isRead: false })], 'v1:5')); await first.sync();
 assert.deepEqual(plain((await first.query({ filter: 'read' })).itemIds), ['2','1']); first.close();
 const reopened = await state.api.create(state.adapter()); assert.equal((await reopened.stats()).pending, 1);
 assert.ok((await reopened.contents(['1'])).items[0].categories.includes('user/-/state/com.google/read'));
 await assert.rejects(reopened.queueMutation('999', 'set_read', true), /Save this article/);
 await assert.rejects(reopened.queueMutation('1', 'rename_feed', true), /Only read and star/);
});

test('partial replay removes only acknowledged receipts, preserves original UUIDs and combines read/star state', async () => {
 const state = fixture(); const library = await state.api.create(state.adapter()); await library.sync();
 const read = await library.queueMutation('1', 'set_read', true); const star = await library.queueMutation('1', 'set_starred', true);
 let step = 0;
 state.setResponse(async (_path, init) => {
  const mutations = JSON.parse(init.body).mutations;
  if (step++ === 0) { assert.deepEqual(mutations.map((m: any) => m.id), [read.id, star.id]); return { results: [{ mutationId: read.id, status: 'applied' }, { mutationId: star.id, status: 'failed' }] }; }
  assert.deepEqual(mutations.map((m: any) => m.id), [star.id]); return { results: [{ mutationId: star.id, status: 'already_applied' }] };
 });
 assert.equal((await library.replay()).pending, 1); assert.equal((await library.replay()).pending, 0);
 const categories = (await library.contents(['1'])).items[0].categories;
 assert.ok(categories.includes('user/-/state/com.google/read')); assert.ok(categories.includes('user/-/state/com.google/starred'));
});

test('overlapping toggles replay in order; failed older action cannot reverse a newer acknowledged state', async () => {
 const state = fixture(); const library = await state.api.create(state.adapter()); await library.sync();
 const first = await library.queueMutation('1','set_read',true); const second = await library.queueMutation('1','set_read',false);
 let phase = 0;
 state.setResponse(async (_path, init) => {
  const batch = JSON.parse(init.body).mutations; assert.equal(batch.length, 1);
  if (phase++ === 0) { assert.equal(batch[0].id, first.id); return { results: [{ mutationId: first.id, status: 'failed' }] }; }
  return { results: [{ mutationId: batch[0].id, status: 'applied' }] };
 });
 assert.equal((await library.replay()).pending, 2); assert.equal((await library.replay()).pending, 0);
 assert.deepEqual(state.calls.filter(call => call.path === '/api/v1/mutations').map(call => JSON.parse(call.init.body).mutations[0].id), [first.id,first.id,second.id]);
 assert.ok(!(await library.contents(['1'])).items[0].categories.includes('user/-/state/com.google/read'));
});

test('account changes during delayed network or storage halt stale writes and close the old library', async () => {
 const state = fixture(); const library = await state.api.create(state.adapter()); let release: (value: any) => void = () => {};
 state.setResponse(() => new Promise(resolve => { release = resolve; }));
 const syncing = library.sync(); await new Promise(resolve => setImmediate(resolve));
 const signal = state.calls[0].init.signal; state.setGeneration('account:2'); release(page());
 await assert.rejects(syncing, /account changed/); assert.equal(signal.aborted, true); assert.ok(state.closed() > 0);
 await assert.rejects(library.stats(), /account changed/);
 const current = await state.api.create(state.adapter('current-token')); assert.equal((await current.stats()).articles, 0);
});

test('cleanup preserves unread, starred and pending bodies; clear refuses edits instead of silently discarding them', async () => {
 const state = fixture(); const library = await state.api.create(state.adapter()); await library.sync();
 await library.queueMutation('1','set_read',true);
 await assert.rejects(library.clearCache(), /Sync pending edits/);
 assert.equal((await library.freeOlderReadUnstarred('2026-10-13T00:00:00.000Z')).freed, 1);
 assert.equal((await library.stats()).savedBodies, 2); assert.equal((await library.stats()).pending, 1);
 state.setResponse(async (_path, init) => ({ results: JSON.parse(init.body).mutations.map((mutation: any) => ({ mutationId: mutation.id, status: 'applied' })) }));
 await library.replay(); assert.equal((await library.clearCache()).freed, 1); assert.equal((await library.stats()).savedBodies, 1);
 assert.equal((await library.clearCache()).freed, 0);
 assert.ok((await library.contents(['3'])).items[0].offlineSaved); assert.equal((await library.stats()).articles, 3);
});

test('failed network replay keeps durable edits and quota failure cannot falsely report queued success', async () => {
 const state = fixture(); const library = await state.api.create(state.adapter()); await library.sync();
 state.setQuota(true); await assert.rejects(library.queueMutation('1','set_starred',true), /full/); state.setQuota(false); assert.equal((await library.stats()).pending, 0);
 await library.queueMutation('1','set_starred',true); state.setResponse(async () => { throw new Error('network offline'); });
 await assert.rejects(library.replay(), /network offline/); assert.equal((await library.stats()).pending, 1);
});

test('multiple open libraries enqueue atomically with unique order and replay same-field toggles in that order', async () => {
 const state = fixture(); const first = await state.api.create(state.adapter()); await first.sync(); const second = await state.api.create(state.adapter());
 const queued = await Promise.all([first.queueMutation('1','set_read',true), second.queueMutation('1','set_read',false)]);
 assert.equal(new Set(queued.map(mutation => mutation.order)).size, 2);
 const ordered = queued.slice().sort((a, b) => a.order - b.order);
 const categories = (await first.contents(['1'])).items[0].categories; assert.equal(categories.includes('user/-/state/com.google/read'), ordered[1].value);
 state.setResponse(async (_path, init) => ({ results: JSON.parse(init.body).mutations.map((mutation: any) => ({ mutationId: mutation.id, status: 'applied' })) }));
 await first.replay(); assert.deepEqual(state.calls.filter(call => call.path === '/api/v1/mutations').map(call => JSON.parse(call.init.body).mutations[0].id), ordered.map(mutation => mutation.id));
 assert.equal((await second.stats()).pending, 0);
});

test('unread alias matches offline filter; unsupported streams and sorts fail closed', async () => {
 const state = fixture(); const library = await state.api.create(state.adapter()); await library.sync();
 assert.deepEqual(plain((await library.query({ stream: 'unread' })).itemIds), plain((await library.query({ filter: 'unread' })).itemIds));
 for (const options of [{ stream: 'user/-/state/com.google/unknown' }, { stream: 'feed/0' }, { stream: 'user/-/label/' }, { sort: 'recommended' }, { filter: 'unknown' }]) await assert.rejects(library.query(options), /not supported|Unsupported/);
});

test('session changes during asynchronous storage read prevent stale queue writes', async () => {
 const state = fixture(); const first = await state.api.create(state.adapter()); await first.sync(); first.close();
 const adapter = state.adapter(); const originalFactory = adapter.storageFactory;
 adapter.storageFactory = async (hash, guard) => {
  const storage = await originalFactory(hash, guard); const originalAll = storage.all;
  return { ...storage, all: async (store: string) => { const result = await originalAll(store); if (store === 'articles') state.setGeneration('other:2'); return result; } };
 };
 const stale = await state.api.create(adapter); await assert.rejects(stale.queueMutation('1','set_read',true), /account changed/);
 state.setGeneration('account:3'); const resumed = await state.api.create(state.adapter()); assert.equal((await resumed.stats()).pending, 0);
});

test('acknowledged online state persists for offline query/contents without enqueue or duplicate API writes', async () => {
 const state=fixture(); const library=await state.api.create(state.adapter()); await library.sync(); const callsBefore=state.calls.length;
 assert.equal((await library.confirmState('1','set_read',true)).saved,true);
 assert.equal((await library.confirmState('1','set_starred',true)).saved,true);
 assert.deepEqual(plain((await library.query({stream:'starred',filter:'read'})).itemIds),['1']);
 const categories=(await library.contents(['1'])).items[0].categories;assert.ok(categories.includes('user/-/state/com.google/read'));assert.ok(categories.includes('user/-/state/com.google/starred'));
 assert.equal((await library.stats()).pending,0);assert.equal(state.calls.length,callsBefore);
 library.close();const reopened=await state.api.create(state.adapter());assert.ok((await reopened.contents(['1'])).items[0].categories.includes('user/-/state/com.google/read'));
 const status=state.databases.get(reopened.accountHash)!.get('statuses')!.get('native-1');assert.equal(status.isRead,true);assert.equal(status.isStarred,true);
 assert.equal((await reopened.confirmState('999','set_read',true)).saved,false);
 await assert.rejects(reopened.confirmState('1','rename_feed',true),/Only acknowledged/);
});

test('acknowledged base updates preserve newer pending overlays and every other state field', async () => {
 const state=fixture();const library=await state.api.create(state.adapter());await library.sync();
 await library.confirmState('1','set_starred',true);const queued=await library.queueMutation('1','set_read',false);
 await library.confirmState('1','set_read',true);
 const categories=(await library.contents(['1'])).items[0].categories;assert.ok(!categories.includes('user/-/state/com.google/read'));assert.ok(categories.includes('user/-/state/com.google/starred'));
 assert.equal((await library.stats()).pending,1);
 const database=state.databases.get(library.accountHash)!;assert.equal(database.get('articles')!.get('native-1').isRead,true);assert.equal(database.get('statuses')!.get('native-1').isStarred,true);assert.equal(database.get('outbox')!.get(queued.id).value,false);
});
