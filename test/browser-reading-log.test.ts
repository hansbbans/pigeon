import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	createStatefulArticleBrowser,
	drainBrowserMembershipPages,
	findListButtonByItemId,
	findListButtonByViewId,
	flushBrowserTasks,
	renderedArticleIds,
	waitForBrowserCondition,
	waitForTodayWindow,
} from './helpers/browser-app-client-harness';

const START = new Date(2026, 9, 12, 12).getTime();

async function openBrowser(options: Parameters<typeof createStatefulArticleBrowser>[0] = {}) {
	let now = START;
	const requests: string[] = [];
	let inFlight = 0;
	const browser = await createStatefulArticleBrowser({
		count: 4,
		now: () => now,
		...options,
		fetchOverride: async (input, init, next) => {
			requests.push(input);
			inFlight += 1;
			try {
				return await (options.fetchOverride ? options.fetchOverride(input, init, next) : next());
			} finally {
				inFlight -= 1;
			}
		},
	});
	const { harness, database } = browser;
	/** Log sends are fire-and-forget in the page, so wait for them to land before asserting. */
	const settle = async () => {
		await flushBrowserTasks();
		await waitForBrowserCondition(() => inFlight === 0, 500);
		await flushBrowserTasks();
	};
	// The page registers exactly one timer, the reading-log tick, every 500 ms.
	assert.deepEqual(harness.intervals.map((interval) => interval.milliseconds), [500]);
	/** Advance the page clock in 500 ms steps, running the reading-log tick at each. */
	const run = async (milliseconds: number) => {
		for (let elapsed = 0; elapsed < milliseconds; elapsed += 500) {
			now += 500;
			harness.intervals[0].handler();
		}
		await settle();
	};
	const sleep = (milliseconds: number) => { now += milliseconds; };
	const itemRowid = (id: string) => String((database.prepare('SELECT rowid FROM items WHERE id = ?').get(id) as { rowid: number }).rowid);
	const openByClick = async (id: string) => {
		findListButtonByItemId(harness.elements.get('articles-list'), itemRowid(id))!.dispatch('click');
		// Reading time starts once the article is on screen, so wait for the frame.
		await waitForBrowserCondition(() => harness.window.__readyReaderItemId() === itemRowid(id), 100);
		await settle();
	};
	// Sends that leave the page in the same instant can land in any order, so
	// order by when things happened, then by item, kind and depth.
	const engagement = () => database.prepare(
		`SELECT item_id, event_type, duration_seconds, scroll_depth, destination_host, client_family
		 FROM engagement_events WHERE event_type NOT IN ('read', 'unread')
		 ORDER BY occurred_at, item_id, event_type, scroll_depth`,
	).all().map((row) => ({ ...row })) as Array<Record<string, unknown>>;
	const impressions = () => database.prepare(
		'SELECT item_id, view, position, session_id, client_family, metadata_json FROM reading_log ORDER BY rowid',
	).all().map((row) => ({ ...row })) as Array<Record<string, unknown>>;
	return { ...browser, requests, run, sleep, settle, openByClick, itemRowid, engagement, impressions };
}

test('cards on screen for a second are logged once per list session, in one batch', async () => {
	const { harness, requests, run, impressions, settle } = await openBrowser();
	const shown = renderedArticleIds(harness).length;
	assert.ok(shown >= 4);

	await run(500);
	await run(500);
	assert.equal(requests.filter((path) => path === '/api/v1/reading-log').length, 0, 'impressions wait for the batch flush');
	await run(4_000);
	assert.equal(requests.filter((path) => path === '/api/v1/reading-log').length, 1);

	const rows = impressions();
	assert.equal(rows.length, shown);
	assert.deepEqual(rows.map((row) => row.position), Array.from({ length: shown }, (_, index) => index));
	assert.equal(new Set(rows.map((row) => row.session_id)).size, 1);
	assert.equal(new Set(rows.map((row) => row.item_id)).size, shown);
	assert.deepEqual([...new Set(rows.map((row) => row.view))], ['all']);
	assert.deepEqual([...new Set(rows.map((row) => row.client_family))], ['pigeon_web']);

	await run(10_000);
	assert.equal(impressions().length, shown, 'a card is logged once per session');
	assert.equal(requests.filter((path) => path === '/api/v1/reading-log').length, 1, 'nothing is sent when nothing is pending');

	findListButtonByViewId(harness.elements.get('views-list'), 'unread')!.dispatch('click');
	await waitForBrowserCondition(() => harness.getCacheSizes().membership === 0 && harness.getCacheSizes().pending === 0, 200);
	await settle();
	await run(5_000);
	const afterSwitch = impressions();
	assert.ok(afterSwitch.length > shown, 'a new view starts a new session');
	assert.equal(new Set(afterSwitch.map((row) => row.session_id)).size, 2);
	assert.equal(afterSwitch.at(-1)!.view, 'unread');
});

test('returning to the page soon keeps the list session; returning after 15 minutes starts a new one', async () => {
	const { harness, run, impressions, settle } = await openBrowser();
	await run(5_000);
	const shown = impressions().length;
	assert.ok(shown > 0);

	harness.setVisibility('hidden');
	await run(60_000);
	harness.setVisibility('visible');
	await settle();
	await run(5_000);
	assert.equal(impressions().length, shown, 'a short absence does not log the same cards again');

	harness.setVisibility('hidden');
	await run(15 * 60_000);
	harness.setVisibility('visible');
	await settle();
	await run(5_000);
	assert.equal(impressions().length, shown * 2);
	assert.equal(new Set(impressions().map((row) => row.session_id)).size, 2);
});

test('a hidden page logs no impressions and restarts the one-second clock', async () => {
	const { harness, run, impressions, settle } = await openBrowser();
	await run(500);
	harness.setVisibility('hidden');
	await run(10_000);
	assert.equal(impressions().length, 0);
	harness.setVisibility('visible');
	await settle();
	await run(500);
	assert.equal(impressions().length, 0);
	await run(5_000);
	assert.ok(impressions().length > 0);
});

test('clicking a card records an open and the exact reading time; the auto-selected article records nothing', async () => {
	const { harness, run, openByClick, engagement, settle } = await openBrowser();
	await run(20_000);
	assert.deepEqual(engagement(), [], 'the article the list selected by itself is not an open');

	await openByClick('today-2');
	assert.deepEqual(engagement(), [
		{ item_id: 'today-2', event_type: 'explicit_open', duration_seconds: null, scroll_depth: null, destination_host: null, client_family: 'pigeon' },
	]);

	await run(4_000);
	await openByClick('today-3');
	assert.deepEqual(engagement().slice(1).map((row) => [row.item_id, row.event_type, row.duration_seconds]), [
		['today-2', 'active_reading', 4],
		['today-3', 'explicit_open', null],
	]);

	await run(15_000);
	assert.deepEqual(engagement().slice(3).map((row) => [row.item_id, row.event_type, row.duration_seconds]), [
		['today-3', 'active_reading', 15],
	], 'long reads report in chunks');
	await run(2_500);
	harness.setVisibility('hidden');
	await settle();
	assert.deepEqual(engagement().slice(4).map((row) => [row.item_id, row.event_type, row.duration_seconds]), [
		['today-3', 'active_reading', 2.5],
	], 'hiding the page reports the remainder');

	await run(30_000);
	harness.setVisibility('visible');
	await settle();
	harness.dispatchWindowEvent('pagehide');
	await settle();
	assert.equal(engagement().length, 5, 'time while hidden is not reading time');
});

test('stepping through articles with the keyboard counts as an open only after three seconds', async () => {
	const { harness, run, engagement, settle } = await openBrowser();
	const title = () => harness.elements.get('reader-title')!.textContent;
	const first = title();
	const ready = () => harness.window.__readyReaderItemId();
	const firstReady = ready();
	assert.equal(harness.dispatchKeydown('j'), true);
	await waitForBrowserCondition(() => title() !== first && ready() !== firstReady && ready() !== null, 100);
	await settle();
	await run(1_500);
	const secondReady = ready();
	assert.equal(harness.dispatchKeydown('j'), true);
	await waitForBrowserCondition(() => ready() !== secondReady && ready() !== null, 100);
	await settle();
	assert.deepEqual(engagement().map((row) => [row.event_type, row.duration_seconds]), [['active_reading', 1.5]]);

	await run(3_000);
	assert.deepEqual(engagement().map((row) => row.event_type), ['active_reading', 'explicit_open']);
	assert.notEqual(engagement()[0].item_id, engagement()[1].item_id);
});

test('scrolling an opened article records each quarter once, and links out record their host', async () => {
	const { harness, run, openByClick, engagement, settle } = await openBrowser({ frameHeight: 2_000, viewportHeight: 500 });
	await openByClick('today-2');
	harness.window.open = () => {};
	(harness.window as any).innerHeight = 500;

	harness.dispatchReaderFrameScroll(100);
	harness.dispatchReaderFrameScroll(600);
	harness.dispatchReaderFrameScroll(650);
	harness.dispatchReaderFrameScroll(1_500);
	await settle();
	const ofType = (type: string) => engagement().filter((row) => row.event_type === type);
	assert.deepEqual(ofType('scroll_depth').map((row) => row.scroll_depth), [0.3, 0.55, 1]);

	const link = (href: string) => ({ target: { closest: () => ({ getAttribute: () => href }) } });
	harness.dispatchFrameEvent('auxclick', link('https://News.Example.com/story?x=1'));
	harness.dispatchFrameEvent('auxclick', link('#footnote-1'));
	harness.dispatchFrameEvent('auxclick', { ...link('https://menu.example.com/'), button: 2 });
	harness.dispatchFrameEvent('auxclick', { target: { closest: () => null } });
	await settle();
	assert.deepEqual(ofType('outbound_link').map((row) => [row.item_id, row.destination_host]), [['today-2', 'news.example.com']]);

	await run(1_000);
	harness.dispatchWindowEvent('pagehide');
	await settle();
	assert.deepEqual(ofType('active_reading'), [{
		item_id: 'today-2', event_type: 'active_reading', duration_seconds: 1, scroll_depth: 1, destination_host: null, client_family: 'pigeon',
	}]);
});

test('a failing or offline reading log never reaches the reader', async () => {
	const { harness, requests, run, openByClick, engagement, impressions, settle } = await openBrowser({
		fetchOverride: async (input, _init, next) =>
			input === '/api/v1/reading-log' || input === '/api/v1/engagement' ? new Response('nope', { status: 500 }) : next(),
	});
	await openByClick('today-2');
	await run(6_000);
	harness.setVisibility('hidden');
	await settle();
	assert.ok(requests.includes('/api/v1/reading-log') && requests.includes('/api/v1/engagement'));
	assert.equal(engagement().length + impressions().length, 0);
	assert.equal(harness.elements.get('reader-title')!.textContent, 'Story 2');
	assert.equal(harness.elements.get('reader-action-status')!.textContent, '');
	assert.equal(harness.elements.get('login-error')!.textContent, '');

	harness.setVisibility('visible');
	harness.setOnline(false);
	const before = requests.filter((path) => path === '/api/v1/reading-log' || path === '/api/v1/engagement').length;
	await openByClick('today-3');
	await run(8_000);
	assert.equal(requests.filter((path) => path === '/api/v1/reading-log' || path === '/api/v1/engagement').length, before, 'offline sends nothing');
});

test('reading time stops while the reader pane is not on screen, as on a phone showing the list', async () => {
	const { harness, run, openByClick, engagement, settle } = await openBrowser();
	await openByClick('today-2');
	await run(3_000);

	// Phone layout: going back to the list leaves the article selected but hides its pane.
	const readerScroll = harness.elements.get('reader-scroll')!;
	const onScreen = readerScroll.getBoundingClientRect;
	readerScroll.getBoundingClientRect = () => ({ width: 0, height: 0, left: 0, right: 0, top: 0, bottom: 0 });
	await run(20_000);
	readerScroll.getBoundingClientRect = onScreen;
	await run(1_000);

	harness.dispatchWindowEvent('pagehide');
	await settle();
	assert.deepEqual(engagement().map((row) => [row.event_type, row.duration_seconds]), [
		['explicit_open', null],
		['active_reading', 4],
	]);
});

test('cards below the fold are not logged until they scroll into view', async () => {
	const { harness, run, impressions, itemRowid } = await openBrowser();
	const ids = renderedArticleIds(harness);
	const belowFold = ids.slice(2);
	const cards = belowFold.map((id) => findListButtonByItemId(harness.elements.get('articles-list'), id)!);
	const onScreen = cards[0].getBoundingClientRect;
	// The list viewport is 900 px tall; put every card after the second below it.
	cards.forEach((card, index) => {
		card.getBoundingClientRect = () => ({ width: 400, height: 100, left: 0, right: 400, top: 900 + index * 100, bottom: 1_000 + index * 100 });
	});
	await run(6_000);
	assert.deepEqual(impressions().map((row) => row.position), [0, 1]);

	// Scrolling brings the third card half into view and no further.
	cards[0].getBoundingClientRect = () => ({ width: 400, height: 100, left: 0, right: 400, top: 850, bottom: 950 });
	await run(6_000);
	assert.deepEqual(impressions().map((row) => row.position), [0, 1, 2]);
	assert.equal(itemRowid(String(impressions()[2].item_id)), ids[2]);
	cards.forEach((card) => { card.getBoundingClientRect = onScreen; });
});

test('a card picked in its first second on screen is logged as seen', async () => {
	const { run, openByClick, impressions, settle } = await openBrowser();
	await openByClick('today-2');
	await settle();
	// Nothing has been on screen for a second yet, but the picked card is queued.
	await run(5_000);
	const picked = impressions().filter((row) => row.item_id === 'today-2');
	assert.equal(picked.length, 1, 'once, not again when its second on screen is up');
	assert.equal(typeof picked[0].position, 'number');
});

test('reading keeps counting when the opened article comes back after a view switch', async () => {
	const { harness, run, openByClick, engagement } = await openBrowser();
	await openByClick('today-2');
	await run(2_000);

	const backOnScreen = async (viewId: string) => {
		findListButtonByViewId(harness.elements.get('views-list'), viewId)!.dispatch('click');
		await waitForBrowserCondition(() => harness.getCacheSizes().membership === 0 && harness.getCacheSizes().pending === 0, 200);
		await waitForBrowserCondition(() => harness.window.__readyReaderItemId() !== null, 200);
	};
	await backOnScreen('unread');
	assert.notEqual(harness.elements.get('reader-title')!.textContent, 'Story 2', 'another article is showing meanwhile');
	await run(5_000);
	await backOnScreen('all');
	await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'Story 2', 200);
	await waitForBrowserCondition(() => harness.window.__readyReaderItemId() !== null, 200);
	await run(6_000);
	harness.dispatchWindowEvent('pagehide');
	await run(0);

	const read = engagement().filter((row) => row.event_type === 'active_reading');
	assert.deepEqual([...new Set(read.map((row) => row.item_id))], ['today-2']);
	assert.equal(read.reduce((sum, row) => sum + Number(row.duration_seconds), 0), 8, 'two seconds before the switch, six after coming back');
	assert.equal(engagement().filter((row) => row.event_type === 'explicit_open').length, 1);
});

test('logging out sends what was read and seen before the session ends', async () => {
	const { harness, requests, run, openByClick, engagement, impressions, settle } = await openBrowser();
	await openByClick('today-2');
	await run(4_000);
	const impressionsBefore = impressions().length;
	const pendingBefore = requests.filter((path) => path === '/api/v1/reading-log').length;

	harness.elements.get('logout-button')!.dispatch('click');
	await settle();
	assert.deepEqual(engagement().filter((row) => row.event_type === 'active_reading').map((row) => [row.item_id, row.duration_seconds]), [['today-2', 4]]);
	assert.ok(impressions().length > impressionsBefore);
	assert.equal(requests.filter((path) => path === '/api/v1/reading-log').length, pendingBefore + 1);

	const sent = requests.length;
	await run(10_000);
	assert.equal(requests.length, sent, 'nothing is logged once logged out');
});

test('the keyboard three seconds are seconds of reading, not seconds since the key press', async () => {
	const { harness, run, sleep, engagement, settle } = await openBrowser();
	const ready = () => harness.window.__readyReaderItemId();
	const before = ready();
	assert.equal(harness.dispatchKeydown('j'), true);
	await waitForBrowserCondition(() => ready() !== before && ready() !== null, 100);
	await settle();
	await run(500);
	harness.setVisibility('hidden');
	sleep(60_000);
	harness.setVisibility('visible');
	await settle();
	await run(2_000);
	assert.deepEqual(engagement().filter((row) => row.event_type === 'explicit_open'), [], 'two and a half seconds of reading is not three');
	await run(500);
	assert.equal(engagement().filter((row) => row.event_type === 'explicit_open').length, 1);
});

test('stepping past the end of a 200-article window with the keyboard still counts as opening', async () => {
	const { harness, run, engagement, itemRowid, settle } = await openBrowser({ count: 205 });
	await drainBrowserMembershipPages(harness);
	await waitForTodayWindow(harness);
	const ids = renderedArticleIds(harness);
	assert.equal(ids.length, 200);
	const last = findListButtonByItemId(harness.elements.get('articles-list'), ids[199])!;
	last.dispatch('click');
	await waitForBrowserCondition(() => harness.window.__readyReaderItemId() === ids[199], 200);
	await settle();
	const opensBefore = engagement().filter((row) => row.event_type === 'explicit_open').length;

	assert.equal(harness.dispatchKeydown('j'), true);
	await waitForBrowserCondition(() => renderedArticleIds(harness)[0] !== ids[0] && harness.window.__readyReaderItemId() === renderedArticleIds(harness)[0], 400);
	await settle();
	const next = renderedArticleIds(harness)[0];
	await run(4_000);
	const opens = engagement().filter((row) => row.event_type === 'explicit_open');
	assert.equal(opens.length, opensBefore + 1);
	assert.equal(itemRowid(String(opens.at(-1)!.item_id)), next);
	harness.dispatchWindowEvent('pagehide');
	await settle();
	const read = engagement().filter((row) => row.event_type === 'active_reading' && itemRowid(String(row.item_id)) === next);
	assert.equal(read.reduce((sum, row) => sum + Number(row.duration_seconds), 0), 4);
});
