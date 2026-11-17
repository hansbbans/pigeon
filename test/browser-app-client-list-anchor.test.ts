import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	createStatefulArticleBrowser,
	findListButtonByItemId,
	flushBrowserTasks,
	renderedArticleIds,
	setFakeLayout,
	waitForBrowserCondition,
} from './helpers/browser-app-client-harness';

// Read rows shrink to one line once they are no longer open, so the row that
// was just left changes height above the one being read. The list must keep
// the reader's place instead of letting everything below jump.
const FULL_ROW = 100;
const READ_ROW = 40;

test('opening the next article keeps it in place when the one above shrinks to read', async (t) => {
	const { harness } = await createStatefulArticleBrowser({ count: 8, policy: 'opened' });
	const shell = harness.elements.get('articles-list-shell')!;
	const list = harness.elements.get('articles-list')!;
	const rowHeight = (button: ReturnType<typeof findListButtonByItemId>) =>
		button!.classList.contains('is-read') && !button!.classList.contains('is-active') ? READ_ROW : FULL_ROW;
	setFakeLayout((element) => {
		if (!element.dataset.itemId || element.parentElement?.parentElement !== list) return undefined;
		let top = -shell.scrollTop;
		for (const row of list.children) {
			const button = row.children.find((child) => child.dataset.itemId);
			const height = button ? rowHeight(button) : 24;
			if (button === element) return { width: 400, height, left: 0, right: 400, top, bottom: top + height };
			top += height;
		}
		return undefined;
	});
	t.after(() => setFakeLayout(null));

	const ids = renderedArticleIds(harness);
	assert.ok(ids.length >= 4);
	const open = async (id: string) => {
		findListButtonByItemId(list, id)!.dispatch('click');
		// When-opened auto-read: wait until the opened row is both open and read.
		await waitForBrowserCondition(() => {
			const button = findListButtonByItemId(list, id);
			return button?.classList.contains('is-active') === true && button.getAttribute('data-read') === 'true';
		}, 100);
		await flushBrowserTasks();
	};
	const topOf = (id: string) => findListButtonByItemId(list, id)!.getBoundingClientRect().top;

	await open(ids[1]);
	shell.scrollTop = 150;
	const before = topOf(ids[2]);

	await open(ids[2]);
	assert.equal(findListButtonByItemId(list, ids[1])!.getAttribute('data-read'), 'true', 'the article left behind is read');
	assert.equal(topOf(ids[2]), before, 'the opened row stays where it was on screen');

	// Keyboard-sized steps, five in a row: the open row never moves.
	for (const id of ids.slice(3, 8)) {
		const top = topOf(id);
		await open(id);
		assert.equal(topOf(id), top);
	}
});
