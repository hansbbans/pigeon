import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { getLocalDayBounds } from '../src/browser-app-client';
import { handleGreaderRequest } from '../src/greader';
import { generateApiToken } from '../src/api-auth';
import {
	browserRegressionItem,
	browserRegressionResponse,
	collectBrowserWindowIds,
	createBrowserHarness,
	createDeferred,
	createLargeTodaySqliteLibrary,
	drainBrowserMembershipPages,
	findListButtonByItemId,
	findListButtonByViewId,
	finishArticleMutation,
	flushBrowserTasks,
	renderedArticleIds,
	setBrowserQuery,
	waitForBrowserCondition,
	waitForTodayWindow,
} from './helpers/browser-app-client-harness';

for (const view of ['all', 'feed']) {
	test(`bounded ${view} windows keep all 2107 real GReader titles and bodies reachable through metadata eviction`, async () => {
		const now = new Date(2026, 9, 2, 12).getTime();
		const count = 2_105;
		const state = createLargeTodaySqliteLibrary(now, count);
		try {
			const token = await generateApiToken('today-test-password');
			let bodyRequests = 0;
			const h = await createBrowserHarness({ now, fetchImpl: async (input, init) => {
				if (input === '/accounts/ClientLogin') return new Response(`Auth=pigeon/${token}`);
				if (input.endsWith('/contents')) bodyRequests += 1;
				return handleGreaderRequest(new Request(`https://pigeon.example${input}`, init as RequestInit), state.env);
			} });
			await h.elements.get('login-form')!.dispatch('submit');
			await waitForBrowserCondition(() => h.elements.get('reader-title')!.textContent === `Story ${count + 1}`);
			if (view === 'feed') {
				findListButtonByViewId(h.elements.get('feeds-list'), 'feed/1')!.dispatch('click');
				await waitForBrowserCondition(() => renderedArticleIds(h).length > 0);
			}
			await drainBrowserMembershipPages(h);
			await waitForBrowserCondition(() => h.getCacheSizes().active === 0 && h.getCacheSizes().queued === 0 && h.getCacheSizes().pending === 0 && !h.getCacheSizes().paging, 1_000);
			assert.equal(h.elements.get('articles-list')!.children.filter((row) => row.textContent.includes('Loading article')).length, 0);
			const seen = new Set<string>();
			for (let page = 0; page < 20; page += 1) {
				const ids = renderedArticleIds(h);
				assert.ok(ids.length <= 200);
				for (const id of ids) {
					assert.ok(findListButtonByItemId(h.elements.get('articles-list'), id)!.textContent.includes(`Story ${id}`));
					seen.add(id);
				}
				if (h.elements.get('article-older-button')!.disabled || h.elements.get('article-page-controls')!.classList.contains('hidden')) break;
				h.elements.get('article-older-button')!.dispatch('click');
				await waitForTodayWindow(h);
			}
			assert.deepEqual([...seen], [String(count + 1), ...Array.from({ length: count }, (_, index) => String(count - index)), String(count + 2)]);
			assert.ok(bodyRequests > 100);
			for (let page = 0; page < 20 && !h.elements.get('article-newer-button')!.disabled; page += 1) {
				h.elements.get('article-newer-button')!.dispatch('click');
				await waitForTodayWindow(h);
			}
			assert.equal(h.elements.get('reader-title')!.textContent, `Story ${count + 1}`);
			assert.ok(h.elements.get('reader-frame')!.srcdoc.includes(`Body ${count + 1}</p>`));
		} finally { state.database.close(); }
	});
}

for (const view of ['unread', 'recent', 'folder']) {
	test(`${view} uses bounded windows without Today date filtering`, async () => {
		const now = new Date(2026, 9, 2, 12).getTime();
		const count = 230;
		const state = createLargeTodaySqliteLibrary(now, count);
		try {
			if (view === 'recent') state.database.exec('UPDATE items SET is_read = 1');
			if (view === 'folder') state.database.exec("UPDATE feeds SET category = 'Today folder'");
			const token = await generateApiToken('today-test-password');
			const h = await createBrowserHarness({ now, fetchImpl: async (input, init) => input === '/accounts/ClientLogin'
				? new Response(`Auth=pigeon/${token}`)
				: handleGreaderRequest(new Request(`https://pigeon.example${input}`, init as RequestInit), state.env) });
			await h.elements.get('login-form')!.dispatch('submit');
			await waitForBrowserCondition(() => h.elements.get('reader-title')!.textContent === `Story ${count + 1}`);
			const id = view === 'folder' ? 'user/-/label/Today folder' : view;
			findListButtonByViewId(h.elements.get(view === 'folder' ? 'folders-list' : 'views-list'), id)!.dispatch('click');
			await waitForBrowserCondition(() => renderedArticleIds(h).length > 0);
			const ids = await collectBrowserWindowIds(h);
			assert.deepEqual(ids, [String(count + 1), ...Array.from({ length: count }, (_, index) => String(count - index)), String(count + 2)]);
			assert.ok(h.elements.get('reader-frame')!.srcdoc.includes('Body'));
		} finally { state.database.close(); }
	});
}

for (const change of ['unsubscribe', 'delete']) {
 test(`Today cached membership reconciles ${change} when authoritative pagination reaches yesterday with a remaining cursor`, async () => {
  const now = new Date(2026, 9, 2, 12).getTime();
  const state = createLargeTodaySqliteLibrary(now, 90);
  try {
   state.database.exec("INSERT INTO feeds (feed_key, display_name) VALUES ('removed-source', 'Removed source'); UPDATE items SET feed_key = 'removed-source' WHERE rowid BETWEEN 80 AND 90");
   const insert = state.database.prepare("INSERT INTO items (id, feed_key, subject, html_content, message_id, received_at) VALUES (?, 'today-source', ?, ?, ?, ?)");
   const start = getLocalDayBounds(new Date(now)).startSeconds;
   for (let i = 0; i < 100; i += 1) insert.run(`old-${i}`, `Older ${i}`, `<p>Older body ${i}</p>`, `older-message-${i}`, new Date((start - 100 - i) * 1000).toISOString());
   const token = await generateApiToken('today-test-password');
   const h = await createBrowserHarness({ now, fetchImpl: async (input, init) => input === '/accounts/ClientLogin'
    ? new Response(`Auth=pigeon/${token}`)
    : handleGreaderRequest(new Request(`https://pigeon.example${input}`, init as RequestInit), state.env) });
   await h.elements.get('login-form')!.dispatch('submit');
   await waitForBrowserCondition(() => h.elements.get('reader-title')!.textContent === 'Story 91');
   findListButtonByViewId(h.elements.get('views-list'), 'today')!.dispatch('click');
   await flushBrowserTasks();
   await waitForTodayWindow(h);
   assert.deepEqual(renderedArticleIds(h), Array.from({ length: 90 }, (_, i) => String(90 - i)));
   findListButtonByItemId(h.elements.get('articles-list'), '80')!.dispatch('click');
   await waitForBrowserCondition(() => h.elements.get('reader-title')!.textContent === 'Story 80');
   findListButtonByViewId(h.elements.get('views-list'), 'all')!.dispatch('click');
   await flushBrowserTasks();
   await waitForTodayWindow(h);
   if (change === 'unsubscribe') state.database.exec("UPDATE feeds SET is_active = 0 WHERE feed_key = 'removed-source'");
   else state.database.exec("DELETE FROM items WHERE feed_key = 'removed-source'");
   findListButtonByViewId(h.elements.get('views-list'), 'today')!.dispatch('click');
   await flushBrowserTasks();
   await waitForTodayWindow(h);
   assert.deepEqual(await collectBrowserWindowIds(h), Array.from({ length: 79 }, (_, i) => String(79 - i)));
   assert.equal(h.elements.get('load-more-button')!.classList.contains('hidden'), true);
   assert.equal(h.elements.get('article-older-button')!.disabled, true);
   const selected = h.elements.get('reader-title')!.textContent.replace('Story ', '');
   assert.ok(renderedArticleIds(h).includes(selected));
   assert.ok(Number(selected) < 80);
   assert.ok(h.elements.get('reader-frame')!.srcdoc.includes(`Body ${selected}</p>`));
  } finally { state.database.close(); }
 });
}

for (const scenario of ['adjacent', 'page failure', 'body failure', 'selection switch', 'view switch', 'same-token account', 'changed-token account']) {
 test(`keyboard next extends a short real-service window safely through ${scenario}`, async () => {
  const now = new Date(2026, 9, 2, 12).getTime();
  const state = createLargeTodaySqliteLibrary(now, 230);
  try {
   let password = 'today-test-password';
   let holdPage = scenario.includes('switch') || scenario.includes('account');
   let failPage = scenario === 'page failure';
   let failBody = false;
   let pageRequested = false;
   let activeBodies = 0;
   let maxBodies = 0;
   const held = createDeferred<Response>();
   const h = await createBrowserHarness({ now, fetchImpl: async (input, init) => {
    if (input === '/accounts/ClientLogin') return new Response(`Auth=pigeon/${await generateApiToken(password)}`);
    const isPage = input.includes('/stream/items/ids?') && new URL(`https://pigeon.example${input}`).searchParams.has('c');
    if (isPage) {
     pageRequested = true;
     if (failPage) { failPage = false; return new Response('Unavailable', { status: 503 }); }
     if (holdPage) { holdPage = false; return held.promise; }
    }
    if (input.endsWith('/contents')) {
     activeBodies += 1; maxBodies = Math.max(maxBodies, activeBodies);
     try { if (failBody) { failBody = false; return new Response('Unavailable', { status: 503 }); }
      return await handleGreaderRequest(new Request(`https://pigeon.example${input}`, init as RequestInit), state.env);
     } finally { activeBodies -= 1; }
    }
    return handleGreaderRequest(new Request(`https://pigeon.example${input}`, init as RequestInit), state.env);
   } });
   await h.elements.get('login-form')!.dispatch('submit');
   await waitForBrowserCondition(() => h.elements.get('reader-title')!.textContent === 'Story 231');
   assert.equal(renderedArticleIds(h).at(-1), '182');
   findListButtonByItemId(h.elements.get('articles-list'), '182')!.dispatch('click');
   await waitForBrowserCondition(() => h.elements.get('reader-frame')!.srcdoc.includes('Body 182</p>'));
   await waitForBrowserCondition(() => h.getCacheSizes().active === 0 && h.getCacheSizes().queued === 0 && h.getCacheSizes().pending === 0);
   failBody = scenario === 'body failure';
   h.dispatchKeydown('j');
   await waitForBrowserCondition(() => pageRequested);
   if (scenario === 'page failure' || scenario === 'body failure') {
    await waitForBrowserCondition(() => h.elements.get('articles-status')!.textContent === (scenario === 'page failure' ? 'Could not load more articles.' : 'Could not load article bodies.'));
    assert.equal(h.elements.get('reader-title')!.textContent, 'Story 182');
    assert.equal(h.elements.get('load-more-button')!.disabled, false);
    if (scenario === 'body failure') { h.elements.get('load-more-button')!.dispatch('click'); await waitForBrowserCondition(() => Boolean(findListButtonByItemId(h.elements.get('articles-list'), '181')?.textContent.includes('Story 181')) && h.getCacheSizes().active === 0 && h.getCacheSizes().pending === 0); }
    h.dispatchKeydown('j');
   } else if (scenario === 'selection switch') {
    findListButtonByItemId(h.elements.get('articles-list'), '230')!.dispatch('click');
    await waitForBrowserCondition(() => h.elements.get('reader-title')!.textContent === 'Story 230');
   } else if (scenario === 'view switch') {
    findListButtonByViewId(h.elements.get('feeds-list'), 'feed/1')!.dispatch('click');
    await waitForBrowserCondition(() => h.elements.get('reader-title')!.textContent === 'Story 231');
   } else if (scenario.includes('account')) {
    h.elements.get('clear-session-button')!.dispatch('click');
    if (scenario === 'changed-token account') { password = 'changed-test-password'; (state.env as { API_PASSWORD: string }).API_PASSWORD = password; }
    h.elements.get('password-input')!.value = password;
    await h.elements.get('login-form')!.dispatch('submit');
    await waitForBrowserCondition(() => h.elements.get('reader-title')!.textContent === 'Story 231');
   }
   if (scenario.includes('switch') || scenario.includes('account')) {
    held.resolve(Response.json({ itemRefs: Array.from({ length: 50 }, (_, i) => ({ id: String(181 - i) })), continuation: 'stale-next' }));
    await flushBrowserTasks(); await flushBrowserTasks();
   }
   const expected = scenario === 'selection switch' ? '230' : scenario === 'view switch' || scenario.includes('account') ? '231' : '181';
   await waitForBrowserCondition(() => h.elements.get('reader-title')!.textContent === `Story ${expected}`);
   assert.ok(renderedArticleIds(h).includes(expected));
   assert.ok(h.elements.get('reader-frame')!.srcdoc.includes(`Body ${expected}</p>`));
   assert.ok(maxBodies <= 2, 'actual body concurrency remains bounded');
   if (expected === '181') { h.dispatchKeydown('k'); await waitForBrowserCondition(() => h.elements.get('reader-title')!.textContent === 'Story 182'); }
  } finally { state.database.close(); }
 });
}

function versionedArticle(id: string, contentVersion: string, categories: string[] = []) {
	// First-party responses omit `summary`; the preview must come from the body.
	return { ...browserRegressionItem(id, 1_742_460_800 + Number(id)), categories, contentVersion };
}

test('a plain stream first visit loads membership and bodies with one stream/contents page and the first-party header', async () => {
	const requests: Array<{ input: string; method: string; client: string | undefined }> = [];
	const harness = await createBrowserHarness({ fetchImpl: async (input, init) => {
		requests.push({ input, method: init?.method ?? 'GET', client: init?.headers?.['X-Pigeon-Client'] });
		if (input.startsWith('/reader/api/0/stream/contents?')) {
			const params = new URL(`https://pigeon.example${input}`).searchParams;
			const ids = params.get('xt') ? ['2'] : ['1', '2', '3'];
			return Response.json({ id: params.get('s'), updated: 1, items: ids.map((id) => versionedArticle(id, 'v1', id === '1' ? ['user/-/state/com.google/read'] : [])) });
		}
		return browserRegressionResponse(input, init);
	} });
	await harness.elements.get('login-form')!.dispatch('submit');
	await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Article 1');
	await flushBrowserTasks();

	const streamPages = requests.filter((request) => request.input.startsWith('/reader/api/0/stream/contents?'));
	assert.equal(streamPages.length, 1);
	const params = new URL(`https://pigeon.example${streamPages[0].input}`).searchParams;
	assert.equal(params.get('s'), 'user/-/state/com.google/reading-list');
	assert.equal(params.get('n'), '50');
	assert.equal(params.has('xt'), false);
	assert.ok(requests.every((request) => request.input === '/accounts/ClientLogin' || request.client === 'pigeon-web/1'),
		'every authenticated request identifies the web client');
	assert.equal(requests.some((request) => request.input.includes('/stream/items/ids?')), false);
	assert.equal(requests.some((request) => request.input.endsWith('/stream/items/contents')), false);
	assert.deepEqual(renderedArticleIds(harness), ['1', '2', '3']);
	assert.equal(harness.getCacheSizes().bodies, 3);
	assert.equal(harness.elements.get('articles-status')!.textContent, '3 articles');
	assert.equal(findListButtonByItemId(harness.elements.get('articles-list'), '1')!.getAttribute('data-read'), 'true');
	assert.match(findListButtonByItemId(harness.elements.get('articles-list'), '2')!.textContent, /Body 2/);
	assert.match(harness.elements.get('reader-frame')!.srcdoc, /Body 1/);
	assert.equal(harness.elements.get('load-more-button')!.classList.contains('hidden'), true);

	findListButtonByViewId(harness.elements.get('views-list'), 'unread')!.dispatch('click');
	await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Article 2');
	const unreadPage = requests.filter((request) => request.input.startsWith('/reader/api/0/stream/contents?')).at(-1)!;
	assert.equal(new URL(`https://pigeon.example${unreadPage.input}`).searchParams.get('xt'), 'user/-/state/com.google/read');
	assert.deepEqual(renderedArticleIds(harness), ['2']);
});

test('first visits with a search, filter, or sort override keep the browser articles path', async () => {
	const requests: string[] = [];
	const harness = await createBrowserHarness({ fetchImpl: async (input, init) => {
		requests.push(input);
		if (input.startsWith('/reader/api/0/stream/contents?')) return Response.json({ items: ['1', '2'].map((id) => versionedArticle(id, 'v1')) });
		if (input.startsWith('/api/v1/browser/articles?')) {
			assert.equal(new URL(`https://pigeon.example${input}`).searchParams.get('q'), 'needle');
			return Response.json({ itemIds: ['7'], continuation: '' });
		}
		return browserRegressionResponse(input, init);
	} });
	await harness.elements.get('login-form')!.dispatch('submit');
	await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Article 1');
	await setBrowserQuery(harness, 'needle');
	await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Article 7');

	assert.equal(requests.filter((input) => input.startsWith('/reader/api/0/stream/contents?')).length, 1);
	assert.equal(requests.filter((input) => input.startsWith('/api/v1/browser/articles?')).length, 1);
	assert.equal(requests.filter((input) => input.endsWith('/stream/items/contents')).length, 1, 'query results still hydrate through chunked body requests');
	assert.deepEqual(renderedArticleIds(harness), ['7']);
});

test('revalidation reuses cached bodies by content version and applies read and star flags from refs', async () => {
	const contentRequests: string[][] = [];
	let idsRequests = 0;
	const harness = await createBrowserHarness({ fetchImpl: async (input, init) => {
		if (input.startsWith('/reader/api/0/stream/contents?')) return Response.json({ items: ['1', '2', '3'].map((id) => versionedArticle(id, 'v1')) });
		if (input.startsWith('/reader/api/0/stream/items/ids?')) {
			idsRequests += 1;
			return Response.json({ itemRefs: [
				{ id: '1', timestampUsec: '1', read: true, starred: false, contentVersion: 'v1' },
				{ id: '2', timestampUsec: '1', read: false, starred: true, contentVersion: 'v2' },
				{ id: '4', timestampUsec: '1', read: false, starred: false, contentVersion: 'v1' },
			] });
		}
		if (input.endsWith('/stream/items/contents')) {
			const ids = (init?.body?.getAll('i') ?? []).map(String);
			contentRequests.push(ids);
			return Response.json({ items: ids.map((id) => ({ ...versionedArticle(id, id === '2' ? 'v2' : 'v1', id === '2' ? ['user/-/state/com.google/starred'] : []), title: id === '2' ? 'Article 2 revised' : `Article ${id}` })) });
		}
		return browserRegressionResponse(input, init);
	} });
	await harness.elements.get('login-form')!.dispatch('submit');
	await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Article 1');
	assert.equal(findListButtonByItemId(harness.elements.get('articles-list'), '1')!.getAttribute('data-read'), 'false');

	harness.dispatchDocumentEvent('visibilitychange');
	await waitForBrowserCondition(() => idsRequests === 1 && Boolean(findListButtonByItemId(harness.elements.get('articles-list'), '4')));
	await flushBrowserTasks();

	assert.deepEqual(contentRequests, [['2', '4']], 'only changed or missing bodies are downloaded');
	assert.deepEqual(renderedArticleIds(harness), ['1', '2', '4']);
	assert.equal(findListButtonByItemId(harness.elements.get('articles-list'), '1')!.getAttribute('data-read'), 'true');
	assert.equal(findListButtonByItemId(harness.elements.get('articles-list'), '2')!.getAttribute('data-starred'), 'true');
	assert.match(findListButtonByItemId(harness.elements.get('articles-list'), '2')!.textContent, /Article 2 revised/);
	assert.equal(harness.elements.get('reader-title')!.textContent, 'Article 1');
	assert.equal(harness.elements.get('mark-unread-button')!.textContent, 'Mark unread');
});

test('revalidation refetches every window body when refs omit content versions', async () => {
	const contentRequests: string[][] = [];
	const harness = await createBrowserHarness({ fetchImpl: async (input, init) => {
		if (input.startsWith('/reader/api/0/stream/contents?')) return Response.json({ items: ['1', '2'].map((id) => versionedArticle(id, 'v1')) });
		if (input.startsWith('/reader/api/0/stream/items/ids?')) return Response.json({ itemRefs: [{ id: '1' }, { id: '2' }] });
		if (input.endsWith('/stream/items/contents')) {
			contentRequests.push((init?.body?.getAll('i') ?? []).map(String));
		}
		return browserRegressionResponse(input, init);
	} });
	await harness.elements.get('login-form')!.dispatch('submit');
	await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Article 1');
	harness.dispatchDocumentEvent('visibilitychange');
	await waitForBrowserCondition(() => contentRequests.length === 1);
	await flushBrowserTasks();
	assert.deepEqual(contentRequests, [['1', '2']]);
	assert.equal(harness.elements.get('articles-status')!.textContent, '2 articles');
});

test('a read change made during revalidation is not reverted by older ref flags', async () => {
	const refs = createDeferred<Response>();
	const harness = await createBrowserHarness({ fetchImpl: async (input, init) => {
		if (input.startsWith('/reader/api/0/stream/contents?')) return Response.json({ items: ['1'].map((id) => versionedArticle(id, 'v1'))});
		if (input.startsWith('/reader/api/0/stream/items/ids?')) return refs.promise;
		if (input.endsWith('/edit-tag')) return new Response('OK');
		return browserRegressionResponse(input, init);
	} });
	await harness.elements.get('login-form')!.dispatch('submit');
	await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Article 1');
	harness.dispatchDocumentEvent('visibilitychange');
	await flushBrowserTasks();
	await finishArticleMutation(harness, 'mark-unread-button');
	assert.equal(findListButtonByItemId(harness.elements.get('articles-list'), '1')!.getAttribute('data-read'), 'true');

	refs.resolve(Response.json({ itemRefs: [{ id: '1', read: false, starred: false, contentVersion: 'v1' }] }));
	await waitForBrowserCondition(() => harness.getCacheSizes().membership === 0);
	await flushBrowserTasks();
	assert.equal(findListButtonByItemId(harness.elements.get('articles-list'), '1')!.getAttribute('data-read'), 'true');
	assert.equal(harness.elements.get('mark-unread-button')!.textContent, 'Mark unread');
});
