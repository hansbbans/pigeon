import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import * as vm from 'node:vm';

import {
	advanceImpressions,
	createReadingMeter,
	isHalfVisible,
	outboundLinkHost,
	readingLogView,
	renderBrowserAppClientScript,
} from '../src/browser-app-client';

function impressionState() {
	return { since: {} as Record<string, number>, logged: {} as Record<string, boolean> };
}

test('a card is an impression after one continuous second of visibility, once per session', () => {
	const state = impressionState();
	const cards = [{ id: 'a', position: 0 }, { id: 'b', position: 1 }];
	assert.deepEqual(advanceImpressions(state, cards, 10_000), []);
	assert.deepEqual(advanceImpressions(state, cards, 10_500), []);
	assert.deepEqual(advanceImpressions(state, cards, 11_000), cards);
	assert.deepEqual(advanceImpressions(state, cards, 11_500), []);
	assert.deepEqual(advanceImpressions(state, cards, 60_000), []);
});

test('a card that leaves before a second restarts its timer when it returns', () => {
	const state = impressionState();
	const card = [{ id: 'a', position: 4 }];
	advanceImpressions(state, card, 0);
	advanceImpressions(state, card, 500);
	assert.deepEqual(advanceImpressions(state, [], 900), []);
	assert.deepEqual(advanceImpressions(state, card, 1_200), []);
	assert.deepEqual(advanceImpressions(state, card, 2_100), []);
	assert.deepEqual(advanceImpressions(state, card, 2_200), card);
});

test('an impression reports the position the card had when it qualified', () => {
	const state = impressionState();
	advanceImpressions(state, [{ id: 'a', position: 3 }], 0);
	assert.deepEqual(advanceImpressions(state, [{ id: 'a', position: 2 }], 1_000), [{ id: 'a', position: 2 }]);
});

test('half visibility is measured against the card, or the viewport for a card taller than it', () => {
	assert.equal(isHalfVisible(100, 200, 0, 600), true);
	assert.equal(isHalfVisible(550, 650, 0, 600), true);
	assert.equal(isHalfVisible(551, 651, 0, 600), false);
	assert.equal(isHalfVisible(-60, 40, 0, 600), false);
	assert.equal(isHalfVisible(-50, 50, 0, 600), true);
	assert.equal(isHalfVisible(700, 800, 0, 600), false);
	assert.equal(isHalfVisible(-400, 1_400, 0, 600), true);
	assert.equal(isHalfVisible(0, 0, 0, 600), false);
	assert.equal(isHalfVisible(0, 100, 0, 0), false);
});

test('reading log view names follow the API values and carry the stream for feeds and folders', () => {
	const view = (id: string, kind: string, streamId: string) => ({ id, kind, streamId });
	assert.deepEqual(readingLogView(view('for-you', 'recommended', 'for-you'), false), { view: 'for-you', stream: null });
	assert.deepEqual(readingLogView(view('unread', 'unread', 'user/-/state/com.google/reading-list'), false), { view: 'unread', stream: null });
	for (const kind of ['all', 'today', 'recent', 'starred', 'saved']) {
		assert.deepEqual(readingLogView(view(kind, kind, 'x'), false), { view: kind, stream: null });
	}
	assert.deepEqual(readingLogView(view('feed/7', 'feed', 'feed/7'), false), { view: 'feed', stream: 'feed/7' });
	assert.deepEqual(
		readingLogView(view('feed/7::user/-/label/Tech', 'feed', 'feed/7'), false),
		{ view: 'feed', stream: 'feed/7' },
	);
	assert.deepEqual(readingLogView(view('user/-/label/Tech', 'folder', 'user/-/label/Tech'), false), { view: 'folder', stream: 'user/-/label/Tech' });
	assert.deepEqual(readingLogView(view('unread', 'unread', 'x'), true), { view: 'search', stream: null });
	assert.deepEqual(readingLogView(view('feed/7', 'feed', 'feed/7'), true), { view: 'search', stream: 'feed/7' });
	assert.equal(readingLogView(null, false), null);
	assert.equal(readingLogView(view('odd', 'Something New', 'x'), false), null);
});

test('outbound link hosts come only from http and https links', () => {
	assert.equal(outboundLinkHost('https://News.Example.com/a?b=1'), 'news.example.com');
	assert.equal(outboundLinkHost('http://example.com:8080/x'), 'example.com');
	assert.equal(outboundLinkHost('#note-1'), null);
	assert.equal(outboundLinkHost('mailto:a@example.com'), null);
	assert.equal(outboundLinkHost('javascript:alert(1)'), null);
	assert.equal(outboundLinkHost('/relative/path'), null);
	assert.equal(outboundLinkHost(''), null);
	assert.equal(outboundLinkHost(null), null);
});

test('the reading meter counts only time spent reading and reports it once', () => {
	const meter = createReadingMeter();
	assert.equal(meter.itemId(), null);
	meter.tick(500, true);
	assert.equal(meter.take(0), null);

	meter.open('a', 1_000);
	assert.equal(meter.itemId(), 'a');
	for (let now = 1_500; now <= 5_000; now += 500) meter.tick(now, true);
	for (let now = 5_500; now <= 9_000; now += 500) meter.tick(now, false);
	for (let now = 9_500; now <= 10_000; now += 500) meter.tick(now, true);
	assert.equal(meter.take(10), null);
	assert.deepEqual(meter.take(1), { itemId: 'a', durationSeconds: 5, scrollDepth: null });
	assert.equal(meter.take(0.1), null);
	meter.tick(10_500, true);
	assert.deepEqual(meter.take(0.1), { itemId: 'a', durationSeconds: 0.5, scrollDepth: null });
});

test('the reading meter ignores a stalled timer and stops counting when the reader goes idle', () => {
	const meter = createReadingMeter(120_000, 2_000);
	meter.open('a', 0);
	meter.tick(60_000, true);
	assert.deepEqual(meter.take(0), { itemId: 'a', durationSeconds: 2, scrollDepth: null });

	meter.open('b', 0);
	for (let now = 1_000; now <= 200_000; now += 1_000) meter.tick(now, true);
	assert.deepEqual(meter.take(0), { itemId: 'b', durationSeconds: 120, scrollDepth: null });
	meter.interact(200_000);
	meter.tick(201_000, true);
	assert.deepEqual(meter.take(0), { itemId: 'b', durationSeconds: 1, scrollDepth: null });
});

test('the reading meter reports each scroll quartile once and carries the deepest scroll', () => {
	const meter = createReadingMeter();
	assert.equal(meter.scroll(0.9), null);
	meter.open('a', 0);
	assert.equal(meter.scroll(0.1), null);
	assert.equal(meter.scroll(0.3), 0.3);
	assert.equal(meter.scroll(0.45), null);
	assert.equal(meter.scroll(0.2), null);
	assert.equal(meter.scroll(0.8), 0.8);
	assert.equal(meter.scroll(1.4), 1);
	assert.equal(meter.scroll(1), null);
	meter.tick(1_000, true);
	assert.deepEqual(meter.take(1), { itemId: 'a', durationSeconds: 1, scrollDepth: 1 });

	meter.open('b', 2_000);
	meter.tick(3_000, true);
	assert.deepEqual(meter.take(1), { itemId: 'b', durationSeconds: 1, scrollDepth: null });
	meter.close();
	assert.equal(meter.itemId(), null);
	assert.equal(meter.take(0), null);
});

test('the reading log helpers survive serialization into the page script', () => {
	const context: Record<string, any> = { window: {}, URL };
	vm.runInNewContext(renderBrowserAppClientScript(), context);
	const shipped = context.window.__PIGEON_BROWSER_CLIENT__;
	const state = { since: {}, logged: {} };
	shipped.advanceImpressions(state, [{ id: 'a', position: 0 }], 0);
	assert.equal(JSON.stringify(shipped.advanceImpressions(state, [{ id: 'a', position: 0 }], 1_000)), '[{"id":"a","position":0}]');
	assert.equal(shipped.isHalfVisible(0, 100, 0, 600), true);
	assert.equal(shipped.outboundLinkHost('https://example.com/a'), 'example.com');
	assert.equal(JSON.stringify(shipped.readingLogView({ id: 'for-you', kind: 'recommended', streamId: 'for-you' }, false)), '{"view":"for-you","stream":null}');
	const meter = shipped.createReadingMeter();
	meter.open('a', 0);
	meter.tick(1_000, true);
	assert.equal(meter.take(1).durationSeconds, 1);
});
