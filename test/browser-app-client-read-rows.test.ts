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

// Read rows are compact so unread ones stand out, but a row a list has shown in
// full keeps its height in that list for the session: nothing above the
// reader's place shrinks while they work through it, or when they come back.
test('a list never shrinks a row it has shown; read rows are compact in a list not shown yet', async (t) => {
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

	// Back to a list already shown: same shapes, so its saved scroll position still fits.
	findListButtonByViewId(views, 'unread')!.dispatch('click');
	await flushBrowserTasks();
	findListButtonByViewId(views, 'all')!.dispatch('click');
	await waitForBrowserCondition(() => row(ids[1]) !== undefined && row(ids[5]).classList.contains('is-active'), 100);
	await flushBrowserTasks();
	assert.deepEqual(compactIds(), []);

	// A list this session has not shown (here: the same view with another sort)
	// shows read rows compact; the open one stays full.
	const sort = harness.elements.get('article-sort-select')!;
	sort.value = 'oldest';
	sort.dispatch('change');
	await waitForBrowserCondition(() => compactIds().length > 0, 100);
	await flushBrowserTasks();
	// Changing the sort opens the first story of the new order; it is never compact.
	const openIds = renderedArticleIds(harness).filter((id) => row(id).classList.contains('is-active'));
	assert.equal(openIds.length, 1);
	assert.ok(!row(openIds[0]).classList.contains('is-compact'));
	assert.ok(compactIds().every((id) => row(id).getAttribute('data-read') === 'true'));
	for (const id of ids.slice(1, 5)) {
		assert.ok(row(id).classList.contains('is-compact'));
		assert.equal(findDescendantByClass(row(id), 'article-preview'), undefined, 'compact: no preview');
		assert.equal(findDescendantByClass(row(id), 'article-hero'), undefined, 'compact: no image is loaded');
	}

	// Rereading a one-line row brings it back in full, and it stays full after.
	await open(ids[2]);
	assert.ok(!row(ids[2]).classList.contains('is-compact') && findDescendantByClass(row(ids[2]), 'article-preview'));
	await open(ids[3]);
	assert.ok(!row(ids[2]).classList.contains('is-compact'), 'a row shown full this visit does not shrink again');
	assert.ok(!row(ids[3]).classList.contains('is-compact'));
	assert.ok(row(ids[4]).classList.contains('is-compact'));
});
