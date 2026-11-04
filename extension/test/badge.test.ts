import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Badge, DEFAULT_TITLE, WAITING_COLOR, type ActionApi } from '../src/core/badge';
import { MemoryStore } from './helpers/fakes';

type Color = string | [number, number, number, number];

/** Chrome's action badge: per-tab values override global ones; only text has a per-tab reset (null). */
class FakeAction implements ActionApi {
	global = { text: '', color: [0, 0, 0, 0] as Color, title: DEFAULT_TITLE };
	tabs = new Map<number, { text?: string; color?: Color; title?: string }>();

	private tab(tabId: number) {
		if (!this.tabs.has(tabId)) this.tabs.set(tabId, {});
		return this.tabs.get(tabId)!;
	}
	async setBadgeText({ tabId, text }: { tabId?: number; text: string | null }) {
		if (tabId === undefined) this.global.text = text ?? '';
		else if (text === null) delete this.tab(tabId).text;
		else this.tab(tabId).text = text;
	}
	async setBadgeBackgroundColor({ tabId, color }: { tabId?: number; color: Color }) {
		if (tabId === undefined) this.global.color = color;
		else this.tab(tabId).color = color;
	}
	async getBadgeBackgroundColor({ tabId }: { tabId?: number }) {
		return tabId === undefined ? this.global.color : this.tab(tabId).color ?? this.global.color;
	}
	async setTitle({ tabId, title }: { tabId?: number; title: string }) {
		if (typeof title !== 'string') throw new Error("Missing required property 'title'.");
		if (tabId === undefined) this.global.title = title;
		else this.tab(tabId).title = title;
	}
	async getTitle({ tabId }: { tabId?: number }) {
		return tabId === undefined ? this.global.title : this.tab(tabId).title ?? this.global.title;
	}
	/** What the user sees on a tab. */
	shown(tabId: number) {
		const tab = this.tabs.get(tabId) ?? {};
		return { text: tab.text ?? this.global.text, color: tab.color ?? this.global.color, title: tab.title ?? this.global.title };
	}
}

function setup() {
	const action = new FakeAction();
	const timers: Array<() => void> = [];
	const badge = new Badge(action, new MemoryStore(), (callback) => timers.push(callback));
	const runTimers = async () => {
		for (const timer of timers.splice(0)) timer();
		await new Promise((resolve) => setTimeout(resolve, 10));
	};
	return { action, badge, runTimers };
}

test('a "!" on a tab clears after its timeout and the tab follows the queue count from then on', async () => {
	const { action, badge, runTimers } = setup();
	await badge.setQueued(1);
	await badge.showOnTab(7, '!', '#b91c1c', 'Pigeon is unreachable. 1 save is waiting.', 10_000);
	assert.equal(action.shown(7).text, '!');
	await runTimers();
	assert.deepEqual(action.shown(7), { text: '1', color: WAITING_COLOR, title: '1 save is waiting.' });
	// The queue empties later: the tab must not keep the stale orange tooltip and colour.
	await badge.setQueued(0);
	assert.deepEqual(action.shown(7), { text: '', color: '#6b7280', title: DEFAULT_TITLE });
	await badge.setQueued(3, 'Sign in to Pigeon');
	assert.deepEqual(action.shown(7), { text: '3', color: WAITING_COLOR, title: 'Sign in to Pigeon. 3 saves are waiting.' });
});

test('an old timer does not clear a newer state on the same tab', async () => {
	const { action, badge, runTimers } = setup();
	await badge.showOnTab(3, '✓', '#15803d', 'Saved to Pigeon', 5_000);
	await badge.showOnTab(3, '…', '#6b7280', 'Saving to Pigeon…');
	await runTimers();
	assert.equal(action.shown(3).text, '…');
});

test('a tab showing its own state is not overwritten by queue changes', async () => {
	const { action, badge } = setup();
	await badge.showOnTab(5, '…', '#6b7280', 'Saving to Pigeon…');
	await badge.setQueued(2);
	assert.deepEqual(action.shown(5), { text: '…', color: '#6b7280', title: 'Saving to Pigeon…' });
});

test('a closed tab is forgotten', async () => {
	const { action, badge, runTimers } = setup();
	await badge.showOnTab(9, '✓', '#15803d', 'Saved', 5_000);
	await runTimers();
	await badge.forgetTab(9);
	action.tabs.delete(9);
	await badge.setQueued(1);
	assert.equal(action.tabs.has(9), false);
});

test('the default timer works when called as a method (browsers reject setTimeout with a foreign this)', async () => {
	const action = new FakeAction();
	const realSetTimeout = globalThis.setTimeout;
	// Mimic the browser: setTimeout called with an object as `this` throws.
	globalThis.setTimeout = function (this: unknown, ...args: Parameters<typeof setTimeout>) {
		if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
		return realSetTimeout(...args);
	} as typeof setTimeout;
	try {
		const badge = new Badge(action, new MemoryStore());
		await badge.showOnTab(1, '✓', '#15803d', 'Saved', 1);
	} finally {
		globalThis.setTimeout = realSetTimeout;
	}
	await new Promise((resolve) => realSetTimeout(resolve, 30));
	assert.equal(action.shown(1).text, '');
});
