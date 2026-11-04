import * as assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
	buildFeedViews,
	filterSavedItemIds,
	formatSavedAge,
	getLocalDayBounds,
	normalizeSavedFilters,
	savedSourceLabel,
	savedThumbnailUrl,
} from '../src/browser-app-client';
import { handleGreaderRequest } from '../src/greader';
import { generateApiToken } from '../src/api-auth';
import {
	createLargeTodaySqliteLibrary,
	createStatefulArticleBrowser,
	findDescendantByClass,
	findListButtonByItemId,
	findListButtonByViewId,
	flushBrowserTasks,
	renderedArticleIds,
	waitForBrowserCondition,
} from './helpers/browser-app-client-harness';

const NOW = new Date(2026, 9, 12, 12).getTime();
const UUID = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

interface SavedSeed {
	n: number;
	title: string;
	url: string;
	html?: string;
	state?: 'pending' | 'done' | 'failed';
	words?: number | null;
	kind?: 'text' | 'video';
	duration?: number | null;
	image?: string | null;
	site?: string | null;
	author?: string | null;
	read?: boolean;
}

// Rowids 5..9 follow the four Today stories. Each save is newer than every
// story, so a list that forgot to exclude them would lead with a saved item.
const DEFAULT_SAVES: SavedSeed[] = [
	{ n: 1, title: 'A long essay', url: 'https://paulgraham.com/greatwork.html', html: '<p>Essay body</p>', words: 4000, image: 'https://example.com/essay.jpg', site: 'Paul Graham' },
	{ n: 2, title: 'A quick note', url: 'https://example.com/note', html: '<p>Note body</p>', words: 500 },
	{ n: 3, title: 'A talk', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', html: '<p>Talk description</p>', kind: 'video', duration: 1500, site: 'YouTube', author: 'Talk Channel' },
	{ n: 4, title: 'example.org/pending', url: 'https://example.org/pending', html: '', state: 'pending', words: null },
	{ n: 5, title: 'An archived read', url: 'https://example.com/archived', html: '<p>Old body</p>', words: 1200, read: true },
];

function seedSaved(database: DatabaseSync, saves: SavedSeed[] = DEFAULT_SAVES) {
	database.prepare("INSERT INTO feeds (feed_key, display_name, source_type) VALUES ('pigeon:saved', 'Read It Later', 'saved')").run();
	const end = getLocalDayBounds(new Date(NOW)).endSeconds;
	const insert = database.prepare(`INSERT INTO items (id, feed_key, subject, html_content, original_url, message_id, received_at,
		word_count, media_kind, duration_seconds, image_url, site_name, author, extraction_state, is_read)
		VALUES (?, 'pigeon:saved', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
	for (const save of saves) {
		insert.run(UUID(save.n), save.title, save.html ?? '<p>Body</p>', save.url, `saved:${save.n}`,
			new Date((end + 600 - save.n * 100) * 1000).toISOString(), save.words ?? null, save.kind ?? 'text', save.duration ?? null,
			save.image ?? null, save.site ?? null, save.author ?? null, save.state ?? 'done', save.read ? 1 : 0);
	}
}

function rowid(database: DatabaseSync, n: number) {
	return String((database.prepare('SELECT rowid FROM items WHERE id = ?').get(UUID(n)) as { rowid: number }).rowid);
}

type Browser = Awaited<ReturnType<typeof createStatefulArticleBrowser>>;

async function openSavedView(harness: Browser['harness']) {
	findListButtonByViewId(harness.elements.get('views-list'), 'saved')!.dispatch('click');
	await waitForBrowserCondition(() => renderedArticleIds(harness).length > 0 &&
		!harness.elements.get('articles-list')!.textContent.includes('Loading'), 200);
	await flushBrowserTasks();
}

function link(url: string, text = 'The Great Work, an essay') {
	const anchor = { href: url, textContent: text, getAttribute: () => url };
	return { closest: (selector: string) => (selector === 'a[href]' ? anchor : null) };
}

function rightClickLink(harness: Browser['harness'], url: string, options: Record<string, unknown> = {}) {
	return harness.dispatchFrameEvent('contextmenu', { target: link(url), clientX: 40, clientY: 60, ...options });
}

test('pure Read It Later helpers: filters, sorts, ages, thumbnails and sources', () => {
	assert.deepEqual(normalizeSavedFilters(null), { status: 'unread', kind: 'all', length: 'any', sort: 'newest' });
	assert.deepEqual(normalizeSavedFilters({ status: 'archive', kind: 'video', length: 'huge', sort: 'longest' }),
		{ status: 'archive', kind: 'video', length: 'any', sort: 'longest' });
	const items = {
		a: { wordCount: 4000 }, // 17 min
		b: { wordCount: 500 }, // 3 min
		c: { mediaKind: 'video', durationSeconds: 1500 }, // 25 min
		d: {}, // unknown
		e: { wordCount: 1190 }, // exactly 5 min
		f: { wordCount: 3570 }, // exactly 15 min
		g: { estimatedWordCount: 3000, extractionState: 'pending' }, // placeholder only: unknown
	};
	const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'loading'];
	const run = (kind: string, length: string, sort: string) => filterSavedItemIds(ids, items, { kind, length, sort });
	assert.deepEqual(run('all', 'any', 'newest'), ids);
	assert.deepEqual(run('video', 'any', 'newest'), ['c', 'loading']);
	assert.deepEqual(run('text', 'any', 'newest'), ['a', 'b', 'd', 'e', 'f', 'g', 'loading']);
	assert.deepEqual(run('all', 'short', 'newest'), ['b', 'loading']);
	assert.deepEqual(run('all', 'medium', 'newest'), ['e', 'loading']);
	assert.deepEqual(run('all', 'long', 'newest'), ['a', 'c', 'f', 'loading']);
	assert.deepEqual(run('all', 'any', 'shortest'), ['b', 'e', 'f', 'a', 'c', 'd', 'g', 'loading']);
	assert.deepEqual(run('all', 'any', 'longest'), ['c', 'a', 'f', 'e', 'b', 'd', 'g', 'loading']);

	const now = Date.UTC(2026, 9, 12, 12);
	assert.equal(formatSavedAge(now / 1000 - 20, now), 'Just now');
	assert.equal(formatSavedAge(now / 1000 - 12 * 60, now), '12 min ago');
	assert.equal(formatSavedAge(now / 1000 - 3 * 3600, now), '3 hr ago');
	assert.equal(formatSavedAge(now / 1000 - 30 * 3600, now), 'Yesterday');
	assert.equal(formatSavedAge(now / 1000 - 4 * 86400, now), '4 days ago');
	assert.equal(formatSavedAge(now / 1000 - 15 * 86400, now), '2 wk ago');
	assert.equal(formatSavedAge(0, now), '');

	assert.equal(savedThumbnailUrl({ imageUrl: 'https://example.com/a.jpg' }), 'https://example.com/a.jpg');
	assert.equal(savedThumbnailUrl({ alternate: [{ href: 'https://youtu.be/dQw4w9WgXcQ' }] }), 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
	assert.equal(savedThumbnailUrl({ imageUrl: 'javascript:alert(1)', alternate: [{ href: 'https://example.com/a' }] }), null);
	assert.equal(savedSourceLabel({ mediaKind: 'video', author: 'Channel', siteName: 'YouTube' }), 'Channel');
	assert.equal(savedSourceLabel({ siteName: 'Paul Graham', author: 'PG' }), 'Paul Graham');
	assert.equal(savedSourceLabel({ alternate: [{ href: 'https://www.example.com/post' }] }), 'example.com');
});

test('buildFeedViews lists Read It Later after Starred and keeps it out of feeds and the All count', () => {
	const views = buildFeedViews(
		[{ id: 'feed/1', title: 'News', sourceType: 'rss' }, { id: 'feed/9', title: 'Read It Later', sourceType: 'saved' }],
		[{ id: 'feed/1', count: 3 }, { id: 'feed/9', count: 4 }, { id: 'user/-/state/com.google/reading-list', count: 7 }],
	);
	assert.deepEqual(views.map((view) => view.id), ['all', 'unread', 'today', 'recent', 'starred', 'saved', 'for-you', 'feed/1']);
	assert.equal(views.find((view) => view.id === 'all')!.unreadCount, 3);
	assert.deepEqual(views.find((view) => view.id === 'saved'), {
		id: 'saved', title: 'Read It Later', streamId: 'saved', unreadCount: 4, kind: 'saved', section: 'views', feedStreamId: 'feed/9',
	});
});

test('GReader streams leave saved items out for the web app only, and saved items carry their UUID', async (t) => {
	const state = createLargeTodaySqliteLibrary(NOW, 2);
	seedSaved(state.database);
	t.after(() => state.database.close());
	const token = await generateApiToken('today-test-password');
	const get = async (path: string, web: boolean) => (await handleGreaderRequest(new Request('https://pigeon.example' + path, {
		headers: { Authorization: 'GoogleLogin auth=pigeon/' + token, ...(web ? { 'X-Pigeon-Client': 'pigeon-web/1' } : {}) },
	}), state.env)).json() as Promise<any>;
	const ids = async (stream: string, web: boolean) => (await get('/reader/api/0/stream/items/ids?n=50&s=' + encodeURIComponent(stream), web)).itemRefs.map((ref: any) => ref.id);
	const saved = ['5', '6', '7', '8', '9'];
	for (const stream of ['user/-/state/com.google/reading-list', 'user/-/state/com.google/read', 'user/-/state/com.google/starred']) {
		assert.equal((await ids(stream, true)).some((id: string) => saved.includes(id)), false, stream);
	}
	assert.deepEqual((await ids('user/-/state/com.google/reading-list', false)).filter((id: string) => saved.includes(id)), saved);
	const contents = await get('/reader/api/0/stream/contents?n=50&s=user%2F-%2Fstate%2Fcom.google%2Freading-list', true);
	assert.equal(contents.items.some((item: any) => item.nativeId), false);
	const savedContents = await get('/reader/api/0/stream/contents?n=50&s=user%2F-%2Fstate%2Fcom.google%2Freading-list', false);
	const essay = savedContents.items.find((item: any) => item.title === 'A long essay');
	assert.equal(essay.nativeId, UUID(1));
	assert.equal(essay.imageUrl, 'https://example.com/essay.jpg');
	assert.equal(savedContents.items.find((item: any) => item.title === 'Story 1').nativeId, undefined);
});

test('All, Today and the unread badges leave saved items out; Read It Later shows its own count', async (t) => {
	const { database, harness } = await createStatefulArticleBrowser({ now: NOW, seed: seedSaved });
	t.after(() => database.close());
	const savedIds = [5, 6, 7, 8, 9].map((n) => String(n));
	assert.equal(renderedArticleIds(harness).some((id) => savedIds.includes(id)), false);
	const viewsList = harness.elements.get('views-list');
	const count = (viewId: string) => findDescendantByClass(findListButtonByViewId(viewsList, viewId), 'feed-count')?.textContent;
	assert.equal(count('all'), '4');
	assert.equal(count('saved'), '4');
	const order = viewsList!.children.map((item) => item.children[0].dataset.viewId);
	assert.equal(order.indexOf('saved'), order.indexOf('starred') + 1);
	assert.equal(harness.elements.get('feeds-list')!.textContent.includes('Read It Later'), false);

	findListButtonByViewId(viewsList, 'today')!.dispatch('click');
	await waitForBrowserCondition(() => !harness.elements.get('articles-list')!.textContent.includes('Loading'), 200);
	await flushBrowserTasks();
	assert.equal(renderedArticleIds(harness).some((id) => savedIds.includes(id)), false);
	findListButtonByViewId(viewsList, 'recent')!.dispatch('click');
	await waitForBrowserCondition(() => harness.elements.get('articles-heading')!.textContent === 'Recently read', 200);
	await flushBrowserTasks();
	assert.equal(renderedArticleIds(harness).includes('9'), false);
	harness.elements.get('logout-button')!.dispatch('click');
});

test('the Read It Later list shows thumbnail, serif title, source, length and age, and filters and sorts', async (t) => {
	const { database, harness } = await createStatefulArticleBrowser({ now: NOW, seed: seedSaved });
	t.after(() => database.close());
	await openSavedView(harness);
	assert.deepEqual(renderedArticleIds(harness), ['5', '6', '7', '8']);
	assert.equal(harness.elements.get('saved-filters')!.classList.contains('hidden'), false);
	assert.equal(harness.elements.get('mark-all-as-read-button')!.classList.contains('hidden'), true);

	const list = harness.elements.get('articles-list');
	const essay = findListButtonByItemId(list, '5')!;
	assert.equal(findDescendantByClass(essay, 'saved-thumbnail')!.getAttribute('src'), 'https://example.com/essay.jpg');
	assert.ok(findDescendantByClass(essay, 'saved-title'));
	assert.equal(findDescendantByClass(essay, 'article-source')!.textContent, 'Paul Graham');
	assert.equal(findDescendantByClass(essay, 'article-length')!.textContent, '17 min read');
	assert.match(findDescendantByClass(essay, 'article-time')!.textContent, /ago|Just now/);
	assert.equal(findDescendantByClass(essay, 'article-preview'), undefined);
	const note = findListButtonByItemId(list, '6')!;
	assert.equal(findDescendantByClass(note, 'saved-thumbnail'), undefined, 'no image means no thumbnail block');
	assert.equal(findDescendantByClass(note, 'article-source')!.textContent, 'example.com');
	assert.equal(findDescendantByClass(note, 'article-length'), undefined, 'short items are not labelled');
	const talk = findListButtonByItemId(list, '7')!;
	assert.equal(findDescendantByClass(talk, 'saved-thumbnail')!.getAttribute('src'), 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
	assert.equal(findDescendantByClass(talk, 'article-source')!.textContent, 'Talk Channel');
	assert.equal(findDescendantByClass(talk, 'article-length')!.textContent, '25 min video');

	const change = async (id: string, value: string) => {
		harness.elements.get(id)!.value = value;
		harness.elements.get(id)!.dispatch('change');
		await flushBrowserTasks();
	};
	await change('saved-kind-filter', 'video');
	assert.deepEqual(renderedArticleIds(harness), ['7']);
	await change('saved-kind-filter', 'text');
	assert.deepEqual(renderedArticleIds(harness), ['5', '6', '8']);
	await change('saved-kind-filter', 'all');
	await change('saved-length-filter', 'short');
	assert.deepEqual(renderedArticleIds(harness), ['6']);
	await change('saved-length-filter', 'long');
	assert.deepEqual(renderedArticleIds(harness), ['5', '7']);
	await change('saved-length-filter', 'any');
	await change('saved-sort-select', 'shortest');
	assert.deepEqual(renderedArticleIds(harness), ['6', '5', '7', '8']);
	await change('saved-sort-select', 'longest');
	assert.deepEqual(renderedArticleIds(harness), ['7', '5', '6', '8']);
	await change('saved-sort-select', 'oldest');
	await waitForBrowserCondition(() => renderedArticleIds(harness)[0] === '8', 200);
	assert.deepEqual(renderedArticleIds(harness), ['8', '7', '6', '5']);
	assert.deepEqual(JSON.parse(harness.localStorageState.get('pigeon.browser.saved-filters')!),
		{ status: 'unread', kind: 'all', length: 'any', sort: 'oldest' });

	harness.elements.get('saved-status-archive')!.dispatch('click');
	await waitForBrowserCondition(() => renderedArticleIds(harness).join() === '9', 200);
	assert.equal(harness.elements.get('saved-status-archive')!.getAttribute('aria-pressed'), 'true');
	assert.equal(JSON.parse(harness.localStorageState.get('pigeon.browser.saved-filters')!).status, 'archive');
	harness.elements.get('logout-button')!.dispatch('click');
});

test('saved filter and sort choices persist across reloads', async (t) => {
	const { database, harness } = await createStatefulArticleBrowser({
		now: NOW, seed: seedSaved,
		storedEntries: { 'pigeon.browser.saved-filters': JSON.stringify({ status: 'unread', kind: 'text', length: 'any', sort: 'longest' }) },
	});
	t.after(() => database.close());
	await openSavedView(harness);
	assert.deepEqual(renderedArticleIds(harness), ['5', '6', '8']);
	assert.equal(harness.elements.get('saved-kind-filter')!.value, 'text');
	assert.equal(harness.elements.get('saved-sort-select')!.value, 'longest');
	harness.elements.get('logout-button')!.dispatch('click');
});

test('right-clicking an article link saves it to Read It Later without leaving the article', async (t) => {
	const posts: string[] = [];
	const { database, harness } = await createStatefulArticleBrowser({
		now: NOW, seed: seedSaved,
		fetchOverride: async (input, init, next) => {
			if (input === '/api/v1/saved') posts.push(String(init?.body));
			return next();
		},
	});
	t.after(() => database.close());
	const frame = harness.elements.get('reader-frame')!;
	const before = frame.srcdoc;
	const menu = harness.elements.get('link-context-menu')!;

	assert.equal(rightClickLink(harness, 'https://example.com/shifted', { shiftKey: true }), false, 'Shift keeps the native menu');
	assert.equal(menu.classList.contains('hidden'), true);
	assert.equal(rightClickLink(harness, 'mailto:someone@example.com'), false);

	assert.equal(rightClickLink(harness, 'http://paulgraham.com/greatwork.html?utm_source=news'), true);
	assert.equal(menu.classList.contains('hidden'), false);
	assert.equal(menu.style.getPropertyValue('left'), '40px');
	harness.elements.get('link-save-button')!.dispatch('click');
	assert.equal(menu.classList.contains('hidden'), true);
	await waitForBrowserCondition(() => harness.elements.get('app-toast')!.textContent === 'Saved to Read It Later', 200);
	assert.equal(harness.elements.get('app-toast')!.classList.contains('hidden'), false);
	assert.deepEqual(JSON.parse(posts[0]!), { url: 'http://paulgraham.com/greatwork.html?utm_source=news', title: 'The Great Work, an essay' });
	const row = database.prepare("SELECT extraction_state, subject FROM items WHERE original_url = 'http://paulgraham.com/greatwork.html'").get() as any;
	assert.deepEqual({ ...row }, { extraction_state: 'pending', subject: 'The Great Work, an essay' });
	assert.equal(frame.srcdoc, before, 'the reader did not navigate');
	assert.equal(harness.elements.get('reader-title')!.textContent, 'Story 3');
	await waitForBrowserCondition(() => findDescendantByClass(findListButtonByViewId(harness.elements.get('views-list'), 'saved'), 'feed-count')?.textContent === '5', 200);

	// Rapid repeated saves of one link share one request; the server dedupes the rest.
	for (let index = 0; index < 5; index += 1) {
		rightClickLink(harness, 'https://example.com/rapid');
		harness.elements.get('link-save-button')!.dispatch('click');
	}
	rightClickLink(harness, 'https://example.com/rapid#again');
	harness.elements.get('link-save-button')!.dispatch('click');
	// Wait on the stored row: a request that has started may not have answered yet.
	const rapidRows = () => (database.prepare("SELECT COUNT(*) AS count FROM items WHERE original_url = 'https://example.com/rapid'").get() as any).count;
	await waitForBrowserCondition(() => posts.length >= 3 && rapidRows() === 1, 400);
	await flushBrowserTasks();
	assert.equal(posts.filter((body) => body.includes('https://example.com/rapid"')).length, 1);
	assert.equal(rapidRows(), 1);
	harness.elements.get('logout-button')!.dispatch('click');
});

test('saving offline shows an error instead of failing silently', async (t) => {
	const posts: string[] = [];
	const { database, harness } = await createStatefulArticleBrowser({
		now: NOW, seed: seedSaved,
		fetchOverride: async (input, init, next) => { if (input === '/api/v1/saved') posts.push(String(init?.body)); return next(); },
	});
	t.after(() => database.close());
	harness.setOnline(false);
	rightClickLink(harness, 'https://example.com/offline');
	harness.elements.get('link-save-button')!.dispatch('click');
	await flushBrowserTasks();
	assert.equal(posts.length, 0);
	assert.equal(harness.elements.get('app-toast')!.getAttribute('data-tone'), 'error');
	assert.match(harness.elements.get('app-toast')!.textContent, /offline/i);
	harness.setOnline(true);

	// A server failure reports an error too.
	const failing = await createStatefulArticleBrowser({
		now: NOW, seed: seedSaved,
		fetchOverride: async (input, _init, next) => input === '/api/v1/saved' ? new Response('down', { status: 503 }) : next(),
	});
	t.after(() => failing.database.close());
	rightClickLink(failing.harness, 'https://example.com/down');
	failing.harness.elements.get('link-save-button')!.dispatch('click');
	await waitForBrowserCondition(() => failing.harness.elements.get('app-toast')!.textContent.includes('Could not save'), 200);
	harness.elements.get('logout-button')!.dispatch('click');
	failing.harness.elements.get('logout-button')!.dispatch('click');
});

test('Copy Link and Copy link copy the URL', async (t) => {
	const { database, harness } = await createStatefulArticleBrowser({ now: NOW, seed: seedSaved });
	t.after(() => database.close());
	const copied: string[] = [];
	harness.window.navigator.clipboard = { writeText: async (text: string) => { copied.push(text); } };
	rightClickLink(harness, 'https://example.com/copy-me');
	harness.elements.get('link-copy-button')!.dispatch('click');
	await flushBrowserTasks();
	assert.deepEqual(copied, ['https://example.com/copy-me']);
	assert.equal(harness.elements.get('app-toast')!.textContent, 'Link copied');

	await openSavedView(harness);
	assert.equal(harness.elements.get('copy-link-button')!.classList.contains('hidden'), false);
	harness.elements.get('copy-link-button')!.dispatch('click');
	await flushBrowserTasks();
	assert.equal(copied.at(-1), 'https://paulgraham.com/greatwork.html');
	harness.elements.get('logout-button')!.dispatch('click');
});

test('Archive and Remove act on saved items; Remove uses the item UUID', async (t) => {
	const mutations: any[] = [];
	const { database, harness } = await createStatefulArticleBrowser({
		now: NOW, seed: seedSaved,
		fetchOverride: async (input, init, next) => {
			if (input === '/api/v1/mutations') mutations.push(...JSON.parse(String(init?.body)).mutations);
			return next();
		},
	});
	t.after(() => database.close());
	await openSavedView(harness);
	const archive = harness.elements.get('mark-unread-button')!;
	assert.equal(harness.elements.get('reader-title')!.textContent, 'A long essay');
	assert.equal(archive.textContent, 'Archive');
	assert.equal(archive.getAttribute('data-icon'), 'archive');
	assert.equal(harness.elements.get('star-article-button')!.classList.contains('hidden'), true);
	assert.equal(harness.elements.get('remove-saved-button')!.classList.contains('hidden'), false);

	archive.dispatch('click');
	await waitForBrowserCondition(() => (database.prepare('SELECT is_read FROM items WHERE id = ?').get(UUID(1)) as any).is_read === 1, 200);
	await waitForBrowserCondition(() => archive.disabled === false && archive.textContent === 'Unarchive', 200);
	assert.equal(harness.elements.get('reader-action-status')!.textContent, 'Archived.');
	archive.dispatch('click');
	await waitForBrowserCondition(() => (database.prepare('SELECT is_read FROM items WHERE id = ?').get(UUID(1)) as any).is_read === 0, 200);
	await waitForBrowserCondition(() => archive.disabled === false, 200);

	harness.elements.get('remove-saved-button')!.dispatch('click');
	await waitForBrowserCondition(() => !renderedArticleIds(harness).includes('5'), 200);
	assert.equal(database.prepare('SELECT id FROM items WHERE id = ?').get(UUID(1)), undefined);
	const removal = mutations.find((mutation) => mutation.kind === 'remove_saved');
	assert.deepEqual(removal.itemIds, [UUID(1)]);
	assert.equal(harness.elements.get('app-toast')!.textContent, 'Removed from Read It Later');
	assert.equal(harness.elements.get('reader-title')!.textContent, 'A quick note', 'the next item is selected');
	await waitForBrowserCondition(() => findDescendantByClass(findListButtonByViewId(harness.elements.get('views-list'), 'saved'), 'feed-count')?.textContent === '3', 200);
	harness.elements.get('logout-button')!.dispatch('click');
});

test('Remove is refused offline with an error toast', async (t) => {
	const { database, harness } = await createStatefulArticleBrowser({ now: NOW, seed: seedSaved });
	t.after(() => database.close());
	await openSavedView(harness);
	harness.setOnline(false);
	harness.elements.get('remove-saved-button')!.dispatch('click');
	await flushBrowserTasks();
	assert.match(harness.elements.get('app-toast')!.textContent, /needs a connection/);
	assert.ok(database.prepare('SELECT id FROM items WHERE id = ?').get(UUID(1)));
	harness.setOnline(true);
	harness.elements.get('logout-button')!.dispatch('click');
});

test('reaching the end of a saved article archives it even with manual read marking', async (t) => {
	const { database, harness } = await createStatefulArticleBrowser({ now: NOW, seed: seedSaved, frameHeight: 2000, viewportHeight: 800 });
	t.after(() => database.close());
	await openSavedView(harness);
	await flushBrowserTasks();
	harness.dispatchReaderFrameScroll(400);
	await flushBrowserTasks();
	assert.equal((database.prepare('SELECT is_read FROM items WHERE id = ?').get(UUID(1)) as any).is_read, 0);
	harness.dispatchReaderFrameScroll(1200);
	await waitForBrowserCondition(() => (database.prepare('SELECT is_read FROM items WHERE id = ?').get(UUID(1)) as any).is_read === 1, 200);
	harness.elements.get('logout-button')!.dispatch('click');
});

function pendingOnly(database: DatabaseSync) {
	seedSaved(database, [DEFAULT_SAVES[3]!]);
}

async function openPending(extractReader: (html: string, url: string) => any, sources: string[] = []) {
	const puts: any[] = [];
	const browser = await createStatefulArticleBrowser({
		now: NOW, seed: pendingOnly, extractReader,
		fetchOverride: async (input, init, next) => {
			if (input.startsWith('/api/v1/browser/reader-source?')) {
				sources.push(input);
				return Response.json({ url: 'https://example.org/pending', html: '<html><body><article>Source</article></body></html>' });
			}
			if (input.startsWith('/api/v1/saved/')) puts.push({ path: input, body: JSON.parse(String(init?.body)) });
			return next();
		},
	});
	await openSavedView(browser.harness);
	return { ...browser, puts, sources };
}

test('opening a pending saved link extracts it, uploads the content, then shows it', async (t) => {
	const { database, harness, puts, sources } = await openPending(() => ({
		content: '<p>The clean article text.</p>', text: 'The clean article text.', title: 'The Pending Article', byline: 'Ada',
		published: '2026-10-01T09:00:00.000Z', image: 'https://example.org/lead.jpg', site: 'Example Org', wordCount: 3000, url: 'https://example.org/pending',
	}));
	t.after(() => database.close());
	await waitForBrowserCondition(() => harness.elements.get('reader-frame')!.srcdoc.includes('The clean article text.'), 300);
	assert.equal(sources.length, 1);
	assert.equal(sources[0], '/api/v1/browser/reader-source?url=' + encodeURIComponent('https://example.org/pending'));
	assert.equal(puts.length, 1);
	assert.equal(puts[0].path, '/api/v1/saved/' + UUID(4) + '/content');
	assert.deepEqual(puts[0].body, {
		html: '<p>The clean article text.</p>', mediaKind: 'text', text: 'The clean article text.', title: 'The Pending Article', author: 'Ada',
		published: '2026-10-01T09:00:00.000Z', image: 'https://example.org/lead.jpg', site: 'Example Org', wordCount: 3000,
	});
	const row = database.prepare('SELECT extraction_state, subject, word_count, text_content FROM items WHERE id = ?').get(UUID(4)) as any;
	assert.deepEqual({ ...row }, { extraction_state: 'done', subject: 'The Pending Article', word_count: 3000, text_content: 'The clean article text.' });
	assert.equal(harness.elements.get('reader-title')!.textContent, 'The Pending Article');
	assert.equal(harness.elements.get('saved-extraction-panel')!.classList.contains('hidden'), true);
	const card = findListButtonByItemId(harness.elements.get('articles-list'), '5')!;
	assert.equal(findDescendantByClass(card, 'article-length')!.textContent, '13 min read');
	assert.equal(findDescendantByClass(card, 'saved-thumbnail')!.getAttribute('src'), 'https://example.org/lead.jpg');
	harness.elements.get('logout-button')!.dispatch('click');
});

test('a pending link shows a loading state while it is being extracted', async (t) => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const puts: any[] = [];
	const { database, harness } = await createStatefulArticleBrowser({
		now: NOW, seed: pendingOnly,
		extractReader: () => ({ content: '<p>Done now.</p>', text: 'Done now.', url: 'https://example.org/pending' }),
		fetchOverride: async (input, init, next) => {
			if (input.startsWith('/api/v1/browser/reader-source?')) { await gate; return Response.json({ url: 'https://example.org/pending', html: '<p>x</p>' }); }
			if (input.startsWith('/api/v1/saved/')) puts.push(init?.body);
			return next();
		},
	});
	t.after(() => database.close());
	findListButtonByViewId(harness.elements.get('views-list'), 'saved')!.dispatch('click');
	await waitForBrowserCondition(() => harness.elements.get('saved-extraction-panel')!.classList.contains('hidden') === false, 200);
	assert.match(harness.elements.get('saved-extraction-status')!.textContent, /Getting a clean copy/);
	assert.equal(harness.elements.get('saved-retry-button')!.classList.contains('hidden'), true);
	assert.match(harness.elements.get('reader-frame')!.srcdoc, /Getting the article/);
	release();
	await waitForBrowserCondition(() => harness.elements.get('reader-frame')!.srcdoc.includes('Done now.'), 300);
	assert.equal(puts.length, 1);
	harness.elements.get('logout-button')!.dispatch('click');
});

test('failed extraction offers Open original and Try again, and reports failed after three attempts', async (t) => {
	const { database, harness, puts, sources } = await openPending(() => { throw new Error('No readable article content found.'); });
	t.after(() => database.close());
	const panel = harness.elements.get('saved-extraction-panel')!;
	const retry = harness.elements.get('saved-retry-button')!;
	await waitForBrowserCondition(() => !panel.classList.contains('hidden') && !retry.classList.contains('hidden'), 300);
	assert.match(harness.elements.get('saved-extraction-status')!.textContent, /could not get a clean copy/);
	assert.equal(harness.elements.get('saved-open-original-button')!.classList.contains('hidden'), false);
	assert.equal(sources.length, 1, 'a failure is not retried automatically');
	assert.equal(puts.length, 0);

	retry.dispatch('click');
	await waitForBrowserCondition(() => sources.length === 2 && !retry.classList.contains('hidden'), 300);
	assert.equal(puts.length, 0);
	retry.dispatch('click');
	await waitForBrowserCondition(() => puts.length === 1, 300);
	assert.deepEqual(puts[0].body, { failed: true });
	await waitForBrowserCondition(() => (database.prepare('SELECT extraction_state FROM items WHERE id = ?').get(UUID(4)) as any).extraction_state === 'failed', 300);
	await waitForBrowserCondition(() => findDescendantByClass(findListButtonByItemId(harness.elements.get('articles-list'), '5'), 'saved-state')?.textContent === 'Original only', 300);
	assert.equal(panel.classList.contains('hidden'), false);

	// Try again still works on a failed item.
	retry.dispatch('click');
	await waitForBrowserCondition(() => sources.length === 4, 300);
	harness.elements.get('logout-button')!.dispatch('click');
});

test('a saved YouTube link plays in the player keyed by its original URL', async (t) => {
	const { database, harness } = await createStatefulArticleBrowser({ now: NOW, seed: seedSaved });
	t.after(() => database.close());
	await openSavedView(harness);
	findListButtonByItemId(harness.elements.get('articles-list'), '7')!.dispatch('click');
	await waitForBrowserCondition(() => harness.elements.get('reader-title')!.textContent === 'A talk', 200);
	assert.equal(harness.elements.get('reader-player-shell')!.classList.contains('hidden'), false);
	assert.equal(harness.elements.get('reader-player-container')!.children[0]!.getAttribute('data-youtube-video-id'), 'dQw4w9WgXcQ');
	assert.equal(harness.elements.get('reader-source-label')!.textContent, 'Talk Channel');
	harness.elements.get('logout-button')!.dispatch('click');
});

test('the first save creates Read It Later: its count moves there instead of into All', async (t) => {
	const { database, harness } = await createStatefulArticleBrowser({ now: NOW });
	t.after(() => database.close());
	const viewsList = harness.elements.get('views-list');
	const count = (viewId: string) => findDescendantByClass(findListButtonByViewId(viewsList, viewId), 'feed-count')?.textContent;
	assert.equal(count('saved'), '0');
	assert.equal(count('all'), '4');
	rightClickLink(harness, 'https://example.com/first-save');
	harness.elements.get('link-save-button')!.dispatch('click');
	await waitForBrowserCondition(() => count('saved') === '1', 300);
	assert.equal(count('all'), '4');
	assert.equal(harness.elements.get('feeds-list')!.textContent.includes('Read It Later'), false);
	harness.elements.get('logout-button')!.dispatch('click');
});
