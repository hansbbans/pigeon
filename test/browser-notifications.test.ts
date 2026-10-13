import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { renderBrowserNotificationsScript } from '../src/browser-notifications';

class Element {
 children: Element[] = []; textContent = ''; tag: string; style: any = {}; dataset: any = {}; type = ''; checked = false; value = ''; disabled = false; attributes = new Map<string,string>(); listeners = new Map<string, Function>();
 constructor(tag: string) { this.tag = tag; }
 appendChild(value: Element) { this.children.push(value); return value; }
 replaceChildren(...values: Element[]) { this.children = values; }
 setAttribute(key: string, value: string) { this.attributes.set(key,value); }
 addEventListener(name: string, callback: Function) { this.listeners.set(name,callback); }
 click() { if (!this.disabled) this.listeners.get('click')?.(); }
 change(checked: boolean) { this.checked = checked; this.listeners.get('change')?.(); }
 all(): Element[] { return [this,...this.children.flatMap(child => child.all())]; }
 text(): string { return this.textContent + this.children.map(child => child.text()).join(' '); }
}
async function settle(predicate: () => boolean) { for (let attempt = 0; attempt < 100; attempt++) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); } throw new Error('Panel did not settle'); }
function fixture() {
 const stored = new Map<string,string>(); const identity = { token: 'private-account-token', generation: 1 }; let denyStorage = false; let permissionRequests = 0; let registrations = 0; let subscriptions = 0; let unsubscriptions = 0; let current: any = null; let permission = 'default'; let grant = 'granted'; let subscribeWait: Promise<any> | null = null;
 const calls: any[] = []; let api: (path: string,init?: any) => Promise<any> = async (path,init) => path.endsWith('capabilities') ? { enabled: true, publicKey: Buffer.alloc(65,4).toString('base64url') } : init.method === 'DELETE' ? { deleted:true } : init.method === 'PUT' ? { id:'own-id' } : { id:'own-id',managementToken:'own-browser-management-secret' };
 const container = new Element('div'); const win: any = { isSecureContext:true }; const notifications: any = { get permission() { return permission; }, requestPermission: async () => { permissionRequests++; permission = grant; return grant; } };
 const registration = { pushManager: { getSubscription: async () => current, subscribe: async () => { subscriptions++; if (subscribeWait) return subscribeWait; return makeSubscription('https://fcm.googleapis.com/wp/own-' + subscriptions); } } };
 function makeSubscription(endpoint: string) { const value = { endpoint, toJSON: () => ({ endpoint, keys: { p256dh:'fixture-public',auth:'fixture-auth' } }), unsubscribe: async () => { unsubscriptions++; if (current === value) current = null; return true; } }; current = value; return value; }
 const serviceWorker = { register: async (path: string,options: any) => { registrations++; assert.equal(path,'/app/sw.js'); assert.equal(options.scope,'/app'); return registration; }, getRegistration: async () => registration };
 runInNewContext(renderBrowserNotificationsScript(), { window:win, document:{ createElement:(tag: string) => new Element(tag) }, Notification:notifications, PushManager:function(){}, navigator:{serviceWorker}, crypto:webcrypto, TextEncoder, AbortController, URL, Uint8Array, atob,
  localStorage:{ getItem:(key: string) => { if (denyStorage) throw new Error('denied'); return stored.get(key) ?? null; }, setItem:(key: string,value: string) => { if (denyStorage) throw new Error('full'); stored.set(key,value); }, removeItem:(key: string) => { if (denyStorage) throw new Error('denied'); stored.delete(key); } } });
 const adapter = { container, getSessionIdentity:() => identity, getSubscriptions:() => [{ id:'feed/1',title:'Newsletter',url:'https://pigeon.example/feed/one' }, { title:'Second',feedKey:'two' }], authenticatedJson:async (path: string,init?: any) => { calls.push({path,init,token:identity.token}); return api(path,init); } };
 const handle = win.PigeonNotifications.mount(adapter);
 const button = (action: string) => container.all().find(node => node.dataset.action === action)!;
 const checkbox = (value: string) => container.all().find(node => node.type === 'checkbox' && node.value === value)!;
 const ready = async () => settle(() => !!button('refresh') && !button('refresh').disabled);
 return { container, handle, identity, stored, calls, ready, button, checkbox, setAPI:(value: typeof api) => { api=value; }, setPermission:(value: string) => { permission=value; }, setGrant:(value: string) => { grant=value; }, setStorageDenied:(value: boolean) => { denyStorage=value; }, setSubscribeWait:(value: Promise<any>) => { subscribeWait=value; }, makeSubscription, count:() => ({permissionRequests,registrations,subscriptions,unsubscriptions}), window:win };
}

test('mount loads capability without permission/subscription; enable persists only account hash and browser-management credentials', async () => {
 const state=fixture(); await state.ready(); assert.equal(state.count().permissionRequests,0); assert.equal(state.count().registrations,0);
 state.checkbox('one').change(true); state.button('enable').click(); await state.ready();
 assert.equal(state.count().permissionRequests,1); assert.equal(state.count().subscriptions,1); assert.equal(state.count().registrations,1);
 const mutation=state.calls.find(call => call.init?.method==='POST'); assert.deepEqual(JSON.parse(mutation.init.body).feedKeys,['one']);
 assert.match([...state.stored.keys()][0],/^pigeon\.browser\.push\.v1\.[a-f0-9]{64}$/); assert.ok(!JSON.stringify([...state.stored]).includes('private-account-token'));
 const record=JSON.parse([...state.stored.values()][0]); assert.equal(record.managementToken,'own-browser-management-secret'); assert.equal(record.uncertain,false);
 assert.match(state.container.text(),/enabled for 1 selected feeds/);
});

test('same browser saves per-feed choices with own token and empty selection pauses delivery', async () => {
 const state=fixture(); await state.ready(); state.checkbox('one').change(true); state.button('enable').click(); await state.ready();
 state.checkbox('one').change(false); state.button('enable').click(); await state.ready();
 const update=state.calls.find(call => call.init?.method==='PUT'); const body=JSON.parse(update.init.body);
 assert.deepEqual(body.feedKeys,[]); assert.equal(body.id,'own-id'); assert.equal(body.managementToken,'own-browser-management-secret');
 assert.equal(state.count().permissionRequests,1); assert.equal(state.count().subscriptions,1); assert.match(state.container.text(),/notifications are paused/);
});

test('permission denied or storage failure produces actionable status without server or browser subscription side effects', async () => {
 const denied=fixture(); denied.setGrant('denied'); await denied.ready(); denied.button('enable').click(); await denied.ready();
 assert.equal(denied.count().subscriptions,0); assert.equal(denied.calls.filter(call=>call.init?.method==='POST').length,0); assert.match(denied.container.text(),/blocked|browser settings/);
 const storage=fixture(); await storage.ready(); storage.setStorageDenied(true); storage.button('enable').click(); await settle(()=>/Could not save/.test(storage.container.text()));
 assert.equal(storage.count().permissionRequests,0); assert.equal(storage.count().subscriptions,0);
});

test('disable stops only owned browser subscription; failed server deletion retains token and supports explicit retry', async () => {
 const state=fixture(); await state.ready(); state.button('enable').click(); await state.ready();
 state.setAPI(async (path,init)=> { if(init?.method==='DELETE') throw new Error('Network unavailable; retry.'); return {enabled:true,publicKey:Buffer.alloc(65,4).toString('base64url')}; });
 state.button('disable').click(); await state.ready(); assert.equal(state.count().unsubscriptions,1);
 const pending=JSON.parse([...state.stored.values()][0]); assert.equal(pending.pendingDelete,true); assert.equal(pending.managementToken,'own-browser-management-secret'); assert.match(state.button('disable').textContent,/Finish disabling/);
 state.setAPI(async()=>({deleted:true})); state.button('disable').click(); await state.ready(); assert.equal(state.stored.size,0); assert.match(state.container.text(),/off for this browser/);
});

test('unconfirmed registration retains uncertainty and stops newly created subscription for a safe retry', async () => {
 const state=fixture(); await state.ready(); state.setAPI(async()=> { throw new Error('Request outcome unknown'); }); state.button('enable').click(); await state.ready();
 assert.equal(state.count().unsubscriptions,1); const record=JSON.parse([...state.stored.values()][0]); assert.equal(record.uncertain,true); assert.equal(record.id,undefined);
 state.setAPI(async()=>({id:'retried',managementToken:'retry-token'})); state.button('enable').click(); await state.ready();
 assert.equal(state.count().subscriptions,2); assert.equal(JSON.parse([...state.stored.values()][0]).id,'retried');
});

test('mutable session identity changed during subscription await cannot use new account auth or overwrite new settings', async () => {
 const state=fixture(); await state.ready(); let release:(value:any)=>void=()=>{}; state.setSubscribeWait(new Promise(resolve=>{release=resolve;}));
 state.button('enable').click(); await settle(()=>state.count().subscriptions===1);
 state.identity.token='new-account-token'; state.identity.generation=2; release(state.makeSubscription('https://fcm.googleapis.com/wp/stale'));
 await new Promise(resolve=>setImmediate(resolve)); await new Promise(resolve=>setImmediate(resolve));
 assert.equal(state.calls.filter(call=>call.init?.method==='POST').length,0); assert.equal(state.stored.size,1);
 assert.ok(!JSON.stringify([...state.stored]).includes('new-account-token')); state.handle.destroy(); assert.equal(state.container.children.length,0);
});

test('unmanaged existing browser subscription is preserved and explained rather than overwritten across accounts', async () => {
 const state=fixture(); state.makeSubscription('https://fcm.googleapis.com/wp/other-account'); await state.ready(); state.button('enable').click(); await state.ready();
 assert.equal(state.count().unsubscriptions,0); assert.equal(state.count().subscriptions,0); assert.equal(state.calls.filter(call=>call.init?.method==='POST').length,0); assert.match(state.container.text(),/another sign-in/);
});

test('disabled server config and unsupported browser state explain availability and never prompt permission', async () => {
 const config=fixture(); await config.ready(); config.setAPI(async()=>({enabled:false,publicKey:null})); await config.handle.refresh(); assert.equal(config.button('enable').disabled,true); assert.match(config.container.text(),/not configured/); assert.equal(config.count().permissionRequests,0);
 const unsupported=fixture(); await unsupported.ready(); unsupported.window.isSecureContext=false; await unsupported.handle.refresh(); assert.match(unsupported.container.text(),/does not support/); assert.equal(unsupported.count().permissionRequests,0);
});

test('server confirmation followed by storage failure keeps credentials in memory so Disable can still stop delivery', async () => {
 const state=fixture(); await state.ready();
 state.setAPI(async (_path,init)=> { if(init?.method==='POST') { state.setStorageDenied(true); return {id:'confirmed',managementToken:'confirmed-management'}; } return {deleted:true}; });
 state.button('enable').click(); await state.ready(); assert.match(state.container.text(),/server enabled notifications.*could not be saved/);
 state.button('disable').click(); await state.ready(); assert.equal(state.count().unsubscriptions,1);
 const deletion=state.calls.find(call=>call.init?.method==='DELETE'); assert.equal(JSON.parse(deletion.init.body).managementToken,'confirmed-management');
 state.setStorageDenied(false); state.button('disable').click(); await state.ready(); assert.equal(state.stored.size,0);
});

test('failed authenticated capability refresh fails closed instead of retaining stale enable permission', async () => {
 const state=fixture(); await state.ready(); state.setAPI(async()=> { throw new Error('Unauthorized'); });
 await assert.rejects(state.handle.refresh(),/Unauthorized/); assert.equal(state.button('enable').disabled,true); assert.equal(state.count().permissionRequests,0);
});
