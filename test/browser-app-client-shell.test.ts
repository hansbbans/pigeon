import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	AUTH_STORAGE_KEY,
	THEME_STORAGE_KEY,
	createArticleFrameDocument,
	getLocalDayBounds,
	getLocalDayRangeBounds,
} from '../src/browser-app-client';
import {
	createBrowserHarness,
	createDeferred,
	createElement,
	createStatefulArticleBrowser,
	findDescendantByAttribute,
	findDescendantByClass,
	findFolderToggleButton,
	findListButtonByItemId,
	findListButtonByViewId,
	finishArticleMutation,
	flushBrowserTasks,
	renderedArticleIds,
	waitForBrowserCondition,
} from './helpers/browser-app-client-harness';

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

test('a server error while restoring the session keeps the saved token', async () => {
	const { elements, storage } = await createBrowserHarness({
		storedToken: 'valid-token',
		fetchImpl: async (input) => {
			if (input === '/app/status') return new Response('Database migration failed', { status: 503 });
			throw new Error(`Unexpected fetch: ${input}`);
		},
	});
	await flushBrowserTasks();

	// The token may still be good, so a reload can retry; only a 401 proves it is not.
	assert.equal(storage.get(AUTH_STORAGE_KEY), 'valid-token');
	assert.equal(elements.get('login-screen')?.classList.contains('hidden'), false);
	assert.equal(elements.get('login-error')?.textContent, 'Could not restore session.');
});

test('a 403 or 404 while restoring the session rejects the saved token like a 401', async () => {
	for (const status of [403, 404]) {
		const { elements, storage } = await createBrowserHarness({
			storedToken: 'rejected-token',
			fetchImpl: async () => new Response('No', { status }),
		});
		await flushBrowserTasks();
		assert.equal(storage.has(AUTH_STORAGE_KEY), false, String(status));
		assert.equal(elements.get('login-screen')?.classList.contains('hidden'), false, String(status));
	}
});

test('clear saved session cancels a pending startup validation and returns focus to the password field', async () => {
	const startupValidation = createDeferred<Response>();
	const { elements, storage, getActiveElement } = await createBrowserHarness({
		storedToken: 'stale-token',
		fetchImpl: async (input) => {
			if (input === '/app/status') {
				return startupValidation.promise;
			}

			throw new Error(`Unexpected fetch: GET ${input}`);
		},
	});

	await elements.get('clear-session-button')?.dispatch('click');

	assert.equal(storage.has(AUTH_STORAGE_KEY), false);
	assert.equal(elements.get('login-screen')?.classList.contains('hidden'), false);
	assert.equal(elements.get('reader-shell')?.classList.contains('hidden'), true);
	assert.equal(elements.get('login-error')?.textContent, 'Saved session cleared. Sign in again.');
	assert.equal(getActiveElement(), elements.get('password-input'));

	startupValidation.resolve(new Response('OK', { status: 200 }));
	await flushBrowserTasks();

	assert.equal(storage.has(AUTH_STORAGE_KEY), false);
	assert.equal(elements.get('login-screen')?.classList.contains('hidden'), false);
	assert.equal(elements.get('reader-shell')?.classList.contains('hidden'), true);
});

test('sign out remains available after an authenticated feed-loading error', async () => {
	const { elements, storage } = await createBrowserHarness({
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				return new Response('SID=pigeon/live-token\nLSID=null\nAuth=pigeon/live-token', { status: 200 });
			}

			if (input === '/reader/api/0/subscription/list') {
				throw new Error('feed service down');
			}

			if (input === '/reader/api/0/unread-count') {
				return Response.json({ unreadcounts: [] });
			}

			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});

	await elements.get('login-form')?.dispatch('submit');
	await flushBrowserTasks();

	assert.equal(storage.get(AUTH_STORAGE_KEY), 'live-token');
	assert.equal(elements.get('reader-shell')?.classList.contains('hidden'), false);
	assert.equal(elements.get('feeds-status')?.textContent, 'Could not load feeds.');

	await elements.get('logout-button')?.dispatch('click');

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
		innerHtmlWrites.filter((id) =>
			['views-list', 'folders-list', 'feeds-list', 'articles-list', 'settings-content'].includes(id),
		),
		[],
	);
	assert.match(elements.get('views-list')?.textContent ?? '', /All items/);
	assert.match(elements.get('views-list')?.textContent ?? '', /Unread/);
	assert.match(elements.get('views-list')?.textContent ?? '', /Today/);
	assert.match(elements.get('views-list')?.textContent ?? '', /Recently read/);
	assert.doesNotMatch(elements.get('views-list')?.textContent ?? '', /Alpha/);
	assert.doesNotMatch(elements.get('views-list')?.textContent ?? '', /Bravo/);
	assert.equal(elements.get('folders-list')?.textContent ?? '', '');
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

test('runtime script defaults to light mode, toggles dark mode, and restores the saved preference', async () => {
	const { elements, localStorageState, documentElementAttributes } = await createBrowserHarness();

	assert.equal(documentElementAttributes.get('data-theme'), 'light');
	assert.equal(elements.get('theme-toggle-button')?.textContent, 'Dark mode: Off');
	assert.equal(elements.get('theme-toggle-button')?.getAttribute('aria-pressed'), 'false');
	assert.equal(elements.get('reader-frame')?.srcdoc, createArticleFrameDocument(''));

	await elements.get('theme-toggle-button')?.dispatch('click');

	assert.equal(documentElementAttributes.get('data-theme'), 'dark');
	assert.equal(elements.get('theme-toggle-button')?.textContent, 'Dark mode: On');
	assert.equal(elements.get('theme-toggle-button')?.getAttribute('aria-pressed'), 'true');
	assert.equal(localStorageState.get(THEME_STORAGE_KEY), 'dark');
	assert.equal(elements.get('reader-frame')?.srcdoc, createArticleFrameDocument('', 'dark'));

	const restored = await createBrowserHarness({ storedTheme: 'dark' });
	assert.equal(restored.documentElementAttributes.get('data-theme'), 'dark');
	assert.equal(restored.elements.get('theme-toggle-button')?.textContent, 'Dark mode: On');
	assert.equal(restored.elements.get('theme-toggle-button')?.getAttribute('aria-pressed'), 'true');
	assert.equal(restored.elements.get('reader-frame')?.srcdoc, createArticleFrameDocument('', 'dark'));
});

test('runtime script toggles and restores title-only article list mode', async () => {
	const { elements, localStorageState } = await createBrowserHarness({
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
					itemRefs: [{ id: '301' }],
				});
			}

			if (input === '/reader/api/0/stream/items/contents' && init?.method === 'POST') {
				return Response.json({
					items: [
						{
							id: 'tag:google.com,2005:reader/item/000000000000012d',
							title: 'Title-only article',
							published: 1_742_460_800,
							origin: { title: 'Alpha' },
							summary: { content: 'This preview should disappear.' },
							content: { content: '<p>Body</p><img src="https://cdn.example/hidden.jpg" />' },
						},
					],
				});
			}

			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});

	assert.equal(elements.get('article-list-mode-button')?.getAttribute('aria-pressed'), 'false');

	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() =>
		Boolean(findDescendantByClass(findListButtonByItemId(elements.get('articles-list'), '301'), 'article-preview')),
	);

	await elements.get('article-list-mode-button')?.dispatch('click');
	const titleOnlyCard = findListButtonByItemId(elements.get('articles-list'), '301');

	assert.equal(elements.get('article-list-mode-button')?.getAttribute('aria-pressed'), 'true');
	assert.equal(elements.get('article-list-mode-button')?.getAttribute('aria-pressed'), 'true');
	assert.equal(localStorageState.get('pigeon.browser.article-list-mode'), 'titles');
	assert.ok(titleOnlyCard?.classList.contains('is-text-only'));
	assert.match(findDescendantByClass(titleOnlyCard, 'article-title')?.textContent ?? '', /Title-only article/);
	assert.equal(findDescendantByClass(titleOnlyCard, 'article-preview'), undefined);
	assert.equal(findDescendantByClass(titleOnlyCard, 'article-meta'), undefined);
	assert.equal(findDescendantByAttribute(titleOnlyCard, 'data-card-hero', 'true'), undefined);

	await elements.get('article-list-mode-button')?.dispatch('click');
	const previewCard = findListButtonByItemId(elements.get('articles-list'), '301');

	assert.equal(elements.get('article-list-mode-button')?.getAttribute('aria-pressed'), 'false');
	assert.equal(localStorageState.get('pigeon.browser.article-list-mode'), 'preview');
	assert.match(findDescendantByClass(previewCard, 'article-preview')?.textContent ?? '', /This preview should disappear/);
	assert.match(findDescendantByClass(previewCard, 'article-meta')?.textContent ?? '', /Alpha/);
	assert.equal(
		findDescendantByAttribute(previewCard, 'data-card-hero', 'true')?.getAttribute('src'),
		'https://cdn.example/hidden.jpg',
	);

	const restored = await createBrowserHarness({ storedArticleListMode: 'titles' });
	assert.equal(restored.elements.get('article-list-mode-button')?.getAttribute('aria-pressed'), 'true');
	assert.equal(restored.elements.get('article-list-mode-button')?.getAttribute('aria-pressed'), 'true');
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
	await waitForBrowserCondition(() =>
		findDescendantByAttribute(findListButtonByItemId(elements.get('articles-list'), '101'), 'data-card-hero', 'true')?.getAttribute('src') ===
		'https://cdn.example/hero.jpg',
	);

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
	assert.match(findDescendantByClass(articleCard, 'article-time')?.textContent ?? '', /\S/);
	assert.match(findDescendantByClass(articleCard, 'article-meta')?.getAttribute('title') ?? '', /\d{1,2}:\d{2}/);
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
	assert.match(findListButtonByViewId(elements.get('views-list'), 'today')?.textContent ?? '', /Today/);
	assert.match(findListButtonByViewId(elements.get('views-list'), 'recent')?.textContent ?? '', /Recently read/);
	assert.equal(findListButtonByViewId(elements.get('views-list'), 'feed/1'), undefined);
	assert.equal(findListButtonByViewId(elements.get('views-list'), 'feed/2'), undefined);
	assert.equal(findListButtonByViewId(elements.get('folders-list'), 'feed/1'), undefined);
	assert.equal(findListButtonByViewId(elements.get('folders-list'), 'feed/2'), undefined);
	assert.match(findListButtonByViewId(elements.get('feeds-list'), 'feed/1')?.textContent ?? '', /Alpha/);
	assert.match(findListButtonByViewId(elements.get('feeds-list'), 'feed/1')?.textContent ?? '', /1/);
	assert.match(findListButtonByViewId(elements.get('feeds-list'), 'feed/2')?.textContent ?? '', /Bravo/);
	assert.match(findListButtonByViewId(elements.get('feeds-list'), 'feed/2')?.textContent ?? '', /4/);
	assert.equal(findListButtonByViewId(elements.get('feeds-list'), 'all'), undefined);
	assert.equal(findListButtonByViewId(elements.get('feeds-list'), 'unread'), undefined);
});

test('runtime Today view filters received timestamps in the local day and stops at the older page', async () => {
	const now = new Date(2026, 2, 20, 12, 0, 0, 0).getTime();
	const bounds = getLocalDayBounds(new Date(now));
	const contentFor = (id: string, title: string, published: number) => ({
		id: `tag:google.com,2005:reader/item/${Number(id).toString(16).padStart(16, '0')}`,
		title,
		published,
		origin: { title: 'Alpha' },
		summary: { content: `${title} preview` },
		content: { content: `<p>${title} body</p>` },
	});
	const contentById = {
		'1': contentFor('1', 'Previous-day article', bounds.startSeconds - 1),
		'2': contentFor('2', 'At-midnight article', bounds.startSeconds),
		'3': contentFor('3', 'Same-day article', bounds.endSeconds - 1),
		'4': contentFor('4', 'Next-day article', bounds.endSeconds),
	};
	const idRequests: Array<string | null> = [];
	const { elements } = await createBrowserHarness({
		now,
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				return new Response('SID=pigeon/live-token\nLSID=null\nAuth=pigeon/live-token', { status: 200 });
			}

			if (input === '/reader/api/0/subscription/list') {
				return Response.json({ subscriptions: [{ id: 'feed/1', title: 'Alpha' }] });
			}

			if (input === '/reader/api/0/unread-count') {
				return Response.json({ unreadcounts: [{ id: 'feed/1', count: 1 }] });
			}

			if (String(input).startsWith('/reader/api/0/stream/items/ids?')) {
				const url = new URL(`https://pigeon.example${String(input)}`);
				const continuation = url.searchParams.get('c');
				idRequests.push(continuation);
				return continuation
					? Response.json({ itemRefs: [{ id: '1' }] })
					: Response.json({
							itemRefs: [{ id: '4' }, { id: '3' }, { id: '2' }],
							continuation: 'older-page',
						});
			}

			if (input === '/reader/api/0/stream/items/contents' && init?.method === 'POST') {
				const ids = [...(init.body?.getAll('i') ?? [])].map(String);
				return Response.json({ items: ids.map((id) => contentById[id as keyof typeof contentById]) });
			}

			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});

	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => Boolean(findListButtonByViewId(elements.get('views-list'), 'today')));

	await findListButtonByViewId(elements.get('views-list'), 'today')?.dispatch('click');
	await waitForBrowserCondition(
		() =>
			(elements.get('articles-heading')?.textContent ?? '') === 'Today' &&
			elements.get('articles-list')?.children.length === 2,
	);

	assert.deepEqual(idRequests, [null, null, 'older-page']);
	assert.equal(elements.get('articles-status')?.textContent, '2 articles');
	assert.equal(findListButtonByItemId(elements.get('articles-list'), '1'), undefined);
	assert.ok(findListButtonByItemId(elements.get('articles-list'), '2'));
	assert.ok(findListButtonByItemId(elements.get('articles-list'), '3'));
	assert.equal(findListButtonByItemId(elements.get('articles-list'), '4'), undefined);
	assert.equal(elements.get('reader-title')?.textContent, 'Same-day article');

	await findListButtonByItemId(elements.get('articles-list'), '2')?.dispatch('click');
	assert.equal(elements.get('reader-title')?.textContent, 'At-midnight article');
});

test('Last 7 Days view requests since/before for seven local days and lists newest first', async () => {
	const now = new Date(2026, 10, 3, 12, 0, 0, 0).getTime();
	const week = getLocalDayRangeBounds(now, 7);
	const contentFor = (id: string, published: number) => ({
		id: `tag:google.com,2005:reader/item/${Number(id).toString(16).padStart(16, '0')}`,
		title: `Story ${id}`, published, origin: { title: 'Alpha', streamId: 'feed/1' },
		summary: { content: `Preview ${id}` }, content: { content: `<p>Body ${id}</p>` },
	});
	const contentById: Record<string, ReturnType<typeof contentFor>> = {
		'1': contentFor('1', week.startSeconds),
		'2': contentFor('2', week.startSeconds + 3 * 86_400),
		'3': contentFor('3', week.endSeconds - 1),
	};
	const articleRequests: URL[] = [];
	const countRequests: URL[] = [];
	const { elements } = await createBrowserHarness({
		now,
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin') return new Response('SID=pigeon/live-token\nLSID=null\nAuth=pigeon/live-token');
			if (input === '/reader/api/0/subscription/list') return Response.json({ subscriptions: [{ id: 'feed/1', title: 'Alpha' }] });
			if (input === '/reader/api/0/unread-count') return Response.json({ unreadcounts: [{ id: 'feed/1', count: 3 }] });
			const url = new URL(`https://pigeon.example${input}`);
			if (url.pathname === '/api/v1/browser/articles/count') {
				countRequests.push(url);
				return Response.json({ count: url.searchParams.get('since') === week.start.toISOString() ? 7 : 2 });
			}
			if (url.pathname === '/api/v1/browser/articles') {
				articleRequests.push(url);
				return Response.json({ itemIds: ['3', '2', '1'], continuation: null, hasMore: false, sort: 'newest' });
			}
			if (url.pathname === '/reader/api/0/stream/items/ids') return Response.json({ itemRefs: [] });
			if (input === '/reader/api/0/stream/items/contents' && init?.method === 'POST') {
				return Response.json({ items: (init.body?.getAll('i') ?? []).map(String).map((id) => contentById[id]).filter(Boolean) });
			}
			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});

	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => (findListButtonByViewId(elements.get('views-list'), 'last-7-days')?.textContent ?? '').includes('7'));
	const viewIds = elements.get('views-list')!.children.map((row) => row.children[0]?.dataset.viewId);
	assert.equal(viewIds[viewIds.indexOf('today') + 1], 'last-7-days');
	assert.match(findListButtonByViewId(elements.get('views-list'), 'last-7-days')?.textContent ?? '', /Last 7 Days/);
	const weekCount = countRequests.find((url) => url.searchParams.get('since') === week.start.toISOString());
	assert.ok(weekCount, 'the Last 7 Days count asks for its own window');
	assert.equal(weekCount.searchParams.get('before'), week.end.toISOString());
	assert.equal(weekCount.searchParams.get('stream'), 'all');
	assert.equal(weekCount.searchParams.get('filter'), 'unread');

	await findListButtonByViewId(elements.get('views-list'), 'last-7-days')?.dispatch('click');
	await waitForBrowserCondition(() => renderedArticleIds({ elements } as any).length === 3);
	const request = articleRequests.at(-1)!;
	assert.equal(request.searchParams.get('stream'), 'user/-/state/com.google/reading-list');
	assert.equal(request.searchParams.get('since'), week.start.toISOString());
	assert.equal(request.searchParams.get('before'), week.end.toISOString());
	assert.equal(request.searchParams.get('sort'), 'newest');
	assert.equal(request.searchParams.get('filter'), 'all');
	assert.deepEqual(renderedArticleIds({ elements } as any), ['3', '2', '1']);
	assert.equal(elements.get('articles-heading')?.textContent, 'Last 7 Days');
	assert.equal(elements.get('sidebar-current-meta')?.textContent, 'Received in the last 7 days');
	await waitForBrowserCondition(() => elements.get('reader-title')?.textContent === 'Story 3');
	// Mark all follows the loaded list, as in Today.
	assert.equal(elements.get('mark-all-as-read-button')?.disabled, false);
});

test('runtime script hides all-read feeds when the unread filter is active', async () => {
	const { elements } = await createBrowserHarness({
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				return new Response('SID=pigeon/live-token\nLSID=null\nAuth=pigeon/live-token', { status: 200 });
			}

			if (input === '/reader/api/0/subscription/list') {
				return Response.json({
					subscriptions: [
						{ id: 'feed/1', title: 'Read Inbox' },
						{ id: 'feed/2', title: 'Unread Inbox' },
						{
							id: 'feed/3',
							title: 'Read Folder Feed',
							categories: [{ id: 'user/-/label/Newsletters', label: 'Newsletters' }],
						},
						{
							id: 'feed/4',
							title: 'Unread Folder Feed',
							categories: [{ id: 'user/-/label/Newsletters', label: 'Newsletters' }],
						},
						{
							id: 'feed/5',
							title: 'Empty Folder Feed',
							categories: [{ id: 'user/-/label/Read Only', label: 'Read Only' }],
						},
					],
				});
			}

			if (input === '/reader/api/0/unread-count') {
				return Response.json({
					unreadcounts: [
						{ id: 'feed/1', count: 0 },
						{ id: 'feed/2', count: 2 },
						{ id: 'feed/3', count: 0 },
						{ id: 'feed/4', count: 3 },
						{ id: 'feed/5', count: 0 },
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
							title: 'Unread article',
							published: 1_742_460_800,
							origin: { title: 'Unread Inbox' },
							summary: { content: 'Unread preview' },
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

	assert.match(findListButtonByViewId(elements.get('feeds-list'), 'feed/1')?.textContent ?? '', /Read Inbox/);
	assert.match(findListButtonByViewId(elements.get('feeds-list'), 'feed/1')?.textContent ?? '', /0/);
	assert.match(findListButtonByViewId(elements.get('feeds-list'), 'feed/2')?.textContent ?? '', /Unread Inbox/);
	assert.match(findListButtonByViewId(elements.get('feeds-list'), 'feed/2')?.textContent ?? '', /2/);
	assert.match(findListButtonByViewId(elements.get('folders-list'), 'user/-/label/Newsletters')?.textContent ?? '', /Newsletters/);
	assert.match(findListButtonByViewId(elements.get('folders-list'), 'user/-/label/Read Only')?.textContent ?? '', /Read Only/);

	await findFolderToggleButton(elements.get('folders-list'), 'user/-/label/Newsletters')?.dispatch('click');
	await waitForBrowserCondition(() =>
		Boolean(findListButtonByViewId(elements.get('folders-list'), 'feed/3')) &&
		Boolean(findListButtonByViewId(elements.get('folders-list'), 'feed/4')),
	);

	await findListButtonByViewId(elements.get('views-list'), 'unread')?.dispatch('click');
	await waitForBrowserCondition(() => (elements.get('articles-heading')?.textContent ?? '') === 'Unread');

	assert.equal(findListButtonByViewId(elements.get('feeds-list'), 'feed/1'), undefined);
	assert.match(findListButtonByViewId(elements.get('feeds-list'), 'feed/2')?.textContent ?? '', /Unread Inbox/);
	assert.equal(findListButtonByViewId(elements.get('folders-list'), 'feed/3'), undefined);
	assert.match(findListButtonByViewId(elements.get('folders-list'), 'feed/4')?.textContent ?? '', /Unread Folder Feed/);
	assert.match(elements.get('feeds-status')?.textContent ?? '', /Uncategorized feeds/);
});

test('runtime unread filtering hides empty folders and restores the full library after view transitions', async () => {
	const { elements } = await createBrowserHarness({
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				return new Response('SID=pigeon/live-token\nLSID=null\nAuth=pigeon/live-token', { status: 200 });
			}

			if (input === '/reader/api/0/subscription/list') {
				return Response.json({
					subscriptions: [
						{ id: 'feed/1', title: 'Read Inbox' },
						{ id: 'feed/2', title: 'Unread Inbox' },
						{
							id: 'feed/3',
							title: 'Read Folder Feed',
							categories: [{ id: 'user/-/label/Newsletters', label: 'Newsletters' }],
						},
						{
							id: 'feed/4',
							title: 'Unread Folder Feed',
							categories: [{ id: 'user/-/label/Newsletters', label: 'Newsletters' }],
						},
						{
							id: 'feed/5',
							title: 'Empty Folder Feed',
							categories: [{ id: 'user/-/label/Read Only', label: 'Read Only' }],
						},
					],
				});
			}

			if (input === '/reader/api/0/unread-count') {
				return Response.json({
					unreadcounts: [
						{ id: 'feed/1', count: 0 },
						{ id: 'feed/2', count: 2 },
						{ id: 'feed/3', count: 0 },
						{ id: 'feed/4', count: 3 },
						{ id: 'feed/5', count: 0 },
					],
				});
			}

			if (String(input).startsWith('/reader/api/0/stream/items/ids?')) {
				return Response.json({ itemRefs: [] });
			}

			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});

	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => Boolean(findListButtonByViewId(elements.get('feeds-list'), 'feed/2')));

	assert.match(findListButtonByViewId(elements.get('folders-list'), 'user/-/label/Newsletters')?.textContent ?? '', /Newsletters/);
	assert.match(findListButtonByViewId(elements.get('folders-list'), 'user/-/label/Read Only')?.textContent ?? '', /Read Only/);
	await findFolderToggleButton(elements.get('folders-list'), 'user/-/label/Newsletters')?.dispatch('click');
	await waitForBrowserCondition(() => Boolean(findListButtonByViewId(elements.get('folders-list'), 'feed/4')));

	await findListButtonByViewId(elements.get('views-list'), 'unread')?.dispatch('click');
	await waitForBrowserCondition(() => (elements.get('articles-heading')?.textContent ?? '') === 'Unread');
	assert.equal(findListButtonByViewId(elements.get('feeds-list'), 'feed/1'), undefined);
	assert.equal(findListButtonByViewId(elements.get('folders-list'), 'user/-/label/Read Only'), undefined);
	assert.equal(findListButtonByViewId(elements.get('folders-list'), 'feed/3'), undefined);
	assert.ok(findListButtonByViewId(elements.get('feeds-list'), 'feed/2'));
	assert.ok(findListButtonByViewId(elements.get('folders-list'), 'feed/4'));

	await findListButtonByViewId(elements.get('folders-list'), 'user/-/label/Newsletters')?.dispatch('click');
	await waitForBrowserCondition(() => (elements.get('articles-heading')?.textContent ?? '') === 'Newsletters');
	assert.ok(findListButtonByViewId(elements.get('feeds-list'), 'feed/1'));
	assert.ok(findListButtonByViewId(elements.get('folders-list'), 'user/-/label/Read Only'));
	assert.ok(findListButtonByViewId(elements.get('folders-list'), 'feed/3'));

	await findListButtonByViewId(elements.get('views-list'), 'unread')?.dispatch('click');
	await waitForBrowserCondition(() => (elements.get('articles-heading')?.textContent ?? '') === 'Unread');
	assert.equal(findListButtonByViewId(elements.get('feeds-list'), 'feed/1'), undefined);
	assert.equal(findListButtonByViewId(elements.get('folders-list'), 'user/-/label/Read Only'), undefined);

	await findListButtonByViewId(elements.get('views-list'), 'all')?.dispatch('click');
	await waitForBrowserCondition(() => (elements.get('articles-heading')?.textContent ?? '') === 'All items');
	assert.ok(findListButtonByViewId(elements.get('feeds-list'), 'feed/1'));
	assert.ok(findListButtonByViewId(elements.get('folders-list'), 'user/-/label/Read Only'));

	await findListButtonByViewId(elements.get('views-list'), 'unread')?.dispatch('click');
	await waitForBrowserCondition(() => (elements.get('articles-heading')?.textContent ?? '') === 'Unread');
	assert.equal(findListButtonByViewId(elements.get('feeds-list'), 'feed/1'), undefined);
	await findListButtonByViewId(elements.get('views-list'), 'recent')?.dispatch('click');
	await waitForBrowserCondition(() => (elements.get('articles-heading')?.textContent ?? '') === 'Recently read');
	assert.ok(findListButtonByViewId(elements.get('feeds-list'), 'feed/1'));
	assert.ok(findListButtonByViewId(elements.get('folders-list'), 'user/-/label/Read Only'));

	await findListButtonByViewId(elements.get('views-list'), 'unread')?.dispatch('click');
	await waitForBrowserCondition(() => (elements.get('articles-heading')?.textContent ?? '') === 'Unread');
	assert.equal(findListButtonByViewId(elements.get('feeds-list'), 'feed/1'), undefined);
	await findListButtonByViewId(elements.get('feeds-list'), 'feed/2')?.dispatch('click');
	await waitForBrowserCondition(() => (elements.get('articles-heading')?.textContent ?? '') === 'Unread Inbox');
	assert.ok(findListButtonByViewId(elements.get('feeds-list'), 'feed/1'));
	assert.ok(findListButtonByViewId(elements.get('folders-list'), 'user/-/label/Read Only'));
});

test('runtime unread filtering renders empty folder and feed states when every count is zero', async () => {
	const { elements } = await createBrowserHarness({
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				return new Response('SID=pigeon/live-token\nLSID=null\nAuth=pigeon/live-token', { status: 200 });
			}

			if (input === '/reader/api/0/subscription/list') {
				return Response.json({
					subscriptions: [
						{ id: 'feed/1', title: 'Read Inbox' },
						{
							id: 'feed/2',
							title: 'Read Folder Feed',
							categories: [{ id: 'user/-/label/Read Only', label: 'Read Only' }],
						},
					],
				});
			}

			if (input === '/reader/api/0/unread-count') {
				return Response.json({ unreadcounts: [{ id: 'feed/1', count: 0 }, { id: 'feed/2', count: 0 }] });
			}

			if (String(input).startsWith('/reader/api/0/stream/items/ids?')) {
				return Response.json({ itemRefs: [] });
			}

			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});

	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => Boolean(findListButtonByViewId(elements.get('feeds-list'), 'feed/1')));
	await findListButtonByViewId(elements.get('views-list'), 'unread')?.dispatch('click');
	await waitForBrowserCondition(() => (elements.get('articles-heading')?.textContent ?? '') === 'Unread');

	assert.equal(elements.get('folders-list')?.textContent, '');
	assert.equal(elements.get('feeds-list')?.textContent, '');
	assert.equal(elements.get('folders-status')?.textContent, 'No tagged feeds with unread items.');
	assert.equal(elements.get('feeds-status')?.textContent, 'No uncategorized feeds with unread items.');
});

test('runtime script lets column resizer drags persist reader column widths', async () => {
	const { elements, localStorageState, dispatchDocumentPointer } = await createBrowserHarness({
		storedToken: 'live-token',
		fetchImpl: async (input, init) => {
			if (input === '/app/status') {
				return new Response(null, { status: 200 });
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

			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});
	const grid = elements.get('reader-grid');
	const sidebarResizer = elements.get('sidebar-column-resizer');
	const dragStreamResizer = elements.get('stream-column-resizer');

	await waitForBrowserCondition(() => elements.get('reader-shell')?.classList.contains('hidden') === false);

	await sidebarResizer?.dispatch('pointerdown', { clientX: 400, pointerId: 1 });
	assert.ok(sidebarResizer?.classList.contains('is-dragging'));
	assert.equal(dispatchDocumentPointer('pointermove', 480), true);
	dispatchDocumentPointer('pointerup', 480);

	assert.equal(grid?.style.getPropertyValue('--sidebar-column-width'), '304px');
	assert.equal(sidebarResizer?.classList.contains('is-dragging'), false);
	assert.equal(JSON.parse(localStorageState.get('pigeon.browser.column-widths') ?? '{}').sidebar, 304);

	await dragStreamResizer?.dispatch('pointerdown', { clientX: 600, pointerId: 2 });
	assert.equal(dispatchDocumentPointer('pointermove', 560), true);
	dispatchDocumentPointer('pointerup', 560);

	assert.equal(grid?.style.getPropertyValue('--stream-column-width'), '300px');
	assert.deepEqual(JSON.parse(localStorageState.get('pigeon.browser.column-widths') ?? '{}'), {
		sidebar: 304,
		stream: 300,
	});
});

test('runtime script applies stored column widths only after the reader grid is visible', async () => {
	let harnessElements: Map<string, ReturnType<typeof createElement>> | null = null;
	const { elements, localStorageState } = await createBrowserHarness({
		storedColumnWidths: { sidebar: 520, stream: 640 },
		readerGridWidth: () => (harnessElements?.get('reader-shell')?.classList.contains('hidden') ? 0 : 900),
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				return new Response('SID=pigeon/live-token\nLSID=null\nAuth=pigeon/live-token', { status: 200 });
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

			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});
	harnessElements = elements;
	const grid = elements.get('reader-grid');

	assert.equal(grid?.style.getPropertyValue('--sidebar-column-width'), '');
	assert.equal(grid?.style.getPropertyValue('--stream-column-width'), '');
	assert.deepEqual(JSON.parse(localStorageState.get('pigeon.browser.column-widths') ?? '{}'), {
		sidebar: 520,
		stream: 640,
	});

	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => !elements.get('reader-shell')?.classList.contains('hidden'));

	assert.equal(grid?.style.getPropertyValue('--sidebar-column-width'), '224px');
	assert.equal(grid?.style.getPropertyValue('--stream-column-width'), '356px');
	assert.deepEqual(JSON.parse(localStorageState.get('pigeon.browser.column-widths') ?? '{}'), {
		sidebar: 520,
		stream: 640,
	});
});

test('runtime script does not overwrite saved column widths during responsive window resizes', async () => {
	let readerGridWidth = 1440;
	const { elements, localStorageState, dispatchWindowEvent } = await createBrowserHarness({
		storedColumnWidths: { sidebar: 496, stream: 484 },
		readerGridWidth: () => readerGridWidth,
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				return new Response('SID=pigeon/live-token\nLSID=null\nAuth=pigeon/live-token', { status: 200 });
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

			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});
	const grid = elements.get('reader-grid');

	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => grid?.style.getPropertyValue('--sidebar-column-width') === '496px');

	readerGridWidth = 1000;
	dispatchWindowEvent('resize');
	assert.equal(grid?.style.getPropertyValue('--sidebar-column-width'), '224px');
	assert.equal(grid?.style.getPropertyValue('--stream-column-width'), '456px');
	assert.deepEqual(JSON.parse(localStorageState.get('pigeon.browser.column-widths') ?? '{}'), {
		sidebar: 496,
		stream: 484,
	});

	readerGridWidth = 1440;
	dispatchWindowEvent('resize');
	assert.equal(grid?.style.getPropertyValue('--sidebar-column-width'), '496px');
	assert.equal(grid?.style.getPropertyValue('--stream-column-width'), '484px');
	assert.deepEqual(JSON.parse(localStorageState.get('pigeon.browser.column-widths') ?? '{}'), {
		sidebar: 496,
		stream: 484,
	});
});

test('runtime script lets keyboard users resize columns and exposes separator values', async () => {
	const { elements, localStorageState } = await createBrowserHarness({
		storedToken: 'live-token',
		fetchImpl: async (input, init) => {
			if (input === '/app/status') {
				return new Response(null, { status: 200 });
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

			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});
	const grid = elements.get('reader-grid');
	const sidebarResizer = elements.get('sidebar-column-resizer');
	const keyboardStreamResizer = elements.get('stream-column-resizer');

	await waitForBrowserCondition(() => elements.get('reader-shell')?.classList.contains('hidden') === false);

	assert.equal(sidebarResizer?.hasEventListener('keydown'), true);
	assert.equal(sidebarResizer?.getAttribute('aria-valuenow'), '224');
	await sidebarResizer?.dispatch('keydown', {
		key: 'ArrowRight',
		preventDefault() {},
	});

	assert.equal(grid?.style.getPropertyValue('--sidebar-column-width'), '240px');
	assert.equal(grid?.style.getPropertyValue('--stream-column-width'), '340px');
	assert.equal(sidebarResizer?.getAttribute('aria-valuemin'), '224');
	assert.equal(sidebarResizer?.getAttribute('aria-valuemax'), '520');
	assert.equal(sidebarResizer?.getAttribute('aria-valuenow'), '240');
	assert.equal(sidebarResizer?.getAttribute('aria-valuetext'), '240 pixels');
	assert.deepEqual(JSON.parse(localStorageState.get('pigeon.browser.column-widths') ?? '{}'), {
		sidebar: 240,
		stream: 340,
	});

	await keyboardStreamResizer?.dispatch('keydown', {
		key: 'ArrowLeft',
		preventDefault() {},
	});

	assert.equal(grid?.style.getPropertyValue('--stream-column-width'), '324px');
	assert.equal(keyboardStreamResizer?.getAttribute('aria-valuemin'), '288');
	assert.equal(keyboardStreamResizer?.getAttribute('aria-valuemax'), '640');
	assert.equal(keyboardStreamResizer?.getAttribute('aria-valuenow'), '324');
	assert.deepEqual(JSON.parse(localStorageState.get('pigeon.browser.column-widths') ?? '{}'), {
		sidebar: 240,
		stream: 324,
	});

	await sidebarResizer?.dispatch('keydown', {
		key: 'Home',
		preventDefault() {},
	});

	assert.equal(grid?.style.getPropertyValue('--sidebar-column-width'), '224px');
	assert.equal(sidebarResizer?.getAttribute('aria-valuenow'), '224');
	assert.deepEqual(JSON.parse(localStorageState.get('pigeon.browser.column-widths') ?? '{}'), {
		sidebar: 224,
		stream: 324,
	});
});

test('runtime script expands folder feeds and requests the folder label stream when selected', async () => {
	const streamRequests: string[] = [];
	const { elements } = await createBrowserHarness({
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				return new Response('SID=pigeon/live-token\nLSID=null\nAuth=pigeon/live-token', { status: 200 });
			}

			if (input === '/reader/api/0/subscription/list') {
				return Response.json({
					subscriptions: [
						{
							id: 'feed/1',
							title: 'Alpha',
							categories: [{ id: 'user/-/label/Daily Reads', label: 'Daily Reads' }],
						},
						{
							id: 'feed/2',
							title: 'Bravo',
							categories: [{ id: 'user/-/label/Daily Reads', label: 'Daily Reads' }],
						},
						{ id: 'feed/3', title: 'Charlie' },
					],
				});
			}

			if (input === '/reader/api/0/unread-count') {
				return Response.json({
					unreadcounts: [
						{ id: 'feed/1', count: 2 },
						{ id: 'feed/2', count: 1 },
						{ id: 'feed/3', count: 4 },
					],
				});
			}

			if (String(input).startsWith('/reader/api/0/stream/items/ids?')) {
				streamRequests.push(String(input));
				return Response.json({
					itemRefs: [{ id: '101' }],
				});
			}

			if (input === '/reader/api/0/stream/items/contents' && init?.method === 'POST') {
				return Response.json({
					items: [
						{
							id: 'tag:google.com,2005:reader/item/0000000000000065',
							title: 'Folder article',
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
	await waitForBrowserCondition(() => Boolean(findListButtonByViewId(elements.get('folders-list'), 'user/-/label/Daily Reads')));

	assert.match(findListButtonByViewId(elements.get('folders-list'), 'user/-/label/Daily Reads')?.textContent ?? '', /Daily Reads/);
	assert.match(findListButtonByViewId(elements.get('folders-list'), 'user/-/label/Daily Reads')?.textContent ?? '', /3/);
	assert.equal(findListButtonByViewId(elements.get('folders-list'), 'feed/1'), undefined);
	assert.match(findListButtonByViewId(elements.get('feeds-list'), 'feed/3')?.textContent ?? '', /Charlie/);
	assert.match(findListButtonByViewId(elements.get('feeds-list'), 'feed/3')?.textContent ?? '', /4/);

	await findListButtonByViewId(elements.get('folders-list'), 'user/-/label/Daily Reads')?.dispatch('click');
	// Folders load newest first like every other stream; the sections are built in the browser.
	const folderRequestUrl = new URL(`https://pigeon.example${streamRequests.at(-1) ?? ''}`);
	assert.equal(folderRequestUrl.pathname, '/reader/api/0/stream/items/ids');
	assert.equal(folderRequestUrl.searchParams.get('s'), 'user/-/label/Daily Reads');

	const requestCountBeforeToggle = streamRequests.length;
	await findFolderToggleButton(elements.get('folders-list'), 'user/-/label/Daily Reads')?.dispatch('click');
	await waitForBrowserCondition(() => Boolean(findListButtonByViewId(elements.get('folders-list'), 'feed/1')));
	assert.equal(streamRequests.length, requestCountBeforeToggle);
	assert.match(findListButtonByViewId(elements.get('folders-list'), 'feed/1')?.textContent ?? '', /Alpha/);
	assert.match(findListButtonByViewId(elements.get('folders-list'), 'feed/2')?.textContent ?? '', /Bravo/);
	assert.doesNotMatch(findListButtonByViewId(elements.get('folders-list'), 'feed/1')?.textContent ?? '', /Daily Reads/);
	assert.doesNotMatch(findListButtonByViewId(elements.get('folders-list'), 'feed/2')?.textContent ?? '', /Daily Reads/);

	await findFolderToggleButton(elements.get('folders-list'), 'user/-/label/Daily Reads')?.dispatch('click');
	await waitForBrowserCondition(() => !findListButtonByViewId(elements.get('folders-list'), 'feed/1'));
});

const FOLDER_ID = 'user/-/label/Daily Reads';

// A folder of three feeds seen on Nov 3, 2026 at noon: six stories today, one
// three days ago, and two older than the week, one from a feed the library
// does not list. A second page adds two older stories.
async function openFolderSections(options: { now?: () => number; rowHeight?: number } = {}) {
	const now = new Date(2026, 10, 3, 12, 0, 0, 0).getTime();
	const today = getLocalDayRangeBounds(now, 1).startSeconds;
	const at = (date: Date) => Math.floor(date.getTime() / 1000);
	const stories: Record<string, { feed: string; title: string; published: number }> = {
		// Not in the first page: a refresh can bring them in.
		'112': { feed: 'feed/1', title: 'Alpha', published: today + 7_000 },
		'111': { feed: 'feed/1', title: 'Alpha', published: today + 6_000 },
		'110': { feed: 'feed/1', title: 'Alpha', published: today + 5_000 },
		'109': { feed: 'feed/2', title: 'Bravo', published: today + 4_000 },
		'108': { feed: 'feed/1', title: 'Alpha', published: today + 3_000 },
		'107': { feed: 'feed/1', title: 'Alpha', published: today + 2_000 },
		'106': { feed: 'feed/3', title: 'Charlie', published: today + 1_000 },
		'105': { feed: 'feed/1', title: 'Alpha', published: today + 500 },
		'104': { feed: 'feed/2', title: 'Bravo', published: at(new Date(2026, 9, 31, 12)) },
		'103': { feed: 'feed/3', title: 'Charlie', published: at(new Date(2026, 9, 24, 12)) },
		'102': { feed: 'feed/9', title: 'Ghost', published: at(new Date(2026, 9, 23, 12)) },
		'101': { feed: 'feed/2', title: 'Bravo', published: at(new Date(2026, 9, 22, 12)) },
		'100': { feed: 'feed/4', title: 'Delta', published: at(new Date(2026, 9, 21, 12)) },
	};
	const firstPage = ['110', '109', '108', '107', '106', '105', '104', '103', '102'];
	const requests: URL[] = [];
	const readingLog: Array<Record<string, any>> = [];
	const markedRead: string[][] = [];
	const harness = await createBrowserHarness({
		now: options.now ?? now,
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin') return new Response('SID=pigeon/live-token\nLSID=null\nAuth=pigeon/live-token');
			if (input === '/reader/api/0/subscription/list') {
				const folder = [{ id: FOLDER_ID, label: 'Daily Reads' }];
				return Response.json({ subscriptions: [
					{ id: 'feed/1', title: 'Alpha', iconUrl: 'https://icons.example/alpha.png', categories: folder },
					{ id: 'feed/2', title: 'Bravo', categories: folder },
					{ id: 'feed/3', title: 'Charlie', categories: folder },
					{ id: 'feed/4', title: 'Delta', categories: folder },
					{ id: 'feed/5', title: 'Echo' },
				] });
			}
			if (input === '/reader/api/0/unread-count') return Response.json({ unreadcounts: [] });
			if (input === '/api/v1/reading-log') {
				readingLog.push(...JSON.parse(String(init?.body)).events);
				return Response.json({});
			}
			if (input === '/api/v1/engagement') return Response.json({});
			if (input === '/api/v1/mutations') {
				const mutations = JSON.parse(String(init?.body)).mutations;
				markedRead.push(...mutations.map((mutation: { itemIds: string[] }) => mutation.itemIds));
				return Response.json({ results: mutations.map((mutation: { id: string }) => ({ mutationId: mutation.id, status: 'applied' })) });
			}
			const url = new URL(`https://pigeon.example${input}`);
			if (url.pathname === '/api/v1/browser/articles/count') return Response.json({ count: 0 });
			if (url.pathname === '/reader/api/0/stream/items/ids') {
				requests.push(url);
				if (url.searchParams.get('s') !== FOLDER_ID) return Response.json({ itemRefs: [] });
				return url.searchParams.get('c') === 'page-2'
					? Response.json({ itemRefs: [{ id: '101' }, { id: '100' }] })
					: Response.json({ itemRefs: firstPage.map((id) => ({ id })), continuation: 'page-2' });
			}
			if (url.pathname === '/api/v1/browser/articles') {
				requests.push(url);
				return Response.json({ itemIds: url.searchParams.get('stream') === FOLDER_ID ? firstPage : [], continuation: null, hasMore: false });
			}
			if (input === '/reader/api/0/stream/items/contents' && init?.method === 'POST') {
				return Response.json({ items: (init.body?.getAll('i') ?? []).map(String).filter((id) => stories[id]).map((id) => ({
					id: `tag:google.com,2005:reader/item/${Number(id).toString(16).padStart(16, '0')}`,
					title: `Story ${id}`, published: stories[id].published, categories: [],
					origin: { title: stories[id].title, streamId: stories[id].feed },
					summary: { content: `Preview ${id}` }, content: { content: `<p>Body ${id}</p>` },
				})) });
			}
			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});
	const { elements } = harness;
	if (options.rowHeight) {
		// Lay list rows out one under another so the page can measure them.
		const rowHeight = options.rowHeight;
		const shell = elements.get('articles-list-shell')!;
		const document = harness.window.document;
		const createElement = document.createElement.bind(document);
		document.createElement = (tagName: string) => {
			const element = createElement(tagName);
			if (tagName === 'li') {
				element.getBoundingClientRect = () => {
					const index = element.parentElement?.children.indexOf(element) ?? 0;
					const top = index * rowHeight - shell.scrollTop;
					return { width: 340, height: rowHeight, left: 0, right: 340, top, bottom: top + rowHeight };
				};
			}
			return element;
		};
	}
	const rows = () => elements.get('articles-list')!.children;
	// Each list row as a short label: headers by their title, stories by id, "N more" by its text.
	const outline = () => rows().map((row) => {
		if (row.classList.contains('article-feed-header')) return '# ' + findDescendantByClass(row, 'article-feed-header-title')?.textContent;
		const more = findDescendantByClass(row, 'article-more-button');
		if (more) return '+ ' + more.textContent;
		return row.children.find((child) => child.dataset.itemId)?.dataset.itemId ?? '?';
	});
	const copies = (id: string) => rows().map((row) => row.children[0]).filter((button) => button?.dataset.itemId === id);
	await elements.get('login-form')!.dispatch('submit');
	await waitForBrowserCondition(() => Boolean(findListButtonByViewId(elements.get('folders-list'), FOLDER_ID)));
	await findListButtonByViewId(elements.get('folders-list'), FOLDER_ID)!.dispatch('click');
	await waitForBrowserCondition(() => outline().includes('102'));
	return { ...harness, requests, readingLog, markedRead, firstPage, rows, outline, copies };
}

test('folders open as Today, Last 7 Days and feed sections with N more', async () => {
	const { elements, requests, rows, outline, copies } = await openFolderSections();

	assert.deepEqual(outline(), [
		'# Today', '110', '109', '108', '107', '106', '+ 1 more',
		'# Last 7 Days', '104',
		'# Alpha', '110', '108', '107', '+ 1 more',
		'# Bravo', '109', '104',
		'# Charlie', '106', '103',
		'# Older',
		'# Ghost', '102',
	]);
	// Folders load newest first; the browser builds the sections.
	assert.ok(requests.every((url) => url.searchParams.get('sort') !== 'feed'));
	assert.equal(requests.at(-1)!.pathname, '/reader/api/0/stream/items/ids');
	assert.equal(requests.at(-1)!.searchParams.get('s'), FOLDER_ID);
	// Feed headers carry the favicon and open their feed; the others are plain text.
	const headers = rows().filter((row) => row.classList.contains('article-feed-header'));
	assert.deepEqual(headers.map((row) => row.getAttribute('data-section-key')),
		['today', 'last-7-days', 'feed:feed/1', 'feed:feed/2', 'feed:feed/3', 'older', 'feed:feed/9']);
	assert.equal(findDescendantByClass(headers[2], 'feed-icon')?.getAttribute('src'), 'https://icons.example/alpha.png');
	assert.equal(findDescendantByClass(headers[3], 'feed-icon'), undefined);
	for (const header of [headers[0], headers[1], headers[5], headers[6]]) {
		assert.equal(findDescendantByClass(header, 'article-feed-header-button'), undefined);
	}
	assert.ok(headers.every((row) => !findDescendantByAttribute(row, 'data-item-id')));
	// A story from today shows in Today with its feed name and again in its feed section without it.
	const [todayCopy, feedCopy] = copies('110');
	assert.equal(findDescendantByClass(todayCopy, 'article-source')?.textContent, 'Alpha');
	assert.equal(findDescendantByClass(feedCopy, 'article-source'), undefined);
	assert.equal(findDescendantByClass(copies('104')[0], 'article-source')?.textContent, 'Bravo');
	// The read filter stays; the sort control is gone for folders.
	assert.equal(elements.get('article-sort-field')!.classList.contains('hidden'), true);

	// "N more" expands its own section in place without asking the server again.
	const requestCount = requests.length;
	findDescendantByClass(rows()[6], 'article-more-button')!.dispatch('click');
	await flushBrowserTasks();
	assert.deepEqual(outline().slice(0, 9), ['# Today', '110', '109', '108', '107', '106', '105', '# Last 7 Days', '104']);
	assert.deepEqual(outline().slice(9, 14), ['# Alpha', '110', '108', '107', '+ 1 more']);
	assert.equal(requests.length, requestCount);

	// The next page adds stories below the ones already shown and new feeds at the end.
	elements.get('load-more-button')!.dispatch('click');
	await waitForBrowserCondition(() => outline().includes('100'));
	assert.deepEqual(outline().slice(14), [
		'# Bravo', '109', '104', '101',
		'# Charlie', '106', '103',
		'# Older',
		'# Ghost', '102',
		'# Delta', '100',
	]);

	// Expanded sections stay expanded when the folder is opened again in this page session.
	await findListButtonByViewId(elements.get('feeds-list'), 'feed/5')!.dispatch('click');
	await flushBrowserTasks();
	assert.equal(elements.get('article-sort-field')!.classList.contains('hidden'), false);
	await findListButtonByViewId(elements.get('folders-list'), FOLDER_ID)!.dispatch('click');
	await waitForBrowserCondition(() => outline().includes('105'));

	// A feed header opens that feed.
	findDescendantByClass(rows().find((row) => row.getAttribute('data-section-key') === 'feed:feed/2'), 'article-feed-header-button')!.dispatch('click');
	await waitForBrowserCondition(() => elements.get('articles-heading')!.textContent === 'Bravo');
});

test('a page landing in a folder keeps the first row on screen in place', async () => {
	const { elements, outline } = await openFolderSections({ rowHeight: 50 });
	const shell = elements.get('articles-list-shell')!;
	const charlie = () => outline().indexOf('# Charlie');
	shell.scrollTop = charlie() * 50;
	const before = charlie();
	// The next page adds 101 to Bravo, above Charlie.
	elements.get('load-more-button')!.dispatch('click');
	await waitForBrowserCondition(() => outline().includes('100'));
	assert.equal(charlie(), before + 1);
	assert.equal(shell.scrollTop, charlie() * 50);
});

test('in a folder, Mark above and below follow the rows as drawn, not the newest-first stream', async () => {
	const { elements, outline, copies, markedRead } = await openFolderSections();
	const contextMenu = (id: string) => copies(id)[0].dispatch('contextmenu', { clientX: 10, clientY: 10 });
	const above = elements.get('context-mark-above-button')!;
	const below = elements.get('context-mark-below-button')!;
	// Only drawn rows count: the last drawn story has nothing below it, even with another page to load.
	contextMenu('102');
	assert.equal(below.disabled, true);
	assert.equal(above.disabled, false);
	elements.get('article-context-menu')!.classList.add('hidden');
	contextMenu('110');
	assert.equal(above.disabled, true);

	// After the next page, 101 (Oct 22) is drawn in Bravo, above Charlie's 103 (Oct 24).
	elements.get('load-more-button')!.dispatch('click');
	await waitForBrowserCondition(() => outline().includes('100'));
	contextMenu('103');
	above.dispatch('click');
	await waitForBrowserCondition(() => markedRead.length > 0);
	// 105 sits behind "1 more", so it is not marked.
	assert.deepEqual(markedRead.flat(), ['110', '109', '108', '107', '106', '104', '101']);
	await waitForBrowserCondition(() => !elements.get('article-bulk-button')!.disabled, 100);

	markedRead.length = 0;
	contextMenu('103');
	below.dispatch('click');
	await waitForBrowserCondition(() => markedRead.length > 0);
	assert.deepEqual(markedRead.flat(), ['102', '100']);
});

test('folders ignore the list sort and keep it for the other views', async () => {
	const { elements, requests } = await openFolderSections();
	async function choose(id: string, value: string) {
		elements.get(id)!.value = value;
		elements.get(id)!.dispatch('change');
		await flushBrowserTasks();
	}
	await findListButtonByViewId(elements.get('views-list'), 'all')!.dispatch('click');
	await flushBrowserTasks();
	await choose('article-sort-select', 'oldest');
	await findListButtonByViewId(elements.get('folders-list'), FOLDER_ID)!.dispatch('click');
	await flushBrowserTasks();
	// Unread in a folder is a browser articles query, newest first whatever All is sorted by.
	await choose('article-read-filter', 'unread');
	const folderQuery = requests.filter((url) => url.searchParams.get('stream') === FOLDER_ID).at(-1)!;
	assert.equal(folderQuery.pathname, '/api/v1/browser/articles');
	assert.equal(folderQuery.searchParams.get('filter'), 'unread');
	assert.equal(folderQuery.searchParams.get('sort'), 'newest');
	await findListButtonByViewId(elements.get('views-list'), 'all')!.dispatch('click');
	await flushBrowserTasks();
	assert.equal(elements.get('article-sort-select')!.value, 'oldest', 'changing the filter in a folder keeps the sort of other views');
});

test('j/k walks each story once in display order of first appearance in a folder', async () => {
	const { elements, dispatchKeydown, copies } = await openFolderSections();
	await waitForBrowserCondition(() => elements.get('reader-title')!.textContent === 'Story 110');
	// Both copies of the selected story are marked active.
	assert.deepEqual(copies('110').map((button) => button.classList.contains('is-active')), [true, true]);
	const walked = ['110'];
	for (let step = 0; step < 7; step += 1) {
		dispatchKeydown('j');
		await flushBrowserTasks();
		walked.push(elements.get('reader-title')!.textContent.replace('Story ', ''));
	}
	// 105 is behind "1 more" in both of its sections, so the keys skip it.
	assert.deepEqual(walked, ['110', '109', '108', '107', '106', '104', '103', '102']);
	assert.deepEqual(copies('109').map((button) => button.classList.contains('is-active')), [false, false]);
	dispatchKeydown('k');
	await flushBrowserTasks();
	assert.equal(elements.get('reader-title')!.textContent, 'Story 103');
	assert.deepEqual(copies('103').map((button) => button.classList.contains('is-active')), [true]);
	dispatchKeydown('k');
	await flushBrowserTasks();
	dispatchKeydown('k');
	await flushBrowserTasks();
	assert.equal(elements.get('reader-title')!.textContent, 'Story 106');
	assert.deepEqual(copies('106').map((button) => button.classList.contains('is-active')), [true, true]);
});

test('the selected story stays drawn when newer stories push it behind N more', async () => {
	const { elements, dispatchKeydown, firstPage, outline, copies } = await openFolderSections();
	copies('107')[0].dispatch('click');
	await waitForBrowserCondition(() => elements.get('reader-title')!.textContent === 'Story 107');
	// Two newer Alpha stories arrive: 107 would drop below Today's five and Alpha's three.
	firstPage.unshift('112', '111');
	elements.get('refresh-view-button')!.dispatch('click');
	await waitForBrowserCondition(() => outline().includes('112'));
	await flushBrowserTasks();
	// Its first section, Today, opens so the open story keeps its row and its place in j/k.
	assert.deepEqual(outline().slice(0, 9), ['# Today', '112', '111', '110', '109', '108', '107', '106', '105']);
	assert.equal(elements.get('reader-title')!.textContent, 'Story 107');
	assert.ok(copies('107').every((button) => button.classList.contains('is-active')));
	dispatchKeydown('j');
	await flushBrowserTasks();
	assert.equal(elements.get('reader-title')!.textContent, 'Story 106');
	dispatchKeydown('k');
	await flushBrowserTasks();
	assert.equal(elements.get('reader-title')!.textContent, 'Story 107');
});

test('impressions count a story shown twice once, at its first position, with metadata.section', async () => {
	let now = new Date(2026, 10, 3, 12, 0, 0, 0).getTime();
	const harness = await openFolderSections({ now: () => now });
	for (let tick = 0; tick < 12; tick += 1) {
		now += 500;
		harness.intervals[0].handler();
	}
	await waitForBrowserCondition(() => harness.readingLog.length > 0);
	const logged = harness.readingLog.map((event) => [event.itemId, event.position, event.metadata?.section, event.metadata?.stream]);
	assert.deepEqual(logged, [
		['110', 0, 'today', FOLDER_ID],
		['109', 1, 'today', FOLDER_ID],
		['108', 2, 'today', FOLDER_ID],
		['107', 3, 'today', FOLDER_ID],
		['106', 4, 'today', FOLDER_ID],
		['104', 5, 'last-7-days', FOLDER_ID],
		['103', 6, 'feed', FOLDER_ID],
		['102', 7, 'feed', FOLDER_ID],
	]);
	assert.ok(harness.readingLog.every((event) => event.view === 'folder'));
});

for (const scope of ['feed', 'folder']) {
 test(`mark-all uses the complete ${scope} scope and supports exact Undo without changing other feeds`, async (t) => {
  const { database, harness, mutations } = await createStatefulArticleBrowser({ count: 65 });
  t.after(() => database.close());
  database.exec("INSERT INTO feeds(feed_key,display_name) VALUES('other','Other'); INSERT INTO items(id,feed_key,subject,html_content,message_id,received_at) VALUES('other-story','other','Other story','<p>Other</p>','other-message','2026-10-12T12:00:00Z')");
  if (scope === 'folder') {
   database.exec("UPDATE feeds SET category='Newsletters' WHERE feed_key='today-source'; INSERT INTO feed_tags(feed_key,label) VALUES('today-source','Newsletters')");
   harness.elements.get('logout-button')!.dispatch('click');
   await harness.elements.get('login-form')!.dispatch('submit');
   await waitForBrowserCondition(() => Boolean(findListButtonByViewId(harness.elements.get('folders-list'), 'user/-/label/Newsletters')), 100);
  }
  const list = scope === 'folder' ? 'folders-list' : 'feeds-list';
  const viewId = scope === 'folder' ? 'user/-/label/Newsletters' : 'feed/1';
  findListButtonByViewId(harness.elements.get(list), viewId)!.dispatch('click');
  await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Story 66', 100);
  database.exec("UPDATE items SET is_read=1 WHERE id='today-5'");
  harness.elements.get('mark-all-as-read-button')!.dispatch('click');
  await waitForBrowserCondition(() => harness.elements.get('article-query-status')!.textContent.startsWith('Marked 66'), 1000);
  await waitForBrowserCondition(() => harness.elements.get('undo-article-button')!.disabled === false, 1000);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM items WHERE feed_key='today-source' AND is_read=1").get()!.count, 67);
  assert.equal(database.prepare("SELECT is_read FROM items WHERE id='other-story'").get()!.is_read, 0);
  assert.equal(harness.elements.get('reader-title')!.textContent, 'Story 66');
  assert.ok(mutations.every((mutation) => mutation.itemIds.length <= 20));
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM engagement_events WHERE event_type='read'").get()!.count, 0, 'bulk cleanup is neutral');
  await finishArticleMutation(harness, 'undo-article-button');
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM items WHERE feed_key='today-source' AND is_read=1").get()!.count, 1);
  assert.equal(database.prepare("SELECT is_read FROM items WHERE id='today-5'").get()!.is_read, 1);
 });
}

test('mark-all is a safe no-op when the selected feed has no unread stories', async (t) => {
 const { database, harness, mutations } = await createStatefulArticleBrowser();
 t.after(() => database.close());
 database.exec('UPDATE items SET is_read=1');
 harness.dispatchDocumentEvent('visibilitychange');
 await waitForBrowserCondition(() => findListButtonByViewId(harness.elements.get('views-list'), 'unread')!.textContent === 'Unread0', 100);
 findListButtonByViewId(harness.elements.get('feeds-list'), 'feed/1')!.dispatch('click');
 await waitForBrowserCondition(() => harness.elements.get('articles-heading')!.textContent === 'Today source', 100);
 assert.equal(harness.elements.get('mark-all-as-read-button')!.disabled, true);
 harness.elements.get('mark-all-as-read-button')!.dispatch('click');
 await flushBrowserTasks();
 assert.equal(mutations.length, 0);
});

test('mark-all reports a failed HTTP-200 receipt and can be retried in the same view', async (t) => {
 let attempts = 0;
 const { database, harness } = await createStatefulArticleBrowser({ fetchOverride: async (input, init, next) => {
  if (input.endsWith('/mutations') && ++attempts === 1) {
   const mutation = JSON.parse(init!.body as string).mutations[0];
   return Response.json({ results: [{ mutationId: mutation.id, status: 'failed', error: 'Temporary failure' }] });
  }
  return next();
 } });
 t.after(() => database.close());
 harness.elements.get('mark-all-as-read-button')!.dispatch('click');
 await waitForBrowserCondition(() => harness.elements.get('article-query-status')!.textContent.includes('0 saved changes confirmed'), 100);
 await waitForBrowserCondition(() => harness.elements.get('mark-all-as-read-button')!.disabled === false, 100);
 assert.equal(database.prepare('SELECT COUNT(*) AS count FROM items WHERE is_read=1').get()!.count, 0);
 assert.equal(harness.elements.get('reader-title')!.textContent, 'Story 3');
 harness.elements.get('mark-all-as-read-button')!.dispatch('click');
 await waitForBrowserCondition(() => harness.elements.get('article-query-status')!.textContent.startsWith('Marked 4'), 100);
 assert.equal(attempts, 2);
 assert.equal(database.prepare('SELECT COUNT(*) AS count FROM items WHERE is_read=1').get()!.count, 4);
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
	const article = (id: string) => ({
						id: `tag:google.com,2005:reader/item/${Number(id).toString(16).padStart(16, '0')}`,
						title: `Article ${id}`,
						published: 1_742_460_800,
						origin: { title: 'Alpha' },
						summary: { content: `Preview ${id}` },
						content: { content: `<p>Body ${id}</p>` },
					});
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
					unreadcounts: [{ id: 'feed/1', count: 75 }],
				});
			}

			if (String(input).startsWith('/reader/api/0/stream/contents?')) {
				return Response.json({
					items: Array.from({ length: 50 }, (_, index) => article(String(index + 1))),
					continuation: 'page-2',
				});
			}

			if (String(input).startsWith('/reader/api/0/stream/items/ids?')) {
				assert.equal(new URL(`https://pigeon.example${String(input)}`).searchParams.get('c'), 'page-2');
				return Response.json({
					itemRefs: Array.from({ length: 25 }, (_, index) => ({ id: String(index + 51) })),
				});
			}

			if (input === '/reader/api/0/stream/items/contents' && init?.method === 'POST') {
				const ids = Array.from((init.body as FormData).values()).map(String);
				contentRequests.push(ids);
				if (contentRequests.length === 1) {
					return firstContentResponse.promise;
				}
				return Response.json({ items: ids.map(article) });
			}

			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});

	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(
		() => elements.get('load-more-button')?.disabled === false && elements.get('load-more-button')?.classList.contains('hidden') === false,
	);
	assert.deepEqual(contentRequests, []);
	await elements.get('load-more-button')?.dispatch('click');
	await waitForBrowserCondition(() => contentRequests.length === 1);
	const loadMoreToggleCalls = () =>
		elements.get('load-more-button')?.toggleCalls.filter((call) => call.name === 'hidden').map((call) => call.force) ?? [];

	assert.ok(loadMoreToggleCalls().includes(false));
	assert.equal(elements.get('load-more-button')?.disabled, true);
	assert.deepEqual(contentRequests, [Array.from({ length: 20 }, (_, index) => String(index + 51))]);

	await elements.get('load-more-button')?.dispatch('click');
	await flushBrowserTasks();
	await flushBrowserTasks();

	assert.deepEqual(contentRequests, [Array.from({ length: 20 }, (_, index) => String(index + 51))]);

	firstContentResponse.resolve(
		Response.json({ items: Array.from({ length: 20 }, (_, index) => article(String(index + 51))) }),
	);
	await waitForBrowserCondition(() => elements.get('load-more-button')?.disabled === false);

	await elements.get('load-more-button')?.dispatch('click');
	await waitForBrowserCondition(() => contentRequests.length === 2);

	assert.ok(loadMoreToggleCalls().filter((force) => force === false).length >= 2);
	assert.deepEqual(contentRequests[1], ['71', '72', '73', '74', '75']);
});

test('load-more fetches continuation pages beyond 50 items without duplicating boundary ids', async () => {
	const idRequests: Array<string | null> = [];
	const contentRequests: string[][] = [];
	const { elements } = await createBrowserHarness({
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				return new Response('SID=pigeon/live-token\nLSID=null\nAuth=pigeon/live-token', { status: 200 });
			}

			if (input === '/reader/api/0/subscription/list') {
				return Response.json({ subscriptions: [{ id: 'feed/1', title: 'Alpha' }] });
			}

			if (input === '/reader/api/0/unread-count') {
				return Response.json({ unreadcounts: [{ id: 'feed/1', count: 55 }] });
			}

			if (String(input).startsWith('/reader/api/0/stream/contents?')) {
				idRequests.push(null);
				return Response.json({
					items: Array.from({ length: 50 }, (_, index) => String(index + 1)).map((id) => ({
						id: `tag:google.com,2005:reader/item/${Number(id).toString(16).padStart(16, '0')}`,
						title: `Article ${id}`,
						published: 1_742_460_800,
						origin: { title: 'Alpha' },
						summary: { content: `Preview ${id}` },
						content: { content: `<p>Body ${id}</p>` },
					})),
					continuation: 'page-2',
				});
			}

			if (String(input).startsWith('/reader/api/0/stream/items/ids?')) {
				const url = new URL(`https://pigeon.example${String(input)}`);
				const continuation = url.searchParams.get('c');
				idRequests.push(continuation);
				assert.ok(continuation, 'first visits load bodies through stream/contents');
				if (continuation === 'page-2') {
					return Response.json({
						itemRefs: [{ id: '50' }],
						continuation: 'page-3',
					});
				}
				assert.equal(continuation, 'page-3');
				return Response.json({
					itemRefs: Array.from({ length: 6 }, (_, index) => ({ id: String(index + 50) })),
				});
			}

			if (input === '/reader/api/0/stream/items/contents' && init?.method === 'POST') {
				const ids = Array.from((init.body as FormData).values()).map(String);
				contentRequests.push(ids);
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
	await waitForBrowserCondition(
		() => idRequests.length === 1 && elements.get('load-more-button')?.disabled === false &&
			(elements.get('articles-list')?.textContent ?? '').includes('Article 50'),
	);
	assert.equal(contentRequests.length, 0);
	assert.equal(elements.get('articles-list')?.children.length, 50);
	await elements.get('load-more-button')?.dispatch('click');
	await elements.get('load-more-button')?.dispatch('click');
	await waitForBrowserCondition(
		() => idRequests.length === 2 && elements.get('load-more-button')?.disabled === false,
	);
	assert.equal(contentRequests.length, 0);
	assert.equal(elements.get('load-more-button')?.classList.contains('hidden'), false);

	await elements.get('load-more-button')?.dispatch('click');
	await elements.get('load-more-button')?.dispatch('click');
	await waitForBrowserCondition(() => idRequests.length === 3 && contentRequests.length === 1);
	await waitForBrowserCondition(() => elements.get('load-more-button')?.disabled === false);

	assert.deepEqual(idRequests, [null, 'page-2', 'page-3']);
	assert.deepEqual(contentRequests, [['51', '52', '53', '54', '55']]);
	assert.match(elements.get('articles-list')?.textContent ?? '', /Article 51/);
	assert.equal(elements.get('articles-list')?.children.length, 55);
	assert.equal(elements.get('load-more-button')?.classList.contains('hidden'), true);
});

test('pagination stops when a duplicate-only page repeats its continuation token', async () => {
	const idRequests: Array<string | null> = [];
	const { elements } = await createBrowserHarness({
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				return new Response('SID=pigeon/live-token\nLSID=null\nAuth=pigeon/live-token', { status: 200 });
			}
			if (input === '/reader/api/0/subscription/list') {
				return Response.json({ subscriptions: [{ id: 'feed/1', title: 'Alpha' }] });
			}
			if (input === '/reader/api/0/unread-count') {
				return Response.json({ unreadcounts: [{ id: 'feed/1', count: 1 }] });
			}
			if (String(input).startsWith('/reader/api/0/stream/items/ids?')) {
				const url = new URL(`https://pigeon.example${String(input)}`);
				const continuation = url.searchParams.get('c');
				idRequests.push(continuation);
				return Response.json({
					itemRefs: [{ id: '1' }],
					continuation: 'same-page',
				});
			}
			if (input === '/reader/api/0/stream/items/contents' && init?.method === 'POST') {
				return Response.json({
					items: [
						{
							id: 'tag:google.com,2005:reader/item/0000000000000001',
							title: 'Article 1',
							published: 1_742_460_800,
							origin: { title: 'Alpha' },
							summary: { content: 'Preview 1' },
							content: { content: '<p>Body 1</p>' },
						},
					],
				});
			}
			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});

	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() =>
		elements.get('load-more-button')?.disabled === false &&
		Boolean(findListButtonByItemId(elements.get('articles-list'), '1')),
	);
	await elements.get('load-more-button')?.dispatch('click');
	await waitForBrowserCondition(
		() => idRequests.length === 2 && elements.get('load-more-button')?.classList.contains('hidden') === true,
	);
	await elements.get('load-more-button')?.dispatch('click');
	await flushBrowserTasks();

	assert.deepEqual(idRequests, [null, 'same-page']);
});

test('a stale continuation response cannot append items after switching views', async () => {
	const staleContinuationResponse = createDeferred<Response>();
	const contentRequests: string[][] = [];
	let continuationRequests = 0;
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
						{ id: 'feed/1', count: 2 },
						{ id: 'feed/2', count: 1 },
					],
				});
			}

			if (String(input).startsWith('/reader/api/0/stream/items/ids?')) {
				const url = new URL(`https://pigeon.example${String(input)}`);
				if (url.searchParams.get('s') === 'feed/2') {
					return Response.json({ itemRefs: [{ id: '301' }] });
				}
				if (url.searchParams.get('c')) {
					continuationRequests += 1;
					return staleContinuationResponse.promise;
				}
				return Response.json({ itemRefs: [{ id: '101' }], continuation: 'older-items' });
			}

			if (input === '/reader/api/0/stream/items/contents' && init?.method === 'POST') {
				const ids = Array.from((init.body as FormData).values()).map(String);
				contentRequests.push(ids);
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
	await elements.get('load-more-button')?.dispatch('click');
	await waitForBrowserCondition(() => continuationRequests === 1);

	const bravoFeedButton = findListButtonByViewId(elements.get('feeds-list'), 'feed/2');
	await bravoFeedButton?.dispatch('click');
	await waitForBrowserCondition(() => contentRequests.some((ids) => ids.includes('301')));
	staleContinuationResponse.resolve(Response.json({ itemRefs: [{ id: '102' }] }));
	await flushBrowserTasks();
	await flushBrowserTasks();

	assert.match(elements.get('articles-list')?.textContent ?? '', /Article 301/);
	assert.doesNotMatch(elements.get('articles-list')?.textContent ?? '', /Article 102/);
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
	assert.match(elements.get('reader-source-label')?.textContent ?? '', /Bravo/);

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

function createRedesignFetch() {
	return async (input: string, init?: RequestInit) => {
		if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
			return new Response('SID=pigeon/live-token\nLSID=null\nAuth=pigeon/live-token', { status: 200 });
		}
		if (input === '/reader/api/0/subscription/list') {
			return Response.json({
				subscriptions: [
					{ id: 'feed/1', title: 'Alpha' },
					{ id: 'feed/2', title: 'Bravo', categories: [{ id: 'user/-/label/Newsletters', label: 'Newsletters' }] },
				],
			});
		}
		if (input === '/reader/api/0/unread-count') {
			return Response.json({ unreadcounts: [{ id: 'feed/1', count: 1 }, { id: 'feed/2', count: 1 }] });
		}
		if (String(input).startsWith('/reader/api/0/stream/items/ids?')) {
			return Response.json({ itemRefs: [{ id: '101' }] });
		}
		if (input === '/reader/api/0/stream/items/contents' && init?.method === 'POST') {
			return Response.json({
				items: [{
					id: 'tag:google.com,2005:reader/item/0000000000000065',
					title: 'Redesign article',
					published: 1_742_460_800,
					origin: { title: 'Alpha' },
					summary: { content: 'Preview' },
					content: { content: '<p>Body</p>' },
				}],
			});
		}
		throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
	};
}

test('folder disclosure is a drawn chevron, not a typed > or v', async () => {
	const { elements } = await createBrowserHarness({ fetchImpl: createRedesignFetch() });
	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => Boolean(findFolderToggleButton(elements.get('folders-list'), 'user/-/label/Newsletters')));

	const toggle = findFolderToggleButton(elements.get('folders-list'), 'user/-/label/Newsletters');
	assert.equal(findDescendantByClass(toggle, 'feed-disclosure')?.textContent, '');
	assert.equal(toggle?.getAttribute('aria-expanded'), 'false');
	await toggle?.dispatch('click');
	const expanded = findFolderToggleButton(elements.get('folders-list'), 'user/-/label/Newsletters');
	assert.equal(expanded?.getAttribute('aria-expanded'), 'true');
	assert.equal(findDescendantByClass(expanded, 'feed-disclosure')?.textContent, '');
	assert.equal(findListButtonByViewId(elements.get('views-list'), 'all')?.getAttribute('data-view-kind'), 'all');
});

test('sidebar toggle hides the feeds column and remembers it across reloads', async () => {
	const { elements, localStorageState } = await createBrowserHarness({ fetchImpl: createRedesignFetch() });
	const grid = elements.get('reader-grid');
	const toggle = elements.get('sidebar-toggle-button');
	assert.equal(grid?.classList.contains('is-sidebar-collapsed'), false);
	assert.equal(toggle?.getAttribute('aria-expanded'), 'true');

	await toggle?.dispatch('click');
	assert.equal(grid?.classList.contains('is-sidebar-collapsed'), true);
	assert.equal(toggle?.getAttribute('aria-expanded'), 'false');
	assert.equal(localStorageState.get('pigeon.browser.sidebar-collapsed'), 'true');

	const restored = await createBrowserHarness({ fetchImpl: createRedesignFetch(), storedSidebarCollapsed: 'true' });
	assert.equal(restored.elements.get('reader-grid')?.classList.contains('is-sidebar-collapsed'), true);

	await toggle?.dispatch('click');
	assert.equal(grid?.classList.contains('is-sidebar-collapsed'), false);
	assert.equal(localStorageState.get('pigeon.browser.sidebar-collapsed'), 'false');
});

test('narrow layout moves from feeds to list to article and back', async () => {
	const { elements } = await createBrowserHarness({ fetchImpl: createRedesignFetch() });
	const grid = elements.get('reader-grid');
	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => Boolean(findListButtonByItemId(elements.get('articles-list'), '101')));

	await elements.get('stream-back-button')?.dispatch('click');
	assert.equal(grid?.getAttribute('data-mobile-pane'), 'sidebar');
	await findListButtonByViewId(elements.get('feeds-list'), 'feed/1')?.dispatch('click');
	assert.equal(grid?.getAttribute('data-mobile-pane'), 'stream');
	await waitForBrowserCondition(() => Boolean(findListButtonByItemId(elements.get('articles-list'), '101')));
	await findListButtonByItemId(elements.get('articles-list'), '101')?.dispatch('click');
	assert.equal(grid?.getAttribute('data-mobile-pane'), 'reader');
	await elements.get('reader-back-button')?.dispatch('click');
	assert.equal(grid?.getAttribute('data-mobile-pane'), 'stream');
});

test('search field opens from the list header and closes when cleared', async () => {
	const { elements } = await createBrowserHarness({ fetchImpl: createRedesignFetch() });
	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => Boolean(findListButtonByItemId(elements.get('articles-list'), '101')));
	const controls = elements.get('article-query-controls');
	const searchButton = elements.get('search-button');

	await searchButton?.dispatch('click');
	assert.equal(controls?.classList.contains('is-searching'), true);
	assert.equal(searchButton?.getAttribute('aria-expanded'), 'true');
	await searchButton?.dispatch('click');
	assert.equal(controls?.classList.contains('is-searching'), false);

	await searchButton?.dispatch('click');
	await elements.get('clear-article-search-button')?.dispatch('click');
	assert.equal(controls?.classList.contains('is-searching'), false);
	assert.equal(searchButton?.getAttribute('aria-expanded'), 'false');
});

test('popover menus close on Escape and after choosing an item', async () => {
	const { elements, dispatchKeydown, dispatchWindowEvent } = await createBrowserHarness({ fetchImpl: createRedesignFetch() }) as any;
	const optionsMenu = elements.get('article-options-menu');
	const actionsMenu = elements.get('article-actions-menu');
	optionsMenu.open = true;
	await optionsMenu.dispatch('toggle');
	actionsMenu.open = true;
	await actionsMenu.dispatch('toggle');
	assert.equal(optionsMenu.open, false, 'opening one menu closes the other');
	assert.equal(actionsMenu.open, true);

	await actionsMenu.dispatch('click', { target: elements.get('more-like-button') });
	assert.equal(actionsMenu.open, true, 'non-menu-item clicks keep the menu open');
	elements.get('more-like-button').classList.add('menu-item');
	await actionsMenu.dispatch('click', { target: elements.get('more-like-button') });
	assert.equal(actionsMenu.open, false);

	optionsMenu.open = true;
	dispatchKeydown('Escape');
	assert.equal(optionsMenu.open, false);

	actionsMenu.open = true;
	await dispatchWindowEvent('blur');
	assert.equal(actionsMenu.open, false, 'clicking into the article frame blurs the window and closes menus');
});

test('dark article frames override newsletter-painted colors while light frames leave them alone', () => {
	const newsletter = '<table bgcolor="#ffffff" style="background-color:#ffffff"><tr><td style="color:#111111">Body</td></tr></table>';
	const dark = createArticleFrameDocument(newsletter, 'dark');
	assert.match(dark, /<html lang="en" data-theme="dark">/);
	assert.match(dark, /html\[data-theme="dark"\] body :where\(:not\(img, picture, video, svg, svg \*\)\) \{\s*background-color: transparent !important;\s*color: inherit !important;/);
	// Links and code come after the zero-specificity catch-all with equal specificity, so they win.
	const catchAll = dark.indexOf('body :where(');
	assert.ok(catchAll > 0 && dark.indexOf('html[data-theme="dark"] body a,') > catchAll);
	assert.ok(dark.indexOf('html[data-theme="dark"] body pre,') > catchAll);
	assert.match(dark, /html\[data-theme="dark"\] body a,\s*html\[data-theme="dark"\] body a :where\(:not\(img, picture, video, svg, svg \*\)\) \{\s*color: var\(--frame-link\) !important;/);
	assert.match(dark, /bgcolor="#ffffff"/, 'the newsletter markup itself is untouched');
	const light = createArticleFrameDocument(newsletter, 'light');
	assert.match(light, /<html lang="en" data-theme="light">/);
});

test('Settings Appearance can return the app to following the system theme', async () => {
	const { elements, localStorageState } = await createBrowserHarness({ fetchImpl: createRedesignFetch(), storedTheme: 'dark' });
	const select = elements.get('app-theme-select');
	assert.equal(select?.value, 'dark');
	select!.value = 'system';
	await select?.dispatch('change');
	assert.equal(localStorageState.has(THEME_STORAGE_KEY), false);
	assert.equal(select?.value, 'system');
	select!.value = 'light';
	await select?.dispatch('change');
	assert.equal(localStorageState.get(THEME_STORAGE_KEY), 'light');
	assert.equal(elements.get('theme-toggle-button')?.getAttribute('aria-pressed'), 'false');
	await elements.get('theme-toggle-button')?.dispatch('click');
	assert.equal(select?.value, 'dark', 'the sidebar toggle is reflected in Settings');
});

test('signing out returns the narrow layout to the list and closes search', async () => {
	const { elements } = await createBrowserHarness({ fetchImpl: createRedesignFetch() });
	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => Boolean(findListButtonByItemId(elements.get('articles-list'), '101')));
	await findListButtonByItemId(elements.get('articles-list'), '101')?.dispatch('click');
	await elements.get('search-button')?.dispatch('click');
	assert.equal(elements.get('reader-grid')?.getAttribute('data-mobile-pane'), 'reader');
	assert.equal(elements.get('article-query-controls')?.classList.contains('is-searching'), true);
	await elements.get('logout-button')?.dispatch('click');
	assert.equal(elements.get('reader-grid')?.getAttribute('data-mobile-pane'), 'stream');
	assert.equal(elements.get('article-query-controls')?.classList.contains('is-searching'), false);
});

test('a browser tab at an old /app address shows the root address; installed apps keep /app', async () => {
	const { rootAppAddress } = await import('../src/browser-app-client');
	assert.equal(rootAppAddress('https://pigeon.example/app', false), '/');
	assert.equal(rootAppAddress('https://pigeon.example/app/', false), '/');
	assert.equal(rootAppAddress('https://pigeon.example/app?article=12&notificationAction=read#top', false), '/?article=12&notificationAction=read#top');
	assert.equal(rootAppAddress('https://pigeon.example/app?article=12', true), null, 'standalone installs are scoped to /app');
	assert.equal(rootAppAddress('https://pigeon.example/', false), null);
	assert.equal(rootAppAddress('https://pigeon.example/?article=1', false), null);
	assert.equal(rootAppAddress('https://pigeon.example/application', false), null);
	assert.equal(rootAppAddress('https://pigeon.example/app/status', false), null);
});

test('browsers with only the old /app worker get a / worker for offline reload', async () => {
	const { ensureRootServiceWorker } = await import('../src/browser-app-client');
	const container = (scopes: string[]) => {
		const registered: unknown[] = [];
		return { registered, getRegistrations: async () => scopes.map((scope) => ({ scope: 'https://pigeon.example' + scope })), register: async (...args: unknown[]) => { registered.push(args); } };
	};
	const legacy = container(['/app']);
	assert.equal(await ensureRootServiceWorker(legacy), true);
	assert.deepEqual(legacy.registered, [['/app/sw.js', { scope: '/' }]]);
	for (const scopes of [[], ['/'], ['/', '/app']]) {
		const current = container(scopes);
		assert.equal(await ensureRootServiceWorker(current), false, scopes.join(','));
		assert.deepEqual(current.registered, []);
	}
	assert.equal(await ensureRootServiceWorker(undefined), false);
	assert.equal(await ensureRootServiceWorker({}), false);
});
