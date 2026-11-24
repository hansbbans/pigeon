import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { kickerColorIndex } from '../src/browser-app-client';
import {
	createBrowserHarness,
	createElement,
	findDescendantByClass,
	findListButtonByViewId,
	flushBrowserTasks,
	waitForBrowserCondition,
} from './helpers/browser-app-client-harness';

type Element = ReturnType<typeof createElement>;

const LOOK_KEY = 'pigeon.browser.look';
const READING_LIST = 'user/-/state/com.google/reading-list';

// Twenty stories in All items, newest first (120 … 101), from three feeds. 120
// has no picture and 119 has one, so 119 leads the first page; the second page
// (107 … 101) has no picture in its first four stories, so 107 leads it.
const ALL_IDS = Array.from({ length: 20 }, (_, index) => String(120 - index));
const MORE_IDS = Array.from({ length: 10 }, (_, index) => String(100 - index));
const WITH_IMAGE = new Set(['119', '117', '114', '103']);
const FEEDS = ['feed/1', 'feed/2', 'feed/3'];
const FEED_TITLES: Record<string, string> = { 'feed/1': 'Alpha', 'feed/2': 'Bravo', 'feed/3': 'Charlie' };
const feedOf = (id: string) => FEEDS[Number(id) % 3];
const imageOf = (id: string) => `https://images.example/${id}.jpg`;
const LONG_PREVIEW = 'A standfirst that runs on. '.repeat(20);

async function openFrontPage(options: { look?: string; policy?: string; now?: () => number; paged?: boolean;
	ids?: string[]; proxyGivesNothing?: boolean; storedEntries?: Record<string, string> } = {}) {
	const allIds = options.ids ?? ALL_IDS;
	const now = new Date(2026, 10, 3, 12, 0, 0, 0).getTime();
	const readingLog: Array<Record<string, any>> = [];
	const preferences = { theme: 'app', font: 'geist', fontSize: 18, lineHeight: 1.6, width: 720, margins: 24, density: 'comfortable',
		imagePolicy: options.policy ?? 'load', shortcuts: { next: 'j', previous: 'k', read: 'm', star: 's' } };
	const proxied: string[] = [];
	const harness = await createBrowserHarness({
		now: options.now ?? now,
		storedEntries: { [LOOK_KEY]: options.look ?? 'cards', ...options.storedEntries },
		readingTools: {
			readPreferences: () => preferences,
			savePreferences: (next: unknown) => next,
			frameCSS: () => 'body{font-size:18px}',
			async applyImagePolicy(html: string) {
				proxied.push(html);
				if (options.proxyGivesNothing) return { html: '', images: [], blockedCount: 1 };
				return { html: html.replace(/src="[^"]*"/, 'src="blob:proxied"'), images: [], blockedCount: 0 };
			},
		},
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin') return new Response('SID=pigeon/live-token\nLSID=null\nAuth=pigeon/live-token');
			if (input === '/reader/api/0/subscription/list') {
				return Response.json({ subscriptions: FEEDS.map((id) => ({ id, title: FEED_TITLES[id] })) });
			}
			if (input === '/reader/api/0/unread-count') return Response.json({ unreadcounts: [{ id: READING_LIST, count: 12 }] });
			if (input === '/api/v1/reading-log') {
				readingLog.push(...JSON.parse(String(init?.body)).events);
				return Response.json({});
			}
			if (input === '/api/v1/engagement') return Response.json({});
			const url = new URL(`https://pigeon.example${input}`);
			if (url.pathname === '/api/v1/browser/articles/count') return Response.json({ count: 0 });
			if (url.pathname === '/reader/api/0/stream/items/ids') {
				if (url.searchParams.get('s') !== READING_LIST) return Response.json({ itemRefs: [] });
				// Paged: a second page of ten older stories (100 … 91) behind a continuation.
				if (url.searchParams.get('c') === 'page-2') return Response.json({ itemRefs: MORE_IDS.map((id) => ({ id })) });
				return Response.json({ itemRefs: allIds.map((id) => ({ id })), ...(options.paged ? { continuation: 'page-2' } : {}) });
			}
			if (url.pathname === '/api/v1/browser/articles') {
				const found = url.searchParams.get('q') ? ['118', '110'] : [];
				return Response.json({ itemIds: found, continuation: null, hasMore: false });
			}
			if (input === '/reader/api/0/stream/items/contents' && init?.method === 'POST') {
				return Response.json({ items: (init.body?.getAll('i') ?? []).map(String).filter((id) => allIds.includes(id) || MORE_IDS.includes(id)).map((id) => ({
					id: `tag:google.com,2005:reader/item/${Number(id).toString(16).padStart(16, '0')}`,
					title: `Story ${id}`,
					published: Math.floor(now / 1000) - (120 - Number(id)) * 600,
					categories: Number(id) === 116 ? ['user/-/state/com.google/read'] : [],
					origin: { title: FEED_TITLES[feedOf(id)], streamId: feedOf(id) },
					summary: { content: id === '119' ? LONG_PREVIEW : `Preview ${id}` },
					content: { content: (WITH_IMAGE.has(id) ? `<p><img src="${imageOf(id)}" width="1200" height="800"></p>` : '') + `<p>Body ${id}</p>` },
				})) });
			}
			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});
	const { elements } = harness;
	const grid = elements.get('reader-grid')!;
	const list = elements.get('articles-list')!;
	// Every story button in the order drawn.
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
	const story = (id: string) => storyButtons().find((button) => button.dataset.itemId === id)!;
	const pages = () => list.children.filter((child) => child.classList.contains('front-page'));
	// Each page as its lead's id, then its grid's ids.
	const outline = () => pages().map((page) => {
		const lead = findDescendantByClass(page, 'front-page-lead')!;
		const gridList = findDescendantByClass(page, 'front-page-grid');
		const ids = (container: Element | undefined) => container ? container.children.map((item) => item.children[0].dataset.itemId) : [];
		return [ids(lead).join(' '), ids(gridList).join(' ')].join(' | ');
	});
	await elements.get('login-form')!.dispatch('submit');
	await waitForBrowserCondition(() => Boolean(findListButtonByViewId(elements.get('views-list'), 'all')));
	return { ...harness, grid, list, storyButtons, story, pages, outline, readingLog, proxied };
}

async function openAllItems(browser: Awaited<ReturnType<typeof openFrontPage>>) {
	await findListButtonByViewId(browser.elements.get('views-list'), 'all')!.dispatch('click');
	await waitForBrowserCondition(() => browser.storyButtons().length === 20 && browser.storyButtons().every((button) => button.dataset.read !== undefined)
		&& findDescendantByClass(browser.story('101'), 'article-title-text')?.textContent === 'Story 101');
	await flushBrowserTasks();
}

test('a smart view in Cards is the Front Page: a masthead, a lead with a picture, then a grid', async () => {
	const browser = await openFrontPage();
	const { elements, grid, list, story, outline } = browser;
	await openAllItems(browser);
	assert.equal(grid.getAttribute('data-page'), 'front-page');
	assert.ok(list.classList.contains('is-front-page'));

	// The masthead names the view between rules, over a dateline with the unread count.
	const masthead = list.children[0];
	assert.ok(masthead.classList.contains('front-page-masthead'));
	assert.equal(findDescendantByClass(masthead, 'front-page-title')!.textContent, 'All items');
	assert.equal(findDescendantByClass(masthead, 'front-page-dateline')!.textContent, 'Tuesday, November 3 · 12 new');

	// Pages of thirteen: the lead is the first story with a picture among the
	// first four, else the first story; the rest keep their order.
	assert.deepEqual(outline(), [
		'119 | 120 118 117 116 115 114 113 112 111 110 109 108',
		'107 | 106 105 104 103 102 101',
	]);

	// The lead: picture, kicker in its feed's colour, headline, a deck of about 240 characters, meta.
	const lead = story('119');
	assert.ok(lead.classList.contains('is-lead') && lead.classList.contains('has-image'));
	assert.equal(findDescendantByClass(lead, 'front-page-image')!.getAttribute('src'), imageOf('119'));
	const kicker = findDescendantByClass(lead, 'article-kicker')!;
	assert.equal(kicker.textContent, FEED_TITLES[feedOf('119')]);
	assert.equal(kicker.style.getPropertyValue('--kicker'), `var(--kicker-${kickerColorIndex(feedOf('119')) + 1})`);
	assert.equal(findDescendantByClass(lead, 'article-title-text')!.textContent, 'Story 119');
	const deck = findDescendantByClass(lead, 'front-page-deck')!.textContent;
	assert.ok(deck.length <= 241 && deck.endsWith('…') && deck.startsWith('A standfirst that runs on.'));
	assert.ok(findDescendantByClass(lead, 'article-meta'));
	// A lead without a picture is text only; grid stories have no deck.
	assert.equal(findDescendantByClass(story('107'), 'front-page-image'), undefined);
	assert.equal(findDescendantByClass(story('107'), 'front-page-deck')!.textContent, 'Preview 107');
	assert.equal(findDescendantByClass(story('118'), 'front-page-deck'), undefined);
	assert.ok(findDescendantByClass(story('117'), 'front-page-image'));
	assert.equal(findDescendantByClass(story('118'), 'front-page-image'), undefined);
	// Read stories keep their place and shape: only the class (colour) changes.
	assert.ok(story('116').classList.contains('is-read'));
	assert.equal(elements.get('reader-back-button')!.textContent, 'All items');
});

test('the Front Page drops a picture that is not editorial once it loads', async () => {
	const browser = await openFrontPage();
	const { story } = browser;
	await openAllItems(browser);
	const image = findDescendantByClass(story('117'), 'front-page-image')!;
	Object.assign(image, { naturalWidth: 900, naturalHeight: 100 });
	image.dispatch('load');
	assert.ok(image.classList.contains('hidden'), 'a banner is not a picture');
	assert.equal(story('117').classList.contains('has-image'), false);
	const lead = findDescendantByClass(story('119'), 'front-page-image')!;
	Object.assign(lead, { naturalWidth: 1200, naturalHeight: 800 });
	lead.dispatch('load');
	assert.equal(lead.classList.contains('hidden'), false);
	assert.ok(story('119').classList.contains('has-image'));
});

test('a lead whose picture is a banner gives way to a story with a picture, and the banner stays out', async () => {
	const browser = await openFrontPage();
	const { story, outline, storyButtons } = browser;
	await openAllItems(browser);
	const banner = findDescendantByClass(story('119'), 'front-page-image')!;
	Object.assign(banner, { naturalWidth: 900, naturalHeight: 100 });
	banner.dispatch('load');
	// 117 is the next story with a picture among the first four.
	await waitForBrowserCondition(() => outline()[0].startsWith('117 |'));
	assert.deepEqual(outline(), [
		'117 | 120 119 118 116 115 114 113 112 111 110 109 108',
		'107 | 106 105 104 103 102 101',
	]);
	// Redrawn, 119 does not fetch its banner again.
	assert.equal(findDescendantByClass(story('119'), 'front-page-image'), undefined);
	assert.equal(story('119').classList.contains('has-image'), false);
	assert.ok(storyButtons().length === 20);
});

test('a picture the private proxy cannot give is dropped, so no empty box is drawn', async () => {
	const browser = await openFrontPage({ policy: 'proxy', proxyGivesNothing: true });
	const { storyButtons, outline } = browser;
	await openAllItems(browser);
	const shown = () => storyButtons().filter((button) => {
		const image = findDescendantByClass(button, 'front-page-image');
		return image && !image.classList.contains('hidden');
	});
	await waitForBrowserCondition(() => shown().length === 0 && storyButtons().every((button) => !button.classList.contains('has-image')), 100);
	// With no usable picture, the first story leads.
	await waitForBrowserCondition(() => outline()[0].startsWith('120 |'), 100);
});

test('titles only leaves the Front Page without pictures', async () => {
	const browser = await openFrontPage({ storedEntries: { 'pigeon.browser.article-list-mode': 'titles' } });
	await openAllItems(browser);
	assert.equal(browser.outline()[0].split(' | ')[0], '120');
	assert.equal(browser.storyButtons().some((button) => findDescendantByClass(button, 'front-page-image')), false);
});

test('once a story is opened, the Front Page keeps its leads while pictures arrive', async () => {
	const browser = await openFrontPage();
	const { elements, story, outline } = browser;
	await openAllItems(browser);
	const before = outline();
	story('118').dispatch('click');
	await waitForBrowserCondition(() => elements.get('reader-title')!.textContent === 'Story 118');
	const banner = findDescendantByClass(story('119'), 'front-page-image')!;
	Object.assign(banner, { naturalWidth: 900, naturalHeight: 100 });
	banner.dispatch('load');
	await flushBrowserTasks();
	await flushBrowserTasks();
	assert.deepEqual(outline(), before, 'j and k keep the order the reader has seen');
	browser.dispatchKeydown('k');
	await flushBrowserTasks();
	assert.equal(elements.get('reader-title')!.textContent, 'Story 120');
});

test('a keyboard step across a window counts as opening the story, so the next step continues from it', async () => {
	// 205 stories: the first window holds 200, the second 5. None has a picture, so each page's first story leads.
	const ids = Array.from({ length: 205 }, (_, index) => String(2000 - index));
	const browser = await openFrontPage({ ids });
	const { elements, story, storyButtons, dispatchKeydown } = browser;
	await findListButtonByViewId(elements.get('views-list'), 'all')!.dispatch('click');
	await waitForBrowserCondition(() => storyButtons().length === 200 && findDescendantByClass(story('1801'), 'article-title-text')?.textContent === 'Story 1801', 200);
	elements.get('article-older-button')!.dispatch('click');
	await waitForBrowserCondition(() => storyButtons().length === 5 && findDescendantByClass(story('1796'), 'article-title-text')?.textContent === 'Story 1796', 200);
	story('1800').dispatch('click');
	await waitForBrowserCondition(() => elements.get('reader-title')!.textContent === 'Story 1800');
	// k from the window's first story steps back into the last story of the window before.
	dispatchKeydown('k');
	await waitForBrowserCondition(() => elements.get('reader-title')!.textContent === 'Story 1801', 200);
	assert.ok(story('1801').classList.contains('is-active'), 'the story stepped to is the one marked open');
	dispatchKeydown('k');
	await waitForBrowserCondition(() => elements.get('reader-title')!.textContent !== 'Story 1801', 50);
	assert.equal(elements.get('reader-title')!.textContent, 'Story 1802');
});

test('the Front Page follows the image policy as list rows do', async () => {
	// Ask: no pictures, so the first story leads.
	const asking = await openFrontPage({ policy: 'ask' });
	await openAllItems(asking);
	assert.equal(asking.outline()[0].split(' | ')[0], '120');
	assert.equal(asking.storyButtons().some((button) => findDescendantByClass(button, 'front-page-image')), false);

	// Proxy: the picture loads through the reading proxy, never from its own address.
	const proxy = await openFrontPage({ policy: 'proxy' });
	await openAllItems(proxy);
	const image = findDescendantByClass(proxy.story('119'), 'front-page-image')!;
	await waitForBrowserCondition(() => image.getAttribute('src') === 'blob:proxied');
	assert.ok(proxy.proxied.some((html) => html.includes(imageOf('119'))));
});

test('a Front Page story has the row menu, opens over the page, and back returns to it', async () => {
	const browser = await openFrontPage();
	const { elements, grid, story } = browser;
	await openAllItems(browser);
	// The row's menu offers the marks around it, as in any list.
	story('114').dispatch('contextmenu', { clientX: 10, clientY: 10 });
	assert.equal(elements.get('article-context-menu')!.classList.contains('hidden'), false);
	assert.equal(elements.get('context-mark-above-button')!.disabled, false);
	assert.equal(elements.get('context-mark-below-button')!.disabled, false);
	elements.get('article-context-menu')!.classList.add('hidden');
	story('114').dispatch('click');
	await waitForBrowserCondition(() => elements.get('reader-title')!.textContent === 'Story 114');
	assert.equal(grid.getAttribute('data-mobile-pane'), 'reader');
	assert.ok(story('114').classList.contains('is-active'));
	elements.get('reader-back-button')!.dispatch('click');
	assert.equal(grid.getAttribute('data-mobile-pane'), 'stream');
	assert.equal(grid.getAttribute('data-page'), 'front-page');
	assert.equal(browser.getActiveElement(), story('114'));
});

test('j and k step from the lead through the grid, page by page', async () => {
	const browser = await openFrontPage();
	const { elements, story, dispatchKeydown } = browser;
	await openAllItems(browser);
	story('119').dispatch('click');
	await waitForBrowserCondition(() => elements.get('reader-title')!.textContent === 'Story 119');
	const walked = ['119'];
	for (let step = 0; step < 3; step += 1) {
		dispatchKeydown('j');
		await flushBrowserTasks();
		walked.push(elements.get('reader-title')!.textContent.replace('Story ', ''));
	}
	assert.deepEqual(walked, ['119', '120', '118', '117']);
	story('108').dispatch('click');
	await waitForBrowserCondition(() => elements.get('reader-title')!.textContent === 'Story 108');
	dispatchKeydown('j');
	await flushBrowserTasks();
	assert.equal(elements.get('reader-title')!.textContent, 'Story 107', 'the next page starts at its lead');
	dispatchKeydown('k');
	await flushBrowserTasks();
	assert.equal(elements.get('reader-title')!.textContent, 'Story 108');
});

test('Front Page impressions carry row "front-page" and the position drawn', async () => {
	let now = new Date(2026, 10, 3, 12, 0, 0, 0).getTime();
	const browser = await openFrontPage({ now: () => now });
	await openAllItems(browser);
	for (let index = 0; index < 12; index += 1) {
		now += 500;
		browser.intervals[0].handler();
	}
	await waitForBrowserCondition(() => browser.readingLog.some((event) => event.itemId === '118'));
	const impressions = browser.readingLog.filter((event) => event.type === 'impression');
	assert.deepEqual(impressions.slice(0, 3).map((event) => [event.itemId, event.position, event.metadata?.row]), [
		['119', 0, 'front-page'],
		['120', 1, 'front-page'],
		['118', 2, 'front-page'],
	]);
	assert.ok(impressions.every((event) => event.metadata?.row === 'front-page'));
});

test('search in Cards stays one flat card, and Reeder keeps its list', async () => {
	const browser = await openFrontPage();
	const { elements, list, grid } = browser;
	await openAllItems(browser);
	elements.get('article-search-input')!.value = 'story';
	elements.get('article-query-form')!.dispatch('submit');
	await waitForBrowserCondition(() => browser.storyButtons().length === 2);
	assert.equal(grid.getAttribute('data-page'), 'cards');
	assert.equal(list.classList.contains('is-front-page'), false);
	assert.ok(list.children[0].classList.contains('is-flat'));

	const reeder = await openFrontPage({ look: 'reeder' });
	await openAllItems(reeder);
	assert.equal(reeder.list.classList.contains('is-front-page'), false);
	assert.equal(reeder.pages().length, 0);
});

test('load more at the bottom of the Front Page adds its stories as further pages', async () => {
	const browser = await openFrontPage({ paged: true });
	const { elements, list, outline } = browser;
	await openAllItems(browser);
	const loadMore = elements.get('load-more-button')!;
	assert.equal(loadMore.classList.contains('hidden'), false);
	loadMore.dispatch('click');
	await waitForBrowserCondition(() => browser.storyButtons().length === 30
		&& findDescendantByClass(browser.story('91'), 'article-title-text')?.textContent === 'Story 91');
	await flushBrowserTasks();
	assert.deepEqual(outline(), [
		'119 | 120 118 117 116 115 114 113 112 111 110 109 108',
		'107 | 106 105 104 103 102 101 100 99 98 97 96 95',
		'94 | 93 92 91',
	]);
	assert.equal(list.children.filter((child) => child.classList.contains('front-page-masthead')).length, 1);
	assert.equal(loadMore.classList.contains('hidden'), true);
});

test('the Front Page draws no selection wash until a story is opened, and j starts at the lead', async () => {
	const browser = await openFrontPage();
	const { elements, grid, storyButtons, story, dispatchKeydown } = browser;
	await openAllItems(browser);
	const washed = () => storyButtons().filter((button) => button.classList.contains('is-active')).map((button) => button.dataset.itemId);
	assert.deepEqual(washed(), []);
	// j from nothing steps to the first story drawn, the lead, without leaving the page.
	assert.equal(dispatchKeydown('j'), true);
	await waitForBrowserCondition(() => elements.get('reader-title')!.textContent === 'Story 119');
	assert.deepEqual(washed(), ['119']);
	assert.equal(grid.getAttribute('data-mobile-pane'), 'stream');
	dispatchKeydown('j');
	await waitForBrowserCondition(() => elements.get('reader-title')!.textContent === 'Story 120');
	assert.deepEqual(washed(), ['120']);
	story('113').dispatch('click');
	await waitForBrowserCondition(() => elements.get('reader-title')!.textContent === 'Story 113');
	assert.deepEqual(washed(), ['113']);
});
