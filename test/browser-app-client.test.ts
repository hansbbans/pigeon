import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

import {
	AUTH_STORAGE_KEY,
	applyUnauthorizedState,
	createLoggedOutSession,
	createSessionFromToken,
	extractAuthToken,
	renderBrowserAppClientScript,
} from '../src/browser-app-client';
import { renderBrowserAppRuntimeScript } from '../src/browser-app';

test('extractAuthToken parses the Auth token from a ClientLogin response', () => {
	assert.equal(
		extractAuthToken('SID=pigeon/abc123\nLSID=null\nAuth=pigeon/abc123'),
		'abc123',
	);
});

test('extractAuthToken rejects malformed ClientLogin responses', () => {
	assert.equal(extractAuthToken('SID=pigeon/abc123\nLSID=null'), null);
	assert.equal(extractAuthToken(''), null);
});

test('createLoggedOutSession clears auth state for logout', () => {
	assert.deepEqual(createLoggedOutSession(), {
		status: 'logged_out',
		token: null,
	});
});

test('applyUnauthorizedState returns the login state on 401', () => {
	assert.deepEqual(
		applyUnauthorizedState(createSessionFromToken('secret-token')),
		createLoggedOutSession(),
	);
});

test('renderBrowserAppClientScript exposes the shared auth helpers for the shell', () => {
	const script = renderBrowserAppClientScript();

	assert.match(script, /window\.__PIGEON_BROWSER_CLIENT__/);
	assert.match(script, /extractAuthToken/);
	assert.match(script, new RegExp(AUTH_STORAGE_KEY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

function createElement(initialValue = '', initialClasses: string[] = []) {
	const handlers = new Map<string, (event: { preventDefault(): void }) => unknown>();
	const classes = new Set(initialClasses);
	return {
		value: initialValue,
		textContent: '',
		hidden: false,
		classList: {
			add(...names: string[]) {
				for (const name of names) {
					classes.add(name);
				}
			},
			remove(...names: string[]) {
				for (const name of names) {
					classes.delete(name);
				}
			},
			toggle(name: string) {
				if (classes.has(name)) {
					classes.delete(name);
					return false;
				}
				classes.add(name);
				return true;
			},
			contains(name: string) {
				return classes.has(name);
			},
		},
		addEventListener(type: string, handler: (event: { preventDefault(): void }) => unknown) {
			handlers.set(type, handler);
		},
		dispatch(type: string) {
			const handler = handlers.get(type);
			if (handler) {
				return handler({ preventDefault() {} });
			}
			return undefined;
		},
	};
}

async function createBrowserHarness(options?: {
	storedToken?: string | null;
	fetchImpl?: (input: string, init?: { method?: string; body?: FormData; headers?: Record<string, string> }) => Promise<Response>;
}) {
	const elements = new Map<string, ReturnType<typeof createElement>>([
		['login-screen', createElement()],
		['reader-shell', createElement('', ['hidden'])],
		['login-form', createElement()],
		['login-error', createElement()],
		['password-input', createElement('secret-password')],
		['logout-button', createElement()],
		['settings-button', createElement()],
		['settings-panel', createElement('', ['hidden'])],
		['close-settings-button', createElement()],
	]);
	const storage = new Map<string, string>();
	if (options?.storedToken) {
		storage.set(AUTH_STORAGE_KEY, options.storedToken);
	}

	const context = {
		window: {
			__PIGEON_CONFIG__: { baseUrl: 'https://pigeon.example' },
			sessionStorage: {
				getItem(key: string) {
					return storage.get(key) ?? null;
				},
				setItem(key: string, value: string) {
					storage.set(key, value);
				},
				removeItem(key: string) {
					storage.delete(key);
				},
			},
			__PIGEON_BROWSER_CLIENT__: undefined as unknown,
		},
		document: {
			documentElement: {
				setAttribute() {},
			},
			getElementById(id: string) {
				const element = elements.get(id);
				if (!element) {
					throw new Error(`Unknown element: ${id}`);
				}
				return element;
			},
		},
		FormData,
		Response,
		console,
		fetch: options?.fetchImpl ?? (async () => new Response('Error=BadAuthentication', { status: 401 })),
	};

	vm.runInNewContext(renderBrowserAppClientScript(), context);
	vm.runInNewContext(renderBrowserAppRuntimeScript(), context);
	await Promise.resolve();
	await Promise.resolve();
	await new Promise((resolve) => setTimeout(resolve, 0));

	return { elements, storage };
}

test('runtime script shows a user-facing error when login request fails', async () => {
	const { elements } = await createBrowserHarness({
		fetchImpl: async () => {
			throw new Error('network down');
		},
	});

	await elements.get('login-form')?.dispatch('submit');

	assert.equal(elements.get('login-error')?.textContent, 'Could not reach the server.');
});

test('runtime script validates a stored token before restoring the logged-in shell', async () => {
	const fetchCalls: string[] = [];
	const { elements, storage } = await createBrowserHarness({
		storedToken: 'stale-token',
		fetchImpl: async (input, init) => {
			fetchCalls.push(`${init?.method ?? 'GET'} ${input}`);
			return new Response('Unauthorized', { status: 401 });
		},
	});

	assert.deepEqual(fetchCalls, ['GET /app/status']);
	assert.equal(storage.has(AUTH_STORAGE_KEY), false);
	assert.equal(elements.get('login-screen')?.classList.contains('hidden'), false);
	assert.equal(elements.get('reader-shell')?.classList.contains('hidden'), true);
});
