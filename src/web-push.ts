/** Opt-in Web Push. No account credentials leave the Worker; article metadata is encrypted. */
import type { Env } from './types';
import type { RefreshQueryBudget } from './rss-fetcher';
import { truncateUtf8 } from './content-size';

const encoder = new TextEncoder();
const MAX_SUBSCRIPTIONS = 32;
const MAX_FEEDS = 100;
const MAX_SENDS = 4;
export const PUSH_SCHEMA = `CREATE TABLE IF NOT EXISTS browser_push_subscriptions (
 id TEXT PRIMARY KEY, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
 management_hash TEXT NOT NULL, feed_keys TEXT NOT NULL, vapid_public TEXT NOT NULL,
 cursor INTEGER NOT NULL, updated_at TEXT NOT NULL, last_attempt_at TEXT NOT NULL
)`;
interface Subscription {
 id: string; endpoint: string; p256dh: string; auth: string; feed_keys: string;
 cursor: number; last_attempt_at: string; updated_at: string;
}
interface VapidConfig { publicKey: string; privateKey: CryptoKey; subject: string; }

export function base64url(bytes: Uint8Array): string {
 return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function unbase64url(value: string): Uint8Array<ArrayBuffer> {
 if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid base64url');
 return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
}
function concat(...arrays: Uint8Array[]): Uint8Array<ArrayBuffer> {
 const result = new Uint8Array(arrays.reduce((sum, array) => sum + array.length, 0));
 let offset = 0; for (const array of arrays) { result.set(array, offset); offset += array.length; } return result;
}
async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array<ArrayBuffer>> {
 const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
 return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8) as ArrayBuffer);
}
/** RFC 8291/8188 single aes128gcm record; fresh ECDH key and salt per message. */
export async function encryptWebPush(p256dh: string, auth: string, plaintext: string): Promise<Uint8Array<ArrayBuffer>> {
 const data = encoder.encode(plaintext);
 if (data.length > 3993) throw new Error('Push payload too large');
 const uaPublic = unbase64url(p256dh); const authSecret = unbase64url(auth);
 if (uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length !== 16) throw new Error('Invalid subscription keys');
 const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
 const sender = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
 const senderPublic = new Uint8Array(await crypto.subtle.exportKey('raw', sender.publicKey) as ArrayBuffer);
 // workers-types currently spells this standard WebCrypto property "$public".
 const agreement = { name: 'ECDH', public: uaKey };
 const shared = new Uint8Array(await crypto.subtle.deriveBits(agreement, sender.privateKey, 256));
 const ikm = await hkdf(shared, authSecret, concat(encoder.encode('WebPush: info\0'), uaPublic, senderPublic), 32);
 const salt = new Uint8Array(16); crypto.getRandomValues(salt);
 const cek = await hkdf(ikm, salt, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
 const nonce = await hkdf(ikm, salt, encoder.encode('Content-Encoding: nonce\0'), 12);
 const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
 const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(data, new Uint8Array([2]))));
 const header = new Uint8Array(21); header.set(salt); new DataView(header.buffer).setUint32(16, 4096); header[20] = 65;
 return concat(header, senderPublic, ciphertext);
}

async function vapidConfig(env: Env): Promise<VapidConfig | null> {
 if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_JWK || !env.VAPID_SUBJECT) return null;
 try {
  const publicBytes = unbase64url(env.VAPID_PUBLIC_KEY);
  const jwk = JSON.parse(env.VAPID_PRIVATE_JWK) as JsonWebKey;
  const subject = new URL(env.VAPID_SUBJECT);
  if (!['mailto:', 'https:'].includes(subject.protocol) || (subject.protocol === 'mailto:' && !subject.pathname) || subject.username || subject.password || publicBytes.length !== 65 || publicBytes[0] !== 4 || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y || !jwk.d) return null;
  if (base64url(concat(new Uint8Array([4]), unbase64url(jwk.x), unbase64url(jwk.y))) !== env.VAPID_PUBLIC_KEY) return null;
  const privateKey = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const verifyKey = await crypto.subtle.importKey('raw', publicBytes, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const probe = encoder.encode('Pigeon VAPID configuration');
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, probe);
  if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifyKey, signature, probe)) return null;
  return { publicKey: env.VAPID_PUBLIC_KEY, privateKey, subject: env.VAPID_SUBJECT };
 } catch { return null; }
}
export async function createVapidAuthorization(endpoint: string, config: VapidConfig, now = new Date()): Promise<string> {
 const header = base64url(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
 const claims = base64url(encoder.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now.getTime() / 1000) + 3600, sub: config.subject })));
 const input = `${header}.${claims}`;
 const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, config.privateKey, encoder.encode(input)));
 return `vapid t=${input}.${base64url(signature)}, k=${config.publicKey}`;
}

/** Exact provider domains only. No arbitrary hosts, ports, credentials, fragments or redirects. */
export function validatePushEndpoint(endpoint: string): boolean {
 try {
  if (endpoint.length > 2048) return false;
  const url = new URL(endpoint);
  return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash && url.pathname !== '/' && (
   url.hostname === 'fcm.googleapis.com' || url.hostname === 'updates.push.services.mozilla.com' ||
   url.hostname === 'push.services.mozilla.com' || url.hostname === 'web.push.apple.com' ||
   /^[a-z0-9-]+\.push\.apple\.com$/.test(url.hostname));
 } catch { return false; }
}
function json(body: unknown, status = 200): Response {
 return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}
async function managementHash(token: string): Promise<string> {
 return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(token))));
}
async function readBody(request: Request): Promise<Record<string, unknown> | null> {
 if (!request.body) return null;
 const reader = request.body.getReader(); let bytes = 0; const chunks: Uint8Array[] = [];
 try {
  while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.length;
   if (bytes > 16_384) { await reader.cancel(); return null; } chunks.push(part.value); }
  const body: unknown = JSON.parse(new TextDecoder().decode(concat(...chunks)));
  return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
 } catch { return null; } finally { reader.releaseLock(); }
}

/** Caller must have passed requireApiAuth. Management tokens additionally bind changes to one browser. */
export async function handleBrowserPush(request: Request, env: Env): Promise<Response> {
 const config = await vapidConfig(env);
 if (new URL(request.url).pathname.endsWith('/capabilities')) {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  return json({ enabled: !!config, publicKey: config?.publicKey ?? null });
 }
 if (!['POST', 'PUT', 'DELETE'].includes(request.method)) return json({ error: 'Method not allowed' }, 405);
 const body = await readBody(request);
 if (!body) return json({ error: 'Invalid or oversized JSON' }, 400);
 if (request.method === 'DELETE') {
  if (typeof body.id !== 'string' || typeof body.managementToken !== 'string' || body.managementToken.length > 128) return json({ error: 'Subscription credentials required' }, 400);
  // Opt-in table creation is harmless for idempotent removal on a fresh deployment.
  await env.DB.prepare(PUSH_SCHEMA).run();
  await env.DB.prepare('DELETE FROM browser_push_subscriptions WHERE id = ? AND management_hash = ?')
   .bind(body.id, await managementHash(body.managementToken)).run();
  return json({ deleted: true });
 }
 if (!config) return json({ error: 'Background push is not configured' }, 503);
 const subscription = body.subscription as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | undefined;
 const feedKeys = body.feedKeys;
 if (!subscription || typeof subscription.endpoint !== 'string' || !validatePushEndpoint(subscription.endpoint) ||
  typeof subscription.keys?.p256dh !== 'string' || typeof subscription.keys?.auth !== 'string' ||
  !Array.isArray(feedKeys) || feedKeys.length > MAX_FEEDS || feedKeys.some(key => typeof key !== 'string' || key.length > 200) || new Set(feedKeys).size !== feedKeys.length) return json({ error: 'Invalid subscription or feed selection' }, 400);
 const { p256dh, auth } = subscription.keys;
 try {
  if (p256dh.length > 100 || auth.length > 32 || unbase64url(auth).length !== 16 || unbase64url(p256dh).length !== 65 || unbase64url(p256dh)[0] !== 4) throw new Error();
  await crypto.subtle.importKey('raw', unbase64url(p256dh), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
 } catch { return json({ error: 'Invalid subscription keys' }, 400); }
 const found = await env.DB.prepare('SELECT COUNT(*) AS count FROM feeds WHERE is_active = 1 AND feed_key IN (SELECT value FROM json_each(?))').bind(JSON.stringify(feedKeys)).first<{ count: number }>();
 if (found?.count !== feedKeys.length) return json({ error: 'Unknown feed' }, 400);
 await env.DB.prepare(PUSH_SCHEMA).run();
 const now = new Date().toISOString();
 const head = await env.DB.prepare('SELECT COALESCE(MAX(sequence), 0) AS head FROM sync_changes').first<{ head: number }>();
 if (request.method === 'PUT') {
  if (typeof body.id !== 'string' || typeof body.managementToken !== 'string' || body.managementToken.length > 128) return json({ error: 'Subscription credentials required' }, 400);
  try {
   const result = await env.DB.prepare(`UPDATE browser_push_subscriptions SET endpoint = ?, p256dh = ?, auth = ?, feed_keys = ?, vapid_public = ?, cursor = ?, updated_at = ?
    WHERE id = ? AND management_hash = ?`).bind(subscription.endpoint, p256dh, auth, JSON.stringify(feedKeys), config.publicKey, head?.head ?? 0, now, body.id, await managementHash(body.managementToken)).run();
   return result.meta.changes ? json({ id: body.id }) : json({ error: 'Subscription not found' }, 404);
  } catch (error) {
   if (error instanceof Error && /UNIQUE constraint failed: browser_push_subscriptions.endpoint/.test(error.message)) return json({ error: 'Endpoint already registered' }, 409);
   throw error;
  }
 }
 const id = crypto.randomUUID(); const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
 await env.DB.prepare('DELETE FROM browser_push_subscriptions WHERE updated_at < ?').bind(new Date(Date.now() - 90 * 86400_000).toISOString()).run();
 const result = await env.DB.prepare(`INSERT OR IGNORE INTO browser_push_subscriptions
  (id, endpoint, p256dh, auth, management_hash, feed_keys, vapid_public, cursor, updated_at, last_attempt_at)
  SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM browser_push_subscriptions) < ?`)
  .bind(id, subscription.endpoint, p256dh, auth, await managementHash(token), JSON.stringify(feedKeys), config.publicKey, head?.head ?? 0, now, now, MAX_SUBSCRIPTIONS).run();
 return result.meta.changes ? json({ id, managementToken: token }, 201) : json({ error: 'Subscription already exists or browser limit reached' }, 409);
}

/** Best effort, at most one latest article per browser/tick; refresh always has first use of D1 budget. */
export async function dispatchBrowserPush(env: Env, budget: Pick<RefreshQueryBudget, 'reserve'>, fetcher: typeof fetch = fetch, now = new Date()): Promise<void> {
 const config = await vapidConfig(env); if (!config || !budget.reserve(1)) return;
 // Never migrate on cron. A missing table means no browser has opted in yet.
 const table = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'browser_push_subscriptions'").first();
 if (!table || !budget.reserve(2)) return;
 const head = (await env.DB.prepare('SELECT COALESCE(MAX(sequence), 0) AS head FROM sync_changes').first<{ head: number }>())?.head ?? 0;
 const { results } = await env.DB.prepare(`SELECT id, endpoint, p256dh, auth, feed_keys, cursor, last_attempt_at, updated_at FROM browser_push_subscriptions
  WHERE vapid_public = ? AND updated_at >= ? AND last_attempt_at < ? ORDER BY last_attempt_at, id LIMIT ?`)
  .bind(config.publicKey, new Date(now.getTime() - 90 * 86400_000).toISOString(), new Date(now.getTime() - 60_000).toISOString(), MAX_SENDS).all<Subscription>();
 for (const subscription of results) {
  if (!budget.reserve(3)) break; // article lookup + atomic claim + expiry renewal or invalid-subscription deletion
  const item = await env.DB.prepare(`SELECT i.rowid AS row_id, i.subject, f.feed_key, COALESCE(f.custom_title, f.display_name) AS feed_title
   FROM sync_changes c JOIN items i ON i.id = c.entity_id JOIN feeds f ON f.feed_key = i.feed_key
   WHERE c.entity_type = 'article' AND c.operation = 'upsert' AND c.sequence > ? AND c.sequence <= ?
    AND c.sequence = (SELECT MIN(first.sequence) FROM sync_changes first WHERE first.entity_type = 'article' AND first.entity_id = c.entity_id)
    AND datetime(i.created_at) >= datetime(?) AND f.is_active = 1 AND i.is_read = 0
    AND i.feed_key IN (SELECT value FROM json_each(?)) ORDER BY c.sequence DESC LIMIT 1`)
   .bind(subscription.cursor, head, new Date(now.getTime() - 24 * 3600_000).toISOString(), subscription.feed_keys).first<{ row_id: number; subject: string; feed_key: string; feed_title: string }>();
  // Advance before delivery: provider/network failures cannot create repeat or catch-up floods.
  const claim = await env.DB.prepare(`UPDATE browser_push_subscriptions SET cursor = ?, last_attempt_at = ?
   WHERE id = ? AND cursor = ? AND last_attempt_at = ? AND updated_at = ? AND feed_keys = ? AND endpoint = ?`)
   .bind(head, now.toISOString(), subscription.id, subscription.cursor, subscription.last_attempt_at, subscription.updated_at, subscription.feed_keys, subscription.endpoint).run();
  if (!claim.meta.changes || !item) continue;
  try {
   if (!validatePushEndpoint(subscription.endpoint)) throw new Error('Invalid saved endpoint');
   const payload = JSON.stringify({ title: truncateUtf8(item.feed_title, 256), body: truncateUtf8(item.subject, 768), articleId: String(item.row_id), feedKey: item.feed_key });
   const body = await encryptWebPush(subscription.p256dh, subscription.auth, payload);
   const response = await fetcher(subscription.endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { Authorization: await createVapidAuthorization(subscription.endpoint, config, now), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '300', Urgency: 'normal' }, body });
   if (response.status === 404 || response.status === 410) await env.DB.prepare('DELETE FROM browser_push_subscriptions WHERE id = ?').bind(subscription.id).run();
   // Accepted delivery is activity: renew the 90-day expiry unless settings changed meanwhile.
   else if (response.ok) await env.DB.prepare('UPDATE browser_push_subscriptions SET updated_at = ? WHERE id = ? AND updated_at = ?')
    .bind(now.toISOString(), subscription.id, subscription.updated_at).run();
   else console.warn('[Web Push] Provider rejected delivery', response.status);
   await response.body?.cancel();
  } catch { console.warn('[Web Push] Delivery failed'); } // never log endpoint, keys or private article metadata
 }
}
