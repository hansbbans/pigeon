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
	selectArticleHeroImageUrl,
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
				heroImageUrl: null,
				isLoaded: true,
			},
			{
				id: 'pending-item',
				title: 'Loading article…',
				feedTitle: '',
				published: 0,
				preview: '',
				heroImageUrl: null,
				isLoaded: false,
			},
		],
	);
});

test('selectArticleHeroImageUrl returns the first usable absolute image URL from loaded article HTML', () => {
	assert.equal(
		selectArticleHeroImageUrl(
			'<figure><img src="cid:hero" /><img src="/relative.jpg" /><img src="https://cdn.example/pixel.gif" width="1" height="1" /><img src="https://cdn.example/hero.jpg" /></figure>',
		),
		'https://cdn.example/hero.jpg',
	);
	assert.equal(selectArticleHeroImageUrl('<p>No hero here.</p>'), null);
});

test('selectArticleHeroImageUrl decodes HTML-escaped query strings and accepts protocol-relative URLs', () => {
	assert.equal(
		selectArticleHeroImageUrl('<img src="//cdn.example/hero.jpg?utm=reader&amp;id=42" />'),
		'//cdn.example/hero.jpg?utm=reader&id=42',
	);
});

test('selectArticleHeroImageUrl skips obviously hidden tracker-style images and continues to a real image', () => {
	assert.equal(
		selectArticleHeroImageUrl(
			'<img src="https://cdn.example/tracker.gif" style="display:none" /><img src="https://cdn.example/hero.jpg" />',
		),
		'https://cdn.example/hero.jpg',
	);
	assert.equal(
		selectArticleHeroImageUrl(
			'<img src="https://cdn.example/tracker.gif" style="visibility:hidden;opacity:0" /><img src="//cdn.example/hero-2.jpg" />',
		),
		'//cdn.example/hero-2.jpg',
	);
});

test('selectArticleHeroImageUrl ignores malformed oversized numeric entities instead of throwing', () => {
	assert.equal(
		selectArticleHeroImageUrl('<img src="https://cdn.example/hero.jpg?broken=&#1114112;&amp;ok=1" />'),
		'https://cdn.example/hero.jpg?broken=&#1114112;&ok=1',
	);
	assert.equal(
		selectArticleHeroImageUrl('<img src="https://cdn.example/hero.jpg?broken=&#9999999999;" />'),
		'https://cdn.example/hero.jpg?broken=&#9999999999;',
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
		children,
		toggleCalls: [] as Array<{ name: string; force: boolean | undefined }>,
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
			toggle(name: string, force?: boolean) {
				element.toggleCalls.push({ name, force });
				if (force === true) {
					classes.add(name);
					return true;
				}
				if (force === false) {
					classes.delete(name);
					return false;
				}
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

async function waitForBrowserCondition(check: () => boolean, attempts = 20) {
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		if (check()) {
			return;
		}
		await flushBrowserTasks();
	}
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
		['views-list', createElement()],
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

function findListButtonByViewId(
	listElement: ReturnType<typeof createElement> | undefined,
	viewId: string,
) {
	for (const listItem of listElement?.children ?? []) {
		for (const child of listItem.children) {
			if (child.dataset.viewId === viewId) {
				return child;
			}
		}
	}
	return undefined;
}

function findListButtonByItemId(
	listElement: ReturnType<typeof createElement> | undefined,
	itemId: string,
) {
	for (const listItem of listElement?.children ?? []) {
		for (const child of listItem.children) {
			if (child.dataset.itemId === itemId) {
				return child;
			}
		}
	}
	return undefined;
}

function findDescendantByClass(
	element: ReturnType<typeof createElement> | undefined,
	className: string,
): ReturnType<typeof createElement> | undefined {
	if (!element) {
		return undefined;
	}

	if (element.classList.contains(className)) {
		return element;
	}

	for (const child of element.children) {
		const match = findDescendantByClass(child, className);
		if (match) {
			return match;
		}
	}

	return undefined;
}

function findDescendantByAttribute(
	element: ReturnType<typeof createElement> | undefined,
	name: string,
	value?: string,
): ReturnType<typeof createElement> | undefined {
	if (!element) {
		return undefined;
	}

	const attributeValue = element.getAttribute(name);
	if (attributeValue !== null && (value === undefined || attributeValue === value)) {
		return element;
	}

	for (const child of element.children) {
		const match = findDescendantByAttribute(child, name, value);
		if (match) {
			return match;
		}
	}

	return undefined;
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
		innerHtmlWrites.filter((id) => ['views-list', 'feeds-list', 'articles-list', 'settings-content'].includes(id)),
		[],
	);
	assert.match(elements.get('views-list')?.textContent ?? '', /All items/);
	assert.match(elements.get('views-list')?.textContent ?? '', /Unread/);
	assert.doesNotMatch(elements.get('views-list')?.textContent ?? '', /Alpha/);
	assert.doesNotMatch(elements.get('views-list')?.textContent ?? '', /Bravo/);
	assert.match(elements.get('feeds-list')?.textContent ?? '', /Alpha/);
	assert.match(elements.get('feeds-list')?.textContent ?? '', /Bravo/);
	assert.match(elements.get('feeds-list')?.textContent ?? '', /4/);
	assert.doesNotMatch(elements.get('feeds-list')?.textContent ?? '', /All items/);
	assert.doesNotMatch(elements.get('feeds-list')?.textContent ?? '', /Unread/);
	assert.match(elements.get('settings-content')?.textContent ?? '', /Starred items2/);
	assert.match(elements.get('settings-content')?.textContent ?? '', /Newest email item2026-03-20T11:00:00.000Z/);
	assert.match(elements.get('settings-content')?.textContent ?? '', /Newest RSS item2026-03-20T10:00:00.000Z/);
	assert.match(elements.get('settings-content')?.textContent ?? '', /Failing RSS feed count1/);
});

test('runtime script renders hero-image cards only for loaded articles whose content includes one', async () => {
	const { elements } = await createBrowserHarness({
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				return new Response('SID=pigeon/live-token\nLSID=null\nAuth=pigeon/live-token', { status: 200 });
			}

			if (input === '/reader/api/0/subscription/list') {
				return Response.json({
					subscriptions: [{ id: 'feed/1', title: 'Alpha' }],
				});
			}

			if (input === '/reader/api/0/unread-count') {
				return Response.json({
					unreadcounts: [{ id: 'feed/1', count: 2 }],
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
							title: 'Hero story',
							published: 1_742_460_800,
							origin: { title: 'Alpha' },
							summary: { content: 'Hero preview' },
							content: { content: '<p>Body</p><img src="https://cdn.example/hero.jpg" />' },
						},
						{
							id: 'tag:google.com,2005:reader/item/0000000000000066',
							title: 'Text story',
							published: 1_742_460_860,
							origin: { title: 'Alpha' },
							summary: { content: 'Text preview' },
							content: { content: '<p>Body only</p>' },
						},
					],
				});
			}

			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});

	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => Boolean(findListButtonByItemId(elements.get('articles-list'), '102')));

	const heroCard = findListButtonByItemId(elements.get('articles-list'), '101');
	const textOnlyCard = findListButtonByItemId(elements.get('articles-list'), '102');

	assert.equal(
		findDescendantByAttribute(heroCard, 'data-card-hero', 'true')?.getAttribute('src'),
		'https://cdn.example/hero.jpg',
	);
	assert.equal(findDescendantByAttribute(textOnlyCard, 'data-card-hero', 'true'), undefined);
});

test('runtime script falls back to a text-first card layout and keeps preview metadata visible when no image is available', async () => {
	const { elements } = await createBrowserHarness({
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				return new Response('SID=pigeon/live-token\nLSID=null\nAuth=pigeon/live-token', { status: 200 });
			}

			if (input === '/reader/api/0/subscription/list') {
				return Response.json({
					subscriptions: [{ id: 'feed/1', title: 'Alpha' }],
				});
			}

			if (input === '/reader/api/0/unread-count') {
				return Response.json({
					unreadcounts: [{ id: 'feed/1', count: 1 }],
				});
			}

			if (String(input).startsWith('/reader/api/0/stream/items/ids?')) {
				return Response.json({
					itemRefs: [{ id: '201' }],
				});
			}

			if (input === '/reader/api/0/stream/items/contents' && init?.method === 'POST') {
				return Response.json({
					items: [
						{
							id: 'tag:google.com,2005:reader/item/00000000000000c9',
							title: 'Text-first article',
							published: 1_742_460_800,
							origin: { title: 'Alpha' },
							summary: { content: 'Preview stays visible' },
							content: { content: '<p>No image here.</p>' },
						},
					],
				});
			}

			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});

	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => Boolean(findListButtonByItemId(elements.get('articles-list'), '201')));

	const articleCard = findListButtonByItemId(elements.get('articles-list'), '201');

	assert.ok(articleCard?.classList.contains('is-text-only'));
	assert.equal(findDescendantByAttribute(articleCard, 'data-card-hero', 'true'), undefined);
	assert.match(findDescendantByClass(articleCard, 'article-title')?.textContent ?? '', /Text-first article/);
	assert.match(findDescendantByClass(articleCard, 'article-preview')?.textContent ?? '', /Preview stays visible/);
	assert.match(findDescendantByClass(articleCard, 'article-meta')?.textContent ?? '', /Alpha/);
	assert.match(findDescendantByClass(articleCard, 'article-meta')?.textContent ?? '', /\d{1,2}:\d{2}/);
});

test('runtime script keeps real views and real feeds separated with intact counts', async () => {
	const { elements } = await createBrowserHarness({
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				return new Response('SID=pigeon/live-token\nLSID=null\nAuth=pigeon/live-token', { status: 200 });
			}

			if (input === '/reader/api/0/subscription/list') {
				return Response.json({
					subscriptions: [
						{ id: 'feed/2', title: 'Bravo' },
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
					itemRefs: [{ id: '101' }],
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

			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});

	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => Boolean(findListButtonByViewId(elements.get('feeds-list'), 'feed/2')));

	assert.match(findListButtonByViewId(elements.get('views-list'), 'all')?.textContent ?? '', /All items/);
	assert.match(findListButtonByViewId(elements.get('views-list'), 'all')?.textContent ?? '', /5/);
	assert.match(findListButtonByViewId(elements.get('views-list'), 'unread')?.textContent ?? '', /Unread/);
	assert.match(findListButtonByViewId(elements.get('views-list'), 'unread')?.textContent ?? '', /5/);
	assert.equal(findListButtonByViewId(elements.get('views-list'), 'feed/1'), undefined);
	assert.equal(findListButtonByViewId(elements.get('views-list'), 'feed/2'), undefined);
	assert.match(findListButtonByViewId(elements.get('feeds-list'), 'feed/1')?.textContent ?? '', /Alpha/);
	assert.match(findListButtonByViewId(elements.get('feeds-list'), 'feed/1')?.textContent ?? '', /1/);
	assert.match(findListButtonByViewId(elements.get('feeds-list'), 'feed/2')?.textContent ?? '', /Bravo/);
	assert.match(findListButtonByViewId(elements.get('feeds-list'), 'feed/2')?.textContent ?? '', /4/);
	assert.equal(findListButtonByViewId(elements.get('feeds-list'), 'all'), undefined);
	assert.equal(findListButtonByViewId(elements.get('feeds-list'), 'unread'), undefined);
});

test('stale status responses do not overwrite logout state or suppress a later settings fetch', async () => {
	const firstStatus = createDeferred<Response>();
	const statusCalls: string[] = [];
	let loginCount = 0;
	const { elements } = await createBrowserHarness({
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				loginCount += 1;
				const token = loginCount === 1 ? 'first-token' : 'second-token';
				return new Response(`SID=pigeon/${token}\nLSID=null\nAuth=pigeon/${token}`, { status: 200 });
			}

			if (input === '/reader/api/0/subscription/list') {
				return Response.json({ subscriptions: [] });
			}

			if (input === '/reader/api/0/unread-count') {
				return Response.json({ unreadcounts: [] });
			}

			if (String(input).startsWith('/reader/api/0/stream/items/ids?')) {
				return Response.json({ itemRefs: [] });
			}

			if (input === '/app/status') {
				statusCalls.push(`status-${statusCalls.length + 1}`);
				if (statusCalls.length === 1) {
					return firstStatus.promise;
				}
				return Response.json({
					configuredBaseUrl: 'https://pigeon.example',
					currentOrigin: 'https://pigeon.example',
					healthUrl: 'https://pigeon.example/health',
					schemaVersion: '3',
					feeds: { activeCount: 0, emailCount: 0, rssCount: 0, failingRssCount: 0, failing: [] },
					items: {
						totalCount: 0,
						unreadCount: 0,
						starredCount: 0,
						newestAt: null,
						newestEmailAt: null,
						newestRssAt: null,
					},
					rss: { latestFetchAttemptAt: null },
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

	await elements.get('logout-button')?.dispatch('click');
	firstStatus.resolve(
		Response.json({
			configuredBaseUrl: 'https://stale.example',
			currentOrigin: 'https://stale.example',
			healthUrl: 'https://stale.example/health',
			schemaVersion: '3',
			feeds: { activeCount: 9, emailCount: 9, rssCount: 9, failingRssCount: 9, failing: [] },
			items: {
				totalCount: 9,
				unreadCount: 9,
				starredCount: 9,
				newestAt: '2026-03-20T12:00:00.000Z',
				newestEmailAt: '2026-03-20T12:00:00.000Z',
				newestRssAt: '2026-03-20T12:00:00.000Z',
			},
			rss: { latestFetchAttemptAt: '2026-03-20T12:00:00.000Z' },
		}),
	);
	await flushBrowserTasks();
	await flushBrowserTasks();

	assert.equal(elements.get('settings-content')?.textContent, 'Open settings to load status.');

	await elements.get('login-form')?.dispatch('submit');
	await flushBrowserTasks();
	await flushBrowserTasks();
	await elements.get('settings-button')?.dispatch('click');
	await flushBrowserTasks();
	await flushBrowserTasks();

	assert.deepEqual(statusCalls, ['status-1', 'status-2']);
	assert.match(elements.get('settings-content')?.textContent ?? '', /Configured BASE_URLhttps:\/\/pigeon\.example/);
});

test('load-more does not duplicate an in-flight chunk and advances after the first chunk settles', async () => {
	const firstContentResponse = createDeferred<Response>();
	const contentRequests: string[][] = [];
	const { elements } = await createBrowserHarness({
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				return new Response('SID=pigeon/live-token\nLSID=null\nAuth=pigeon/live-token', { status: 200 });
			}

			if (input === '/reader/api/0/subscription/list') {
				return Response.json({
					subscriptions: [{ id: 'feed/1', title: 'Alpha' }],
				});
			}

			if (input === '/reader/api/0/unread-count') {
				return Response.json({
					unreadcounts: [{ id: 'feed/1', count: 25 }],
				});
			}

			if (String(input).startsWith('/reader/api/0/stream/items/ids?')) {
				return Response.json({
					itemRefs: Array.from({ length: 25 }, (_, index) => ({ id: String(index + 1) })),
				});
			}

			if (input === '/reader/api/0/stream/items/contents' && init?.method === 'POST') {
				const ids = Array.from((init.body as FormData).values()).map(String);
				contentRequests.push(ids);
				if (contentRequests.length === 1) {
					return firstContentResponse.promise;
				}
				return Response.json({
					items: ids.map((id) => ({
						id: `tag:google.com,2005:reader/item/${Number(id).toString(16).padStart(16, '0')}`,
						title: `Article ${id}`,
						published: 1_742_460_800,
						origin: { title: 'Alpha' },
						summary: { content: `Preview ${id}` },
						content: { content: `<p>Body ${id}</p>` },
					})),
				});
			}

			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});

	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => contentRequests.length === 1);
	const loadMoreToggleCalls = () =>
		elements.get('load-more-button')?.toggleCalls.filter((call) => call.name === 'hidden').map((call) => call.force) ?? [];

	assert.ok(loadMoreToggleCalls().includes(false));
	assert.equal(elements.get('load-more-button')?.disabled, true);
	assert.deepEqual(contentRequests, [Array.from({ length: 20 }, (_, index) => String(index + 1))]);

	await elements.get('load-more-button')?.dispatch('click');
	await flushBrowserTasks();
	await flushBrowserTasks();

	assert.deepEqual(contentRequests, [Array.from({ length: 20 }, (_, index) => String(index + 1))]);

	firstContentResponse.resolve(
		Response.json({
			items: Array.from({ length: 20 }, (_, index) => {
				const id = String(index + 1);
				return {
					id: `tag:google.com,2005:reader/item/${Number(id).toString(16).padStart(16, '0')}`,
					title: `Article ${id}`,
					published: 1_742_460_800,
					origin: { title: 'Alpha' },
					summary: { content: `Preview ${id}` },
					content: { content: `<p>Body ${id}</p>` },
				};
			}),
		}),
	);
	await waitForBrowserCondition(() => elements.get('load-more-button')?.disabled === false);

	await elements.get('load-more-button')?.dispatch('click');
	await waitForBrowserCondition(() => contentRequests.length === 2);

	assert.ok(loadMoreToggleCalls().filter((force) => force === false).length >= 2);
	assert.deepEqual(contentRequests[1], ['21', '22', '23', '24', '25']);
});

test('switching views during an in-flight content load still fetches bodies for the new view', async () => {
	const allItemsContentResponse = createDeferred<Response>();
	const contentRequests: string[][] = [];
	const { elements } = await createBrowserHarness({
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				return new Response('SID=pigeon/live-token\nLSID=null\nAuth=pigeon/live-token', { status: 200 });
			}

			if (input === '/reader/api/0/subscription/list') {
				return Response.json({
					subscriptions: [
						{ id: 'feed/1', title: 'Alpha' },
						{ id: 'feed/2', title: 'Bravo' },
					],
				});
			}

			if (input === '/reader/api/0/unread-count') {
				return Response.json({
					unreadcounts: [
						{ id: 'feed/1', count: 1 },
						{ id: 'feed/2', count: 1 },
					],
				});
			}

			if (String(input).startsWith('/reader/api/0/stream/items/ids?')) {
				const url = new URL(`https://pigeon.example${String(input)}`);
				const streamId = url.searchParams.get('s');
				if (streamId === 'feed/2') {
					return Response.json({
						itemRefs: [{ id: '301' }],
					});
				}
				return Response.json({
					itemRefs: [{ id: '101' }, { id: '102' }],
				});
			}

			if (input === '/reader/api/0/stream/items/contents' && init?.method === 'POST') {
				const ids = Array.from((init.body as FormData).values()).map(String);
				contentRequests.push(ids);
				if (contentRequests.length === 1) {
					return allItemsContentResponse.promise;
				}
				return Response.json({
					items: ids.map((id) => ({
						id: `tag:google.com,2005:reader/item/${Number(id).toString(16).padStart(16, '0')}`,
						title: `Article ${id}`,
						published: 1_742_460_800,
						origin: { title: id === '301' ? 'Bravo' : 'Alpha' },
						summary: { content: `Preview ${id}` },
						content: { content: `<p>Body ${id}</p>` },
					})),
				});
			}

			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});

	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => contentRequests.length === 1);

	const feedsList = elements.get('feeds-list');
	const bravoFeedButton = findListButtonByViewId(feedsList, 'feed/2');
	await bravoFeedButton?.dispatch('click');
	await waitForBrowserCondition(() => contentRequests.length === 2);

	assert.deepEqual(contentRequests[0], ['101', '102']);
	assert.deepEqual(contentRequests[1], ['301']);
	assert.match(elements.get('reader-title')?.textContent ?? '', /Article 301/);
	assert.match(elements.get('reader-meta')?.textContent ?? '', /Bravo/);

	allItemsContentResponse.resolve(
		Response.json({
			items: [
				{
					id: 'tag:google.com,2005:reader/item/0000000000000065',
					title: 'Article 101',
					published: 1_742_460_800,
					origin: { title: 'Alpha' },
					summary: { content: 'Preview 101' },
					content: { content: '<p>Body 101</p>' },
				},
			],
		}),
	);
	await flushBrowserTasks();
	await flushBrowserTasks();

	assert.match(elements.get('articles-list')?.textContent ?? '', /Article 301/);
	assert.doesNotMatch(elements.get('reader-title')?.textContent ?? '', /Article 101/);
});

test('runtime script keeps the active article title and metadata outside the iframe while the iframe holds the full body', async () => {
	const articleBody = '<article><p>Full body copy that belongs in the frame.</p><p>Second paragraph.</p></article>';
	const { elements } = await createBrowserHarness({
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				return new Response('SID=pigeon/live-token\nLSID=null\nAuth=pigeon/live-token', { status: 200 });
			}

			if (input === '/reader/api/0/subscription/list') {
				return Response.json({
					subscriptions: [{ id: 'feed/1', title: 'Alpha' }],
				});
			}

			if (input === '/reader/api/0/unread-count') {
				return Response.json({
					unreadcounts: [{ id: 'feed/1', count: 1 }],
				});
			}

			if (String(input).startsWith('/reader/api/0/stream/items/ids?')) {
				return Response.json({
					itemRefs: [{ id: '101' }],
				});
			}

			if (input === '/reader/api/0/stream/items/contents' && init?.method === 'POST') {
				return Response.json({
					items: [
						{
							id: 'tag:google.com,2005:reader/item/0000000000000065',
							title: 'Reader polish story',
							published: 1_742_460_800,
							origin: { title: 'Alpha' },
							summary: { content: 'Short summary' },
							content: { content: articleBody },
						},
					],
				});
			}

			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});

	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => (elements.get('reader-frame')?.srcdoc ?? '') === articleBody);

	assert.match(elements.get('reader-title')?.textContent ?? '', /Reader polish story/);
	assert.match(elements.get('reader-meta')?.textContent ?? '', /Alpha/);
	assert.match(elements.get('reader-meta')?.textContent ?? '', /2025/);
	assert.equal(elements.get('reader-frame')?.srcdoc, articleBody);
	assert.doesNotMatch(elements.get('reader-title')?.textContent ?? '', /Full body copy that belongs in the frame/);
	assert.doesNotMatch(elements.get('reader-meta')?.textContent ?? '', /Full body copy that belongs in the frame/);
});
