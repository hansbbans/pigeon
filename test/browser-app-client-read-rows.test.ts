import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	createStatefulArticleBrowser,
	findDescendantByClass,
	findListButtonByItemId,
	findListButtonByViewId,
	flushBrowserTasks,
	renderedArticleIds,
	waitForBrowserCondition,
} from './helpers/browser-app-client-harness';

// Read rows are one line so unread ones stand out, but a row the reader has
// already seen in full keeps its height for the rest of the visit: nothing
// above the reader's place shrinks while they work through the list.
test('read rows stay full during a visit and are one line on the next visit', async (t) => {
	const { database, harness } = await createStatefulArticleBrowser({ count: 6, policy: 'opened' });
	t.after(() => database.close());
	const list = harness.elements.get('articles-list')!;
	const views = harness.elements.get('views-list')!;
	const row = (id: string) => findListButtonByItemId(list, id)!;
	const compactIds = () => renderedArticleIds(harness).filter((id) => row(id).classList.contains('is-compact'));
	const open = async (id: string) => {
		row(id).dispatch('click');
		await waitForBrowserCondition(() => row(id).classList.contains('is-active') && row(id).getAttribute('data-read') === 'true', 100);
		await flushBrowserTasks();
	};

	findListButtonByViewId(views, 'all')!.dispatch('click');
	await waitForBrowserCondition(() => renderedArticleIds(harness).length >= 6, 100);
	await flushBrowserTasks();
	const ids = renderedArticleIds(harness);
	assert.ok(row(ids[1]).getAttribute('data-read') === 'false' && findDescendantByClass(row(ids[1]), 'article-preview'));

	// Five opens in a row: every article left behind is read, none shrinks.
	for (const id of ids.slice(1, 6)) await open(id);
	for (const id of ids.slice(1, 5)) {
		assert.equal(row(id).getAttribute('data-read'), 'true');
		assert.ok(findDescendantByClass(row(id), 'article-preview'), 'a row read during the visit keeps its preview');
	}
	assert.deepEqual(compactIds(), []);

	// A new visit: the read rows are one line, the open one stays full.
	findListButtonByViewId(views, 'unread')!.dispatch('click');
	await flushBrowserTasks();
	findListButtonByViewId(views, 'all')!.dispatch('click');
	await waitForBrowserCondition(() => compactIds().length > 0, 100);
	await flushBrowserTasks();
	const open5 = row(ids[5]);
	assert.ok(open5.classList.contains('is-active') && !open5.classList.contains('is-compact'));
	// Only read rows are ever one line (a row read after this visit showed it stays full).
	assert.ok(compactIds().every((id) => row(id).getAttribute('data-read') === 'true'));
	for (const id of ids.slice(1, 5)) {
		assert.ok(row(id).classList.contains('is-compact'));
		assert.equal(findDescendantByClass(row(id), 'article-preview'), undefined, 'one line: no preview');
		assert.equal(findDescendantByClass(row(id), 'article-hero'), undefined, 'one line: no image is loaded');
	}

	// Rereading a one-line row brings it back in full, and it stays full after.
	await open(ids[2]);
	assert.ok(!row(ids[2]).classList.contains('is-compact') && findDescendantByClass(row(ids[2]), 'article-preview'));
	await open(ids[3]);
	assert.ok(!row(ids[2]).classList.contains('is-compact'), 'a row shown full this visit does not shrink again');
	assert.ok(!row(ids[3]).classList.contains('is-compact'));
	assert.ok(row(ids[4]).classList.contains('is-compact'));
});
