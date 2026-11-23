import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { getLocalDayRangeBounds, kickerColorIndex } from '../src/browser-app-client';
import {
	createBrowserHarness,
	createElement,
	findDescendantByClass,
	findListButtonByViewId,
	flushBrowserTasks,
	waitForBrowserCondition,
} from './helpers/browser-app-client-harness';

type Element = ReturnType<typeof createElement>;

const FOLDER_ID = 'user/-/label/Daily Reads';
const LOOK_KEY = 'pigeon.browser.look';

// A folder of three feeds seen on Nov 3, 2026 at noon, as in the Reeder folder
// section tests: six stories today, one three days ago, two older than the week.
// Feed 1 (Alpha) also opens on its own as day cards.
async function openCardsBrowser(options: { look?: string; now?: () => number } = {}) {
	const now = new Date(2026, 10, 3, 12, 0, 0, 0).getTime();
	const today = getLocalDayRangeBounds(now, 1).startSeconds;
	const at = (date: Date) => Math.floor(date.getTime() / 1000);
	const stories: Record<string, { feed: string; title: string; published: number }> = {
		'110': { feed: 'feed/1', title: 'Alpha', published: today + 5_000 },
		'109': { feed: 'feed/2', title: 'Bravo', published: today + 4_000 },
		'108': { feed: 'feed/1', title: 'Alpha', published: today + 3_000 },
		'107': { feed: 'feed/1', title: 'Alpha', published: today + 2_000 },
		'106': { feed: 'feed/3', title: 'Charlie', published: today + 1_000 },
		'105': { feed: 'feed/1', title: 'Alpha', published: today + 500 },
		'104': { feed: 'feed/2', title: 'Bravo', published: at(new Date(2026, 9, 31, 12)) },
		'103': { feed: 'feed/3', title: 'Charlie', published: at(new Date(2026, 9, 24, 12)) },
		'102': { feed: 'feed/9', title: 'Ghost', published: at(new Date(2026, 9, 23, 12)) },
		'101': { feed: 'feed/1', title: 'Alpha', published: at(new Date(2026, 10, 2, 9)) },
	};
	const folderPage = ['110', '109', '108', '107', '106', '105', '104', '103', '102'];
	const alphaPage = ['110', '108', '107', '105', '101'];
	const readingLog: Array<Record<string, any>> = [];
	const harness = await createBrowserHarness({
		now: options.now ?? now,
		storedEntries: options.look ? { [LOOK_KEY]: options.look } : {},
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin') return new Response('SID=pigeon/live-token\nLSID=null\nAuth=pigeon/live-token');
			if (input === '/reader/api/0/subscription/list') {
				const folder = [{ id: FOLDER_ID, label: 'Daily Reads' }];
				return Response.json({ subscriptions: [
					{ id: 'feed/1', title: 'Alpha', iconUrl: 'https://icons.example/alpha.png', categories: folder },
					{ id: 'feed/2', title: 'Bravo', categories: folder },
					{ id: 'feed/3', title: 'Charlie', categories: folder },
					{ id: 'feed/5', title: 'Echo' },
				] });
			}
			if (input === '/reader/api/0/unread-count') return Response.json({ unreadcounts: [] });
			if (input === '/api/v1/reading-log') {
				readingLog.push(...JSON.parse(String(init?.body)).events);
				return Response.json({});
			}
			if (input === '/api/v1/engagement') return Response.json({});
			const url = new URL(`https://pigeon.example${input}`);
			if (url.pathname === '/api/v1/browser/articles/count') return Response.json({ count: 0 });
			if (url.pathname === '/reader/api/0/stream/items/ids') {
				const stream = url.searchParams.get('s');
				const ids = stream === FOLDER_ID ? folderPage : stream === 'feed/1' ? alphaPage : [];
				return Response.json({ itemRefs: ids.map((id) => ({ id })) });
			}
			if (url.pathname === '/api/v1/browser/articles') {
				// Search: a few of the folder's stories.
				const found = url.searchParams.get('stream') === FOLDER_ID && url.searchParams.get('q') ? ['110', '104', '102'] : [];
				return Response.json({ itemIds: found, continuation: null, hasMore: false });
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
	const grid = elements.get('reader-grid')!;
	const list = elements.get('articles-list')!;
	const cards = () => list.children.filter((child) => child.classList.contains('cards-card'));
	// Every story button in the order drawn, looking inside the cards.
	const storyButtons = () => {
		const buttons: Element[] = [];
		const visit = (element: Element) => {
			for (const child of element.children) {
				if (child.classList.contains('article-card')) buttons.push(child);
				else visit(child);
			}
		};
		visit(list);
		return buttons;
	};
	const copies = (id: string) => storyButtons().filter((button) => button.dataset.itemId === id);
	// Each card as its header and story ids, "N more" as "+ text".
	const outline = () => list.children.map((child) => {
		if (!child.classList.contains('cards-card')) return '# ' + findDescendantByClass(child, 'article-feed-header-title')?.textContent;
		const header = findDescendantByClass(child, 'article-feed-header-title')?.textContent ?? '';
		const ids = child.children.flatMap((part) => part.classList.contains('cards-card-list')
			? part.children.map((row) => row.children[0]?.dataset.itemId ?? '?') : []);
		const more = findDescendantByClass(child, 'article-more-button');
		return [header, ...ids, ...(more ? ['+ ' + more.textContent] : [])].join(' ');
	});
	await elements.get('login-form')!.dispatch('submit');
	await waitForBrowserCondition(() => Boolean(findListButtonByViewId(elements.get('folders-list'), FOLDER_ID)));
	return { ...harness, grid, list, cards, storyButtons, copies, outline, readingLog };
}

async function openFolder(browser: Awaited<ReturnType<typeof openCardsBrowser>>) {
	await findListButtonByViewId(browser.elements.get('folders-list'), FOLDER_ID)!.dispatch('click');
	await waitForBrowserCondition(() => browser.copies('102').length > 0);
	await flushBrowserTasks();
}

test('the look switch is Reeder by default, toggles to Cards and persists per browser', async () => {
	const browser = await openCardsBrowser();
	const { elements, grid, localStorageState } = browser;
	const toggle = elements.get('look-toggle-button')!;
	const select = elements.get('look-select')!;
	assert.equal(grid.getAttribute('data-look'), 'reeder');
	assert.equal(toggle.getAttribute('aria-pressed'), 'false');
	assert.equal(select.value, 'reeder');
	assert.equal(elements.get('home-list')!.children.length, 0, 'Reeder has no Home row');
	await openFolder(browser);
	assert.equal(browser.cards().length, 0, 'Reeder keeps its rows');

	toggle.dispatch('click');
	await flushBrowserTasks();
	assert.equal(grid.getAttribute('data-look'), 'cards');
	assert.equal(toggle.getAttribute('aria-pressed'), 'true');
	assert.equal(select.value, 'cards');
	assert.equal(localStorageState.get(LOOK_KEY), 'cards');
	// Switching keeps the open view: the folder is now cards, not Home.
	assert.equal(elements.get('articles-heading')!.textContent, 'Daily Reads');
	assert.ok(browser.cards().length > 0);
	assert.equal(grid.getAttribute('data-page'), 'cards');
	assert.equal(elements.get('cards-home')!.classList.contains('hidden'), true);
	assert.equal(elements.get('home-list')!.children.length, 1, 'Cards adds Home to the sidebar');

	// Settings switches back.
	select.value = 'reeder';
	select.dispatch('change');
	await flushBrowserTasks();
	assert.equal(grid.getAttribute('data-look'), 'reeder');
	assert.equal(localStorageState.get(LOOK_KEY), 'reeder');
	assert.equal(toggle.getAttribute('aria-pressed'), 'false');
	assert.equal(browser.cards().length, 0);
	assert.equal(elements.get('home-list')!.children.length, 0);
});

test('a folder in Cards is cards of its sections whose stories select on click and step with j/k', async () => {
	const browser = await openCardsBrowser({ look: 'cards' });
	const { elements, grid, cards, copies, outline, dispatchKeydown } = browser;
	await openFolder(browser);
	assert.equal(grid.getAttribute('data-page'), 'cards');
	assert.deepEqual(outline(), [
		'Today 110 109 108 107 106 + 1 more',
		'Last 7 Days 104',
		'Alpha 110 108 107 + 1 more',
		'Bravo 109 104',
		'Charlie 106 103',
		'# Older',
		'Ghost 102',
	]);
	// Today spans the page; every card has the folder's colour bar.
	const [todayCard, recentCard, alphaCard] = cards();
	assert.ok(todayCard.classList.contains('is-wide'));
	assert.ok(!recentCard.classList.contains('is-wide') && !alphaCard.classList.contains('is-wide'));
	const bar = todayCard.style.getPropertyValue('--bar');
	assert.match(bar, /^var\(--kicker-[1-8]\)$/);
	assert.ok(cards().every((card) => card.style.getPropertyValue('--bar') === bar));
	// Today names each story's feed as a kicker in the feed's colour; a feed's card does not.
	const kicker = findDescendantByClass(copies('109')[0], 'article-kicker')!;
	assert.equal(kicker.textContent, 'Bravo');
	assert.equal(kicker.style.getPropertyValue('--kicker'), `var(--kicker-${kickerColorIndex('feed/2') + 1})`);
	assert.equal(findDescendantByClass(copies('109')[1], 'article-kicker'), undefined);
	// No preview or image in a card; a feed header still opens its feed.
	assert.equal(findDescendantByClass(copies('110')[0], 'article-preview'), undefined);
	assert.ok(findDescendantByClass(alphaCard, 'article-feed-header-button'));

	// A click opens the story over the cards, with a back button named for the folder.
	copies('108')[0].dispatch('click');
	await waitForBrowserCondition(() => elements.get('reader-title')!.textContent === 'Story 108');
	assert.equal(grid.getAttribute('data-mobile-pane'), 'reader');
	assert.ok(copies('108').every((button) => button.classList.contains('is-active')) === false, 'only the clicked copy is active');
	assert.ok(copies('108')[0].classList.contains('is-active'));
	assert.equal(elements.get('reader-back-button')!.textContent, 'Daily Reads');
	// j/k walk the stories in card order, each once.
	const walked = ['108'];
	for (let step = 0; step < 4; step += 1) {
		dispatchKeydown('j');
		await flushBrowserTasks();
		walked.push(elements.get('reader-title')!.textContent.replace('Story ', ''));
	}
	assert.deepEqual(walked, ['108', '107', '106', '104', '103']);
	dispatchKeydown('k');
	await flushBrowserTasks();
	assert.equal(elements.get('reader-title')!.textContent, 'Story 104');
	assert.equal(grid.getAttribute('data-mobile-pane'), 'reader', 'stepping keeps the story open');

	// "N more" still opens its card in place.
	findDescendantByClass(todayCard, 'article-more-button')!.dispatch('click');
	await flushBrowserTasks();
	assert.equal(outline()[0], 'Today 110 109 108 107 106 105');
});

test('card impressions carry row "card" and their section; none count under Home or an open story', async () => {
	let now = new Date(2026, 10, 3, 12, 0, 0, 0).getTime();
	const browser = await openCardsBrowser({ look: 'cards', now: () => now });
	const tick = (count: number) => {
		for (let index = 0; index < count; index += 1) {
			now += 500;
			browser.intervals[0].handler();
		}
	};
	// Home is not a view: the list loading under it logs nothing.
	await waitForBrowserCondition(() => browser.grid.getAttribute('data-page') === 'home');
	tick(12);
	await flushBrowserTasks();
	assert.deepEqual(browser.readingLog, []);

	await openFolder(browser);
	tick(12);
	await waitForBrowserCondition(() => browser.readingLog.length > 0);
	assert.deepEqual(browser.readingLog.map((event) => [event.itemId, event.position, event.metadata?.row, event.metadata?.section]), [
		['110', 0, 'card', 'today'],
		['109', 1, 'card', 'today'],
		['108', 2, 'card', 'today'],
		['107', 3, 'card', 'today'],
		['106', 4, 'card', 'today'],
		['104', 5, 'card', 'last-7-days'],
		['103', 6, 'card', 'feed'],
		['102', 7, 'card', 'feed'],
	]);

	// While a story is open over the cards, a story that turns up in them is not seen.
	browser.copies('110')[0].dispatch('click');
	await waitForBrowserCondition(() => browser.elements.get('reader-title')!.textContent === 'Story 110');
	findDescendantByClass(browser.cards()[0], 'article-more-button')!.dispatch('click');
	await flushBrowserTasks();
	assert.equal(browser.copies('105').length, 1);
	const logged = browser.readingLog.length;
	tick(12);
	await flushBrowserTasks();
	assert.deepEqual(browser.readingLog.slice(logged).filter((event) => event.type === 'impression'), []);
	browser.elements.get('reader-back-button')!.dispatch('click');
	tick(12);
	await waitForBrowserCondition(() => browser.readingLog.some((event) => event.itemId === '105'));
	assert.equal(browser.readingLog.find((event) => event.itemId === '105')?.metadata?.row, 'card');
});

test('Cards opens on Home, whose tiles open views and folders', async () => {
	const browser = await openCardsBrowser({ look: 'cards' });
	const { elements, grid } = browser;
	const home = elements.get('cards-home')!;
	await waitForBrowserCondition(() => findDescendantByClass(home, 'cards-home-folder') !== undefined);
	assert.equal(grid.getAttribute('data-look'), 'cards');
	assert.equal(grid.getAttribute('data-page'), 'home');
	assert.equal(home.classList.contains('hidden'), false);
	assert.equal(elements.get('articles-heading')!.textContent, 'Home');
	const homeRow = elements.get('home-list')!.children[0].children[0];
	assert.ok(homeRow.classList.contains('is-active'));
	assert.equal(homeRow.getAttribute('aria-current'), 'page');
	// The list underneath is not the selected sidebar row while Home shows.
	assert.equal(findListButtonByViewId(elements.get('views-list'), 'all')!.classList.contains('is-active'), false);

	// One tile per view iOS gives a tile, in its order; Unread and All items get none.
	const viewTiles = findDescendantByClass(home, 'cards-home-views')!.children.map((item) => item.children[0].dataset.viewId);
	assert.deepEqual(viewTiles, ['for-you', 'starred', 'saved', 'today', 'last-7-days']);
	// Then a tile per folder: its colour, its name and its first feeds.
	const folderTile = findDescendantByClass(home, 'cards-home-folder')!;
	assert.equal(folderTile.dataset.viewId, FOLDER_ID);
	assert.match(folderTile.style.getPropertyValue('--bar'), /^var\(--kicker-[1-8]\)$/);
	assert.equal(findDescendantByClass(folderTile, 'cards-home-folder-name')!.textContent, 'Daily Reads');
	const feedTitles = findDescendantByClass(folderTile, 'cards-home-folder-feeds')!.children
		.map((feed) => findDescendantByClass(feed, 'cards-home-folder-feed-title')!.textContent);
	assert.deepEqual(feedTitles, ['Alpha', 'Bravo', 'Charlie']);
	// j/k do nothing on Home.
	assert.equal(browser.dispatchKeydown('j'), false);

	folderTile.dispatch('click');
	await waitForBrowserCondition(() => browser.copies('102').length > 0);
	assert.equal(grid.getAttribute('data-page'), 'cards');
	assert.equal(home.classList.contains('hidden'), true);
	assert.equal(elements.get('articles-heading')!.textContent, 'Daily Reads');
	assert.equal(elements.get('home-list')!.children[0].children[0].classList.contains('is-active'), false);
	assert.ok(findListButtonByViewId(elements.get('folders-list'), FOLDER_ID)!.classList.contains('is-active'));
	// The folder's tile colour is its cards' colour.
	assert.equal(browser.cards()[0].style.getPropertyValue('--bar'), folderTile.style.getPropertyValue('--bar'));

	// The Home row goes back to the tiles.
	elements.get('home-list')!.children[0].children[0].dispatch('click');
	await flushBrowserTasks();
	assert.equal(grid.getAttribute('data-page'), 'home');
	assert.equal(elements.get('articles-heading')!.textContent, 'Home');
	findDescendantByClass(home, 'cards-home-views')!.children[3].children[0].dispatch('click');
	await waitForBrowserCondition(() => elements.get('articles-heading')!.textContent === 'Today');
	assert.equal(grid.getAttribute('data-page'), 'cards');
});

test('back and Escape from a story in Cards return to the cards where they were scrolled', async () => {
	const browser = await openCardsBrowser({ look: 'cards' });
	const { elements, grid, copies, dispatchKeydown } = browser;
	await openFolder(browser);
	const shell = elements.get('articles-list-shell')!;
	shell.scrollTop = 300;
	copies('104')[0].dispatch('click');
	await waitForBrowserCondition(() => elements.get('reader-title')!.textContent === 'Story 104');
	assert.equal(grid.getAttribute('data-mobile-pane'), 'reader');
	// A hidden list can lose its scroll position (a narrow window hides it outright).
	shell.scrollTop = 0;
	elements.get('reader-back-button')!.dispatch('click');
	assert.equal(grid.getAttribute('data-mobile-pane'), 'stream');
	assert.equal(shell.scrollTop, 300);
	assert.equal(browser.getActiveElement(), copies('104')[0], 'focus returns to the story it opened');

	copies('103')[0].dispatch('click');
	await waitForBrowserCondition(() => elements.get('reader-title')!.textContent === 'Story 103');
	assert.equal(grid.getAttribute('data-mobile-pane'), 'reader');
	assert.equal(dispatchKeydown('Escape'), true);
	assert.equal(grid.getAttribute('data-mobile-pane'), 'stream');
	assert.equal(shell.scrollTop, 300);
	// With the cards showing, Escape is not taken.
	assert.equal(dispatchKeydown('Escape'), false);
});

test('a single feed in Cards is day cards in its folder\'s colour; search in Cards is one flat card', async () => {
	const browser = await openCardsBrowser({ look: 'cards' });
	const { elements, cards, outline } = browser;
	await openFolder(browser);
	const folderBar = cards()[0].style.getPropertyValue('--bar');
	// Alpha opens from its card's header, as day cards.
	findDescendantByClass(cards()[2], 'article-feed-header-button')!.dispatch('click');
	await waitForBrowserCondition(() => elements.get('articles-heading')!.textContent === 'Alpha' && browser.copies('101').length > 0);
	await flushBrowserTasks();
	assert.deepEqual(outline(), ['Today 110 108 107 105', 'Yesterday 101']);
	assert.equal(elements.get('article-sort-field')!.classList.contains('hidden'), true, 'the days are the order');
	// A feed in a folder takes the folder's colour, and one feed needs no kicker.
	assert.ok(cards().every((card) => card.style.getPropertyValue('--bar') === folderBar));
	assert.equal(findDescendantByClass(cards()[0], 'article-kicker'), undefined);
	browser.copies('101')[0].dispatch('click');
	await waitForBrowserCondition(() => elements.get('reader-title')!.textContent === 'Story 101');
	browser.dispatchKeydown('k');
	await flushBrowserTasks();
	assert.equal(elements.get('reader-title')!.textContent, 'Story 105');

	// Search results are one card of stories, not sections, each with its feed.
	await openFolder(browser);
	elements.get('article-search-input')!.value = 'story';
	elements.get('article-query-form')!.dispatch('submit');
	await waitForBrowserCondition(() => cards().length === 1 && browser.copies('102').length === 1);
	assert.ok(cards()[0].classList.contains('is-flat') && cards()[0].classList.contains('is-wide'));
	assert.deepEqual(browser.storyButtons().map((button) => button.dataset.itemId), ['110', '104', '102']);
	assert.equal(findDescendantByClass(browser.copies('104')[0], 'article-kicker')!.textContent, 'Bravo');
});
