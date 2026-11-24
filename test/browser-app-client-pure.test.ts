import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	AUTH_STORAGE_KEY,
	THEME_STORAGE_KEY,
	applyUnauthorizedState,
	assignFolderColorIndices,
	buildArticleListEntries,
	buildFrontPagePages,
	buildFeedDaySections,
	buildFeedViews,
	buildFolderSections,
	createArticleFrameDocument,
	createContentLoadPlan,
	createFeedOrderComparator,
	createLoggedOutSession,
	createSessionFromToken,
	extractAuthToken,
	filterItemIdsForLocalDay,
	formatArticleListTime,
	frontPageDeck,
	getLocalDayBounds,
	getLocalDayRangeBounds,
	getViewDayBounds,
	isEditorialImage,
	isTimeWindowView,
	kickerColorIndex,
	limitInitialItemIds,
	normalizeBrowserTheme,
	renderBrowserAppClientScript,
	sanitizeArticleHtml,
	selectArticleHeroImageUrl,
	sortSubscriptionsByTitle,
} from '../src/browser-app-client';
import { renderBrowserAppStyles } from '../src/browser-app-styles';

test('extractAuthToken parses the Auth token from a ClientLogin response', () => {
	assert.equal(
		extractAuthToken('SID=pigeon/abc123\nLSID=null\nAuth=pigeon/abc123'),
		'abc123',
	);
});

test('extractAuthToken rejects malformed ClientLogin responses', () => {
	assert.equal(extractAuthToken('SID=pigeon/abc123\nLSID=null'), null);
	assert.equal(extractAuthToken(''), null);
});

test('createLoggedOutSession clears auth state for logout', () => {
	assert.deepEqual(createLoggedOutSession(), {
		status: 'logged_out',
		token: null,
	});
});

test('normalizeBrowserTheme defaults to light unless dark was stored', () => {
	assert.equal(normalizeBrowserTheme(undefined), 'light');
	assert.equal(normalizeBrowserTheme(null), 'light');
	assert.equal(normalizeBrowserTheme('light'), 'light');
	assert.equal(normalizeBrowserTheme('sepia'), 'light');
	assert.equal(normalizeBrowserTheme('dark'), 'dark');
});

test('applyUnauthorizedState returns the login state on 401', () => {
	assert.deepEqual(
		applyUnauthorizedState(createSessionFromToken('secret-token')),
		createLoggedOutSession(),
	);
});

test('filterItemIdsForLocalDay uses local midnight boundaries deterministically', () => {
	const now = new Date(2026, 2, 20, 12, 0, 0, 0);
	const bounds = getLocalDayBounds(now);

	assert.deepEqual(
		filterItemIdsForLocalDay(
			['previous-day', 'at-midnight', 'same-day', 'next-midnight'],
			{
				'previous-day': { published: bounds.startSeconds - 1 },
				'at-midnight': { published: bounds.startSeconds },
				'same-day': { published: bounds.endSeconds - 1 },
				'next-midnight': { published: bounds.endSeconds },
			},
			now,
		),
		['at-midnight', 'same-day'],
	);
});

test('sortSubscriptionsByTitle orders subscriptions alphabetically by title', () => {
	assert.deepEqual(
		sortSubscriptionsByTitle([
			{ id: 'feed/3', title: 'zebra' },
			{ id: 'feed/1', title: 'Alpha' },
			{ id: 'feed/2', title: 'mango' },
		]),
		[
			{ id: 'feed/1', title: 'Alpha' },
			{ id: 'feed/2', title: 'mango' },
			{ id: 'feed/3', title: 'zebra' },
		],
	);
});

test('buildFeedViews shows the local-day unread count on Today and defaults it to zero', () => {
	const unread = [{ id: 'user/-/state/com.google/reading-list', count: 9 }];
	const today = (views: ReturnType<typeof buildFeedViews>) => views.find((view) => view.kind === 'today')!.unreadCount;
	assert.equal(today(buildFeedViews([], unread, 4)), 4);
	assert.equal(today(buildFeedViews([], unread)), 0);
	assert.equal(buildFeedViews([], unread, 4).find((view) => view.kind === 'all')!.unreadCount, 9);
});

test('buildFeedViews lists Last 7 Days after Today with its unread count', () => {
	const unread = [{ id: 'user/-/state/com.google/reading-list', count: 9 }];
	const views = buildFeedViews([], unread, 4, 7);
	assert.deepEqual(views.map((view) => view.id).slice(0, 5), ['all', 'unread', 'today', 'last-7-days', 'recent']);
	assert.deepEqual(views.find((view) => view.id === 'last-7-days'), {
		id: 'last-7-days',
		title: 'Last 7 Days',
		streamId: 'user/-/state/com.google/reading-list',
		unreadCount: 7,
		kind: 'last-7-days',
		section: 'views',
	});
	assert.equal(buildFeedViews([], unread, 4).find((view) => view.kind === 'last-7-days')!.unreadCount, 0);
});

test('Today and Last 7 Days are time-window views over one and seven local days', () => {
	const now = new Date(2026, 10, 3, 12).getTime();
	assert.equal(isTimeWindowView({ kind: 'today' }), true);
	assert.equal(isTimeWindowView({ kind: 'last-7-days' }), true);
	for (const kind of ['all', 'unread', 'folder', 'feed', 'recommended']) assert.equal(isTimeWindowView({ kind }), false);
	assert.equal(isTimeWindowView(null), false);
	const day = getLocalDayRangeBounds(now, 1);
	const week = getLocalDayRangeBounds(now, 7);
	assert.deepEqual(getViewDayBounds({ kind: 'today' }, now), { startSeconds: day.startSeconds, endSeconds: day.endSeconds });
	assert.deepEqual(getViewDayBounds({ kind: 'last-7-days' }, now), { startSeconds: week.startSeconds, endSeconds: week.endSeconds });
});

test('every built-in view has a sidebar icon', () => {
	const styles = renderBrowserAppStyles();
	for (const view of buildFeedViews([], []).filter((candidate) => candidate.section === 'views')) {
		const rule = new RegExp(`\\.list-button\\[data-view-kind="${view.kind}"\\] \\{ --icon: var\\(--icon-([a-z-]+)\\); \\}`).exec(styles);
		assert.ok(rule, `${view.kind} has an icon rule`);
		assert.match(styles, new RegExp(`--icon-${rule[1]}: url\\(`), `${view.kind} icon ${rule[1]} is defined`);
	}
});

test('buildFeedViews returns built-in views plus sorted uncategorized feeds', () => {
	assert.deepEqual(
		buildFeedViews(
			[
				{ id: 'feed/2', title: 'Bravo' },
				{ id: 'feed/1', title: 'Alpha' },
			],
			[
				{ id: 'feed/2', count: 4 },
				{ id: 'feed/1', count: 1 },
			],
		),
		[
			{
				id: 'all',
				title: 'All items',
				streamId: 'user/-/state/com.google/reading-list',
				unreadCount: 5,
				kind: 'all',
				section: 'views',
			},
			{
				id: 'unread',
				title: 'Unread',
				streamId: 'user/-/state/com.google/reading-list',
				unreadCount: 5,
				kind: 'unread',
				section: 'views',
			},
			{
				id: 'today',
				title: 'Today',
				streamId: 'user/-/state/com.google/reading-list',
				unreadCount: 0,
				kind: 'today',
				section: 'views',
			},
			{
				id: 'last-7-days',
				title: 'Last 7 Days',
				streamId: 'user/-/state/com.google/reading-list',
				unreadCount: 0,
				kind: 'last-7-days',
				section: 'views',
			},
			{
				id: 'recent',
				title: 'Recently read',
				streamId: 'user/-/state/com.google/read',
				unreadCount: 0,
				kind: 'recent',
				section: 'views',
			},
			{
				id: 'starred', title: 'Starred', streamId: 'user/-/state/com.google/starred',
				unreadCount: 0, kind: 'starred', section: 'views',
			},
			{ id: 'saved', title: 'Read It Later', streamId: 'saved', unreadCount: 0, kind: 'saved', section: 'views' },
			{ id:'for-you',title:'For You',streamId:'for-you',unreadCount:0,kind:'recommended',section:'views' },
			{
				id: 'feed/1',
				title: 'Alpha',
				streamId: 'feed/1',
				unreadCount: 1,
				kind: 'feed',
				section: 'feeds',
			},
			{
				id: 'feed/2',
				title: 'Bravo',
				streamId: 'feed/2',
				unreadCount: 4,
				kind: 'feed',
				section: 'feeds',
			},
		],
	);
});

test('buildFeedViews groups categorized feeds into folder views and keeps uncategorized feeds separate', () => {
	assert.deepEqual(
		buildFeedViews(
			[
				{
					id: 'feed/2',
					title: 'Bravo',
					categories: [{ id: 'user/-/label/Newsletters', label: 'Newsletters' }],
				},
				{ id: 'feed/1', title: 'Alpha' },
				{
					id: 'feed/3',
					title: 'Charlie',
					categories: [{ id: 'user/-/label/Newsletters', label: 'Newsletters' }],
				},
			],
			[
				{ id: 'feed/1', count: 1 },
				{ id: 'feed/2', count: 4 },
				{ id: 'feed/3', count: 2 },
			],
		),
		[
			{
				id: 'all',
				title: 'All items',
				streamId: 'user/-/state/com.google/reading-list',
				unreadCount: 7,
				kind: 'all',
				section: 'views',
			},
			{
				id: 'unread',
				title: 'Unread',
				streamId: 'user/-/state/com.google/reading-list',
				unreadCount: 7,
				kind: 'unread',
				section: 'views',
			},
			{
				id: 'today',
				title: 'Today',
				streamId: 'user/-/state/com.google/reading-list',
				unreadCount: 0,
				kind: 'today',
				section: 'views',
			},
			{
				id: 'last-7-days',
				title: 'Last 7 Days',
				streamId: 'user/-/state/com.google/reading-list',
				unreadCount: 0,
				kind: 'last-7-days',
				section: 'views',
			},
			{
				id: 'recent',
				title: 'Recently read',
				streamId: 'user/-/state/com.google/read',
				unreadCount: 0,
				kind: 'recent',
				section: 'views',
			},
			{
				id: 'starred', title: 'Starred', streamId: 'user/-/state/com.google/starred',
				unreadCount: 0, kind: 'starred', section: 'views',
			},
			{ id: 'saved', title: 'Read It Later', streamId: 'saved', unreadCount: 0, kind: 'saved', section: 'views' },
			{ id:'for-you',title:'For You',streamId:'for-you',unreadCount:0,kind:'recommended',section:'views' },
			{
				id: 'user/-/label/Newsletters',
				title: 'Newsletters',
				streamId: 'user/-/label/Newsletters',
				unreadCount: 6,
				kind: 'folder',
				section: 'folders',
			},
			{
				id: 'feed/1',
				title: 'Alpha',
				streamId: 'feed/1',
				unreadCount: 1,
				kind: 'feed',
				section: 'feeds',
			},
			{
				id: 'feed/2',
				title: 'Bravo',
				streamId: 'feed/2',
				unreadCount: 4,
				kind: 'feed',
				section: 'folders',
				parentId: 'user/-/label/Newsletters',
			},
			{
				id: 'feed/3',
				title: 'Charlie',
				streamId: 'feed/3',
				unreadCount: 2,
				kind: 'feed',
				section: 'folders',
				parentId: 'user/-/label/Newsletters',
			},
		],
	);
});

test('buildFeedViews keeps feeds in every assigned folder tag', () => {
	const views = buildFeedViews(
		[
			{
				id: 'feed/1',
				title: 'Alpha',
				categories: [
					{ id: 'user/-/label/Favorites', label: 'Favorites' },
					{ id: 'user/-/label/Work', label: 'Work' },
				],
			},
		],
		[{ id: 'feed/1', count: 3 }],
	);

	assert.equal(views.find((view) => view.id === 'user/-/label/Favorites')?.unreadCount, 3);
	assert.equal(views.find((view) => view.id === 'user/-/label/Work')?.unreadCount, 3);
	const feedViews = views.filter((view) => view.streamId === 'feed/1' && view.kind === 'feed');
	assert.deepEqual(
		feedViews.map((view) => view.parentId).sort(),
		['user/-/label/Favorites', 'user/-/label/Work'],
	);
	assert.deepEqual(
		feedViews.map((view) => view.id).sort(),
		['feed/1::user/-/label/Favorites', 'feed/1::user/-/label/Work'],
	);
});

test('buildFeedViews prefers the reading-list aggregate when present so counts do not double', () => {
	assert.equal(
		buildFeedViews(
			[
				{ id: 'feed/2', title: 'Bravo' },
				{ id: 'feed/1', title: 'Alpha' },
			],
			[
				{ id: 'feed/2', count: 4 },
				{ id: 'feed/1', count: 1 },
				{ id: 'user/-/state/com.google/reading-list', count: 5 },
			],
		)[0].unreadCount,
		5,
	);
});

test('limitInitialItemIds caps the first fetch at 50 ids', () => {
	const ids = Array.from({ length: 75 }, (_, index) => String(index + 1));

	assert.deepEqual(limitInitialItemIds(ids), Array.from({ length: 50 }, (_, index) => String(index + 1)));
});

test('createContentLoadPlan loads contents in chunks of 20 without duplicates', () => {
	const itemIds = Array.from({ length: 30 }, (_, index) => String(index + 1));

	assert.deepEqual(
		createContentLoadPlan({
			itemIds,
			loadedItemIds: ['1', '2', '3', '4'],
		}),
		Array.from({ length: 20 }, (_, index) => String(index + 5)),
	);
});

test('createContentLoadPlan prioritizes the selected item and does not duplicate ids', () => {
	assert.deepEqual(
		createContentLoadPlan({
			itemIds: ['1', '2', '3', '4', '5'],
			loadedItemIds: ['2', '4'],
			selectedItemId: '5',
		}),
		['5', '1', '3'],
	);
});

test('buildArticleListEntries only renders previews from already-loaded content', () => {
	assert.deepEqual(
		buildArticleListEntries({
			itemIds: ['loaded-item', 'pending-item'],
			loadedItemsById: {
				'loaded-item': {
					id: 'loaded-item',
					title: 'Loaded title',
					published: 1_742_460_800,
					origin: { title: 'Alpha Feed' },
					summary: { content: 'Loaded preview' },
					content: { content: '<p>Loaded article</p>' },
				},
			},
		}),
		[
			{
				id: 'loaded-item',
				title: 'Loaded title',
				feedTitle: 'Alpha Feed',
				published: 1_742_460_800,
				preview: 'Loaded preview',
				heroImageUrl: null,
				isPaywalled: false,
				isLoaded: true,
				readingLength: null,
			},
			{
				id: 'pending-item',
				title: 'Loading article…',
				feedTitle: '',
				published: 0,
				preview: '',
				heroImageUrl: null,
				isPaywalled: false,
				isLoaded: false,
				readingLength: null,
			},
		],
	);
});

test('buildArticleListEntries carries the server paywall flag', () => {
	const [entry] = buildArticleListEntries({
		itemIds: ['teaser'],
		loadedItemsById: {
			teaser: { id: 'teaser', title: 'Teaser', published: 1_742_460_800, isPaywalled: true, content: { content: '<p>Intro</p>' } },
		},
	});
	assert.equal(entry.isPaywalled, true);
});

test('buildArticleListEntries removes escaped invisible newsletter spacer entities from previews', () => {
	assert.deepEqual(
		buildArticleListEntries({
			itemIds: ['summary-spacers', 'html-spacers'],
			loadedItemsById: {
				'summary-spacers': {
					id: 'summary-spacers',
					title: 'Summary spacers',
					published: 1_742_460_800,
					origin: { title: 'Capital Gains' },
					summary: {
						content:
							'Plus! Diff Jobs; Unit Economics;&amp;#x2007;&amp;#x34F;&amp;#x2007;&amp;#x34F;',
					},
					content: { content: '<p>Body</p>' },
				},
				'html-spacers': {
					id: 'html-spacers',
					title: 'HTML spacers',
					published: 1_742_460_801,
					origin: { title: 'Capital Gains' },
					summary: { content: '' },
					content: {
						content:
							'<p>Mindshare; Consumption Equality &#x2007;&#x34F;&#x2007;&#x34F;</p>',
					},
				},
			},
		}).map((entry) => entry.preview),
		[
			'Plus! Diff Jobs; Unit Economics;',
			'Mindshare; Consumption Equality',
		],
	);
});

test('buildArticleListEntries strips decoded numeric entities plus raw invisible and control characters from previews', () => {
	assert.deepEqual(
		buildArticleListEntries({
			itemIds: ['plain-text-noise', 'html-decimal-noise'],
			loadedItemsById: {
				'plain-text-noise': {
					id: 'plain-text-noise',
					title: 'Plain text noise',
					published: 1_742_460_802,
					origin: { title: 'Capital Gains' },
					summary: {
						content: 'Signal\u0007\u200b\u2060\u034f value\u009f survives',
					},
					content: { content: '<p>Body</p>' },
				},
				'html-decimal-noise': {
					id: 'html-decimal-noise',
					title: 'HTML decimal noise',
					published: 1_742_460_803,
					origin: { title: 'Capital Gains' },
					summary: { content: '' },
					content: {
						content: '<p>Markets&#8199;&#847; stayed&#13; readable&#10;today</p>',
					},
				},
			},
		}).map((entry) => entry.preview),
		[
			'Signal value survives',
			'Markets stayed readable today',
		],
	);
});

test('buildArticleListEntries strips HTML summaries before showing previews', () => {
	assert.deepEqual(
		buildArticleListEntries({
			itemIds: ['html-summary'],
			loadedItemsById: {
				'html-summary': {
					id: 'html-summary',
					title: 'HTML summary',
					published: 1_742_460_804,
					origin: { title: 'Daily Brief' },
					summary: {
						content:
							'<article><p>Markets opened mixed.</p><p><img src="https://example.com/image.png" alt="Market" /></p><p>Analysts expect a calmer close.</p></article>',
					},
					content: { content: '<p>Fallback body should not replace this summary.</p>' },
				},
			},
		}).map((entry) => entry.preview),
		['Markets opened mixed. Analysts expect a calmer close.'],
	);
});

test('buildArticleListEntries preserves plain-text angle brackets and meaningful Unicode joiners in previews', () => {
	assert.deepEqual(
		buildArticleListEntries({
			itemIds: ['angle-brackets', 'unicode-joiners'],
			loadedItemsById: {
				'angle-brackets': {
					id: 'angle-brackets',
					title: 'Angle brackets',
					published: 1_742_460_804,
					origin: { title: 'Support' },
					summary: {
						content: 'Contact <support@example.com>; use <a> and <p> literally when 2 < 5 > 3.',
					},
					content: { content: '<p>Fallback body should not replace this summary.</p>' },
				},
				'unicode-joiners': {
					id: 'unicode-joiners',
					title: 'Unicode joiners',
					published: 1_742_460_805,
					origin: { title: 'Language' },
					summary: {
						content: 'Persian می‌خواهم and emoji 🧑‍💻 stay joined.',
					},
					content: { content: '<p>Body</p>' },
				},
			},
		}).map((entry) => entry.preview),
		[
			'Contact <support@example.com>; use <a> and <p> literally when 2 < 5 > 3.',
			'Persian می‌خواهم and emoji 🧑‍💻 stay joined.',
		],
	);
});

test('createArticleFrameDocument wraps article HTML in a complete readable document with external links', () => {
	const articleHtml = '<article><p>Read <a href="https://example.com/story">the original</a>.</p></article>';
	const documentHtml = createArticleFrameDocument(articleHtml);
	const emptyDocumentHtml = createArticleFrameDocument('');
	const darkDocumentHtml = createArticleFrameDocument(articleHtml, 'dark');

	assert.match(documentHtml, /^<!doctype html>/i);
	assert.match(documentHtml, /<html lang="en" data-theme="light">/);
	assert.match(documentHtml, /<base target="_blank" \/>/);
	assert.match(documentHtml, /text-decoration:\s*underline/);
	assert.match(documentHtml, /<body><article><p>Read <a href="https:\/\/example\.com\/story">the original<\/a>\.<\/p><\/article><\/body>/);
	assert.match(emptyDocumentHtml, /No article content available/);
	assert.match(darkDocumentHtml, /<html lang="en" data-theme="dark">/);
	assert.match(darkDocumentHtml, /html\[data-theme="dark"\]/);
	assert.match(darkDocumentHtml, /--frame-page:\s*#1f1f21/);
	assert.match(darkDocumentHtml, /--frame-link:\s*#409cff/);
});

test('selectArticleHeroImageUrl returns the first usable absolute image URL from loaded article HTML', () => {
	assert.equal(
		selectArticleHeroImageUrl(
			'<figure><img src="cid:hero" /><img src="/relative.jpg" /><img src="https://cdn.example/pixel.gif" width="1" height="1" /><img src="https://cdn.example/hero.jpg" /></figure>',
		),
		'https://cdn.example/hero.jpg',
	);
	assert.equal(selectArticleHeroImageUrl('<p>No hero here.</p>'), null);
});

test('selectArticleHeroImageUrl decodes HTML-escaped query strings and accepts protocol-relative URLs', () => {
	assert.equal(
		selectArticleHeroImageUrl('<img src="//cdn.example/hero.jpg?utm=reader&amp;id=42" />'),
		'//cdn.example/hero.jpg?utm=reader&id=42',
	);
});

test('selectArticleHeroImageUrl skips obviously hidden tracker-style images and continues to a real image', () => {
	assert.equal(
		selectArticleHeroImageUrl(
			'<img src="https://cdn.example/tracker.gif" style="display:none" /><img src="https://cdn.example/hero.jpg" />',
		),
		'https://cdn.example/hero.jpg',
	);
	assert.equal(
		selectArticleHeroImageUrl(
			'<img src="https://cdn.example/tracker.gif" style="visibility:hidden;opacity:0" /><img src="//cdn.example/hero-2.jpg" />',
		),
		'//cdn.example/hero-2.jpg',
	);
});

test('sanitizeArticleHtml leaves on*= and href-like text outside tags untouched', () => {
	assert.equal(
		sanitizeArticleHtml('<pre><code>const onSubmit = handleForm;</code></pre>'),
		'<pre><code>const onSubmit = handleForm;</code></pre>',
	);
	assert.equal(sanitizeArticleHtml('<p>Set online=true in your config.</p>'), '<p>Set online=true in your config.</p>');
	assert.equal(
		sanitizeArticleHtml('<p>Write href="javascript:void(0)" or src=data:x in docs.</p>'),
		'<p>Write href="javascript:void(0)" or src=data:x in docs.</p>',
	);
});

test('sanitizeArticleHtml still strips event handlers and script URLs inside tags, including obfuscated forms', () => {
	assert.equal(sanitizeArticleHtml('<img src="https://x.com/a.png" onerror="alert(1)">'), '<img src="https://x.com/a.png">');
	assert.equal(sanitizeArticleHtml("<div onclick='x()' class=\"k\">Hi</div>"), '<div class="k">Hi</div>');
	assert.equal(sanitizeArticleHtml('<a href="javascript:alert(1)">bad</a>'), '<a>bad</a>');
	assert.equal(sanitizeArticleHtml('<img src=data:image/svg+xml,abc>'), '<img>');
	assert.equal(sanitizeArticleHtml('<iframe srcdoc="x"></iframe><div srcdoc="y">k</div>'), '<div>k</div>');
	assert.doesNotMatch(sanitizeArticleHtml('<img/onerror=alert(1) src=x>'), /onerror/i);
	assert.doesNotMatch(sanitizeArticleHtml('<a href="jav&#x61;script:alert(1)">x</a>'), /href/i);
	assert.doesNotMatch(sanitizeArticleHtml('<a href="&#106;ava&#9;script&colon;alert(1)">x</a>'), /href/i);
	assert.doesNotMatch(sanitizeArticleHtml('<a href=" java\tscript:alert(1)">x</a>'), /href/i);
	assert.equal(sanitizeArticleHtml('<a href="https://example.com/?a=1&amp;b=2">ok</a>'), '<a href="https://example.com/?a=1&amp;b=2">ok</a>');
	assert.equal(sanitizeArticleHtml('<p style="color: red">Keep</p>'), '<p style="color: red">Keep</p>');
});

test('selectArticleHeroImageUrl does not treat non-hiding zero-valued styles as hidden', () => {
	for (const style of ['display:block;border-width:0', 'line-height:0', 'min-height:0', 'opacity:0.9', 'min-width: 0px; opacity: 0.5', 'width:0.5em']) {
		assert.equal(
			selectArticleHeroImageUrl(`<img src="https://x.com/hero.jpg" width="600" style="${style}">`),
			'https://x.com/hero.jpg',
			style,
		);
	}
	for (const style of ['display:none', 'opacity:0', 'opacity: 0.0 !important', 'width:0', 'max-height:0px', 'color:red; height: 0px;', 'visibility:hidden', 'DISPLAY: NONE']) {
		assert.equal(selectArticleHeroImageUrl(`<img src="https://x.com/hero.jpg" style="${style}">`), null, style);
	}
});

test('buildArticleListEntries keeps escaped angle brackets in HTML summaries', () => {
	assert.deepEqual(
		buildArticleListEntries({
			itemIds: ['escaped'],
			loadedItemsById: {
				escaped: {
					id: 'escaped',
					title: 'Escaped',
					published: 1_742_460_804,
					origin: { title: 'Code' },
					summary: { content: '<p>If x &lt; y and y &gt; z then use &lt;div&gt; tags.</p>' },
					content: { content: '<p>Body</p>' },
				},
			},
		}).map((entry) => entry.preview),
		['If x < y and y > z then use <div> tags.'],
	);
});

test('buildArticleListEntries truncates previews without splitting surrogate pairs', () => {
	const [entry] = buildArticleListEntries({
		itemIds: ['emoji'],
		loadedItemsById: {
			emoji: {
				id: 'emoji',
				title: 'Emoji',
				published: 1_742_460_804,
				origin: { title: 'Emoji' },
				summary: { content: 'a'.repeat(276) + '😀' + 'b'.repeat(20) },
			},
		},
	});
	assert.doesNotMatch(entry.preview, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
	assert.ok(entry.preview.endsWith('...'));
});

test('selectArticleHeroImageUrl ignores malformed oversized numeric entities instead of throwing', () => {
	assert.equal(
		selectArticleHeroImageUrl('<img src="https://cdn.example/hero.jpg?broken=&#1114112;&amp;ok=1" />'),
		'https://cdn.example/hero.jpg?broken=&#1114112;&ok=1',
	);
	assert.equal(
		selectArticleHeroImageUrl('<img src="https://cdn.example/hero.jpg?broken=&#9999999999;" />'),
		'https://cdn.example/hero.jpg?broken=&#9999999999;',
	);
});

test('renderBrowserAppClientScript exposes the shared auth helpers for the shell', () => {
	const script = renderBrowserAppClientScript();

	assert.match(script, /window\.__PIGEON_BROWSER_CLIENT__/);
	assert.match(script, /extractAuthToken/);
	assert.match(script, new RegExp(AUTH_STORAGE_KEY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
	assert.match(script, new RegExp(THEME_STORAGE_KEY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
	assert.match(script, /normalizeBrowserTheme/);
});

test('formatArticleListTime gives short Reeder-style row times', () => {
	const now = new Date(2026, 10, 1, 15, 0, 0).getTime();
	const seconds = (date: Date) => Math.floor(date.getTime() / 1000);
	assert.match(formatArticleListTime(seconds(new Date(2026, 10, 1, 9, 40)), now), /9:40/);
	assert.equal(formatArticleListTime(seconds(new Date(2026, 9, 31, 23, 59)), now), 'Yesterday');
	assert.doesNotMatch(formatArticleListTime(seconds(new Date(2026, 9, 30, 8, 0)), now), /2026|:/);
	// Nov 1, 2026 is a 25-hour day in zones that end daylight saving that night; boundaries stay at midnight.
	const lateToday = new Date(2026, 10, 1, 23, 30).getTime();
	assert.match(formatArticleListTime(seconds(new Date(2026, 10, 1, 23, 30)), lateToday), /11:30|23:30/);
	const nextMorning = new Date(2026, 10, 2, 9, 0).getTime();
	assert.equal(formatArticleListTime(seconds(new Date(2026, 10, 1, 0, 30)), nextMorning), 'Yesterday');
	assert.doesNotMatch(formatArticleListTime(seconds(new Date(2026, 9, 31, 23, 30)), nextMorning), /Yesterday/);
	assert.match(formatArticleListTime(seconds(new Date(2025, 2, 20, 8, 0)), now), /2025/);
	assert.equal(formatArticleListTime(0, now), '');
	assert.equal(formatArticleListTime(undefined, now), '');
});

test('createFeedOrderComparator groups by folded feed title and feed ID, newest first, unloaded items last', () => {
	const items: Record<string, { published: number; origin?: { title?: string; streamId?: string } }> = {
		'1': { published: 100, origin: { title: 'beta', streamId: 'feed/3' } },
		'2': { published: 300, origin: { title: 'Alpha', streamId: 'feed/9' } },
		'3': { published: 200, origin: { title: 'ALPHA', streamId: 'feed/2' } },
		'4': { published: 300, origin: { title: 'Alpha', streamId: 'feed/9' } },
		'5': { published: 400, origin: { title: 'Beta', streamId: 'feed/3' } },
		'6': { published: 500, origin: { title: 'Écho', streamId: 'feed/4' } },
	};
	const compare = createFeedOrderComparator((id) => items[id]);
	assert.deepEqual(['1', '2', '3', '4', '5', '6', '8', '7'].sort(compare), ['3', '4', '2', '5', '1', '6', '8', '7']);
	assert.equal(compare('1', '1'), 0);
});


function withTimeZone<T>(timeZone: string, run: () => T): T {
	const previous = process.env.TZ;
	process.env.TZ = timeZone;
	try {
		return run();
	} finally {
		if (previous === undefined) delete process.env.TZ;
		else process.env.TZ = previous;
	}
}

test('getLocalDayRangeBounds covers six days back to next midnight across DST', () => {
	withTimeZone('America/New_York', () => {
		// Daylight saving ends on Nov 1, 2026, so this week is 7 days and one hour long.
		const now = new Date(2026, 10, 3, 12, 0, 0).getTime();
		const week = getLocalDayRangeBounds(now, 7);
		assert.equal(week.start.toISOString(), '2026-10-28T04:00:00.000Z');
		assert.equal(week.end.toISOString(), '2026-11-04T05:00:00.000Z');
		assert.equal(week.startSeconds, Date.parse('2026-10-28T04:00:00Z') / 1000);
		assert.equal(week.endSeconds, Date.parse('2026-11-04T05:00:00Z') / 1000);
		assert.equal(week.endSeconds - week.startSeconds, 7 * 86_400 + 3_600);
		const day = getLocalDayRangeBounds(now, 1);
		assert.equal(day.start.toISOString(), '2026-11-03T05:00:00.000Z');
		assert.equal(day.endSeconds, week.endSeconds);
		assert.deepEqual(getLocalDayBounds(new Date(now)), { startSeconds: day.startSeconds, endSeconds: day.endSeconds });
	});
});

test('buildFolderSections orders Today, Last 7 Days, feeds by newest, then Older', () => {
	withTimeZone('America/New_York', () => {
		const now = new Date(2026, 10, 3, 12, 0, 0).getTime();
		const today = getLocalDayRangeBounds(now, 1).startSeconds;
		const weekStart = getLocalDayRangeBounds(now, 7).startSeconds;
		const story = (id: string, streamId: string, feedTitle: string, published: number) => ({ id, streamId, feedTitle, published });
		const items = [
			story('o2', 'feed/6', 'Foxtrot', weekStart - 1),
			story('t6', 'feed/1', 'Alpha', today),
			story('r2', 'feed/5', 'Echo', weekStart),
			story('t1', 'feed/1', 'Alpha', today + 600),
			story('t2', 'feed/2', 'Bravo', today + 500),
			story('o1', 'feed/4', 'Delta', weekStart - 1),
			story('t3', 'feed/1', 'Alpha', today + 400),
			story('m1', '', 'Mystery', today - 100),
			story('t4', 'feed/1', 'Alpha', today + 300),
			story('r1', 'feed/3', 'Charlie', today - 1),
			story('t5', 'feed/2', 'Bravo', today + 200),
		];
		const summary = (sections: ReturnType<typeof buildFolderSections>) =>
			sections.map((section) => [section.key, section.kind, section.title, section.itemIds.join(' '), section.hiddenCount]);

		assert.deepEqual(summary(buildFolderSections(items, now)), [
			// Midnight exactly is today; 23:59:59 yesterday and the first second of the week are the Last 7 Days.
			['today', 'today', 'Today', 't1 t2 t3 t4 t5', 1],
			['last-7-days', 'last-7-days', 'Last 7 Days', 'r1 m1 r2', 0],
			// Today's stories appear again in their feed; feeds follow their newest story.
			['feed:feed/1', 'feed', 'Alpha', 't1 t3 t4', 1],
			['feed:feed/2', 'feed', 'Bravo', 't2 t5', 0],
			['feed:feed/3', 'feed', 'Charlie', 'r1', 0],
			// A story without a known feed keeps its own source title.
			['feed:Mystery', 'feed', 'Mystery', 'm1', 0],
			['feed:feed/5', 'feed', 'Echo', 'r2', 0],
			// One second before the week starts is Older; equal newest stories fall back to the feed title.
			['older', 'older-header', 'Older', '', 0],
			['feed:feed/4', 'feed', 'Delta', 'o1', 0],
			['feed:feed/6', 'feed', 'Foxtrot', 'o2', 0],
		]);
		const sections = buildFolderSections(items, now);
		assert.equal(sections.find((section) => section.key === 'feed:feed/1')?.streamId, 'feed/1');
		assert.equal(sections.find((section) => section.key === 'feed:Mystery')?.streamId, undefined);
		assert.equal(sections.find((section) => section.key === 'today')?.streamId, undefined);

		const expanded = summary(buildFolderSections(items, now, { expanded: new Set(['today', 'feed:feed/1']) }));
		assert.deepEqual(expanded[0], ['today', 'today', 'Today', 't1 t2 t3 t4 t5 t6', 0]);
		assert.deepEqual(expanded[2], ['feed:feed/1', 'feed', 'Alpha', 't1 t3 t4 t6', 0]);

		const limited = summary(buildFolderSections(items, now, { todayLimit: 2, recentLimit: 1, feedLimit: 1 }));
		assert.deepEqual(limited.slice(0, 3), [
			['today', 'today', 'Today', 't1 t2', 4],
			['last-7-days', 'last-7-days', 'Last 7 Days', 'r1', 2],
			['feed:feed/1', 'feed', 'Alpha', 't1', 3],
		]);

		// No story today or this week: no Today or Last 7 Days section, and Older still heads the old feeds.
		assert.deepEqual(summary(buildFolderSections([items[0], items[5]], now)).map((row) => row[0]), ['older', 'feed:feed/4', 'feed:feed/6']);
		assert.deepEqual(buildFolderSections([], now), []);
	});
});

test('buildFolderSections survives serialization into the browser script', () => {
	const script = renderBrowserAppClientScript();
	const window: Record<string, any> = {};
	new Function('window', script)(window);
	const now = new Date(2026, 10, 3, 12).getTime();
	const sections = window.__PIGEON_BROWSER_CLIENT__.buildFolderSections(
		[{ id: '1', streamId: 'feed/1', feedTitle: 'Alpha', published: Math.floor(now / 1000) }], now,
	);
	assert.deepEqual(sections.map((section: { key: string }) => section.key), ['today', 'feed:feed/1']);
});

test('buildFeedDaySections splits a feed into Today, Yesterday and Earlier, five each until N more', () => {
	withTimeZone('America/New_York', () => {
		const now = new Date(2026, 10, 3, 12, 0, 0).getTime();
		const today = getLocalDayRangeBounds(now, 1).startSeconds;
		const yesterday = getLocalDayRangeBounds(now, 2).startSeconds;
		const story = (id: string, published: number) => ({ id, published });
		const items = [
			story('e1', yesterday - 1),
			story('y1', yesterday),
			story('t1', today),
			story('f1', today + 86_400 * 2),
			story('t2', today + 60),
			...[2, 3, 4, 5, 6, 7].map((day) => story('e' + day, yesterday - day * 86_400)),
		];
		const summary = (sections: ReturnType<typeof buildFeedDaySections>) =>
			sections.map((section) => [section.key, section.kind, section.title, section.itemIds.join(' '), section.hiddenCount]);
		assert.deepEqual(summary(buildFeedDaySections(items, now)), [
			// A story dated after today (a skewed clock) is Today; midnight exactly is Today.
			['today', 'today', 'Today', 'f1 t2 t1', 0],
			['yesterday', 'yesterday', 'Yesterday', 'y1', 0],
			// Earlier is capped at five too.
			['earlier', 'earlier', 'Earlier', 'e1 e2 e3 e4 e5', 2],
		]);
		assert.deepEqual(summary(buildFeedDaySections(items, now, { expanded: new Set(['earlier']) }))[2],
			['earlier', 'earlier', 'Earlier', 'e1 e2 e3 e4 e5 e6 e7', 0]);
		assert.deepEqual(summary(buildFeedDaySections(items, now, { limit: 1 })).map((row) => row[4]), [2, 0, 6]);
		// Days without a story have no section.
		assert.deepEqual(buildFeedDaySections([story('e1', yesterday - 1)], now).map((section) => section.key), ['earlier']);
		assert.deepEqual(buildFeedDaySections([], now), []);
	});
});

test('kickerColorIndex matches the iOS FNV-1a palette index', () => {
	// The fixed values iOS FrontPageLayoutTests pins.
	assert.equal(kickerColorIndex(''), 5);
	assert.equal(kickerColorIndex('abc'), 3);
	assert.equal(kickerColorIndex('money-stuff'), 0);
	const indices = Array.from({ length: 200 }, (_, index) => kickerColorIndex('feed-' + index));
	assert.ok(indices.every((index) => index >= 0 && index < 8));
	assert.equal(new Set(indices).size, 8);
});

test('assignFolderColorIndices gives folders distinct colours until the palette runs out', () => {
	const ids = Array.from({ length: 8 }, (_, index) => 'user/-/label/Folder ' + (index + 1));
	const indices = assignFolderColorIndices(ids);
	assert.equal(new Set(indices).size, 8);
	assert.equal(indices[0], kickerColorIndex(ids[0]));
	// A ninth folder cannot be unique; it keeps its own hash, and the first eight do not move.
	const nine = assignFolderColorIndices([...ids, 'user/-/label/Ninth']);
	assert.equal(nine[8], kickerColorIndex('user/-/label/Ninth'));
	assert.deepEqual(nine.slice(0, 8), indices);
	// A collision moves the later folder to the next free colour.
	const [first, second] = assignFolderColorIndices(['a', 'a']);
	assert.equal(second, (first + 1) % 8);
	assert.deepEqual(assignFolderColorIndices([]), []);
});

test('day sections and colours survive serialization into the browser script', () => {
	const script = renderBrowserAppClientScript();
	const window: Record<string, any> = {};
	new Function('window', script)(window);
	const client = window.__PIGEON_BROWSER_CLIENT__;
	const now = new Date(2026, 10, 3, 12).getTime();
	assert.deepEqual(client.buildFeedDaySections([{ id: '1', published: Math.floor(now / 1000) }], now).map((section: { key: string }) => section.key), ['today']);
	assert.equal(client.kickerColorIndex('money-stuff'), 0);
	assert.deepEqual(client.assignFolderColorIndices(['a', 'a']), assignFolderColorIndices(['a', 'a']));
});

test('buildFrontPagePages leads each page of thirteen with an early picture, else its first story', () => {
	const stories = Array.from({ length: 30 }, (_, index) => ({ id: String(index), hasImage: [2, 9, 13 + 4, 26].includes(index) }));
	const { pages, order } = buildFrontPagePages(stories);
	assert.deepEqual(pages.map((page) => page.lead), ['2', '13', '26']);
	assert.deepEqual(pages[0].grid, ['0', '1', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']);
	// Page two's picture is its fifth story, outside the first four: its first story leads.
	assert.deepEqual(pages[1].grid.slice(0, 4), ['14', '15', '16', '17']);
	assert.deepEqual(pages[2], { lead: '26', grid: ['27', '28', '29'] });
	assert.deepEqual(order, pages.flatMap((page) => [page.lead, ...page.grid]));
	assert.equal(new Set(order).size, 30);
	assert.deepEqual(buildFrontPagePages([]), { pages: [], order: [] });
	assert.deepEqual(buildFrontPagePages([{ id: 'a', hasImage: false }]).pages, [{ lead: 'a', grid: [] }]);
});

test('buildFrontPagePages keeps a pinned lead wherever it sits on its page', () => {
	const stories = Array.from({ length: 15 }, (_, index) => ({ id: String(index), hasImage: index === 1 }));
	const { pages, order } = buildFrontPagePages(stories, { pinnedLeads: new Set(['6', '14']) });
	assert.deepEqual(pages.map((page) => page.lead), ['6', '14']);
	assert.equal(order.length, 15);
	assert.deepEqual(buildFrontPagePages(stories, { pinnedLeads: new Set(['99']) }).pages[0].lead, '1', 'a pin not on the page changes nothing');
});

test('frontPageDeck collapses whitespace and stops near 240 characters', () => {
	assert.equal(frontPageDeck('  Short\n\n deck  '), 'Short deck');
	assert.equal(frontPageDeck(null), '');
	const long = frontPageDeck('word '.repeat(100));
	assert.ok(long.endsWith('…') && long.length <= 241);
	// A cut never leaves half of a surrogate pair.
	const emoji = frontPageDeck('a'.repeat(239) + '😀' + 'b'.repeat(10));
	assert.equal(emoji, 'a'.repeat(239) + '…');
});

test('isEditorialImage keeps photo-shaped pictures of some size, as on iOS', () => {
	assert.equal(isEditorialImage(1200, 800, 320), true);
	assert.equal(isEditorialImage(600, 1000, 320), true);
	assert.equal(isEditorialImage(900, 100, 140), false, 'a banner');
	assert.equal(isEditorialImage(300, 600, 140), false, 'too tall');
	assert.equal(isEditorialImage(120, 100, 140), false, 'too small');
	assert.equal(isEditorialImage(0, 0, 140), false);
	assert.equal(isEditorialImage(Number.NaN, 100, 140), false);
});

test('Front Page helpers survive serialization into the browser script', () => {
	const window: Record<string, any> = {};
	new Function('window', renderBrowserAppClientScript())(window);
	const client = window.__PIGEON_BROWSER_CLIENT__;
	assert.deepEqual(client.buildFrontPagePages([{ id: 'a', hasImage: false }, { id: 'b', hasImage: true }]).order, ['b', 'a']);
	assert.equal(client.frontPageDeck('x '.repeat(200)).length, 240);
	assert.equal(client.isEditorialImage(1200, 800, 320), true);
});
