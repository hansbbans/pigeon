import assert from 'node:assert/strict';
import { test } from 'node:test';
import { optionsState, signIn, signOut } from '../src/core/sign-in';
import { markNeedsSignIn } from '../src/core/session';
import { MemoryStore, mockFetch } from './helpers/fakes';

function deps(store: MemoryStore, fetch: typeof globalThis.fetch, grant = true) {
	const requested: string[] = [];
	return { requested, deps: { fetch, store, requestHostPermission: async (pattern: string) => { requested.push(pattern); return grant; } } };
}

test('default state: production address, signed out', async () => {
	assert.deepEqual(await optionsState(new MemoryStore()), { origin: 'https://pigeon.hanscho.com', signedIn: false, needsSignIn: false, queued: 0 });
});

test('sign-in stores the token and the origin, never the password', async () => {
	const store = new MemoryStore();
	const { fetch, requests } = mockFetch(() => new Response('SID=pigeon/t\nLSID=null\nAuth=pigeon/t'));
	const { deps: d, requested } = deps(store, fetch);
	assert.deepEqual(await signIn('pigeon.hanscho.com/', 'hunter2', d), { ok: true, origin: 'https://pigeon.hanscho.com' });
	assert.deepEqual(requested, ['https://pigeon.hanscho.com/*']);
	assert.equal(requests[0].url, 'https://pigeon.hanscho.com/accounts/ClientLogin');
	assert.deepEqual(Object.fromEntries(store.data), { pigeonOrigin: 'https://pigeon.hanscho.com', pigeonAuth: 'pigeon/t', pigeonNeedsSignIn: false });
	assert.ok(!JSON.stringify([...store.data]).includes('hunter2'));
	assert.deepEqual(await optionsState(store), { origin: 'https://pigeon.hanscho.com', signedIn: true, needsSignIn: false, queued: 0 });
});

test('a custom address asks for its host permission; refusing stops before the password is sent', async () => {
	const store = new MemoryStore();
	const { fetch, requests } = mockFetch([]);
	const { deps: d, requested } = deps(store, fetch, false);
	const result = await signIn('http://localhost:8787', 'pw', d);
	assert.equal(result.ok, false);
	assert.equal(!result.ok && result.field, 'url');
	assert.deepEqual(requested, ['http://localhost/*']);
	assert.equal(requests.length, 0);
	assert.equal(store.data.size, 0);
});

test('bad address, empty password and wrong password report the right field', async () => {
	const store = new MemoryStore();
	const bad = await signIn('http://example.com', 'pw', deps(store, mockFetch([]).fetch).deps);
	assert.equal(!bad.ok && bad.field, 'url');
	const empty = await signIn('pigeon.hanscho.com', '', deps(store, mockFetch([]).fetch).deps);
	assert.equal(!empty.ok && empty.field, 'password');
	const wrong = await signIn('pigeon.hanscho.com', 'nope', deps(store, mockFetch(() => new Response('Error=BadAuthentication', { status: 401 })).fetch).deps);
	assert.deepEqual(wrong, { ok: false, field: 'password', message: 'Incorrect password.' });
	const offline = await signIn('pigeon.hanscho.com', 'pw', deps(store, mockFetch(() => 'network-error').fetch).deps);
	assert.equal(!offline.ok && offline.field, 'general');
	assert.equal(store.data.size, 0);
});

test('a 401 shows the re-sign-in notice; signing in again clears it; sign-out keeps the address', async () => {
	const store = new MemoryStore();
	const ok = () => new Response('Auth=pigeon/t2');
	await signIn('https://pigeon.example.dev', 'pw', deps(store, mockFetch(ok).fetch).deps);
	await markNeedsSignIn(store);
	assert.deepEqual(await optionsState(store), { origin: 'https://pigeon.example.dev', signedIn: false, needsSignIn: true, queued: 0 });
	await signIn('https://pigeon.example.dev', 'pw', deps(store, mockFetch(ok).fetch).deps);
	assert.equal((await optionsState(store)).needsSignIn, false);
	await signOut(store);
	assert.deepEqual(await optionsState(store), { origin: 'https://pigeon.example.dev', signedIn: false, needsSignIn: false, queued: 0 });
});
