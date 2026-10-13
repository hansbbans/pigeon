import * as assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createECDH, hkdfSync, createDecipheriv, createPublicKey, verify } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { base64url, encryptWebPush, createVapidAuthorization, validatePushEndpoint, handleBrowserPush, dispatchBrowserPush } from '../src/web-push';
import { RefreshQueryBudget } from '../src/rss-fetcher';
import worker from '../src/index';
import type { Env } from '../src/types';

const ua = createECDH('prime256v1'); ua.generateKeys();
const auth = Buffer.alloc(16, 42);
const subscription = { endpoint: 'https://fcm.googleapis.com/wp/fixture', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
function decrypt(body: Uint8Array): string {
 const wire = Buffer.from(body); const salt = wire.subarray(0, 16); const asPublic = wire.subarray(21, 86);
 assert.equal(wire.readUInt32BE(16), 4096); assert.equal(wire[20], 65);
 const shared = ua.computeSecret(asPublic);
 const ikm = hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]), 32);
 const cek = hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
 const nonce = hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
 const decipher = createDecipheriv('aes-128-gcm', cek, nonce); decipher.setAuthTag(wire.subarray(-16));
 const plain = Buffer.concat([decipher.update(wire.subarray(86, -16)), decipher.final()]);
 assert.equal(plain[plain.length - 1], 2); return plain.subarray(0, -1).toString();
}
async function config() {
 const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
 const jwk = await crypto.subtle.exportKey('jwk', keys.privateKey);
 const raw = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
 return { env: { VAPID_PUBLIC_KEY: base64url(raw), VAPID_PRIVATE_JWK: JSON.stringify(jwk), VAPID_SUBJECT: 'mailto:push@example.com' }, jwk,
  value: { publicKey: base64url(raw), privateKey: keys.privateKey, subject: 'mailto:push@example.com' } };
}
class Statement {
 values: any[] = [];
 constructor(private db: DatabaseSync, private sql: string) {}
 bind(...values: any[]) { this.values = values; return this; }
 async first<T>() { return this.db.prepare(this.sql).get(...this.values) as T ?? null; }
 async all<T>() { return { results: this.db.prepare(this.sql).all(...this.values) as T[] }; }
 async run() { const result = this.db.prepare(this.sql).run(...this.values); return { meta: { changes: result.changes } }; }
}
async function fixture(t: TestContext) {
 const db = new DatabaseSync(':memory:'); t.after(() => db.close());
 db.exec(readFileSync(new URL('../04-storage/SCHEMA.sql', import.meta.url), 'utf8'));
 db.exec("INSERT INTO feeds (feed_key, display_name) VALUES ('one','Private feed'), ('two','Second')");
 const cfg = await config();
 const env = { ...cfg.env, API_PASSWORD: 'fixture', BASE_URL: 'https://pigeon.example', DB: { prepare: (sql: string) => new Statement(db, sql) } } as unknown as Env;
 function request(body: unknown, method = 'POST') { return new Request('https://pigeon.example/api/v1/browser/push/subscription', { method, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }); }
 async function subscribe(endpoint = subscription.endpoint, feedKeys = ['one']) {
  const response = await handleBrowserPush(request({ subscription: { ...subscription, endpoint }, feedKeys }), env);
  assert.equal(response.status, 201, await response.clone().text()); return await response.json() as { id: string; managementToken: string };
 }
 function insert(id: string, feed = 'one', created = new Date().toISOString()) {
  db.prepare('INSERT INTO items (id, feed_key, subject, html_content, received_at, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, feed, `Private subject ${id}`, '<p>private body</p>', created, created);
 }
 return { db, env, request, subscribe, insert };
}

test('RFC8291 encryption decrypts using independent Node ECDH/HKDF/AES implementation; fresh secrets and bounded size', async () => {
 const message = 'Private article 日本語 🔒';
 const first = await encryptWebPush(subscription.keys.p256dh, subscription.keys.auth, message);
 const second = await encryptWebPush(subscription.keys.p256dh, subscription.keys.auth, message);
 assert.equal(decrypt(first), message); assert.equal(decrypt(second), message); assert.notDeepEqual(first, second);
 assert.ok(!Buffer.from(first).includes(Buffer.from(message)));
 assert.equal(decrypt(await encryptWebPush(subscription.keys.p256dh, subscription.keys.auth, 'x'.repeat(3993))).length, 3993);
 await assert.rejects(encryptWebPush(subscription.keys.p256dh, subscription.keys.auth, 'x'.repeat(3994)));
 await assert.rejects(encryptWebPush(subscription.keys.p256dh, 'AAAA', message));
 first[first.length - 1] ^= 1; assert.throws(() => decrypt(first));
});

test('VAPID ES256 signature verified independently with Node; audience, expiry and contact correct', async () => {
 const cfg = await config(); const now = new Date('2026-10-12T12:00:00Z');
 const authorization = await createVapidAuthorization(subscription.endpoint, cfg.value, now);
 const jwt = authorization.match(/^vapid t=(.+), k=(.+)$/)!;
 assert.equal(jwt[2], cfg.env.VAPID_PUBLIC_KEY);
 const [header, claims, signature] = jwt[1].split('.');
 assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), { typ: 'JWT', alg: 'ES256' });
 assert.deepEqual(JSON.parse(Buffer.from(claims, 'base64url').toString()), { aud: 'https://fcm.googleapis.com', exp: now.getTime() / 1000 + 3600, sub: cfg.env.VAPID_SUBJECT });
 assert.equal(Buffer.from(signature, 'base64url').length, 64);
 const publicJwk = { ...cfg.jwk }; delete publicJwk.d;
 assert.ok(verify('sha256', Buffer.from(`${header}.${claims}`), { key: createPublicKey({ key: publicJwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
});

test('strict endpoint allowlist rejects SSRF, credentials, deceptive suffixes and redirects', () => {
 for (const endpoint of ['https://fcm.googleapis.com/wp/x', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/Qx', 'https://eu.push.apple.com/Qx']) assert.equal(validatePushEndpoint(endpoint), true, endpoint);
 for (const endpoint of ['http://fcm.googleapis.com/wp/x', 'https://fcm.googleapis.com.evil.test/x', 'https://evilpush.apple.com/x', 'https://user:pass@fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'https://fcm.googleapis.com/x#fragment', 'https://127.0.0.1/x', 'https://localhost/x', 'https://fcm.googleapis.com/']) assert.equal(validatePushEndpoint(endpoint), false, endpoint);
});

test('capabilities and subscription routes authenticate before DB; disabled capability needs no storage', async () => {
 const env = { API_PASSWORD: 'fixture' } as Env;
 for (const route of ['capabilities', 'subscription']) assert.equal((await worker.fetch(new Request(`https://pigeon.example/api/v1/browser/push/${route}`), env)).status, 401);
 const response = await handleBrowserPush(new Request('https://pigeon.example/api/v1/browser/push/capabilities'), env);
 assert.deepEqual(await response.json(), { enabled: false, publicKey: null });
 assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('subscriptions opt in lazily, baseline historical articles, validate feeds and require browser ownership', async (t) => {
 const state = await fixture(t); state.insert('old');
 assert.equal(state.db.prepare("SELECT name FROM sqlite_master WHERE name='browser_push_subscriptions'").get(), undefined);
 const own = await state.subscribe();
 assert.equal((await handleBrowserPush(state.request({ subscription, feedKeys: ['missing'] }), state.env)).status, 400);
 assert.equal((await handleBrowserPush(state.request({ subscription, feedKeys: ['one'] }), state.env)).status, 409);
 assert.equal((await handleBrowserPush(state.request({ ...own, managementToken: 'wrong', subscription, feedKeys: [] }, 'PUT'), state.env)).status, 404);
 assert.equal((await handleBrowserPush(state.request({ ...own, subscription, feedKeys: [] }, 'PUT'), state.env)).status, 200);
 assert.equal((state.db.prepare('SELECT feed_keys FROM browser_push_subscriptions').get() as any).feed_keys, '[]');
 await handleBrowserPush(state.request({ ...own, managementToken: 'wrong' }, 'DELETE'), state.env);
 assert.equal((state.db.prepare('SELECT count(*) AS n FROM browser_push_subscriptions').get() as any).n, 1);
 await handleBrowserPush(state.request(own, 'DELETE'), state.env);
 assert.equal((state.db.prepare('SELECT count(*) AS n FROM browser_push_subscriptions').get() as any).n, 0);
});

test('push delivers only latest new unread selected-feed article with encrypted metadata, then never repeats', async (t) => {
 const state = await fixture(t); state.insert('historical'); await state.subscribe();
 state.insert('first'); state.insert('latest'); state.insert('other', 'two');
 let calls = 0;
 const fetcher = (async (input: any, init: any) => {
  calls++; assert.equal(input, subscription.endpoint); assert.equal(init.redirect, 'error'); assert.ok(init.signal);
  const headers = new Headers(init.headers); assert.equal(headers.get('Content-Encoding'), 'aes128gcm');
  assert.match(headers.get('Authorization')!, /^vapid /); assert.equal(headers.get('Cookie'), null);
  assert.equal(headers.get('TTL'), '300');
  assert.deepEqual(JSON.parse(decrypt(init.body)), { title: 'Private feed', body: 'Private subject latest', articleId: '3', feedKey: 'one' });
  return new Response(null, { status: 201 });
 }) as typeof fetch;
 const now = new Date(Date.now() + 120_000);
 await dispatchBrowserPush(state.env, new RefreshQueryBudget(47), fetcher, now); assert.equal(calls, 1);
 // Body updates also create sync changes, but cannot re-notify an already known article.
 state.db.exec("UPDATE items SET html_content='<p>edited</p>' WHERE id='latest'");
 await dispatchBrowserPush(state.env, new RefreshQueryBudget(47), fetcher, new Date(now.getTime() + 120_000)); assert.equal(calls, 1);
});

test('delivery fairness and budgets bound sends; provider expiration deletes only own subscription', async (t) => {
 const state = await fixture(t);
 for (let i = 0; i < 6; i++) await state.subscribe(`https://fcm.googleapis.com/wp/browser-${i}`);
 state.insert('new'); let calls = 0;
 const fetcher = (async () => { calls++; return new Response(null, { status: 201 }); }) as typeof fetch;
 const now = new Date(Date.now() + 120_000);
 await dispatchBrowserPush(state.env, new RefreshQueryBudget(3), fetcher, now); assert.equal(calls, 0);
 await dispatchBrowserPush(state.env, new RefreshQueryBudget(47), fetcher, now); assert.equal(calls, 4);
 await dispatchBrowserPush(state.env, new RefreshQueryBudget(47), fetcher, new Date(now.getTime() + 2 * 3600_000)); assert.equal(calls, 6);
 state.insert('next');
 await dispatchBrowserPush(state.env, new RefreshQueryBudget(6), (async () => new Response(null, { status: 410 })) as typeof fetch, new Date(now.getTime() + 3 * 3600_000));
 assert.equal((state.db.prepare('SELECT COUNT(*) AS n FROM browser_push_subscriptions').get() as any).n, 5);
});

test('no catch-up flood for old inserts, read articles, or empty preferences; provider errors are best effort', async (t) => {
 const state = await fixture(t); await state.subscribe();
 state.insert('old-import', 'one', new Date(Date.now() - 25 * 3600_000).toISOString());
 state.insert('read'); state.db.exec("UPDATE items SET is_read=1 WHERE id='read'");
 let calls = 0; const fetcher = (async () => { calls++; throw new Error('private endpoint failure'); }) as typeof fetch;
 const now = new Date(Date.now() + 120_000);
 await dispatchBrowserPush(state.env, new RefreshQueryBudget(47), fetcher, now); assert.equal(calls, 0);
 state.insert('current');
 await dispatchBrowserPush(state.env, new RefreshQueryBudget(47), fetcher, new Date(now.getTime() + 120_000)); assert.equal(calls, 1);
 await dispatchBrowserPush(state.env, new RefreshQueryBudget(47), fetcher, new Date(now.getTime() + 240_000)); assert.equal(calls, 1);
});

test('bounded registration validates size and key material; cap32 cannot be exceeded and stale slots reclaimed', async (t) => {
 const state = await fixture(t);
 const invalid: unknown[] = [
  { subscription, feedKeys: ['one', 'one'] }, { subscription, feedKeys: Array(101).fill('one') },
  { subscription: { ...subscription, endpoint: 'https://localhost/x' }, feedKeys: ['one'] },
  { subscription: { ...subscription, keys: { ...subscription.keys, p256dh: base64url(new Uint8Array(65).fill(4)) } }, feedKeys: ['one'] },
  { subscription, feedKeys: [], padding: 'x'.repeat(17_000) },
 ];
 for (const body of invalid) assert.equal((await handleBrowserPush(state.request(body), state.env)).status, 400);
 for (let index = 0; index < 32; index++) await state.subscribe(`https://fcm.googleapis.com/wp/cap-${index}`, []);
 assert.equal((await handleBrowserPush(state.request({ subscription, feedKeys: [] }), state.env)).status, 409);
 state.db.exec("UPDATE browser_push_subscriptions SET updated_at='2000-01-01T00:00:00.000Z'");
 await state.subscribe(); assert.equal((state.db.prepare('SELECT COUNT(*) AS n FROM browser_push_subscriptions').get() as any).n, 1);
});

test('capabilities fail closed for malformed or mismatched VAPID key material; public-key response never leaks private JWK', async () => {
 const cfg = await config(); const request = new Request('https://pigeon.example/api/v1/browser/push/capabilities');
 const ready = await handleBrowserPush(request, cfg.env as Env);
 assert.deepEqual(await ready.json(), { enabled: true, publicKey: cfg.env.VAPID_PUBLIC_KEY });
 for (const override of [{ VAPID_PRIVATE_JWK: '{}' }, { VAPID_PUBLIC_KEY: 'AAAA' }, { VAPID_SUBJECT: 'http://bad.example' }, { VAPID_SUBJECT: 'mailto:' }]) {
  assert.deepEqual(await (await handleBrowserPush(request, { ...cfg.env, ...override } as Env)).json(), { enabled: false, publicKey: null });
 }
});

test('concurrent notification scans use atomic claim so a browser receives only one delivery', async (t) => {
 const state = await fixture(t); await state.subscribe(); state.insert('new');
 let calls = 0; const fetcher = (async () => { calls++; return new Response(null, { status: 201 }); }) as typeof fetch;
 const now = new Date(Date.now() + 120_000);
 await Promise.all([dispatchBrowserPush(state.env, new RefreshQueryBudget(47), fetcher, now), dispatchBrowserPush(state.env, new RefreshQueryBudget(47), fetcher, now)]);
 assert.equal(calls, 1);
});
