import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markNeedsSignIn } from '../src/core/session';
import { MemoryStore, mockFetch } from './helpers/fakes';
import { OPTIONS_STATE_KEYS, optionsState, signIn, signOut, submitSignIn } from '../src/core/sign-in';

function deps(store: MemoryStore, fetch: typeof globalThis.fetch, grant = true) {
	const requested: string[] = [];
	return { requested, deps: { fetch, store, requestHostPermission: async (pattern: string) => { requested.push(pattern); return grant; } } };
}

test('default state: production address, signed out', async () => {
	assert.deepEqual(await optionsState(new MemoryStore()), { origin: 'https://pigeon.hanscho.com', signedIn: false, needsSignIn: false, queued: 0, missingAccess: null });
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
	assert.deepEqual(await optionsState(store), { origin: 'https://pigeon.hanscho.com', signedIn: true, needsSignIn: false, queued: 0, missingAccess: null });
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
	await markNeedsSignIn(store, (await store.get("pigeonAuth")).pigeonAuth as string);
	assert.deepEqual(await optionsState(store), { origin: 'https://pigeon.example.dev', signedIn: false, needsSignIn: true, queued: 0, missingAccess: null });
	await signIn('https://pigeon.example.dev', 'pw', deps(store, mockFetch(ok).fetch).deps);
	assert.equal((await optionsState(store)).needsSignIn, false);
	await signOut(store);
	assert.deepEqual(await optionsState(store), { origin: 'https://pigeon.example.dev', signedIn: false, needsSignIn: false, queued: 0, missingAccess: null });
});

function form() {
	const events: string[] = [];
	return {
		events,
		form: {
			setBusy: (busy: boolean) => events.push(busy ? 'busy' : 'idle'),
			showError: (field: string, message: string) => events.push(`error:${field}:${message}`),
			signedIn: async () => { events.push('signedIn'); },
		},
	};
}

test('the sign-in form is re-enabled and shows the error even when something throws', async () => {
	const store = new MemoryStore();
	store.set = async () => { throw new Error('QUOTA_BYTES quota exceeded'); };
	const { events, form: f } = form();
	const ok = await submitSignIn('pigeon.hanscho.com', 'pw', deps(store, mockFetch(() => new Response('Auth=pigeon/t')).fetch).deps, f);
	assert.equal(ok, false);
	assert.deepEqual(events, ['busy', 'error:general:Sign-in failed: QUOTA_BYTES quota exceeded', 'idle']);
	const rejecting = { ...deps(new MemoryStore(), mockFetch([]).fetch).deps, requestHostPermission: async () => { throw new Error('gesture required'); } };
	const second = form();
	assert.equal(await submitSignIn('pigeon.hanscho.com', 'pw', rejecting, second.form), false);
	assert.deepEqual(second.events.at(-1), 'idle');
	const third = form();
	assert.equal(await submitSignIn('pigeon.hanscho.com', 'pw', deps(new MemoryStore(), mockFetch(() => new Response('Auth=pigeon/t')).fetch).deps, third.form), true);
	assert.deepEqual(third.events, ['busy', 'signedIn', 'idle']);
});

test('the options page re-renders only for the keys it shows', () => {
	assert.deepEqual([...OPTIONS_STATE_KEYS].sort(), ['pigeonAuth', 'pigeonNeedsSignIn', 'pigeonOrigin', 'pigeonPendingSummary']);
});
