import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTH_STORAGE_KEY, getLocalDayBounds } from '../src/browser-app-client';
import {
	browserRegressionItem,
	browserRegressionResponse,
	collectBrowserWindowIds,
	createBrowserHarness,
	createDeferred,
	createStatefulArticleBrowser,
	findDescendantByClass,
	findListButtonByItemId,
	findListButtonByViewId,
	flushBrowserTasks,
	renderedArticleIds,
	waitForBrowserCondition,
	waitForTodayWindow,
} from './helpers/browser-app-client-harness';

test('Today can reload an evicted selected article after reaching yesterday', async () => {
	const now = new Date(2026, 2, 20, 12).getTime();
	const bounds = getLocalDayBounds(new Date(now));
	const allIds = Array.from({ length: 552 }, (_, index) => String(index + 1));
	let rootRequests = 0;
	const contentRequests: string[][] = [];
	const harness = await createBrowserHarness({
		now,
		fetchImpl: async (input, init) => {
			if (input.startsWith('/reader/api/0/stream/items/ids?')) {
				const continuation = new URL(`https://test${input}`).searchParams.get('c');
				if (!continuation && ++rootRequests === 1) return Response.json({ itemRefs: [] });
				const page = continuation ? Number(continuation) : 0;
				return Response.json({
					itemRefs: allIds.slice(page * 50, (page + 1) * 50).map((id) => ({ id })),
					...(page < 11 ? { continuation: String(page + 1) } : {}),
				});
			}
			if (input.endsWith('/contents')) {
				const ids = (init?.body?.getAll('i') ?? []).map(String);
				contentRequests.push(ids);
				return Response.json({ items: ids.map((id) => browserRegressionItem(id, id === '552' ? bounds.startSeconds - 1 : bounds.startSeconds + 1)) });
			}
			return browserRegressionResponse(input, init);
		},
	});
	const { elements } = harness;
	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => rootRequests === 1);
	findListButtonByViewId(elements.get('views-list'), 'today')?.dispatch('click');
	await waitForBrowserCondition(() => Boolean(findListButtonByItemId(elements.get('articles-list'), '200')), 400);
	await waitForTodayWindow(harness);
	for (let page = 0; page < 2; page += 1) {
		elements.get('article-older-button')!.dispatch('click');
		await waitForTodayWindow(harness);
	}
	assert.ok(findListButtonByItemId(elements.get('articles-list'), '551'));
	const requestsBefore = contentRequests.length;
	for (let page = 0; page < 2; page += 1) {
		elements.get('article-newer-button')!.dispatch('click');
		await waitForTodayWindow(harness);
	}
	findListButtonByItemId(elements.get('articles-list'), '2')?.dispatch('click');
	await waitForBrowserCondition(() => (elements.get('reader-frame')?.srcdoc ?? '').includes('Body 2</p>'));
	assert.ok(contentRequests.length > requestsBefore, 'returning to the newest window rehydrates evicted bodies');
	assert.ok(contentRequests.slice(requestsBefore).some((ids) => ids.includes('2')));

});

test('foreground refresh selects an article when an empty Today view receives new items', async () => {
	const now = new Date(2026, 2, 20, 12).getTime();
	const published = getLocalDayBounds(new Date(now)).startSeconds + 1;
	let roots = 0;
	const harness = await createBrowserHarness({ now, fetchImpl: async (input, init) => {
		if (input.startsWith('/reader/api/0/stream/items/ids?')) return Response.json({ itemRefs: ++roots < 3 ? [] : [{ id: '1' }, { id: '2' }] });
		return browserRegressionResponse(input, init, published);
	} });
	await harness.elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => roots === 1);
	findListButtonByViewId(harness.elements.get('views-list'), 'today')?.dispatch('click');
	await waitForBrowserCondition(() => roots === 2);
	await flushBrowserTasks();
	harness.dispatchDocumentEvent('visibilitychange');
	await waitForBrowserCondition(() => harness.elements.get('reader-title')?.textContent === 'Article 1');
	assert.equal(harness.dispatchKeydown('j'), true);
	assert.equal(harness.elements.get('reader-title')?.textContent, 'Article 2');
});

test('Unread refresh discards old paginated membership after another client marks it read', async () => {
	let unreadRoots = 0;
	const initialIds = Array.from({ length: 50 }, (_, index) => String(index + 1));
	const updatedIds = Array.from({ length: 50 }, (_, index) => String(index + 51));
	const harness = await createBrowserHarness({ fetchImpl: async (input, init) => {
		if (input.startsWith('/reader/api/0/stream/items/ids?') && new URL(`https://test${input}`).searchParams.has('xt')) {
			return Response.json({ itemRefs: (++unreadRoots === 1 ? initialIds : updatedIds).map((id) => ({ id })), continuation: 'tail' });
		}
		return browserRegressionResponse(input, init);
	} });
	await harness.elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => Boolean(findListButtonByViewId(harness.elements.get('views-list'), 'unread')));
	findListButtonByViewId(harness.elements.get('views-list'), 'unread')?.dispatch('click');
	await waitForBrowserCondition(() => Boolean(findListButtonByItemId(harness.elements.get('articles-list'), '1')));
	harness.dispatchDocumentEvent('visibilitychange');
	await waitForBrowserCondition(() => Boolean(findListButtonByItemId(harness.elements.get('articles-list'), '51')));
	assert.equal(harness.elements.get('articles-list')?.children.length, 50);
	assert.equal(findListButtonByItemId(harness.elements.get('articles-list'), '1'), undefined);
	assert.equal(harness.elements.get('reader-title')?.textContent, 'Article 51');
});

test('a failed first stream page keeps a visible error and refresh recovers the view', async () => {
	let shouldFail = true;
	let streamPages = 0;
	const { elements } = await createBrowserHarness({ fetchImpl: async (input, init) => {
		if (input.startsWith('/reader/api/0/stream/contents?')) {
			streamPages += 1;
			return shouldFail ? new Response('Error', { status: 503 }) : Response.json({ items: [browserRegressionItem('1', 1_742_460_800)] });
		}
		if (input.startsWith('/reader/api/0/stream/items/ids?')) return Response.json({ itemRefs: [{ id: '1' }] });
		if (input.endsWith('/contents') && shouldFail) return new Response('Error', { status: 503 });
		return browserRegressionResponse(input, init);
	} });
	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => elements.get('articles-status')?.textContent === 'Could not load this view.');
	assert.equal(streamPages, 1);
	assert.equal(elements.get('articles-list')?.children.length, 0);
	shouldFail = false;
	elements.get('refresh-view-button')?.dispatch('click');
	await waitForBrowserCondition(() => (elements.get('reader-frame')?.srcdoc ?? '').includes('Body 1</p>'));
	assert.equal(elements.get('articles-status')?.textContent, '1 article');
	assert.equal(streamPages, 1, 'refreshing an unloaded view revalidates through membership refs');
});

test('clearing the saved session cancels a pending successful login', async () => {
	const pending = createDeferred<Response>();
	const { elements, storage } = await createBrowserHarness({ fetchImpl: async (input, init) => input === '/accounts/ClientLogin' ? pending.promise : browserRegressionResponse(input, init) });
	const loginAttempt = elements.get('login-form')?.dispatch('submit');
	elements.get('clear-session-button')?.dispatch('click');
	pending.resolve(new Response('Auth=pigeon/old-attempt'));
	await loginAttempt;
	await flushBrowserTasks();
	assert.equal(storage.has(AUTH_STORAGE_KEY), false);
	assert.equal(elements.get('login-screen')?.classList.contains('hidden'), false);
	assert.equal(elements.get('login-error')?.textContent, 'Saved session cleared. Sign in again.');
});

test('a stale failed login cannot log out a newer successful login', async () => {
	const first = createDeferred<Response>();
	let loginRequests = 0;
	const { elements, storage } = await createBrowserHarness({ fetchImpl: async (input, init) => {
		if (input === '/accounts/ClientLogin') return ++loginRequests === 1 ? first.promise : new Response('Auth=pigeon/new-token');
		return browserRegressionResponse(input, init);
	} });
	const firstAttempt = elements.get('login-form')?.dispatch('submit');
	await elements.get('login-form')?.dispatch('submit');
	first.resolve(new Response('Error', { status: 401 }));
	await firstAttempt;
	assert.equal(storage.get(AUTH_STORAGE_KEY), 'new-token');
	assert.equal(elements.get('reader-shell')?.classList.contains('hidden'), false);
	assert.equal(elements.get('login-error')?.textContent, '');
});

test('a truncated login response shows an error and permits a successful retry', async () => {
	let loginRequests = 0;
	const { elements, storage } = await createBrowserHarness({ fetchImpl: async (input, init) => {
		if (input === '/accounts/ClientLogin') {
			if (++loginRequests === 1) {
				return new Response(new ReadableStream({ start(controller) {
					controller.error(new TypeError('Connection terminated'));
				} }));
			}
			return new Response('Auth=pigeon/retry-token');
		}
		return browserRegressionResponse(input, init);
	} });
	await elements.get('login-form')?.dispatch('submit');
	assert.equal(elements.get('login-error')?.textContent, 'Could not reach the server.');
	assert.equal(elements.get('login-screen')?.classList.contains('hidden'), false);
	assert.equal(storage.has(AUTH_STORAGE_KEY), false);
	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => elements.get('reader-shell')?.classList.contains('hidden') === false);
	assert.equal(storage.get(AUTH_STORAGE_KEY), 'retry-token');
	assert.equal(elements.get('login-error')?.textContent, '');
});

test('an older truncated login body cannot log out a newer successful session', async () => {
	let oldBody: ReadableStreamDefaultController<Uint8Array> | undefined;
	let loginRequests = 0;
	const { elements, storage } = await createBrowserHarness({ fetchImpl: async (input, init) => {
		if (input === '/accounts/ClientLogin') {
			return ++loginRequests === 1
				? new Response(new ReadableStream<Uint8Array>({ start(controller) { oldBody = controller; } }))
				: new Response('Auth=pigeon/new-token');
		}
		return browserRegressionResponse(input, init);
	} });
	const firstAttempt = elements.get('login-form')?.dispatch('submit');
	await flushBrowserTasks();
	await elements.get('login-form')?.dispatch('submit');
	oldBody?.error(new TypeError('Old connection terminated'));
	await firstAttempt;
	assert.equal(storage.get(AUTH_STORAGE_KEY), 'new-token');
	assert.equal(elements.get('reader-shell')?.classList.contains('hidden'), false);
	assert.equal(elements.get('login-error')?.textContent, '');
});

for (const currentScrollTop of [0, 64]) {
	test(`root refresh preserves the current scroll position ${currentScrollTop} rather than an older saved position`, async () => {
		const refresh = createDeferred<Response>();
		let roots = 0;
		const harness = await createBrowserHarness({ fetchImpl: async (input, init) => {
			if (input.startsWith('/reader/api/0/stream/items/ids?')) {
				return ++roots === 1 ? Response.json({ itemRefs: [{ id: '1' }, { id: '2' }] }) : refresh.promise;
			}
			return browserRegressionResponse(input, init);
		} });
		await harness.elements.get('login-form')?.dispatch('submit');
		await waitForBrowserCondition(() => harness.elements.get('reader-title')?.textContent === 'Article 1');
		const list = harness.elements.get('articles-list-shell');
		assert.ok(list);
		list.scrollTop = 123;
		findListButtonByItemId(harness.elements.get('articles-list'), '2')?.dispatch('click');
		await flushBrowserTasks();
		harness.dispatchDocumentEvent('visibilitychange');
		await waitForBrowserCondition(() => roots === 2);
		list.scrollTop = currentScrollTop;
		refresh.resolve(Response.json({ itemRefs: [{ id: '1' }, { id: '2' }] }));
		await flushBrowserTasks();
		assert.equal(list.scrollTop, currentScrollTop);
		assert.equal(harness.elements.get('reader-title')?.textContent, 'Article 2');
	});
}

test('an inactive root refresh leaves the current scroll alone and cached navigation restores its saved position', async () => {
	const refresh = createDeferred<Response>();
	let allRoots = 0;
	const harness = await createBrowserHarness({ fetchImpl: async (input, init) => {
		if (input.endsWith('/subscription/list')) return Response.json({ subscriptions: [{ id: 'feed/1', title: 'Alpha' }] });
		if (input.startsWith('/reader/api/0/stream/items/ids?')) {
			const stream = new URL('https://pigeon.test' + input).searchParams.get('s');
			if (stream === 'feed/1') return Response.json({ itemRefs: [{ id: '3' }] });
			return ++allRoots === 1 ? Response.json({ itemRefs: [{ id: '1' }, { id: '2' }] }) : refresh.promise;
		}
		return browserRegressionResponse(input, init);
	} });
	await harness.elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => harness.elements.get('reader-title')?.textContent === 'Article 1');
	const list = harness.elements.get('articles-list-shell');
	assert.ok(list);
	list.scrollTop = 123;
	findListButtonByItemId(harness.elements.get('articles-list'), '2')?.dispatch('click');
	harness.dispatchDocumentEvent('visibilitychange');
	await waitForBrowserCondition(() => allRoots === 2);
	findListButtonByViewId(harness.elements.get('feeds-list'), 'feed/1')?.dispatch('click');
	await waitForBrowserCondition(() => harness.elements.get('reader-title')?.textContent === 'Article 3');
	list.scrollTop = 64;
	refresh.resolve(Response.json({ itemRefs: [{ id: '1' }, { id: '2' }] }));
	await flushBrowserTasks();
	assert.equal(list.scrollTop, 64);
	assert.equal(harness.elements.get('reader-title')?.textContent, 'Article 3');
	findListButtonByViewId(harness.elements.get('views-list'), 'all')?.dispatch('click');
	await flushBrowserTasks();
	assert.equal(list.scrollTop, 123);
	assert.equal(harness.elements.get('reader-title')?.textContent, 'Article 2');
});

test('online foreground recovers a failed inventory bootstrap and coalesces repeated events', async () => {
	const retry = createDeferred<Response>();
	let subscriptionRequests = 0;
	let countRequests = 0;
	const harness = await createBrowserHarness({ fetchImpl: async (input, init) => {
		if (input.endsWith('/subscription/list')) return ++subscriptionRequests === 1
			? new Response('Unavailable', { status: 503 }) : retry.promise;
		if (input.endsWith('/unread-count')) { countRequests += 1; return Response.json({ unreadcounts: [] }); }
		if (input.startsWith('/reader/api/0/stream/items/ids?')) return Response.json({ itemRefs: [{ id: '1' }] });
		return browserRegressionResponse(input, init);
	} });
	await harness.elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => harness.elements.get('feeds-status')?.textContent === 'Could not load feeds.');
	harness.setOnline(false);
	harness.dispatchDocumentEvent('visibilitychange');
	await flushBrowserTasks();
	assert.equal(subscriptionRequests, 1);
	harness.setOnline(true);
	harness.dispatchWindowEvent('online');
	harness.dispatchDocumentEvent('visibilitychange');
	harness.dispatchWindowEvent('online');
	await flushBrowserTasks();
	assert.equal(subscriptionRequests, 2);
	assert.equal(countRequests, 2);
	retry.resolve(Response.json({ subscriptions: [{ id: 'feed/1', title: 'Recovered' }] }));
	await waitForBrowserCondition(() => harness.elements.get('reader-title')?.textContent === 'Article 1');
	assert.ok(findListButtonByViewId(harness.elements.get('feeds-list'), 'feed/1'));
	assert.equal(harness.elements.get('articles-status')?.textContent, '1 article');
});

test('a recovery inventory response cannot restore a cleared same-token session', async () => {
	const oldRetry = createDeferred<Response>();
	let subscriptionRequests = 0;
	const harness = await createBrowserHarness({ fetchImpl: async (input, init) => {
		if (input.endsWith('/subscription/list')) {
			subscriptionRequests += 1;
			if (subscriptionRequests === 1) return new Response('Unavailable', { status: 503 });
			if (subscriptionRequests === 2) return oldRetry.promise;
			return Response.json({ subscriptions: [{ id: 'feed/new', title: 'Current' }] });
		}
		if (input.startsWith('/reader/api/0/stream/items/ids?')) return Response.json({ itemRefs: [{ id: '2' }] });
		return browserRegressionResponse(input, init);
	} });
	await harness.elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => harness.elements.get('feeds-status')?.textContent === 'Could not load feeds.');
	harness.dispatchWindowEvent('online');
	await flushBrowserTasks();
	assert.equal(subscriptionRequests, 2);
	harness.elements.get('clear-session-button')?.dispatch('click');
	await harness.elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => harness.elements.get('reader-title')?.textContent === 'Article 2');
	oldRetry.resolve(Response.json({ subscriptions: [{ id: 'feed/old', title: 'Old' }] }));
	await flushBrowserTasks();
	assert.equal(subscriptionRequests, 3);
	assert.equal(findListButtonByViewId(harness.elements.get('feeds-list'), 'feed/old'), undefined);
	assert.ok(findListButtonByViewId(harness.elements.get('feeds-list'), 'feed/new'));
	assert.equal(harness.elements.get('reader-title')?.textContent, 'Article 2');
});

for (const malformed of ['subscriptions', 'counts']) {
	test(`a malformed bootstrap ${malformed} response stays retryable on foreground`, async () => {
		let valid = false;
		let subscriptionRequests = 0;
		const harness = await createBrowserHarness({ fetchImpl: async (input, init) => {
			if (input.endsWith('/subscription/list')) {
				subscriptionRequests += 1;
				return Response.json(!valid && malformed === 'subscriptions' ? {} : { subscriptions: [] });
			}
			if (input.endsWith('/unread-count')) return Response.json(!valid && malformed === 'counts' ? { unreadcounts: null } : { unreadcounts: [] });
			return browserRegressionResponse(input, init);
		} });
		await harness.elements.get('login-form')?.dispatch('submit');
		await flushBrowserTasks();
		assert.equal(harness.elements.get('feeds-status')?.textContent, 'Could not load feeds.');
		assert.equal(harness.elements.get('views-list')?.children.length, 0);
		valid = true;
		harness.dispatchDocumentEvent('visibilitychange');
		await waitForBrowserCondition(() => Boolean(findListButtonByViewId(harness.elements.get('views-list'), 'all')));
		assert.equal(subscriptionRequests, 2);
		assert.equal(harness.elements.get('articles-status')?.textContent, 'No articles in All items.');
	});
}

test('Today refresh clears an old day boundary and loads new continuation pages', async () => {
	const now = new Date(2026, 2, 20, 12).getTime();
	const bounds = getLocalDayBounds(new Date(now));
	const todayIds = Array.from({ length: 60 }, (_, index) => String(index + 100));
	let roots = 0;
	let continuationRequests = 0;
	const harness = await createBrowserHarness({
		now,
		fetchImpl: async (input, init) => {
			if (input.startsWith('/reader/api/0/stream/items/ids?')) {
				if (new URL(`https://test${input}`).searchParams.has('c')) {
					continuationRequests += 1;
					return Response.json({ itemRefs: [...todayIds.slice(50), '1'].map((id) => ({ id })) });
				}
				roots += 1;
				if (roots === 1) return Response.json({ itemRefs: [] });
				if (roots === 2) return Response.json({ itemRefs: [{ id: '1' }] });
				return Response.json({ itemRefs: todayIds.slice(0, 50).map((id) => ({ id })), continuation: 'next' });
			}
			if (input.endsWith('/contents')) {
				return Response.json({
					items: (init?.body?.getAll('i') ?? []).map(String).map((id) =>
						browserRegressionItem(id, id === '1' ? bounds.startSeconds - 1 : bounds.startSeconds + 1),
					),
				});
			}
			return browserRegressionResponse(input, init);
		},
	});
	await harness.elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => roots === 1);
	findListButtonByViewId(harness.elements.get('views-list'), 'today')?.dispatch('click');
	await waitForBrowserCondition(() => roots === 2);
	await flushBrowserTasks();
	assert.equal(harness.elements.get('articles-list')?.children.length, 0);
	harness.dispatchDocumentEvent('visibilitychange');
	harness.dispatchWindowEvent('online');
	await waitForBrowserCondition(() => Boolean(findListButtonByItemId(harness.elements.get('articles-list'), '159')));
	assert.equal(continuationRequests, 1);
	assert.equal(harness.elements.get('articles-list')?.children.length, 60);
	assert.equal(harness.elements.get('reader-title')?.textContent, 'Article 100');
	assert.equal(findListButtonByItemId(harness.elements.get('articles-list'), '1'), undefined);
	assert.equal(harness.elements.get('load-more-button')?.classList.contains('hidden'), true);
});

test('foreground refresh reconciles unread sidebar counts without changing the current view', async () => {
	let changedElsewhere = false;
	let countRequests = 0;
	const harness = await createBrowserHarness({ fetchImpl: async (input, init) => {
		if (input.endsWith('/subscription/list')) return Response.json({ subscriptions: [{ id: 'feed/1', title: 'Alpha' }] });
		if (input.endsWith('/unread-count')) {
			countRequests += 1;
			const count = changedElsewhere ? 0 : 5;
			return Response.json({ unreadcounts: [{ id: 'feed/1', count }, { id: 'user/-/state/com.google/reading-list', count }] });
		}
		if (input.startsWith('/reader/api/0/stream/items/ids?')) return Response.json({ itemRefs: changedElsewhere ? [] : [{ id: '1' }] });
		return browserRegressionResponse(input, init);
	} });
	await harness.elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => harness.elements.get('reader-title')?.textContent === 'Article 1');
	findListButtonByViewId(harness.elements.get('views-list'), 'unread')?.dispatch('click');
	await flushBrowserTasks();
	changedElsewhere = true;
	harness.dispatchDocumentEvent('visibilitychange');
	await waitForBrowserCondition(() => harness.elements.get('articles-list')?.children.length === 0);
	await flushBrowserTasks();
	assert.equal(findListButtonByViewId(harness.elements.get('views-list'), 'unread')?.textContent, 'Unread0');
	assert.equal(countRequests, 2);
	assert.equal(harness.elements.get('articles-heading')?.textContent, 'Unread');
});

test('a continuation from old Unread membership cannot append after a newer root refresh', async () => {
	const oldPage = createDeferred<Response>();
	let changedElsewhere = false;
	let pageRequests = 0;
	const initialIds = Array.from({ length: 50 }, (_, index) => String(index + 1));
	const updatedIds = Array.from({ length: 50 }, (_, index) => String(index + 101));
	const harness = await createBrowserHarness({ fetchImpl: async (input, init) => {
		if (input.startsWith('/reader/api/0/stream/items/ids?')) {
			const url = new URL(`https://test${input}`);
			if (!url.searchParams.has('xt')) return Response.json({ itemRefs: [] });
			if (url.searchParams.has('c')) {
				pageRequests += 1;
				return oldPage.promise;
			}
			return Response.json({
				itemRefs: (changedElsewhere ? updatedIds : initialIds).map((id) => ({ id })),
				continuation: changedElsewhere ? 'new-next' : 'old-next',
			});
		}
		return browserRegressionResponse(input, init);
	} });
	await harness.elements.get('login-form')?.dispatch('submit');
	await flushBrowserTasks();
	findListButtonByViewId(harness.elements.get('views-list'), 'unread')?.dispatch('click');
	await waitForBrowserCondition(() => harness.elements.get('reader-title')?.textContent === 'Article 1');
	for (let chunk = 0; chunk < 2; chunk += 1) {
		harness.elements.get('load-more-button')?.dispatch('click');
		await flushBrowserTasks();
	}
	harness.elements.get('load-more-button')?.dispatch('click');
	await waitForBrowserCondition(() => pageRequests === 1);
	changedElsewhere = true;
	harness.dispatchDocumentEvent('visibilitychange');
	await waitForBrowserCondition(() => harness.elements.get('reader-title')?.textContent === 'Article 101');
	oldPage.resolve(Response.json({
		itemRefs: Array.from({ length: 50 }, (_, index) => ({ id: String(index + 51) })),
		continuation: 'old-third',
	}));
	await flushBrowserTasks();
	assert.equal(harness.elements.get('articles-list')?.children.length, 50);
	assert.equal(findListButtonByItemId(harness.elements.get('articles-list'), '51'), undefined);
	assert.equal(harness.elements.get('load-more-button')?.disabled, false);
});

test('a deleted evicted selection does not block an authoritative root refresh', async () => {
	for (const continuation of ['', 'tail']) {
		let deleted = false;
		let feedRequests = 0;
		const feedIds = Array.from({ length: 551 }, (_, index) => String(index + 1001));
		const contentRequests: string[][] = [];
		const harness = await createBrowserHarness({ fetchImpl: async (input, init) => {
			if (input.endsWith('/subscription/list')) return Response.json({ subscriptions: [{ id: 'feed/1', title: 'Alpha' }] });
			if (input.startsWith('/reader/api/0/stream/items/ids?')) {
				if (new URL(`https://test${input}`).searchParams.get('s') === 'feed/1') {
					feedRequests += 1;
					return Response.json({ itemRefs: feedIds.map((id) => ({ id })) });
				}
				return Response.json({ itemRefs: [{ id: deleted ? '2' : '1' }], ...(deleted && continuation ? { continuation } : {}) });
			}
			if (input.endsWith('/contents')) {
				const ids = (init?.body?.getAll('i') ?? []).map(String);
				contentRequests.push(ids);
				return Response.json({ items: ids.filter((id) => !deleted || id !== '1').map((id) => browserRegressionItem(id, 1_742_460_800)) });
			}
			return browserRegressionResponse(input, init);
		} });
		await harness.elements.get('login-form')?.dispatch('submit');
		await waitForBrowserCondition(() => harness.elements.get('reader-title')?.textContent === 'Article 1');
		findListButtonByViewId(harness.elements.get('feeds-list'), 'feed/1')?.dispatch('click');
		await waitForBrowserCondition(() => feedRequests === 1);
		await flushBrowserTasks();
		harness.dispatchDocumentEvent('visibilitychange');
		await waitForBrowserCondition(() => contentRequests.length >= 11, 200);
		await collectBrowserWindowIds(harness);
		await flushBrowserTasks();
		deleted = true;
		findListButtonByViewId(harness.elements.get('views-list'), 'all')?.dispatch('click');
		await waitForBrowserCondition(() => harness.elements.get('reader-title')?.textContent === 'Article 2');
		assert.deepEqual(contentRequests.at(-1), [continuation ? '1' : '2']);
		assert.equal(findListButtonByItemId(harness.elements.get('articles-list'), '1'), undefined);
		assert.equal(harness.elements.get('articles-status')?.textContent, '1 article');
	}
});


test('an older root refresh cannot replace a newer root while its article bodies finish late', async () => {
	const oldBody = createDeferred<Response>();
	let roots = 0;
	let oldBodyStarted = false;
	const harness = await createBrowserHarness({ fetchImpl: async (input, init) => {
		if (input.startsWith('/reader/api/0/stream/items/ids?')) return Response.json({ itemRefs: [{ id: String(++roots) }] });
		if (input.endsWith('/contents') && init?.body?.getAll('i').includes('2')) {
			oldBodyStarted = true;
			return oldBody.promise;
		}
		return browserRegressionResponse(input, init);
	} });
	await harness.elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => harness.elements.get('reader-title')?.textContent === 'Article 1');
	harness.dispatchDocumentEvent('visibilitychange');
	await waitForBrowserCondition(() => oldBodyStarted);
	harness.dispatchDocumentEvent('visibilitychange');
	await waitForBrowserCondition(() => harness.elements.get('reader-title')?.textContent === 'Article 3');
	oldBody.resolve(Response.json({ items: [browserRegressionItem('2', 1_742_460_800)] }));
	await flushBrowserTasks();
	assert.equal(harness.elements.get('reader-title')?.textContent, 'Article 3');
	assert.equal(findListButtonByItemId(harness.elements.get('articles-list'), '2'), undefined);
});

test('overlapping count refreshes coalesce and a late result preserves a newly selected view', async () => {
	const counts = createDeferred<Response>();
	let countRequests = 0;
	const harness = await createBrowserHarness({ fetchImpl: async (input, init) => {
		if (input.endsWith('/subscription/list')) return Response.json({ subscriptions: [{ id: 'feed/1', title: 'Alpha' }] });
		if (input.endsWith('/unread-count')) {
			countRequests += 1;
			return countRequests === 1 ? Response.json({ unreadcounts: [{ id: 'feed/1', count: 5 }] }) : counts.promise;
		}
		if (input.startsWith('/reader/api/0/stream/items/ids?')) return Response.json({ itemRefs: [{ id: '1' }] });
		return browserRegressionResponse(input, init);
	} });
	await harness.elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => harness.elements.get('reader-title')?.textContent === 'Article 1');
	harness.dispatchDocumentEvent('visibilitychange');
	harness.dispatchWindowEvent('online');
	assert.equal(countRequests, 2);
	findListButtonByViewId(harness.elements.get('feeds-list'), 'feed/1')?.dispatch('click');
	await waitForBrowserCondition(() => harness.elements.get('articles-heading')?.textContent === 'Alpha');
	counts.resolve(Response.json({ unreadcounts: [{ id: 'feed/1', count: 2 }] }));
	await waitForBrowserCondition(() => findListButtonByViewId(harness.elements.get('feeds-list'), 'feed/1')?.textContent === 'Alpha2');
	assert.equal(harness.elements.get('articles-heading')?.textContent, 'Alpha');
	assert.equal(harness.elements.get('reader-title')?.textContent, 'Article 1');
});

test('a stale failed root refresh cannot overwrite the status of a newer successful root', async () => {
	const oldBody = createDeferred<Response>();
	let roots = 0;
	let oldBodyStarted = false;
	const harness = await createBrowserHarness({ fetchImpl: async (input, init) => {
		if (input.startsWith('/reader/api/0/stream/items/ids?')) return Response.json({ itemRefs: [{ id: String(++roots) }] });
		if (input.endsWith('/contents') && init?.body?.getAll('i').includes('2')) {
			oldBodyStarted = true;
			return oldBody.promise;
		}
		return browserRegressionResponse(input, init);
	} });
	await harness.elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => harness.elements.get('reader-title')?.textContent === 'Article 1');
	harness.dispatchDocumentEvent('visibilitychange');
	await waitForBrowserCondition(() => oldBodyStarted);
	harness.dispatchDocumentEvent('visibilitychange');
	await waitForBrowserCondition(() => harness.elements.get('reader-title')?.textContent === 'Article 3');
	oldBody.resolve(new Response('Temporary failure', { status: 503 }));
	await flushBrowserTasks();
	assert.equal(harness.elements.get('reader-title')?.textContent, 'Article 3');
	assert.equal(harness.elements.get('articles-status')?.textContent, '1 article');
});

test('mark-all ignores an older count response after native bulk cleanup', async (t) => {
 const oldCounts = createDeferred<Response>();
 let countRequests = 0;
 const { database, harness } = await createStatefulArticleBrowser({ fetchOverride: async (input, _init, next) => {
  if (input.endsWith('/unread-count') && ++countRequests === 2) return oldCounts.promise;
  return next();
 } });
 t.after(() => database.close());
 harness.dispatchDocumentEvent('visibilitychange');
 await waitForBrowserCondition(() => countRequests === 2);
 harness.elements.get('mark-all-as-read-button')!.dispatch('click');
 await waitForBrowserCondition(() => findListButtonByViewId(harness.elements.get('views-list'), 'unread')!.textContent === 'Unread0', 100);
 oldCounts.resolve(Response.json({ unreadcounts: [{ id: 'feed/1', count: 4 }, { id: 'user/-/state/com.google/reading-list', count: 4 }] }));
 await flushBrowserTasks();
 assert.equal(findListButtonByViewId(harness.elements.get('views-list'), 'unread')!.textContent, 'Unread0');
 assert.equal(harness.elements.get('mark-all-as-read-button')!.disabled, true);
});

test('Today selects an already cached article and supports keyboard navigation without another body request', async () => {
	const now = new Date(2026, 9, 2, 12).getTime();
	let bodyRequests = 0;
	let streamPages = 0;
	const harness = await createBrowserHarness({ now, fetchImpl: async (input, init) => {
		if (input.startsWith('/reader/api/0/stream/contents?')) {
			streamPages += 1;
			return Response.json({ items: ['1', '2'].map((id) => browserRegressionItem(id, Math.floor(now / 1000))) });
		}
		if (input.startsWith('/reader/api/0/stream/items/ids?')) return Response.json({ itemRefs: [{ id: '1' }, { id: '2' }] });
		if (input.endsWith('/contents')) bodyRequests += 1;
		return browserRegressionResponse(input, init, Math.floor(now / 1000));
	} });
	await harness.elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => harness.elements.get('reader-title')?.textContent === 'Article 1');
	findListButtonByViewId(harness.elements.get('views-list'), 'today')?.dispatch('click');
	await flushBrowserTasks();
	assert.equal(harness.elements.get('reader-title')?.textContent, 'Article 1');
	assert.equal(findListButtonByItemId(harness.elements.get('articles-list'), '1')?.classList.contains('is-active'), true);
	assert.equal(harness.dispatchKeydown('j'), true);
	await waitForBrowserCondition(() => harness.elements.get('reader-title')?.textContent === 'Article 2');
	assert.equal(streamPages, 2);
	assert.equal(bodyRequests, 0);
});

for (const returnToCachedToday of [false, true]) {
	test(`offline Today removes yesterday's rows and selection after midnight${returnToCachedToday ? ' when returning to the cached view' : ' on foreground'}`, async () => {
		let now = new Date(2026, 9, 2, 23, 50).getTime();
		const published = Math.floor(now / 1000);
		let networkRequests = 0;
		const harness = await createBrowserHarness({ now: () => now, fetchImpl: async (input, init) => {
			networkRequests += 1;
			if (input.startsWith('/reader/api/0/stream/items/ids?')) return Response.json({ itemRefs: [{ id: '1' }] });
			return browserRegressionResponse(input, init, published);
		} });
		await harness.elements.get('login-form')?.dispatch('submit');
		await waitForBrowserCondition(() => harness.elements.get('reader-title')?.textContent === 'Article 1');
		findListButtonByViewId(harness.elements.get('views-list'), 'today')?.dispatch('click');
		await flushBrowserTasks();
		findListButtonByItemId(harness.elements.get('articles-list'), '1')?.dispatch('click');
		await waitForBrowserCondition(() => harness.elements.get('reader-title')?.textContent === 'Article 1');
		if (returnToCachedToday) {
			findListButtonByViewId(harness.elements.get('views-list'), 'all')?.dispatch('click');
			await flushBrowserTasks();
		}
		now = new Date(2026, 9, 3, 0, 10).getTime();
		harness.setOnline(false);
		const requestsBeforeForeground = networkRequests;
		if (returnToCachedToday) findListButtonByViewId(harness.elements.get('views-list'), 'today')?.dispatch('click');
		else harness.dispatchDocumentEvent('visibilitychange');
		await flushBrowserTasks();
		assert.equal(harness.elements.get('articles-list')?.children.length, 0);
		assert.equal(harness.elements.get('reader-title')?.textContent, 'Select an article');
		assert.equal(harness.elements.get('articles-status')?.textContent, 'Offline · showing cached articles.');
		assert.equal(networkRequests, requestsBeforeForeground);
		findListButtonByViewId(harness.elements.get('views-list'), 'all')?.dispatch('click');
		await flushBrowserTasks();
		assert.equal(harness.elements.get('reader-title')?.textContent, 'Article 1');
		assert.equal(harness.elements.get('articles-list')?.children.length, 1);
		assert.equal(networkRequests, requestsBeforeForeground);
	});
}

for (const oldStatus of [200, 503, 401]) {
 for (const newMutationPending of [false, true]) {
  test(`old mark-all ${oldStatus} cannot affect a same-token session${newMutationPending ? ' with another bulk write pending' : ''}`, async (t) => {
   const oldWrite = createDeferred<Response>();
   const newWrite = createDeferred<Response>();
   let writes = 0;
   let newMutationId = '';
   const { database, harness } = await createStatefulArticleBrowser({ fetchOverride: async (input, init, next) => {
    if (input.endsWith('/mutations')) {
     writes += 1;
     const mutation = JSON.parse(init!.body as string).mutations[0];
     if (writes === 1) return oldWrite.promise;
     newMutationId = mutation.id;
     return newWrite.promise;
    }
    return next();
   } });
   t.after(() => database.close());
   harness.elements.get('mark-all-as-read-button')!.dispatch('click');
   await waitForBrowserCondition(() => writes === 1, 100);
   harness.elements.get('logout-button')!.dispatch('click');
   await harness.elements.get('login-form')!.dispatch('submit');
   await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Story 3', 100);
   if (newMutationPending) {
    harness.elements.get('mark-all-as-read-button')!.dispatch('click');
    await waitForBrowserCondition(() => writes === 2, 100);
   }
   oldWrite.resolve(new Response('Old response', { status: oldStatus }));
   await flushBrowserTasks();
   assert.equal(harness.elements.get('reader-shell')!.classList.contains('hidden'), false);
   assert.equal(harness.elements.get('mark-all-as-read-button')!.disabled, newMutationPending);
   assert.equal(harness.elements.get('reader-title')!.textContent, 'Story 3');
   if (newMutationPending) {
    assert.match(harness.elements.get('article-query-status')!.textContent, /Marking read/);
    newWrite.resolve(Response.json({ results: [{ mutationId: newMutationId, status: 'applied' }] }));
    await waitForBrowserCondition(() => harness.elements.get('undo-article-button')!.disabled === false, 100);
   }
  });
 }
}

for (const ignoresAbort of [false, true]) {
	test(`clearing a session aborts old body jobs and preserves the concurrency cap${ignoresAbort ? ' when a transport ignores cancellation' : ''}`, async () => {
		const oldBodies = [createDeferred<Response>(), createDeferred<Response>()];
		const signals: AbortSignal[] = [];
		let loginCount = 0;
		let oldBodyRequests = 0;
		let newBodyRequests = 0;
		let activeBodies = 0;
		let maxActiveBodies = 0;
		let newBodySignal: AbortSignal | undefined;
		let roots = 0;
		const harness = await createBrowserHarness({ fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin') return new Response(`Auth=pigeon/account-${++loginCount}`);
			const sessionIds = loginCount === 1 ? Array.from({ length: 50 }, (_, index) => String(index + 1)) : ['100'];
			if (input.startsWith('/reader/api/0/stream/contents?')) {
				return Response.json({ items: sessionIds.map((id) => browserRegressionItem(id, 1_742_460_800)) });
			}
			if (input.startsWith('/reader/api/0/stream/items/ids?')) {
				roots += 1;
				return Response.json({ itemRefs: sessionIds.map((id) => ({ id })) });
			}
			if (input.endsWith('/contents')) {
				activeBodies += 1;
				maxActiveBodies = Math.max(maxActiveBodies, activeBodies);
				if (init?.headers?.Authorization?.endsWith('account-1')) {
					const pending = oldBodies[oldBodyRequests++];
					if (init.signal) {
						signals.push(init.signal);
						if (!ignoresAbort) init.signal.addEventListener('abort', () => pending.reject(new DOMException('Request aborted', 'AbortError')), { once: true });
					}
					return pending.promise.finally(() => { activeBodies -= 1; });
				}
				newBodyRequests += 1;
				newBodySignal = init?.signal;
				activeBodies -= 1;
				return Response.json({ items: [browserRegressionItem('100', 1_742_460_800)] });
			}
			return browserRegressionResponse(input, init);
		} });
		await harness.elements.get('login-form')?.dispatch('submit');
		await waitForBrowserCondition(() => harness.elements.get('reader-title')?.textContent === 'Article 1');
		assert.equal(oldBodyRequests, 0);
		harness.dispatchDocumentEvent('visibilitychange');
		await waitForBrowserCondition(() => oldBodyRequests === 2);
		await harness.elements.get('logout-button')?.dispatch('click');
		assert.equal(signals.length, 2);
		assert.ok(signals.every((signal) => signal.aborted));
		await harness.elements.get('login-form')?.dispatch('submit');
		await waitForBrowserCondition(() => harness.elements.get('reader-title')?.textContent === 'Article 100');
		assert.equal(newBodyRequests, 0);
		harness.dispatchDocumentEvent('visibilitychange');
		await waitForBrowserCondition(() => roots === 2);
		if (ignoresAbort) {
			await flushBrowserTasks();
			assert.equal(newBodyRequests, 0);
			oldBodies[0].resolve(Response.json({ items: [browserRegressionItem('1', 1_742_460_800)] }));
		}
		await waitForBrowserCondition(() => newBodyRequests === 1);
		assert.equal(harness.elements.get('reader-title')?.textContent, 'Article 100');
		assert.equal(newBodySignal?.aborted, false);
		assert.equal(maxActiveBodies, 2);
		if (ignoresAbort) {
			oldBodies[1].resolve(Response.json({ items: [browserRegressionItem('100', 1_742_460_800)] .map((item) => ({ ...item, title: 'Old account body' })) }));
			await flushBrowserTasks();
			assert.equal(harness.elements.get('reader-title')?.textContent, 'Article 100');
		}
	});
}

for (const oldBodyStatus of [200, 503]) {
	test(`settling an inactive view body request ${oldBodyStatus} restores current pagination controls without moving its list`, async () => {
		const oldBody = createDeferred<Response>();
		let oldBodyStarted = false;
		let allRoots = 0;
		let pages = 0;
		let activeBodies = 0;
		let maxActiveBodies = 0;
		const rows = (ids: string[]) => ids.map((id) => browserRegressionItem(id, 1_742_460_800));
		const harness = await createBrowserHarness({ fetchImpl: async (input, init) => {
			if (input.endsWith('/subscription/list')) return Response.json({ subscriptions: [{ id: 'feed/1', title: 'Alpha' }] });
			if (input.startsWith('/reader/api/0/stream/items/ids?')) {
				const url = new URL(`https://test${input}`);
				if (url.searchParams.get('s') === 'feed/1') return Response.json({ itemRefs: Array.from({ length: 50 }, (_, index) => ({ id: String(index + 1001) })) });
				if (url.searchParams.get('c')) {
					pages += 1;
					return Response.json({ itemRefs: [{ id: '51' }] });
				}
				allRoots += 1;
				return Response.json({ itemRefs: Array.from({ length: 50 }, (_, index) => ({ id: String(index + 1) })), continuation: 'more-all' });
			}
			if (input.endsWith('/contents')) {
				activeBodies += 1;
				maxActiveBodies = Math.max(maxActiveBodies, activeBodies);
				const ids = (init?.body?.getAll('i') ?? []).map(String);
				if (ids.includes('1001')) {
					oldBodyStarted = true;
					return oldBody.promise.finally(() => { activeBodies -= 1; });
				}
				activeBodies -= 1;
				return Response.json({ items: rows(ids) });
			}
			return browserRegressionResponse(input, init);
		} });
		await harness.elements.get('login-form')?.dispatch('submit');
		await waitForBrowserCondition(() => harness.elements.get('reader-title')?.textContent === 'Article 1');
		findListButtonByViewId(harness.elements.get('feeds-list'), 'feed/1')?.dispatch('click');
		await waitForBrowserCondition(() => oldBodyStarted);
		findListButtonByViewId(harness.elements.get('views-list'), 'all')?.dispatch('click');
		await waitForBrowserCondition(() => allRoots === 2 && Boolean(findListButtonByItemId(harness.elements.get('articles-list'), '50')));
		await flushBrowserTasks();
		const list = harness.elements.get('articles-list-shell');
		if (list) list.scrollTop = 180;
		oldBody.resolve(oldBodyStatus === 200
			? Response.json({ items: rows(Array.from({ length: 20 }, (_, index) => String(index + 1001))) })
			: new Response('Old view failure', { status: oldBodyStatus }));
		await flushBrowserTasks();
		assert.equal(harness.elements.get('load-more-button')?.disabled, false);
		assert.equal(list?.scrollTop, 180);
		assert.equal(harness.elements.get('articles-status')?.textContent, '50 articles');
		assert.equal(harness.elements.get('articles-heading')?.textContent, 'All items');
		harness.elements.get('load-more-button')?.dispatch('click');
		await waitForBrowserCondition(() => Boolean(findListButtonByItemId(harness.elements.get('articles-list'), '51')));
		await flushBrowserTasks();
		assert.equal(pages, 1);
		assert.equal(harness.elements.get('articles-status')?.textContent, '51 articles');
		assert.equal(harness.elements.get('load-more-button')?.disabled, false);
		assert.equal(maxActiveBodies, 2);
	});
}


for (const clockChange of ['midnight', 'timezone']) {
	for (const operation of ['root', 'page', 'body']) {
		for (const failed of [false, true]) {
			test(`Today reconciles the reader after a held ${operation} ${failed ? 'failure' : 'success'} across ${clockChange}`, async () => {
				const previousTimezone = process.env.TZ;
				process.env.TZ = 'America/New_York';
				try {
					let now = Date.parse('2026-10-03T03:55:00Z');
					const oldPublished = clockChange === 'midnight' ? now / 1000 : Date.parse('2026-10-02T23:00:00Z') / 1000;
					const newPublished = Date.parse(clockChange === 'midnight' ? '2026-10-03T04:00:01Z' : '2026-10-03T00:00:01Z') / 1000;
					const held = createDeferred<Response>();
					let roots = 0;
					let requestHeld = false;
					const harness = await createBrowserHarness({ now: () => now, fetchImpl: async (input, init) => {
						if (input.startsWith('/reader/api/0/stream/items/ids?')) {
							const continuation = new URL(`https://test${input}`).searchParams.get('c');
							if (continuation) {
								if (operation === 'page') { requestHeld = true; return held.promise; }
								return Response.json({ itemRefs: [{ id: '2' }] });
							}
							roots += 1;
							if (operation === 'root' && roots === 3) { requestHeld = true; return held.promise; }
							return Response.json({ itemRefs: [{ id: '1' }], ...(roots === 2 && operation !== 'root' ? { continuation: 'older' } : {}) });
						}
						if (input.endsWith('/contents')) {
							const ids = (init?.body?.getAll('i') ?? []).map(String);
							if (operation === 'body' && ids.includes('2')) { requestHeld = true; return held.promise; }
							return Response.json({ items: ids.map((id) => browserRegressionItem(id, id === '1' ? oldPublished : newPublished)) });
						}
						return browserRegressionResponse(input, init);
					} });
					await harness.elements.get('login-form')?.dispatch('submit');
					await waitForBrowserCondition(() => harness.elements.get('reader-title')?.textContent === 'Article 1');
					findListButtonByViewId(harness.elements.get('views-list'), 'today')?.dispatch('click');
					await waitForBrowserCondition(() => roots === 2);
					if (operation === 'root') {
						await flushBrowserTasks();
						harness.dispatchDocumentEvent('visibilitychange');
					}
					await waitForBrowserCondition(() => requestHeld);
					const list = harness.elements.get('articles-list-shell');
					assert.ok(list);
					list.scrollTop = 63;
					if (clockChange === 'midnight') now = Date.parse('2026-10-03T04:05:00Z');
					else process.env.TZ = 'UTC';
					held.resolve(failed ? new Response('Unavailable', { status: 503 }) : Response.json(operation === 'body'
						? { items: [browserRegressionItem('2', newPublished)] }
						: { itemRefs: [{ id: '2' }] }));
					await flushBrowserTasks();
					if (failed) {
						assert.equal(harness.elements.get('articles-list')?.children.length, operation === 'body' ? 1 : 0);
						if (operation === 'body') assert.match(harness.elements.get('articles-list')?.textContent ?? '', /Loading article/);
						assert.equal(harness.elements.get('reader-title')?.textContent, 'Select an article');
						assert.equal(harness.elements.get('reader-frame')?.srcdoc.includes('Body 1'), false);
						assert.equal(harness.elements.get('articles-status')?.textContent, operation === 'root'
							? 'Refresh failed · showing cached articles.' : operation === 'page' ? 'Could not load more articles.' : 'Could not load article bodies.');
					} else {
						assert.equal(harness.elements.get('articles-list')?.children.length, 1);
						assert.equal(harness.elements.get('reader-title')?.textContent, 'Article 2');
						assert.equal(harness.elements.get('articles-status')?.textContent, '1 article');
					}
					assert.equal(list.scrollTop, 63);
				} finally {
					if (previousTimezone === undefined) delete process.env.TZ;
					else process.env.TZ = previousTimezone;
				}
			});
		}
	}
}


for (const change of ['unsubscribe', 'delete', 'unchanged', 'replace']) {
	test(`completed authoritative pagination reconciles a large cached tail after ${change}`, async () => {
		const initialIds = Array.from({ length: 650 }, (_, index) => String(index + 1));
		const currentIds = change === 'unsubscribe' ? initialIds.slice(0, 300)
			: change === 'delete' ? initialIds.filter((id) => id !== '2' && id !== '600')
			: change === 'replace' ? initialIds.map((id) => String(Number(id) + 650)) : initialIds;
		let refreshed = false;
		let duplicatePageSent = false;
		const heldDuplicatePage = createDeferred<Response>();
		const bodyRequests: string[][] = [];
		const harness = await createBrowserHarness({ fetchImpl: async (input, init) => {
			if (input.startsWith('/reader/api/0/stream/items/ids?')) {
				const cursor = new URL(`https://test${input}`).searchParams.get('c');
				const ids = refreshed ? currentIds : initialIds;
				if (refreshed && cursor === '50' && !duplicatePageSent) {
					duplicatePageSent = true;
					return heldDuplicatePage.promise;
				}
				const offset = cursor === 'duplicate-page' ? 50 : Number(cursor || 0);
				return Response.json({ itemRefs: ids.slice(offset, offset + 50).map((id) => ({ id })),
					...(offset + 50 < ids.length ? { continuation: String(offset + 50) } : {}) });
			}
			if (input.endsWith('/contents')) bodyRequests.push((init?.body?.getAll('i') ?? []).map(String));
			return browserRegressionResponse(input, init);
		} });
		await harness.elements.get('login-form')?.dispatch('submit');
		await waitForBrowserCondition(() => harness.elements.get('reader-title')?.textContent === 'Article 1');
		assert.deepEqual(await collectBrowserWindowIds(harness), initialIds);
		harness.elements.get('article-newer-button')!.dispatch('click');
		await waitForTodayWindow(harness);
		findListButtonByItemId(harness.elements.get('articles-list'), '600')?.dispatch('click');
		await waitForBrowserCondition(() => harness.elements.get('reader-title')?.textContent === 'Article 600');
		refreshed = true;
		harness.dispatchDocumentEvent('visibilitychange');
		await waitForBrowserCondition(() => duplicatePageSent, 100);
		assert.ok(findListButtonByItemId(harness.elements.get('articles-list'), '600'), 'retain the cached selection while current pagination is incomplete');
		heldDuplicatePage.resolve(Response.json({ itemRefs: currentIds.slice(0, 50).map((id) => ({ id })), continuation: 'duplicate-page' }));
		const completeIds = await collectBrowserWindowIds(harness);
		assert.deepEqual(completeIds, currentIds);
		assert.equal(duplicatePageSent, true);
		for (const id of ['1', '2', '600', '650', '651', '1300']) {
			assert.equal(completeIds.includes(id), currentIds.includes(id), id);
		}
		const expectedSelection = harness.elements.get('reader-title')!.textContent.replace('Article ', '');
		assert.ok(currentIds.includes(expectedSelection));
		assert.ok(renderedArticleIds(harness).includes(expectedSelection));
		assert.ok(harness.elements.get('reader-frame')?.srcdoc.includes(`<p>Body ${expectedSelection}</p>`), 'the surviving selection has a full body, even if its cache entry was evicted');
		assert.ok(bodyRequests.some((ids) => ids.includes(expectedSelection)), 'the selected survivor was hydrated');
	});
}


test('a failed continuation keeps provisional cached rows and retry reconciles completed membership', async () => {
	let refreshed = false;
	let failed = false;
	const harness = await createBrowserHarness({ fetchImpl: async (input, init) => {
		if (input.startsWith('/reader/api/0/stream/items/ids?')) {
			const continuation = new URL(`https://test${input}`).searchParams.get('c');
			if (continuation) {
				if (!failed) { failed = true; return new Response('Unavailable', { status: 503 }); }
				return Response.json({ itemRefs: [{ id: '3' }] });
			}
			return Response.json(refreshed ? { itemRefs: [{ id: '2' }], continuation: 'tail' }
				: { itemRefs: [{ id: '1' }, { id: '2' }, { id: '3' }] });
		}
		return browserRegressionResponse(input, init);
	} });
	await harness.elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => harness.elements.get('reader-title')?.textContent === 'Article 1');
	refreshed = true;
	harness.dispatchDocumentEvent('visibilitychange');
	await flushBrowserTasks();
	const list = harness.elements.get('articles-list-shell');
	assert.ok(list);
	list.scrollTop = 73;
	harness.elements.get('load-more-button')?.dispatch('click');
	await waitForBrowserCondition(() => harness.elements.get('articles-status')?.textContent === 'Could not load more articles.');
	assert.equal(harness.elements.get('articles-list')?.children.length, 3);
	assert.equal(harness.elements.get('reader-title')?.textContent, 'Article 1');
	assert.equal(harness.elements.get('load-more-button')?.classList.contains('hidden'), false);
	assert.equal(harness.elements.get('load-more-button')?.disabled, false);
	harness.elements.get('load-more-button')?.dispatch('click');
	await waitForBrowserCondition(() => harness.elements.get('load-more-button')?.classList.contains('hidden') === true);
	assert.equal(harness.elements.get('articles-list')?.children.length, 2);
	assert.equal(findListButtonByItemId(harness.elements.get('articles-list'), '1'), undefined);
	assert.equal(harness.elements.get('reader-title')?.textContent, 'Article 2');
	assert.equal(list.scrollTop, 73);
});

test('completed Today pagination removes provisional current-day rows and keeps its date filter', async () => {
	const now = new Date(2026, 9, 2, 12).getTime();
	const bounds = getLocalDayBounds(new Date(now));
	let roots = 0;
	let refreshed = false;
	const harness = await createBrowserHarness({ now, fetchImpl: async (input, init) => {
		if (input.startsWith('/reader/api/0/stream/items/ids?')) {
			if (new URL(`https://test${input}`).searchParams.has('c')) return Response.json({ itemRefs: [{ id: '4' }, { id: '2' }] });
			roots += 1;
			return Response.json(roots === 1 ? { itemRefs: [] } : refreshed
				? { itemRefs: [{ id: '3' }], continuation: 'tail' }
				: { itemRefs: [{ id: '1' }, { id: '2' }] });
		}
		if (input.endsWith('/contents')) return Response.json({ items: (init?.body?.getAll('i') ?? []).map(String)
			.map((id) => browserRegressionItem(id, id === '2' ? bounds.startSeconds - 1 : bounds.startSeconds + 1)) });
		return browserRegressionResponse(input, init);
	} });
	await harness.elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => roots === 1);
	findListButtonByViewId(harness.elements.get('views-list'), 'today')?.dispatch('click');
	await waitForBrowserCondition(() => harness.elements.get('reader-title')?.textContent === 'Article 1');
	refreshed = true;
	harness.dispatchDocumentEvent('visibilitychange');
	await waitForBrowserCondition(() => Boolean(findListButtonByItemId(harness.elements.get('articles-list'), '4')));
	await flushBrowserTasks();
	assert.equal(harness.elements.get('articles-list')?.children.length, 2);
	assert.equal(findListButtonByItemId(harness.elements.get('articles-list'), '1'), undefined);
	assert.equal(findListButtonByItemId(harness.elements.get('articles-list'), '2'), undefined);
	assert.equal(harness.elements.get('reader-title')?.textContent, 'Article 3');
});

function browserRetryStatus(title = 'Current status') {
	return { configuredBaseUrl: title, healthUrl: 'https://pigeon.example/health',
		feeds: { activeCount: 1, emailCount: 0, rssCount: 1, failingRssCount: 1, failing: [] },
		items: { totalCount: 1, unreadCount: 1, starredCount: 0 }, rss: {},
		syncHealth: { healthyCount: 0, dueCount: 1, backedOffCount: 0, feeds: [
			{ feedKey: 'retry-source', title, state: 'due', canRetry: true },
		] } };
}

for (const sameToken of [false, true]) {
	for (const outcome of ['success', 'failure', 'rejection']) {
		for (const currentRetryActive of [false, true]) {
			test(`old Settings retry ${outcome} preserves the ${sameToken ? 'same-token' : 'new-token'} session with current retry ${currentRetryActive}`, async () => {
				const oldRetry = createDeferred<Response>();
				const currentRetry = createDeferred<Response>();
				let logins = 0, statusCalls = 0, retries = 0;
				const h = await createBrowserHarness({ fetchImpl: async (input, init) => {
					if (input === '/accounts/ClientLogin') {
						logins += 1;
						return new Response(`Auth=pigeon/${sameToken ? 'stable-token' : `session-${logins}`}`);
					}
					if (input === '/app/status') {
						statusCalls += 1;
						if (statusCalls === 2 && !currentRetryActive) return new Response('Unavailable', { status: 503 });
						return Response.json(browserRetryStatus(`Session ${logins} status`));
					}
					if (input === '/app/status/retry') {
						retries += 1;
						return retries === 1 ? oldRetry.promise : currentRetry.promise;
					}
					if (input.includes('/stream/items/ids?')) return Response.json({ itemRefs: [] });
					return browserRegressionResponse(input, init);
				} });
				await h.elements.get('login-form')?.dispatch('submit');
				await flushBrowserTasks();
				h.elements.get('settings-button')?.dispatch('click');
				await waitForBrowserCondition(() => Boolean(findDescendantByClass(h.elements.get('settings-content'), 'secondary-button')));
				const oldButton = findDescendantByClass(h.elements.get('settings-content'), 'secondary-button');
				assert.ok(oldButton);
				const oldOperation = oldButton.dispatch('click');
				await waitForBrowserCondition(() => retries === 1);
				h.elements.get('clear-session-button')?.dispatch('click');
				h.elements.get('password-input')!.value = 'secret-password';
				await h.elements.get('login-form')?.dispatch('submit');
				await flushBrowserTasks();
				h.elements.get('settings-button')?.dispatch('click');
				await waitForBrowserCondition(() => statusCalls === 2);
				await flushBrowserTasks();
				const currentButton = findDescendantByClass(h.elements.get('settings-content'), 'secondary-button');
				let currentOperation: unknown;
				if (currentRetryActive) {
					assert.ok(currentButton);
					currentOperation = currentButton.dispatch('click');
					await waitForBrowserCondition(() => retries === 2);
					assert.equal(currentButton.disabled, true);
				} else assert.equal(h.elements.get('settings-content')?.textContent, 'Could not load status.');
				const before = h.elements.get('settings-content')?.textContent;
				if (outcome === 'rejection') oldRetry.reject(new TypeError('Old interrupted connection'));
				else oldRetry.resolve(new Response(outcome === 'success' ? 'OK' : 'Unavailable', { status: outcome === 'success' ? 200 : 503 }));
				await oldOperation;
				await flushBrowserTasks();
				assert.equal(statusCalls, 2, 'old retry must not request the new session status');
				assert.equal(h.elements.get('settings-content')?.textContent, before);
				assert.equal(h.elements.get('reader-shell')?.classList.contains('hidden'), false);
				if (currentRetryActive) {
					assert.equal(findDescendantByClass(h.elements.get('settings-content'), 'secondary-button'), currentButton);
					assert.equal(currentButton!.disabled, true);
					assert.equal(currentButton!.textContent, 'Queuing…');
					currentRetry.resolve(new Response('OK'));
					await currentOperation;
					await flushBrowserTasks();
					assert.equal(statusCalls, 3, 'the current retry refreshes its own status');
					assert.match(h.elements.get('settings-content')?.textContent ?? '', /Session 2 status/);
				}
			});
		}
	}
}

test('current Settings retry failure remains retryable and successful retry refreshes status', async () => {
	let retries = 0, statuses = 0;
	const h = await createBrowserHarness({ fetchImpl: async (input, init) => {
		if (input === '/app/status') { statuses += 1; return Response.json(browserRetryStatus()); }
		if (input === '/app/status/retry') { retries += 1; return new Response(retries === 1 ? 'Unavailable' : 'OK', { status: retries === 1 ? 503 : 200 }); }
		if (input.includes('/stream/items/ids?')) return Response.json({ itemRefs: [] });
		return browserRegressionResponse(input, init);
	} });
	await h.elements.get('login-form')?.dispatch('submit');
	await flushBrowserTasks();
	h.elements.get('settings-button')?.dispatch('click');
	await waitForBrowserCondition(() => Boolean(findDescendantByClass(h.elements.get('settings-content'), 'secondary-button')));
	const button = findDescendantByClass(h.elements.get('settings-content'), 'secondary-button');
	assert.ok(button);
	await button.dispatch('click');
	assert.equal(button.textContent, 'Retry failed');
	assert.equal(button.disabled, false);
	await button.dispatch('click');
	await flushBrowserTasks();
	assert.equal(retries, 2);
	assert.equal(statuses, 2);
	assert.match(h.elements.get('settings-content')?.textContent ?? '', /Current status/);
});

// Plain stream first visits now arrive fully hydrated, so a membership page
// whose bodies load in chunks only happens on the search/filter/sort path.
function queryMembershipCursor(input: string): string | null | undefined {
	if (!input.includes('/stream/items/ids?') && !input.startsWith('/api/v1/browser/articles?')) return undefined;
	const params = new URL(`https://test${input}`).searchParams;
	return params.get('c') ?? params.get('continuation');
}

async function openOldestFirstQuery(harness: Awaited<ReturnType<typeof createBrowserHarness>>) {
	await waitForBrowserCondition(() => harness.elements.get('articles-status')?.textContent === 'No articles in All items.');
	harness.elements.get('article-sort-select')!.value = 'oldest';
	harness.elements.get('article-sort-select')!.dispatch('change');
	await flushBrowserTasks();
}

for (const selectedTail of [false, true]) {
	for (const failCurrentPage of [false, true]) {
		test(`unconfirmed ${selectedTail ? 'selected' : 'unselected'} deleted tail cannot block current pagination with page failure ${failCurrentPage}`, async () => {
			let refreshed = false, roots = 0, pages = 0, staleBodyRequests = 0;
			const ids = Array.from({ length: 60 }, (_, index) => String(index + 1));
			const currentIds = ids.filter((id) => id !== '41');
			const h = await createBrowserHarness({ fetchImpl: async (input, init) => {
				if (input.startsWith('/reader/api/0/stream/contents?')) return Response.json({ items: [] });
				const cursor = queryMembershipCursor(input);
				if (cursor !== undefined) {
					if (cursor) {
						pages += 1;
						if (failCurrentPage && pages === 1) return new Response('Unavailable', { status: 503 });
						return Response.json({ itemRefs: currentIds.slice(50).map((id) => ({ id })) });
					}
					roots += 1;
					return Response.json({ itemRefs: (refreshed ? currentIds : ids).slice(0, 50).map((id) => ({ id })), continuation: refreshed ? 'current-page' : 'old-page' });
				}
				if (input.endsWith('/contents')) {
					const requested = (init?.body?.getAll('i') ?? []).map(String);
					if (requested.includes('41')) {
						staleBodyRequests += 1;
						if (selectedTail) return new Response('Unavailable', { status: 503 });
					}
					return Response.json({ items: requested.filter((id) => !refreshed || id !== '41').map((id) => browserRegressionItem(id)) });
				}
				return browserRegressionResponse(input, init);
			} });
			await h.elements.get('login-form')?.dispatch('submit');
			await openOldestFirstQuery(h);
			await waitForBrowserCondition(() => h.elements.get('reader-title')?.textContent === 'Article 1');
			assert.match(findListButtonByItemId(h.elements.get('articles-list'), '41')?.textContent ?? '', /Loading/);
			if (selectedTail) {
				findListButtonByItemId(h.elements.get('articles-list'), '41')?.dispatch('click');
				await waitForBrowserCondition(() => h.elements.get('articles-status')?.textContent === 'Could not load article bodies.');
			}
			refreshed = true;
			h.dispatchDocumentEvent('visibilitychange');
			await waitForBrowserCondition(() => roots === 2 && Boolean(findListButtonByItemId(h.elements.get('articles-list'), '51')));
			await waitForBrowserCondition(() => !h.elements.get('load-more-button')!.disabled);
			const staleRequestsBeforePaging = staleBodyRequests;
			assert.ok(findListButtonByItemId(h.elements.get('articles-list'), '41'), 'partial root retains the old tail');
			h.elements.get('load-more-button')?.dispatch('click');
			await flushBrowserTasks();
			assert.equal(pages, 1, 'current continuation must advance before provisional body retry');
			if (failCurrentPage) {
				await waitForBrowserCondition(() => h.elements.get('articles-status')?.textContent === 'Could not load more articles.');
				assert.ok(findListButtonByItemId(h.elements.get('articles-list'), '41'), 'failed page keeps provisional rows');
				assert.equal(h.elements.get('load-more-button')?.disabled, false);
				h.elements.get('load-more-button')?.dispatch('click');
			}
			await waitForBrowserCondition(() => h.elements.get('load-more-button')?.classList.contains('hidden') === true);
			assert.equal(h.elements.get('articles-list')?.children.length, 59);
			assert.equal(findListButtonByItemId(h.elements.get('articles-list'), '41'), undefined);
			assert.match(findListButtonByItemId(h.elements.get('articles-list'), '60')?.textContent ?? '', /Article 60/);
			assert.equal(h.elements.get('reader-title')?.textContent, 'Article 1');
			assert.equal(staleBodyRequests, staleRequestsBeforePaging);
		});
	}
}

test('confirmed current body failures remain visible and retry before membership pagination', async () => {
	let rejectBodies = true, bodyAttempts = 0, pages = 0;
	const h = await createBrowserHarness({ fetchImpl: async (input, init) => {
		if (input.startsWith('/reader/api/0/stream/contents?')) return Response.json({ items: [] });
		const cursor = queryMembershipCursor(input);
		if (cursor !== undefined) {
			if (cursor) pages += 1;
			return Response.json({ itemRefs: [{ id: '1' }, { id: '2' }], continuation: 'current-page' });
		}
		if (input.endsWith('/contents')) {
			bodyAttempts += 1;
			if (rejectBodies) return new Response('Unavailable', { status: 503 });
			return Response.json({ items: (init?.body?.getAll('i') ?? []).map(String).map((id) => browserRegressionItem(id)) });
		}
		return browserRegressionResponse(input, init);
	} });
	await h.elements.get('login-form')?.dispatch('submit');
	await openOldestFirstQuery(h);
	await waitForBrowserCondition(() => h.elements.get('articles-status')?.textContent === 'Could not load article bodies.');
	await h.elements.get('load-more-button')?.dispatch('click');
	await flushBrowserTasks();
	assert.equal(bodyAttempts, 2);
	assert.equal(pages, 0);
	assert.equal(h.elements.get('articles-status')?.textContent, 'Could not load article bodies.');
	rejectBodies = false;
	await h.elements.get('load-more-button')?.dispatch('click');
	await waitForBrowserCondition(() => h.elements.get('reader-title')?.textContent === 'Article 1');
	assert.equal(bodyAttempts, 3);
	assert.equal(pages, 0);
});

test('unhydrated selected provisional survivor loads when its current page confirms membership', async () => {
	let refreshed = false, pages = 0;
	const original = Array.from({ length: 60 }, (_, index) => String(index + 1));
	const current = [...Array.from({ length: 10 }, (_, index) => String(index + 61)), ...original];
	const h = await createBrowserHarness({ fetchImpl: async (input, init) => {
		if (input.startsWith('/reader/api/0/stream/contents?')) return Response.json({ items: [] });
		const cursor = queryMembershipCursor(input);
		if (cursor !== undefined) {
			if (cursor) {
				pages += 1;
				return Response.json({ itemRefs: current.slice(50).map((id) => ({ id })) });
			}
			return Response.json({ itemRefs: (refreshed ? current : original).slice(0, 50).map((id) => ({ id })), continuation: 'current-page' });
		}
		if (input.endsWith('/contents')) {
			const requested = (init?.body?.getAll('i') ?? []).map(String);
			if (requested.includes('41') && pages === 0) return new Response('Unavailable', { status: 503 });
			return Response.json({ items: requested.map((id) => browserRegressionItem(id)) });
		}
		return browserRegressionResponse(input, init);
	} });
	await h.elements.get('login-form')?.dispatch('submit');
	await openOldestFirstQuery(h);
	await waitForBrowserCondition(() => h.elements.get('reader-title')?.textContent === 'Article 1');
	findListButtonByItemId(h.elements.get('articles-list'), '41')?.dispatch('click');
	await waitForBrowserCondition(() => h.elements.get('articles-status')?.textContent === 'Could not load article bodies.');
	refreshed = true;
	h.dispatchDocumentEvent('visibilitychange');
	await waitForBrowserCondition(() => Boolean(findListButtonByItemId(h.elements.get('articles-list'), '61')));
	await waitForBrowserCondition(() => !h.elements.get('load-more-button')!.disabled);
	h.elements.get('load-more-button')?.dispatch('click');
	await flushBrowserTasks();
	assert.equal(pages, 1);
	await waitForBrowserCondition(() => h.elements.get('reader-title')?.textContent === 'Article 41');
	assert.equal(h.elements.get('articles-list')?.children.length, 70);
	assert.match(h.elements.get('reader-frame')?.srcdoc ?? '', /Body 41/);
	assert.equal(h.elements.get('load-more-button')?.classList.contains('hidden'), true);
});
