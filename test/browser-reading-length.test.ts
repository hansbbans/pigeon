import * as assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
	articleLengthMinutes,
	formatArticleTimeBoxSummary,
	formatReadingLength,
	matchesArticleTimeBox,
	shouldReportWordCount,
} from '../src/browser-app-client';
import {
	createStatefulArticleBrowser,
	findDescendantByClass,
	findListButtonByViewId,
	findListButtonByItemId,
	flushBrowserTasks,
	renderedArticleIds,
	waitForBrowserCondition,
} from './helpers/browser-app-client-harness';

test('formatReadingLength labels only items longer than 10 minutes', () => {
	assert.equal(formatReadingLength({ wordCount: 1 }), null);
	assert.equal(formatReadingLength({ wordCount: 2380 }), null);
	assert.equal(formatReadingLength({ wordCount: 2381 }), '11 min read');
	assert.equal(formatReadingLength({ wordCount: 2856 }), '12 min read');
	assert.equal(formatReadingLength({ wordCount: 0 }), null);
	assert.equal(formatReadingLength({}), null);
	assert.equal(formatReadingLength({ mediaKind: 'video', durationSeconds: 1080 }), '18 min video');
	assert.equal(formatReadingLength({ mediaKind: 'video', durationSeconds: 1100 }), '19 min video');
	assert.equal(formatReadingLength({ mediaKind: 'video', durationSeconds: 600 }), null);
	assert.equal(formatReadingLength({ mediaKind: 'video', durationSeconds: 601 }), '11 min video');
	assert.equal(formatReadingLength({ mediaKind: 'video', durationSeconds: 625 }), '11 min video');
	assert.equal(formatReadingLength({ mediaKind: 'video', durationSeconds: 20 }), null);
	assert.equal(formatReadingLength({ mediaKind: 'video', durationSeconds: 3900 }), '1 hr 5 min video');
	assert.equal(formatReadingLength({ mediaKind: 'video', durationSeconds: 3901 }), '1 hr 6 min video');
	assert.equal(formatReadingLength({ mediaKind: 'video', durationSeconds: 7200 }), '2 hr video');
	assert.equal(formatReadingLength({ mediaKind: 'video', durationSeconds: 0, wordCount: 9000 }), null);
});

test('shouldReportWordCount reports unknown or much shorter stored counts', () => {
	assert.equal(shouldReportWordCount(null, 600, 'text'), true);
	assert.equal(shouldReportWordCount(100, 149, 'text'), false);
	assert.equal(shouldReportWordCount(100, 150, 'text'), true);
	assert.equal(shouldReportWordCount(null, 49, 'text'), false);
	assert.equal(shouldReportWordCount(null, 900, 'video'), false);
	assert.equal(shouldReportWordCount(0, 900, undefined), true);
	assert.equal(shouldReportWordCount(null, 2_000_000, 'text'), true);
	assert.equal(shouldReportWordCount(null, 2_000_001, 'text'), false);
});

function seedLengths(database: DatabaseSync) {
	database.exec(`
		UPDATE items SET word_count = 2856, media_kind = 'text' WHERE id = 'today-3';
		UPDATE items SET word_count = 900, media_kind = 'text' WHERE id = 'today-2';
	`);
}

function lengthLabel(harness: Awaited<ReturnType<typeof createStatefulArticleBrowser>>['harness'], itemId: string) {
	const card = findListButtonByItemId(harness.elements.get('articles-list'), itemId);
	assert.ok(card, `card ${itemId}`);
	return findDescendantByClass(card, 'article-length')?.textContent ?? null;
}

test('list rows and the reader header show reading time for long articles only', async (t) => {
	const { database, harness } = await createStatefulArticleBrowser({ seed: seedLengths });
	t.after(() => database.close());

	assert.equal(lengthLabel(harness, '3'), '12 min read');
	assert.equal(lengthLabel(harness, '2'), null);
	assert.match(harness.elements.get('reader-source-note')!.textContent, /12 min read/);
	harness.elements.get('logout-button')!.dispatch('click');
});

test('without a server count, the label comes from the body the client already has', async (t) => {
	const longBody = `<p>${'word '.repeat(3000)}</p>`;
	const { database, harness } = await createStatefulArticleBrowser({
		seed: (db) => {
			db.prepare("UPDATE items SET html_content = ?, word_count = NULL WHERE id = 'today-3'").run(longBody);
			db.exec("UPDATE items SET word_count = 900 WHERE id = 'today-2'");
		},
	});
	t.after(() => database.close());

	assert.equal(lengthLabel(harness, '3'), '13 min read');
	assert.equal(lengthLabel(harness, '2'), null);
	harness.elements.get('logout-button')!.dispatch('click');
});

test('formatReadingLength prefers the server count over the estimate', () => {
	assert.equal(formatReadingLength({ wordCount: 5000, estimatedWordCount: 10 }), '22 min read');
	assert.equal(formatReadingLength({ estimatedWordCount: 3000 }), '13 min read');
	assert.equal(formatReadingLength({ wordCount: 0, estimatedWordCount: 3000 }), null);
});

test('the Show reading time setting hides labels, persists, and re-renders when toggled', async (t) => {
	const { database, harness } = await createStatefulArticleBrowser({ seed: seedLengths, storedShowReadingTime: '0' });
	t.after(() => database.close());
	const checkbox = harness.elements.get('show-reading-time')!;

	assert.equal(checkbox.checked, false);
	assert.equal(lengthLabel(harness, '3'), null);
	assert.doesNotMatch(harness.elements.get('reader-source-note')!.textContent, /min read/);

	checkbox.checked = true;
	checkbox.dispatch('change');
	assert.equal(harness.localStorageState.get('pigeon.browser.show-reading-time'), '1');
	assert.equal(lengthLabel(harness, '3'), '12 min read');
	assert.match(harness.elements.get('reader-source-note')!.textContent, /12 min read/);

	checkbox.checked = false;
	checkbox.dispatch('change');
	assert.equal(harness.localStorageState.get('pigeon.browser.show-reading-time'), '0');
	assert.equal(lengthLabel(harness, '3'), null);
	harness.elements.get('logout-button')!.dispatch('click');
});

function readingTools() {
	const preferences = {
		theme: 'sepia', font: 'serif', fontSize: 18, lineHeight: 1.6, width: 720, margins: 24, density: 'comfortable',
		imagePolicy: 'load', shortcuts: { next: 'n', previous: 'p', read: 'r', star: 't' },
	};
	return {
		readPreferences: () => preferences,
		savePreferences: (next: unknown) => next,
		frameCSS: () => 'body{font-size:18px}',
		async applyImagePolicy(html: string) { return { html, images: [], blockedCount: 0 }; },
	};
}

async function openInReaderMode(extractedWordCount: number) {
	const reports: Array<{ itemIds: string[]; wordCount: number }> = [];
	const browser = await createStatefulArticleBrowser({
		readingTools: readingTools(),
		seed: (database) => {
			database.exec("UPDATE items SET word_count = 40, media_kind = 'text', original_url = 'https://example.com/story-3' WHERE id = 'today-3'");
		},
		extractReader: () => ({ content: '<p>Extracted story</p>', url: 'https://example.com/story-3', wordCount: extractedWordCount }),
		fetchOverride: async (input, init, next) => {
			if (input.startsWith('/api/v1/browser/reader-source?')) {
				return Response.json({ url: 'https://example.com/story-3', html: '<article>Source</article>' });
			}
			if (input === '/api/v1/mutations') {
				for (const mutation of JSON.parse(String(init?.body)).mutations) {
					if (mutation.kind === 'set_word_count') reports.push({ itemIds: mutation.itemIds, wordCount: mutation.wordCount });
				}
			}
			return next();
		},
	});
	const modeSelect = browser.harness.elements.get('reader-mode-select')!;
	const switchTo = async (mode: string) => {
		modeSelect.value = mode;
		modeSelect.dispatch('change');
		await flushBrowserTasks();
	};
	await switchTo('reader');
	await waitForBrowserCondition(() => browser.harness.elements.get('reader-frame')!.srcdoc.includes('Extracted story'), 100);
	await flushBrowserTasks();
	return { ...browser, reports, switchTo };
}

test('reader mode reports a much longer extracted count once and updates the label', async (t) => {
	const { database, harness, reports, switchTo } = await openInReaderMode(3000);
	t.after(() => database.close());

	assert.equal(reports.length, 1);
	assert.equal(reports[0]?.wordCount, 3000);
	assert.equal(reports[0]?.itemIds.length, 1);
	// The report is fire-and-forget; wait for the write to land.
	await waitForBrowserCondition(
		() => (database.prepare("SELECT word_count FROM items WHERE id = 'today-3'").get() as { word_count: number }).word_count === 3000,
		1_000,
	);
	assert.equal(lengthLabel(harness, '3'), '13 min read');
	assert.match(harness.elements.get('reader-source-note')!.textContent, /13 min read/);

	await switchTo('newsletter');
	await switchTo('reader');
	await waitForBrowserCondition(() => harness.elements.get('reader-frame')!.srcdoc.includes('Extracted story'), 100);
	await flushBrowserTasks();
	assert.equal(reports.length, 1);
	harness.elements.get('logout-button')!.dispatch('click');
});

test('reader mode does not report a count close to the stored one', async (t) => {
	const { database, harness, reports } = await openInReaderMode(45);
	t.after(() => database.close());

	assert.equal(reports.length, 0);
	assert.equal((database.prepare("SELECT word_count FROM items WHERE id = 'today-3'").get() as { word_count: number }).word_count, 40);
	harness.elements.get('logout-button')!.dispatch('click');
});

test('a reader-mode choice survives a render that resets the select while settings load', async (t) => {
	const browser = await createStatefulArticleBrowser({
		readingTools: readingTools(),
		seed: (database) => { database.exec("UPDATE items SET original_url = 'https://example.com/story-3' WHERE id = 'today-3'"); },
		extractReader: () => ({ content: '<p>Extracted story</p>', url: 'https://example.com/story-3', wordCount: 100 }),
		fetchOverride: async (input, _init, next) => input.startsWith('/api/v1/browser/reader-source?')
			? Response.json({ url: 'https://example.com/story-3', html: '<article>Source</article>' })
			: next(),
	});
	t.after(() => browser.database.close());
	const modeSelect = browser.harness.elements.get('reader-mode-select')!;
	modeSelect.value = 'reader';
	modeSelect.dispatch('change');
	// What an in-flight prepareReadingFrame does before the handler resumes.
	modeSelect.value = 'newsletter';
	await waitForBrowserCondition(() => browser.harness.elements.get('reader-frame')!.srcdoc.includes('Extracted story'), 100);
	browser.harness.elements.get('logout-button')!.dispatch('click');
});

test('For You does not erase a video length the feed view already loaded', async (t) => {
	const { database, harness } = await createStatefulArticleBrowser({
		seed: (db) => { db.exec("UPDATE items SET media_kind = 'video', duration_seconds = 1080 WHERE id = 'today-3'"); },
		fetchOverride: async (input, _init, next) => input.startsWith('/api/v1/recommendations?')
			// The recommendations payload carries no reading-length fields.
			? Response.json({ items: [{
				readerId: 'tag:google.com,2005:reader/item/0000000000000003', id: 'today-3', feedKey: 'today-source',
				source: 'Today source', title: 'Story 3', author: '', receivedAt: '2026-10-12T12:00:00.000Z',
				originalURL: null, html: '<p>Body 3</p>', text: 'Body 3', isRead: false, isStarred: false,
				score: 20, explanation: 'Matches your interests', matchedTopics: [],
			}], continuation: null })
			: next(),
	});
	t.after(() => database.close());
	assert.equal(lengthLabel(harness, '3'), '18 min video');

	findListButtonByViewId(harness.elements.get('views-list'), 'for-you')!.dispatch('click');
	await waitForBrowserCondition(() => findListButtonByItemId(harness.elements.get('articles-list'), '3') !== null, 200);
	await flushBrowserTasks();
	assert.equal(lengthLabel(harness, '3'), '18 min video');
	harness.elements.get('logout-button')!.dispatch('click');
});

test('articleLengthMinutes, matchesArticleTimeBox, and formatArticleTimeBoxSummary match reading buckets', () => {
	assert.equal(articleLengthMinutes({ wordCount: 952 }), 4);
	assert.equal(articleLengthMinutes({ wordCount: 953 }), 5);
	assert.equal(articleLengthMinutes({ wordCount: 3332 }), 14);
	assert.equal(articleLengthMinutes({ wordCount: 3333 }), 15);
	assert.equal(articleLengthMinutes({ estimatedWordCount: 1190 }), 5);
	assert.equal(articleLengthMinutes({ wordCount: 500, estimatedWordCount: 5000 }), 3);
	assert.equal(articleLengthMinutes({ mediaKind: 'video', durationSeconds: 240 }), 4);
	assert.equal(articleLengthMinutes({ mediaKind: 'video', durationSeconds: 241 }), 5);
	assert.equal(articleLengthMinutes({ mediaKind: 'video', durationSeconds: 840 }), 14);
	assert.equal(articleLengthMinutes({ mediaKind: 'video', durationSeconds: 841 }), 15);
	assert.equal(articleLengthMinutes({ mediaKind: 'video', wordCount: 5000 }), null);
	assert.equal(articleLengthMinutes({}), null);

	const shortText = { wordCount: 952, mediaKind: 'text' };
	const mediumText = { wordCount: 953, mediaKind: 'text' };
	const longVideo = { mediaKind: 'video', durationSeconds: 900 };
	const unknownText = {};

	assert.equal(matchesArticleTimeBox(shortText, 'all', 'short'), true);
	assert.equal(matchesArticleTimeBox(shortText, 'text', 'short'), true);
	assert.equal(matchesArticleTimeBox(shortText, 'video', 'short'), false);
	assert.equal(matchesArticleTimeBox(mediumText, 'text', 'short'), false);
	assert.equal(matchesArticleTimeBox(mediumText, 'text', 'medium'), true);
	assert.equal(matchesArticleTimeBox(longVideo, 'video', 'long'), true);
	assert.equal(matchesArticleTimeBox(longVideo, 'text', 'long'), false);
	assert.equal(matchesArticleTimeBox(unknownText, 'text', 'any'), true);
	assert.equal(matchesArticleTimeBox(unknownText, 'text', 'short'), false);

	assert.equal(formatArticleTimeBoxSummary('all', 'any'), '');
	assert.equal(formatArticleTimeBoxSummary('video', 'any'), 'Video');
	assert.equal(formatArticleTimeBoxSummary('all', 'short'), 'Under 5 min');
	assert.equal(formatArticleTimeBoxSummary('text', 'medium'), 'Text · 5–15 min');
	assert.equal(formatArticleTimeBoxSummary('video', 'long'), 'Video · 15+ min');
});

test('Type and Length filters narrow regular views, show Clear bar, and keep bulk mark-read safe', async (t) => {
	const { database, harness } = await createStatefulArticleBrowser({
		seed: (db) => {
			db.exec(`
				UPDATE items SET word_count = 400, media_kind = 'text' WHERE id = 'today-1';
				UPDATE items SET word_count = 1900, media_kind = 'text' WHERE id = 'today-2';
				UPDATE items SET media_kind = 'video', duration_seconds = 1080 WHERE id = 'today-3';
				UPDATE items SET word_count = 4200, media_kind = 'text' WHERE id = 'today-4';
			`);
		},
	});
	t.after(() => database.close());

	const kindSelect = harness.elements.get('article-kind-filter')!;
	const lengthSelect = harness.elements.get('article-length-filter')!;
	const activeBar = harness.elements.get('article-active-filters')!;
	const activeLabel = harness.elements.get('article-active-filters-label')!;
	const clearButton = harness.elements.get('clear-article-filters-button')!;
	const optionsSummary = harness.elements.get('article-options-summary')!;
	const markAllButton = harness.elements.get('mark-all-as-read-button')!;
	const bulkSelect = harness.elements.get('article-bulk-select')!;
	const bulkButton = harness.elements.get('article-bulk-button')!;

	assert.deepEqual(renderedArticleIds(harness), ['3', '2', '1', '4']);
	assert.equal(activeBar.classList.contains('hidden'), true);
	assert.equal(optionsSummary.getAttribute('data-active'), 'false');

	// Filter to Video only (server-side kind=video).
	kindSelect.value = 'video';
	kindSelect.dispatch('change');
	await waitForBrowserCondition(() => renderedArticleIds(harness).join(',') === '3', 200);
	assert.equal(activeBar.classList.contains('hidden'), false);
	assert.equal(activeLabel.textContent, 'Filtered: Video');
	assert.equal(optionsSummary.getAttribute('data-active'), 'true');
	assert.equal(markAllButton.disabled, false);

	// Filter to Text + Under 5 min (client-side length=short).
	kindSelect.value = 'text';
	lengthSelect.value = 'short';
	lengthSelect.dispatch('change');
	await waitForBrowserCondition(() => renderedArticleIds(harness).join(',') === '1', 200);
	assert.equal(activeLabel.textContent, 'Filtered: Text · Under 5 min');
	// Mark All and non-positional bulk actions are disabled while length filter is active.
	assert.equal(markAllButton.disabled, true);
	bulkSelect.value = 'all';
	bulkSelect.dispatch('change');
	assert.equal(bulkButton.disabled, true);

	// Filter to 15+ min across both types (should show the 18 min video and the 18 min essay).
	kindSelect.value = 'all';
	lengthSelect.value = 'long';
	lengthSelect.dispatch('change');
	await waitForBrowserCondition(() => renderedArticleIds(harness).join(',') === '3,4', 200);
	assert.equal(activeLabel.textContent, 'Filtered: 15+ min');

	// Clear resets both Type and Length back to defaults.
	clearButton.dispatch('click');
	await waitForBrowserCondition(() => renderedArticleIds(harness).join(',') === '3,2,1,4', 200);
	assert.equal(kindSelect.value, 'all');
	assert.equal(lengthSelect.value, 'any');
	assert.equal(activeBar.classList.contains('hidden'), true);
	assert.equal(optionsSummary.getAttribute('data-active'), 'false');
	assert.equal(markAllButton.disabled, false);

	harness.elements.get('logout-button')!.dispatch('click');
});

test('Type and Length filters also apply to For You recommendations', async (t) => {
	const { database, harness } = await createStatefulArticleBrowser({
		fetchOverride: async (input, _init, next) => input.startsWith('/api/v1/recommendations?')
			? Response.json({
				items: [
					{
						readerId: 'tag:google.com,2005:reader/item/0000000000000003', id: 'today-3', feedKey: 'today-source',
						source: 'Today source', title: 'Long Video', author: '', receivedAt: '2026-10-12T12:00:00.000Z',
						originalURL: null, html: '<p>Video</p>', text: 'Video', isRead: false, isStarred: false,
						score: 30, explanation: 'Matches', matchedTopics: [], mediaKind: 'video', durationSeconds: 1200,
					},
					{
						readerId: 'tag:google.com,2005:reader/item/0000000000000002', id: 'today-2', feedKey: 'today-source',
						source: 'Today source', title: 'Quick Note', author: '', receivedAt: '2026-10-12T11:00:00.000Z',
						originalURL: null, html: '<p>Quick</p>', text: 'Quick', isRead: false, isStarred: false,
						score: 20, explanation: 'Matches', matchedTopics: [], mediaKind: 'text', wordCount: 500,
					},
				],
				continuation: null,
			})
			: next(),
	});
	t.after(() => database.close());

	findListButtonByViewId(harness.elements.get('views-list'), 'for-you')!.dispatch('click');
	await waitForBrowserCondition(() => renderedArticleIds(harness).join(',') === '3,2', 200);

	const lengthSelect = harness.elements.get('article-length-filter')!;
	lengthSelect.value = 'short';
	lengthSelect.dispatch('change');
	await waitForBrowserCondition(() => renderedArticleIds(harness).join(',') === '2', 200);

	const kindSelect = harness.elements.get('article-kind-filter')!;
	kindSelect.value = 'video';
	lengthSelect.value = 'long';
	kindSelect.dispatch('change');
	await waitForBrowserCondition(() => renderedArticleIds(harness).join(',') === '3', 200);

	harness.elements.get('logout-button')!.dispatch('click');
});

test('starring a text article does not leak it into a cached Video-only Starred view', async (t) => {
	const { database, harness } = await createStatefulArticleBrowser({
		seed: (db) => {
			db.exec(`
				UPDATE items SET word_count = 400, media_kind = 'text' WHERE id = 'today-1';
				UPDATE items SET media_kind = 'video', duration_seconds = 1080 WHERE id = 'today-3';
			`);
		},
	});
	t.after(() => database.close());

	const viewsList = harness.elements.get('views-list')!;
	const kindSelect = harness.elements.get('article-kind-filter')!;
	const starButton = harness.elements.get('star-article-button')!;

	// Prime Starred + Video filter (empty).
	findListButtonByViewId(viewsList, 'starred')!.dispatch('click');
	await flushBrowserTasks();
	kindSelect.value = 'video';
	kindSelect.dispatch('change');
	await waitForBrowserCondition(() => renderedArticleIds(harness).length === 0, 200);

	// Switch back to All, reset to All types, star text story '1', then switch back to Starred + Video.
	kindSelect.value = 'all';
	kindSelect.dispatch('change');
	findListButtonByViewId(viewsList, 'all')!.dispatch('click');
	await waitForBrowserCondition(() => renderedArticleIds(harness).includes('1'), 200);
	findListButtonByItemId(harness.elements.get('articles-list'), '1')!.dispatch('click');
	starButton.dispatch('click');
	await flushBrowserTasks();

	findListButtonByViewId(viewsList, 'starred')!.dispatch('click');
	kindSelect.value = 'video';
	kindSelect.dispatch('change');
	await flushBrowserTasks();
	assert.deepEqual(renderedArticleIds(harness), []);

	harness.elements.get('logout-button')!.dispatch('click');
});

test('reader-mode extraction keeps the open story selected if its true length leaves the active length filter', async (t) => {
	const browser = await createStatefulArticleBrowser({
		readingTools: readingTools(),
		seed: (database) => {
			database.exec(`
				UPDATE items SET word_count = 40, media_kind = 'text', original_url = 'https://example.com/story-3' WHERE id = 'today-3';
				UPDATE items SET word_count = 300, media_kind = 'text' WHERE id = 'today-2';
			`);
		},
		extractReader: () => ({ content: '<p>Extracted long essay</p>', url: 'https://example.com/story-3', wordCount: 4000 }),
		fetchOverride: async (input, _init, next) => input.startsWith('/api/v1/browser/reader-source?')
			? Response.json({ url: 'https://example.com/story-3', html: '<article>Source</article>' })
			: next(),
	});
	t.after(() => browser.database.close());

	const lengthSelect = browser.harness.elements.get('article-length-filter')!;
	lengthSelect.value = 'short';
	lengthSelect.dispatch('change');
	await waitForBrowserCondition(() => renderedArticleIds(browser.harness).includes('3'), 200);

	// Select story 3 (currently a 40-word snippet), then open Reader mode which extracts 4,000 words (17 min).
	findListButtonByItemId(browser.harness.elements.get('articles-list'), '3')!.dispatch('click');
	const modeSelect = browser.harness.elements.get('reader-mode-select')!;
	modeSelect.value = 'reader';
	modeSelect.dispatch('change');
	await waitForBrowserCondition(() => browser.harness.elements.get('reader-frame')!.srcdoc.includes('Extracted long essay'), 200);
	await flushBrowserTasks();

	// Story 3 leaves the Under 5 min list, but remains the open story in the reader pane (not silently switched to story 2).
	assert.equal(renderedArticleIds(browser.harness).includes('3'), false);
	assert.equal(browser.harness.elements.get('reader-title')!.textContent, 'Story 3');
	assert.match(browser.harness.elements.get('reader-source-note')!.textContent, /17 min read/);

	browser.harness.elements.get('logout-button')!.dispatch('click');
});


