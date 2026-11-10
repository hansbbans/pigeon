import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	AUTH_STORAGE_KEY,
	THEME_STORAGE_KEY,
	applyUnauthorizedState,
	buildArticleListEntries,
	buildFeedViews,
	createArticleFrameDocument,
	createContentLoadPlan,
	createLoggedOutSession,
	createSessionFromToken,
	extractAuthToken,
	filterItemIdsForLocalDay,
	formatArticleListTime,
	getLocalDayBounds,
	limitInitialItemIds,
	normalizeBrowserTheme,
	renderBrowserAppClientScript,
	sanitizeArticleHtml,
	selectArticleHeroImageUrl,
	sortSubscriptionsByTitle,
} from '../src/browser-app-client';

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
