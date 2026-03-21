import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

import {
	AUTH_STORAGE_KEY,
	applyUnauthorizedState,
	buildArticleListEntries,
	buildFeedViews,
	createContentLoadPlan,
	createLoggedOutSession,
	createSessionFromToken,
	extractAuthToken,
	limitInitialItemIds,
	renderBrowserAppClientScript,
	sortSubscriptionsByTitle,
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

test('sortSubscriptionsByTitle orders subscriptions alphabetically by title', () => {
	assert.deepEqual(
		sortSubscriptionsByTitle([
			{ id: 'feed/3', title: 'zebra' },
			{ id: 'feed/1', title: 'Alpha' },
			{ id: 'feed/2', title: 'mango' },
		]),
		[
			{ id: 'feed/1', title: 'Alpha' },
			{ id: 'feed/2', title: 'mango' },
			{ id: 'feed/3', title: 'zebra' },
		],
	);
});

test('buildFeedViews returns All items, Unread, and sorted single-feed views', () => {
	assert.deepEqual(
		buildFeedViews(
			[
				{ id: 'feed/2', title: 'Bravo' },
				{ id: 'feed/1', title: 'Alpha' },
			],
			[
				{ id: 'feed/2', count: 4 },
				{ id: 'feed/1', count: 1 },
			],
		),
		[
			{
				id: 'all',
				title: 'All items',
				streamId: 'user/-/state/com.google/reading-list',
				unreadCount: 5,
				kind: 'all',
			},
			{
				id: 'unread',
				title: 'Unread',
				streamId: 'user/-/state/com.google/reading-list',
				unreadCount: 5,
				kind: 'unread',
			},
			{
				id: 'feed/1',
				title: 'Alpha',
				streamId: 'feed/1',
				unreadCount: 1,
				kind: 'feed',
			},
			{
				id: 'feed/2',
				title: 'Bravo',
				streamId: 'feed/2',
				unreadCount: 4,
				kind: 'feed',
			},
		],
	);
});

test('limitInitialItemIds caps the first fetch at 50 ids', () => {
	const ids = Array.from({ length: 75 }, (_, index) => String(index + 1));

	assert.deepEqual(limitInitialItemIds(ids), Array.from({ length: 50 }, (_, index) => String(index + 1)));
});

test('createContentLoadPlan loads contents in chunks of 20 without duplicates', () => {
	const itemIds = Array.from({ length: 30 }, (_, index) => String(index + 1));

	assert.deepEqual(
		createContentLoadPlan({
			itemIds,
			loadedItemIds: ['1', '2', '3', '4'],
		}),
		Array.from({ length: 20 }, (_, index) => String(index + 5)),
	);
});

test('createContentLoadPlan prioritizes the selected item and does not duplicate ids', () => {
	assert.deepEqual(
		createContentLoadPlan({
			itemIds: ['1', '2', '3', '4', '5'],
			loadedItemIds: ['2', '4'],
			selectedItemId: '5',
		}),
		['5', '1', '3'],
	);
});

test('buildArticleListEntries only renders previews from already-loaded content', () => {
	assert.deepEqual(
		buildArticleListEntries({
			itemIds: ['loaded-item', 'pending-item'],
			loadedItemsById: {
				'loaded-item': {
					id: 'loaded-item',
					title: 'Loaded title',
					published: 1_742_460_800,
					origin: { title: 'Alpha Feed' },
					summary: { content: 'Loaded preview' },
					content: { content: '<p>Loaded article</p>' },
				},
			},
		}),
		[
			{
				id: 'loaded-item',
				title: 'Loaded title',
				feedTitle: 'Alpha Feed',
				published: 1_742_460_800,
				preview: 'Loaded preview',
				isLoaded: true,
			},
			{
				id: 'pending-item',
				title: 'Loading article…',
				feedTitle: '',
				published: 0,
				preview: '',
				isLoaded: false,
			},
		],
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
	const attributes = new Map<string, string>();
	const dataset: Record<string, string> = {};
	const children: Array<ReturnType<typeof createElement>> = [];
	let ownTextContent = '';
	let innerHtmlValue = '';
	const element = {
		value: initialValue,
		srcdoc: '',
		hidden: false,
		dataset,
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
		appendChild(child: ReturnType<typeof createElement>) {
			children.push(child);
			return child;
		},
		replaceChildren(...newChildren: Array<ReturnType<typeof createElement>>) {
			children.length = 0;
			for (const child of newChildren) {
				children.push(child);
			}
		},
		setAttribute(name: string, value: string) {
			attributes.set(name, value);
			if (name.startsWith('data-')) {
				dataset[name.slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())] = value;
			}
		},
		getAttribute(name: string) {
			return attributes.get(name) ?? null;
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

	Object.defineProperty(element, 'textContent', {
		get() {
			return ownTextContent + children.map((child) => child.textContent).join('');
		},
		set(value: string) {
			ownTextContent = value;
			children.length = 0;
		},
		enumerable: true,
		configurable: true,
	});

	Object.defineProperty(element, 'innerHTML', {
		get() {
			return innerHtmlValue;
		},
		set(value: string) {
			innerHtmlValue = value;
			children.length = 0;
		},
		enumerable: true,
		configurable: true,
	});

	return element;
}

function createDeferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

async function flushBrowserTasks() {
	await Promise.resolve();
	await Promise.resolve();
	await new Promise((resolve) => setTimeout(resolve, 0));
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
		['feeds-status', createElement()],
		['feeds-list', createElement()],
		['articles-status', createElement()],
		['articles-list', createElement()],
		['load-more-button', createElement('', ['hidden'])],
		['reader-title', createElement()],
		['reader-meta', createElement()],
		['reader-frame', createElement()],
		['settings-content', createElement()],
	]);
	const storage = new Map<string, string>();
	const innerHtmlWrites: string[] = [];
	if (options?.storedToken) {
		storage.set(AUTH_STORAGE_KEY, options.storedToken);
	}

	for (const [id, element] of elements) {
		let currentValue = '';
		Object.defineProperty(element, 'innerHTML', {
			get() {
				return currentValue;
			},
			set(value: string) {
				currentValue = value;
				innerHtmlWrites.push(id);
			},
			enumerable: true,
			configurable: true,
		});
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
			createElement() {
				return createElement();
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
		URLSearchParams,
		console,
		fetch: options?.fetchImpl ?? (async () => new Response('Error=BadAuthentication', { status: 401 })),
	};

	vm.runInNewContext(renderBrowserAppClientScript(), context);
	vm.runInNewContext(renderBrowserAppRuntimeScript(), context);
	await flushBrowserTasks();

	return { elements, storage, innerHtmlWrites };
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

test('startup token validation cannot overwrite a newer successful manual login', async () => {
	const startupValidation = createDeferred<Response>();
	const { elements, storage } = await createBrowserHarness({
		storedToken: 'stale-token',
		fetchImpl: async (input, init) => {
			if (input === '/app/status') {
				return startupValidation.promise;
			}

			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				return new Response('SID=pigeon/fresh-token\nLSID=null\nAuth=pigeon/fresh-token', {
					status: 200,
				});
			}

			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});

	await elements.get('login-form')?.dispatch('submit');
	await flushBrowserTasks();

	assert.equal(storage.get(AUTH_STORAGE_KEY), 'fresh-token');
	assert.equal(elements.get('login-screen')?.classList.contains('hidden'), true);
	assert.equal(elements.get('reader-shell')?.classList.contains('hidden'), false);

	startupValidation.resolve(new Response('Unauthorized', { status: 401 }));
	await flushBrowserTasks();

	assert.equal(storage.get(AUTH_STORAGE_KEY), 'fresh-token');
	assert.equal(elements.get('login-screen')?.classList.contains('hidden'), true);
	assert.equal(elements.get('reader-shell')?.classList.contains('hidden'), false);
});

test('startup validation request failure cannot overwrite a newer successful manual login', async () => {
	const startupValidation = createDeferred<Response>();
	const { elements, storage } = await createBrowserHarness({
		storedToken: 'stale-token',
		fetchImpl: async (input, init) => {
			if (input === '/app/status') {
				return startupValidation.promise;
			}

			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				return new Response('SID=pigeon/fresh-token\nLSID=null\nAuth=pigeon/fresh-token', {
					status: 200,
				});
			}

			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});

	await elements.get('login-form')?.dispatch('submit');
	await flushBrowserTasks();

	assert.equal(storage.get(AUTH_STORAGE_KEY), 'fresh-token');
	assert.equal(elements.get('login-screen')?.classList.contains('hidden'), true);
	assert.equal(elements.get('reader-shell')?.classList.contains('hidden'), false);

	startupValidation.reject(new Error('network down'));
	await flushBrowserTasks();

	assert.equal(storage.get(AUTH_STORAGE_KEY), 'fresh-token');
	assert.equal(elements.get('login-screen')?.classList.contains('hidden'), true);
	assert.equal(elements.get('reader-shell')?.classList.contains('hidden'), false);
});

test('runtime script keeps app chrome rendering out of innerHTML and shows the full settings fields', async () => {
	const { elements, innerHtmlWrites } = await createBrowserHarness({
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				return new Response('SID=pigeon/live-token\nLSID=null\nAuth=pigeon/live-token', { status: 200 });
			}

			if (input === '/reader/api/0/subscription/list') {
				return Response.json({
					subscriptions: [
						{ id: 'feed/2', title: 'Bravo', iconUrl: 'https://example.com/bravo.ico' },
						{ id: 'feed/1', title: 'Alpha' },
					],
				});
			}

			if (input === '/reader/api/0/unread-count') {
				return Response.json({
					unreadcounts: [
						{ id: 'feed/2', count: 4 },
						{ id: 'feed/1', count: 1 },
					],
				});
			}

			if (String(input).startsWith('/reader/api/0/stream/items/ids?')) {
				return Response.json({
					itemRefs: [{ id: '101' }, { id: '102' }],
				});
			}

			if (input === '/reader/api/0/stream/items/contents' && init?.method === 'POST') {
				return Response.json({
					items: [
						{
							id: 'tag:google.com,2005:reader/item/0000000000000065',
							title: 'First article',
							published: 1_742_460_800,
							origin: { title: 'Alpha' },
							summary: { content: 'Loaded preview' },
							content: { content: '<p>Body</p>' },
						},
					],
				});
			}

			if (input === '/app/status') {
				return Response.json({
					configuredBaseUrl: 'https://pigeon.example',
					currentOrigin: 'https://pigeon.example',
					healthUrl: 'https://pigeon.example/health',
					schemaVersion: '3',
					feeds: {
						activeCount: 2,
						emailCount: 1,
						rssCount: 1,
						failingRssCount: 1,
						failing: [{ title: 'Bravo', error: 'HTTP 500' }],
					},
					items: {
						totalCount: 12,
						unreadCount: 5,
						starredCount: 2,
						newestAt: '2026-03-20T12:00:00.000Z',
						newestEmailAt: '2026-03-20T11:00:00.000Z',
						newestRssAt: '2026-03-20T10:00:00.000Z',
					},
					rss: {
						latestFetchAttemptAt: '2026-03-20T12:05:00.000Z',
					},
				});
			}

			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});

	await elements.get('login-form')?.dispatch('submit');
	await flushBrowserTasks();
	await flushBrowserTasks();
	await elements.get('settings-button')?.dispatch('click');
	await flushBrowserTasks();
	await flushBrowserTasks();

	assert.deepEqual(
		innerHtmlWrites.filter((id) => ['feeds-list', 'articles-list', 'settings-content'].includes(id)),
		[],
	);
	assert.match(elements.get('feeds-list')?.textContent ?? '', /Alpha/);
	assert.match(elements.get('feeds-list')?.textContent ?? '', /Bravo/);
	assert.match(elements.get('feeds-list')?.textContent ?? '', /4/);
	assert.match(elements.get('settings-content')?.textContent ?? '', /Starred items2/);
	assert.match(elements.get('settings-content')?.textContent ?? '', /Newest email item2026-03-20T11:00:00.000Z/);
	assert.match(elements.get('settings-content')?.textContent ?? '', /Newest RSS item2026-03-20T10:00:00.000Z/);
	assert.match(elements.get('settings-content')?.textContent ?? '', /Failing RSS feed count1/);
});
