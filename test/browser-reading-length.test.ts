import * as assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { formatReadingLength, shouldReportWordCount } from '../src/browser-app-client';
import {
	createStatefulArticleBrowser,
	findDescendantByClass,
	findListButtonByViewId,
	findListButtonByItemId,
	flushBrowserTasks,
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
