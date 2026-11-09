import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleGreaderRequest } from '../src/greader';
import { handleNativeApiRequest } from '../src/native-api';
import { generateApiToken } from '../src/api-auth';
import {
	browserRegressionItem,
	browserRegressionResponse,
	createBrowserHarness,
	createLargeTodaySqliteLibrary,
	findListButtonByItemId,
	findListButtonByViewId,
	flushBrowserTasks,
	renderedArticleIds,
	waitForBrowserCondition,
	waitForTodayWindow,
} from './helpers/browser-app-client-harness';

test('bounded Today windows keep every story reachable beyond 2100 real GReader items and metadata eviction', async () => {
	let now = new Date(2026, 9, 2, 12).getTime();
	const count = 2_105;
	const state = createLargeTodaySqliteLibrary(now, count);
	try {
		const token = await generateApiToken('today-test-password');
		let bodyRequests = 0;
		const harness = await createBrowserHarness({ now: () => now, fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin') return new Response(`Auth=pigeon/${token}`);
			if (input.endsWith('/contents')) bodyRequests += 1;
			if (input.startsWith('/api/v1/browser/articles/count?')) {
				return handleNativeApiRequest(new Request(`https://pigeon.example${input}`, init as RequestInit), state.env);
			}
			return handleGreaderRequest(new Request(`https://pigeon.example${input}`, init as RequestInit), state.env);
		} });
		await harness.elements.get('login-form')!.dispatch('submit');
		await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === `Story ${count + 1}`);
		findListButtonByViewId(harness.elements.get('views-list'), 'today')!.dispatch('click');
		await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === `Story ${count}`);
		await waitForTodayWindow(harness);
		// The sidebar counts today's unread stories, not the future or yesterday items around them.
		assert.equal(findListButtonByViewId(harness.elements.get('views-list'), 'today')!.textContent, `Today${count}`);
		assert.equal(findListButtonByViewId(harness.elements.get('views-list'), 'recent')!.textContent, 'Recently read');
		const seen = new Set<string>();
		for (let page = 0; page < 20; page += 1) {
			const ids = renderedArticleIds(harness);
			assert.ok(ids.length <= 200, `bounded Today rendered ${ids.length} rows`);
			for (const id of ids) {
				assert.ok(Number(id) <= count, 'known future/yesterday articles stay outside Today');
				assert.ok(findListButtonByItemId(harness.elements.get('articles-list'), id)!.textContent.includes(`Story ${id}`));
				seen.add(id);
			}
			const older = harness.elements.get('article-older-button')!;
			if (older.disabled || harness.elements.get('article-page-controls')!.classList.contains('hidden')) break;
			older.dispatch('click');
			await waitForTodayWindow(harness);
		}
		assert.deepEqual([...seen], Array.from({ length: count }, (_, index) => String(count - index)));
		assert.ok(bodyRequests > 100, 'crossed the full-body and metadata cache capacities');
		for (let page = 0; page < 20 && !harness.elements.get('article-newer-button')!.disabled; page += 1) {
			harness.elements.get('article-newer-button')!.dispatch('click');
			await waitForTodayWindow(harness);
		}
		assert.equal(renderedArticleIds(harness)[0], String(count));
		assert.match(harness.elements.get('articles-list')!.textContent, /Story 2105/);
		const last = renderedArticleIds(harness).at(-1)!;
		findListButtonByItemId(harness.elements.get('articles-list'), last)!.dispatch('click');
		await waitForBrowserCondition(() => harness.elements.get('reader-frame')!.srcdoc.includes(`Body ${last}</p>`));
		let revealStart = harness.revealCalls.length;
		harness.dispatchKeydown('j');
		await waitForTodayWindow(harness);
		assert.equal(harness.elements.get('reader-title')!.textContent, `Story ${Number(last) - 1}`);
		assert.ok(harness.revealCalls.slice(revealStart).some((call) => call.id === String(Number(last) - 1) && call.block === 'nearest'));
		revealStart = harness.revealCalls.length;
		harness.dispatchKeydown('k');
		await waitForTodayWindow(harness);
		assert.equal(harness.elements.get('reader-title')!.textContent, `Story ${last}`);
		assert.ok(harness.revealCalls.slice(revealStart).some((call) => call.id === last && call.block === 'nearest'));
		const bodiesBeforeMidnight = bodyRequests;
		harness.setOnline(false);
		harness.elements.get('articles-list-shell')!.scrollTop = 63;
		now = new Date(2026, 9, 3, 0, 10).getTime();
		harness.elements.get('theme-toggle-button')!.dispatch('click');
		await flushBrowserTasks();
		assert.deepEqual(renderedArticleIds(harness), [String(count + 1)], 'the cached date index survives metadata eviction and changes local day');
		assert.equal(harness.elements.get('reader-title')!.textContent, 'Select an article');
		assert.equal(harness.elements.get('articles-list-shell')!.scrollTop, 63);
		assert.equal(bodyRequests, bodiesBeforeMidnight);
		harness.setOnline(true);
		harness.dispatchWindowEvent('online');
		await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === `Story ${count + 1}`, 400);
		await waitForTodayWindow(harness);
		assert.deepEqual(renderedArticleIds(harness), [String(count + 1)]);

	} finally { state.database.close(); }
});

for (const event of ['keyboard', 'theme', 'list mode']) {
	test(`Today reconciles list and reader on a local ${event} after midnight without fetching offline`, async () => {
		let now = new Date(2026, 9, 2, 23, 50).getTime();
		const yesterday = now / 1000;
		const today = new Date(2026, 9, 3, 0, 0, 1).getTime() / 1000;
		let requests = 0;
		const harness = await createBrowserHarness({ now: () => now, fetchImpl: async (input, init) => {
			requests += 1;
			if (input.startsWith('/reader/api/0/stream/items/ids?')) return Response.json({ itemRefs: [{ id: '2' }, { id: '1' }] });
			if (input.endsWith('/contents')) return Response.json({ items: (init?.body?.getAll('i') ?? []).map(String).map((id) => browserRegressionItem(id, id === '1' ? yesterday : today)) });
			return browserRegressionResponse(input, init);
		} });
		await harness.elements.get('login-form')!.dispatch('submit');
		await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Article 2');
		findListButtonByViewId(harness.elements.get('views-list'), 'today')!.dispatch('click');
		await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Article 1');
		const before = requests;
		harness.elements.get('articles-list-shell')!.scrollTop = 63;
		now = new Date(2026, 9, 3, 0, 10).getTime();
		harness.setOnline(false);
		if (event === 'keyboard') harness.dispatchKeydown('j');
		else harness.elements.get(event === 'theme' ? 'theme-toggle-button' : 'article-list-mode-button')!.dispatch('click');
		await flushBrowserTasks();
		assert.deepEqual(renderedArticleIds(harness), ['2']);
		assert.equal(harness.elements.get('reader-title')!.textContent, 'Article 2');
		assert.equal(harness.elements.get('articles-list-shell')!.scrollTop, 63);
		assert.equal(requests, before);
	});
}

test('Today windows retain a partial cached tail through a page error, then prune deleted rows on real authoritative completion', async () => {
	const now = new Date(2026, 9, 2, 12).getTime();
	const state = createLargeTodaySqliteLibrary(now, 650);
	try {
		const token = await generateApiToken('today-test-password');
		let failPage = false;
		const harness = await createBrowserHarness({ now, fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin') return new Response(`Auth=pigeon/${token}`);
			if (failPage && input.includes('/stream/items/ids?') && new URL(`https://pigeon.example${input}`).searchParams.has('c')) {
				failPage = false;
				return new Response('Unavailable', { status: 503 });
			}
			return handleGreaderRequest(new Request(`https://pigeon.example${input}`, init as RequestInit), state.env);
		} });
		await harness.elements.get('login-form')!.dispatch('submit');
		await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Story 651');
		findListButtonByViewId(harness.elements.get('views-list'), 'today')!.dispatch('click');
		await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Story 650');
		await waitForTodayWindow(harness);
		for (let page = 0; page < 3; page += 1) {
			harness.elements.get('article-older-button')!.dispatch('click');
			await waitForTodayWindow(harness);
		}
		assert.ok(renderedArticleIds(harness).includes('1'));
		state.database.prepare('DELETE FROM items WHERE rowid > 300').run();
		failPage = true;
		harness.dispatchDocumentEvent('visibilitychange');
		await waitForBrowserCondition(() => harness.elements.get('articles-status')!.textContent === 'Could not load more articles.', 400);
		assert.ok(renderedArticleIds(harness).includes('1'), 'cached surviving rows remain reachable after partial failure');
		assert.equal(harness.elements.get('load-more-button')!.disabled, false);
		harness.elements.get('load-more-button')!.dispatch('click');
		await waitForTodayWindow(harness);
		const seen = new Set<string>();
		for (let page = 0; page < 10 && !harness.elements.get('article-newer-button')!.disabled; page += 1) {
			harness.elements.get('article-newer-button')!.dispatch('click');
			await waitForTodayWindow(harness);
		}
		for (let page = 0; page < 3; page += 1) {
			for (const id of renderedArticleIds(harness)) seen.add(id);
			if (harness.elements.get('article-older-button')!.disabled) break;
			harness.elements.get('article-older-button')!.dispatch('click');
			await waitForTodayWindow(harness);
		}
		assert.deepEqual([...seen], Array.from({ length: 300 }, (_, index) => String(300 - index)));
		assert.ok(renderedArticleIds(harness).includes(harness.elements.get('reader-title')!.textContent.replace('Story ', '')));
	} finally { state.database.close(); }
});

test('Today sidebar count follows the local day and never carries a stale day forward', async () => {
	let now = new Date(2026, 9, 2, 12).getTime();
	const count = 30;
	const state = createLargeTodaySqliteLibrary(now, count);
	try {
		const token = await generateApiToken('today-test-password');
		let failCount = false;
		const harness = await createBrowserHarness({ now: () => now, fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin') return new Response(`Auth=pigeon/${token}`);
			const request = new Request(`https://pigeon.example${input}`, init as RequestInit);
			if (input.startsWith('/api/v1/browser/articles/count?')) {
				return failCount ? new Response('Unavailable', { status: 503 }) : handleNativeApiRequest(request, state.env);
			}
			return handleGreaderRequest(request, state.env);
		} });
		const todayButton = () => findListButtonByViewId(harness.elements.get('views-list'), 'today');
		await harness.elements.get('login-form')!.dispatch('submit');
		await waitForBrowserCondition(() => todayButton()?.textContent === `Today${count}`);
		// The next day's count request fails: Today must drop yesterday's number, not keep it.
		now += 24 * 60 * 60 * 1000;
		failCount = true;
		findListButtonByViewId(harness.elements.get('views-list'), 'all')!.dispatch('click');
		await waitForBrowserCondition(() => todayButton()?.textContent === 'Today0');
		await flushBrowserTasks();
		assert.equal(todayButton()?.textContent, 'Today0');
	} finally {
		state.database.close();
	}
});
