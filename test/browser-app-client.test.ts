import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

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
	getLocalDayBounds,
	limitInitialItemIds,
	normalizeBrowserTheme,
	renderBrowserAppClientScript,
	selectArticleHeroImageUrl,
	sortSubscriptionsByTitle,
} from '../src/browser-app-client';
import { renderBrowserAppRuntimeScript } from '../src/browser-app';

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
				isLoaded: true,
			},
			{
				id: 'pending-item',
				title: 'Loading article…',
				feedTitle: '',
				published: 0,
				preview: '',
				heroImageUrl: null,
				isLoaded: false,
			},
		],
	);
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
	assert.match(darkDocumentHtml, /--frame-page:\s*#0f172a/);
	assert.match(darkDocumentHtml, /--frame-link:\s*#8ab4ff/);
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

function createElement(
	initialValue = '',
	initialClasses: string[] = [],
	tagName = 'div',
	onFocus?: (element: ReturnType<typeof createElement>) => void,
) {
	const handlers = new Map<string, (event: Record<string, unknown> & { preventDefault(): void; target: unknown }) => unknown>();
	const classes = new Set(initialClasses);
	const attributes = new Map<string, string>();
	const styleProperties = new Map<string, string>();
	const dataset: Record<string, string> = {};
	const children: Array<ReturnType<typeof createElement>> = [];
	let ownTextContent = '';
	let innerHtmlValue = '';
	const element = {
		tagName: tagName.toUpperCase(),
		value: initialValue,
		srcdoc: '',
		hidden: false,
		isContentEditable: false,
		parentElement: null as ReturnType<typeof createElement> | null,
		dataset,
		children,
		style: {
			setProperty(name: string, value: string) {
				styleProperties.set(name, value);
			},
			getPropertyValue(name: string) {
				return styleProperties.get(name) ?? '';
			},
			removeProperty(name: string) {
				styleProperties.delete(name);
			},
		},
		toggleCalls: [] as Array<{ name: string; force: boolean | undefined }>,
		classList: {
			add(...names: string[]) {
				for (const name of names) {
					classes.add(name);
				}
			},
			remove(...names: string[]) {
				for (const name of names) {
					classes.delete(name);
				}
			},
			toggle(name: string, force?: boolean) {
				element.toggleCalls.push({ name, force });
				if (force === true) {
					classes.add(name);
					return true;
				}
				if (force === false) {
					classes.delete(name);
					return false;
				}
				if (classes.has(name)) {
					classes.delete(name);
					return false;
				}
				classes.add(name);
				return true;
			},
			contains(name: string) {
				return classes.has(name);
			},
		},
		appendChild(child: ReturnType<typeof createElement>) {
			child.parentElement = element;
			children.push(child);
			return child;
		},
		replaceChildren(...newChildren: Array<ReturnType<typeof createElement>>) {
			children.length = 0;
			for (const child of newChildren) {
				child.parentElement = element;
				children.push(child);
			}
		},
		setAttribute(name: string, value: string) {
			attributes.set(name, value);
			if (name === 'contenteditable') {
				element.isContentEditable = value !== 'false';
			}
			if (name.startsWith('data-')) {
				dataset[name.slice(5).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())] = value;
			}
		},
		getAttribute(name: string) {
			return attributes.get(name) ?? null;
		},
		addEventListener(type: string, handler: (event: Record<string, unknown> & { preventDefault(): void }) => unknown) {
			handlers.set(type, handler);
		},
		removeEventListener(type: string) {
			handlers.delete(type);
		},
		hasEventListener(type: string) {
			return handlers.has(type);
		},
		dispatch(type: string, event?: Record<string, unknown>) {
			const handler = handlers.get(type);
			if (handler) {
				return handler({ preventDefault() {}, target: element, currentTarget: element, ...event });
			}
			return undefined;
		},
		focus() {
			onFocus?.(element);
		},
		setPointerCapture() {},
		getBoundingClientRect() {
			return { width: 1440, height: 900, left: 0, right: 1440, top: 0, bottom: 900 };
		},
	};

	Object.defineProperty(element, 'textContent', {
		get() {
			return ownTextContent + children.map((child) => child.textContent).join('');
		},
		set(value: string) {
			ownTextContent = value;
			children.length = 0;
		},
		enumerable: true,
		configurable: true,
	});

	Object.defineProperty(element, 'innerHTML', {
		get() {
			return innerHtmlValue;
		},
		set(value: string) {
			innerHtmlValue = value;
			children.length = 0;
		},
		enumerable: true,
		configurable: true,
	});

	return element;
}

function createDeferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

async function flushBrowserTasks() {
	await Promise.resolve();
	await Promise.resolve();
	await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForBrowserCondition(check: () => boolean, attempts = 20) {
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		if (check()) {
			return;
		}
		await flushBrowserTasks();
	}
}

function createFixedDateConstructor(timestamp: number) {
	return class FixedDate extends Date {
		constructor(
			value?: string | number,
			month?: number,
			day?: number,
			hours?: number,
			minutes?: number,
			seconds?: number,
			milliseconds?: number,
		) {
			if (month === undefined) {
				super(value === undefined ? timestamp : value);
				return;
			}

			super(
				value as number,
				month,
				day ?? 1,
				hours ?? 0,
				minutes ?? 0,
				seconds ?? 0,
				milliseconds ?? 0,
			);
		}

		static now() {
			return timestamp;
		}
	};
}

async function createBrowserHarness(options?: {
	storedToken?: string | null;
	storedTheme?: string | null;
	storedArticleListMode?: string | null;
	storedColumnWidths?: { sidebar?: number; stream?: number };
	readerGridWidth?: number | (() => number);
	now?: number;
	fetchImpl?: (input: string, init?: { method?: string; body?: FormData; headers?: Record<string, string> }) => Promise<Response>;
}) {
	const documentHandlers = new Map<string, (event: Record<string, unknown>) => unknown>();
	const windowHandlers = new Map<string, (event: Record<string, unknown>) => unknown>();
	let activeElement: ReturnType<typeof createElement> | null = null;
	const registerFocus = (element: ReturnType<typeof createElement>) => {
		activeElement = element;
	};
	const elements = new Map<string, ReturnType<typeof createElement>>([
		['login-screen', createElement('', [], 'div', registerFocus)],
		['reader-shell', createElement('', ['hidden'], 'section', registerFocus)],
		['reader-grid', createElement('', [], 'div', registerFocus)],
		['sidebar-column-resizer', createElement('', [], 'button', registerFocus)],
		['stream-column-resizer', createElement('', [], 'button', registerFocus)],
		['reader-window-address', createElement('', [], 'div', registerFocus)],
		['login-form', createElement('', [], 'form', registerFocus)],
		['login-error', createElement('', [], 'div', registerFocus)],
		['password-input', createElement('secret-password', [], 'input', registerFocus)],
		['clear-session-button', createElement('', [], 'button', registerFocus)],
		['logout-button', createElement('', [], 'button', registerFocus)],
		['theme-toggle-button', createElement('', [], 'button', registerFocus)],
		['article-list-mode-button', createElement('', [], 'button', registerFocus)],
		['settings-button', createElement('', [], 'button', registerFocus)],
		['settings-panel', createElement('', ['hidden'], 'aside', registerFocus)],
		['close-settings-button', createElement('', [], 'button', registerFocus)],
		['sidebar-current-title', createElement('', [], 'strong', registerFocus)],
		['sidebar-current-meta', createElement('', [], 'p', registerFocus)],
		['views-list', createElement('', [], 'ul', registerFocus)],
		['folders-status', createElement('', [], 'p', registerFocus)],
		['folders-list', createElement('', [], 'ul', registerFocus)],
		['feeds-status', createElement('', [], 'p', registerFocus)],
		['feeds-list', createElement('', [], 'ul', registerFocus)],
		['articles-heading', createElement('', [], 'strong', registerFocus)],
		['articles-status', createElement('', [], 'p', registerFocus)],
		['articles-list', createElement('', [], 'ul', registerFocus)],
		['load-more-button', createElement('', ['hidden'], 'button', registerFocus)],
		['reader-source-label', createElement('', [], 'p', registerFocus)],
		['reader-source-note', createElement('', [], 'p', registerFocus)],
		['open-original-button', createElement('', [], 'button', registerFocus)],
		['reader-title', createElement('', [], 'strong', registerFocus)],
		['reader-meta', createElement('', [], 'p', registerFocus)],
		['reader-frame', createElement('', [], 'iframe', registerFocus)],
		['settings-content', createElement('', [], 'div', registerFocus)],
	]);
	const frameDocumentHandlers = new Map<string, (event: Record<string, unknown>) => unknown>();
	const frameBody = createElement('', [], 'body', registerFocus);
	const frameDocument = {
		body: frameBody,
		activeElement: frameBody,
		addEventListener(type: string, handler: (event: Record<string, unknown>) => unknown) {
			frameDocumentHandlers.set(type, handler);
		},
		removeEventListener(type: string) {
			frameDocumentHandlers.delete(type);
		},
		createElement(tagName?: string) {
			return createElement('', [], tagName, registerFocus);
		},
	};
	const storage = new Map<string, string>();
	const localStorageState = new Map<string, string>();
	const documentElementAttributes = new Map<string, string>();
	const innerHtmlWrites: string[] = [];
	if (options?.storedToken) {
		storage.set(AUTH_STORAGE_KEY, options.storedToken);
	}
	if (options?.storedTheme) {
		localStorageState.set(THEME_STORAGE_KEY, options.storedTheme);
	}
	if (options?.storedArticleListMode) {
		localStorageState.set('pigeon.browser.article-list-mode', options.storedArticleListMode);
	}
	if (options?.storedColumnWidths) {
		localStorageState.set('pigeon.browser.column-widths', JSON.stringify(options.storedColumnWidths));
	}

	for (const [id, element] of elements) {
		let currentValue = '';
		Object.defineProperty(element, 'innerHTML', {
			get() {
				return currentValue;
			},
			set(value: string) {
				currentValue = value;
				innerHtmlWrites.push(id);
			},
			enumerable: true,
			configurable: true,
		});
	}

	const readerFrame = elements.get('reader-frame');
	if (!readerFrame) {
		throw new Error('Missing reader-frame element');
	}
	const readerGrid = elements.get('reader-grid');
	if (!readerGrid) {
		throw new Error('Missing reader-grid element');
	}
	readerGrid.getBoundingClientRect = () => {
		const widthOption = options?.readerGridWidth ?? 1440;
		const width = typeof widthOption === 'function' ? widthOption() : widthOption;
		return { width, height: 900, left: 0, right: width, top: 0, bottom: 900 };
	};

	let currentSrcdoc = '';
	Object.defineProperty(readerFrame, 'srcdoc', {
		get() {
			return currentSrcdoc;
		},
		set(value: string) {
			currentSrcdoc = value;
			frameDocumentHandlers.clear();
			void setTimeout(() => {
				readerFrame.dispatch('load');
			}, 0);
		},
		enumerable: true,
		configurable: true,
	});

	Object.defineProperty(readerFrame, 'contentDocument', {
		get() {
			return frameDocument;
		},
		enumerable: true,
		configurable: true,
	});

	Object.defineProperty(readerFrame, 'contentWindow', {
		get() {
			return { document: frameDocument };
		},
		enumerable: true,
		configurable: true,
	});

	const context = {
		window: {
			__PIGEON_CONFIG__: { baseUrl: 'https://pigeon.example' },
			sessionStorage: {
				getItem(key: string) {
					return storage.get(key) ?? null;
				},
				setItem(key: string, value: string) {
					storage.set(key, value);
				},
				removeItem(key: string) {
					storage.delete(key);
				},
			},
			localStorage: {
				getItem(key: string) {
					return localStorageState.get(key) ?? null;
				},
				setItem(key: string, value: string) {
					localStorageState.set(key, value);
				},
				removeItem(key: string) {
					localStorageState.delete(key);
				},
			},
			__PIGEON_BROWSER_CLIENT__: undefined as unknown,
			open() {},
			addEventListener(type: string, handler: (event: Record<string, unknown>) => unknown) {
				windowHandlers.set(type, handler);
			},
			removeEventListener(type: string) {
				windowHandlers.delete(type);
			},
		},
		document: {
			documentElement: {
				setAttribute(name: string, value: string) {
					documentElementAttributes.set(name, value);
				},
			},
			addEventListener(type: string, handler: (event: Record<string, unknown>) => unknown) {
				documentHandlers.set(type, handler);
			},
			removeEventListener(type: string) {
				documentHandlers.delete(type);
			},
			get activeElement() {
				return activeElement;
			},
			createElement(tagName?: string) {
				return createElement('', [], tagName, registerFocus);
			},
			getElementById(id: string) {
				const element = elements.get(id);
				if (!element) {
					throw new Error(`Unknown element: ${id}`);
				}
				return element;
			},
		},
		FormData,
		Response,
		URLSearchParams,
		Date: options?.now === undefined ? Date : createFixedDateConstructor(options.now),
		console,
		setTimeout,
		clearTimeout,
		fetch: options?.fetchImpl ?? (async () => new Response('Error=BadAuthentication', { status: 401 })),
	};

	vm.runInNewContext(renderBrowserAppClientScript(), context);
	vm.runInNewContext(renderBrowserAppRuntimeScript(), context);
	await flushBrowserTasks();

	function dispatchKeydown(
		key: string,
		target: Record<string, unknown> = (activeElement ??
			elements.get('reader-shell')) as Record<string, unknown>,
		options?: { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean },
	) {
		const handler = documentHandlers.get('keydown');
		if (!handler) {
			throw new Error('No keydown handler registered');
		}

		let prevented = false;
		handler({
			key,
			target,
			metaKey: options?.metaKey ?? false,
			ctrlKey: options?.ctrlKey ?? false,
			altKey: options?.altKey ?? false,
			preventDefault() {
				prevented = true;
			},
		});
		return prevented;
	}

	function dispatchFrameKeydown(
		key: string,
		target: Record<string, unknown> = frameBody as Record<string, unknown>,
		options?: { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean },
	) {
		const handler = frameDocumentHandlers.get('keydown');
		if (!handler) {
			throw new Error('No frame keydown handler registered');
		}

		let prevented = false;
		handler({
			key,
			target,
			metaKey: options?.metaKey ?? false,
			ctrlKey: options?.ctrlKey ?? false,
			altKey: options?.altKey ?? false,
			preventDefault() {
				prevented = true;
			},
		});
		return prevented;
	}

	function dispatchDocumentPointer(type: string, clientX: number) {
		const handler = documentHandlers.get(type);
		if (!handler) {
			throw new Error(`No ${type} handler registered`);
		}

		let prevented = false;
		handler({
			clientX,
			target: elements.get('reader-grid'),
			preventDefault() {
				prevented = true;
			},
		});
		return prevented;
	}

	function dispatchWindowEvent(type: string) {
		const handler = windowHandlers.get(type);
		if (handler) {
			handler({});
		}
	}

	return {
		elements,
		storage,
		localStorageState,
		documentElementAttributes,
		innerHtmlWrites,
		dispatchKeydown,
		dispatchFrameKeydown,
		dispatchDocumentPointer,
		dispatchWindowEvent,
		getActiveElement() {
			return activeElement;
		},
	};
}

function findListButtonByViewId(
	listElement: ReturnType<typeof createElement> | undefined,
	viewId: string,
) {
	for (const listItem of listElement?.children ?? []) {
		for (const child of listItem.children) {
			if (child.dataset.viewId === viewId) {
				return child;
			}
		}
	}
	return undefined;
}

function findFolderToggleButton(
	listElement: ReturnType<typeof createElement> | undefined,
	folderId: string,
) {
	for (const listItem of listElement?.children ?? []) {
		for (const child of listItem.children) {
			if (child.getAttribute('data-folder-toggle-id') === folderId) {
				return child;
			}
		}
	}
	return undefined;
}

function findListButtonByItemId(
	listElement: ReturnType<typeof createElement> | undefined,
	itemId: string,
) {
	for (const listItem of listElement?.children ?? []) {
		for (const child of listItem.children) {
			if (child.dataset.itemId === itemId) {
				return child;
			}
		}
	}
	return undefined;
}

function findDescendantByClass(
	element: ReturnType<typeof createElement> | undefined,
	className: string,
): ReturnType<typeof createElement> | undefined {
	if (!element) {
		return undefined;
	}

	if (element.classList.contains(className)) {
		return element;
	}

	for (const child of element.children) {
		const match = findDescendantByClass(child, className);
		if (match) {
			return match;
		}
	}

	return undefined;
}

function findDescendantByAttribute(
	element: ReturnType<typeof createElement> | undefined,
	name: string,
	value?: string,
): ReturnType<typeof createElement> | undefined {
	if (!element) {
		return undefined;
	}

	const attributeValue = element.getAttribute(name);
	if (attributeValue !== null && (value === undefined || attributeValue === value)) {
		return element;
	}

	for (const child of element.children) {
		const match = findDescendantByAttribute(child, name, value);
		if (match) {
			return match;
		}
	}

	return undefined;
}

test('runtime script shows a user-facing error when login request fails', async () => {
	const { elements } = await createBrowserHarness({
		fetchImpl: async () => {
			throw new Error('network down');
		},
	});

	await elements.get('login-form')?.dispatch('submit');

	assert.equal(elements.get('login-error')?.textContent, 'Could not reach the server.');
});

test('runtime script validates a stored token before restoring the logged-in shell', async () => {
	const fetchCalls: string[] = [];
	const { elements, storage } = await createBrowserHarness({
		storedToken: 'stale-token',
		fetchImpl: async (input, init) => {
			fetchCalls.push(`${init?.method ?? 'GET'} ${input}`);
			return new Response('Unauthorized', { status: 401 });
		},
	});

	assert.deepEqual(fetchCalls, ['GET /app/status']);
	assert.equal(storage.has(AUTH_STORAGE_KEY), false);
	assert.equal(elements.get('login-screen')?.classList.contains('hidden'), false);
	assert.equal(elements.get('reader-shell')?.classList.contains('hidden'), true);
});

test('clear saved session cancels a pending startup validation and returns focus to the password field', async () => {
	const startupValidation = createDeferred<Response>();
	const { elements, storage, getActiveElement } = await createBrowserHarness({
		storedToken: 'stale-token',
		fetchImpl: async (input) => {
			if (input === '/app/status') {
				return startupValidation.promise;
			}

			throw new Error(`Unexpected fetch: GET ${input}`);
		},
	});

	await elements.get('clear-session-button')?.dispatch('click');

	assert.equal(storage.has(AUTH_STORAGE_KEY), false);
	assert.equal(elements.get('login-screen')?.classList.contains('hidden'), false);
	assert.equal(elements.get('reader-shell')?.classList.contains('hidden'), true);
	assert.equal(elements.get('login-error')?.textContent, 'Saved session cleared. Sign in again.');
	assert.equal(getActiveElement(), elements.get('password-input'));

	startupValidation.resolve(new Response('OK', { status: 200 }));
	await flushBrowserTasks();

	assert.equal(storage.has(AUTH_STORAGE_KEY), false);
	assert.equal(elements.get('login-screen')?.classList.contains('hidden'), false);
	assert.equal(elements.get('reader-shell')?.classList.contains('hidden'), true);
});

test('sign out remains available after an authenticated feed-loading error', async () => {
	const { elements, storage } = await createBrowserHarness({
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				return new Response('SID=pigeon/live-token\nLSID=null\nAuth=pigeon/live-token', { status: 200 });
			}

			if (input === '/reader/api/0/subscription/list') {
				throw new Error('feed service down');
			}

			if (input === '/reader/api/0/unread-count') {
				return Response.json({ unreadcounts: [] });
			}

			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});

	await elements.get('login-form')?.dispatch('submit');
	await flushBrowserTasks();

	assert.equal(storage.get(AUTH_STORAGE_KEY), 'live-token');
	assert.equal(elements.get('reader-shell')?.classList.contains('hidden'), false);
	assert.equal(elements.get('feeds-status')?.textContent, 'Could not load feeds.');

	await elements.get('logout-button')?.dispatch('click');

	assert.equal(storage.has(AUTH_STORAGE_KEY), false);
	assert.equal(elements.get('login-screen')?.classList.contains('hidden'), false);
	assert.equal(elements.get('reader-shell')?.classList.contains('hidden'), true);
});

test('startup token validation cannot overwrite a newer successful manual login', async () => {
	const startupValidation = createDeferred<Response>();
	const { elements, storage } = await createBrowserHarness({
		storedToken: 'stale-token',
		fetchImpl: async (input, init) => {
			if (input === '/app/status') {
				return startupValidation.promise;
			}

			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				return new Response('SID=pigeon/fresh-token\nLSID=null\nAuth=pigeon/fresh-token', {
					status: 200,
				});
			}

			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});

	await elements.get('login-form')?.dispatch('submit');
	await flushBrowserTasks();

	assert.equal(storage.get(AUTH_STORAGE_KEY), 'fresh-token');
	assert.equal(elements.get('login-screen')?.classList.contains('hidden'), true);
	assert.equal(elements.get('reader-shell')?.classList.contains('hidden'), false);

	startupValidation.resolve(new Response('Unauthorized', { status: 401 }));
	await flushBrowserTasks();

	assert.equal(storage.get(AUTH_STORAGE_KEY), 'fresh-token');
	assert.equal(elements.get('login-screen')?.classList.contains('hidden'), true);
	assert.equal(elements.get('reader-shell')?.classList.contains('hidden'), false);
});

test('startup validation request failure cannot overwrite a newer successful manual login', async () => {
	const startupValidation = createDeferred<Response>();
	const { elements, storage } = await createBrowserHarness({
		storedToken: 'stale-token',
		fetchImpl: async (input, init) => {
			if (input === '/app/status') {
				return startupValidation.promise;
			}

			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				return new Response('SID=pigeon/fresh-token\nLSID=null\nAuth=pigeon/fresh-token', {
					status: 200,
				});
			}

			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});

	await elements.get('login-form')?.dispatch('submit');
	await flushBrowserTasks();

	assert.equal(storage.get(AUTH_STORAGE_KEY), 'fresh-token');
	assert.equal(elements.get('login-screen')?.classList.contains('hidden'), true);
	assert.equal(elements.get('reader-shell')?.classList.contains('hidden'), false);

	startupValidation.reject(new Error('network down'));
	await flushBrowserTasks();

	assert.equal(storage.get(AUTH_STORAGE_KEY), 'fresh-token');
	assert.equal(elements.get('login-screen')?.classList.contains('hidden'), true);
	assert.equal(elements.get('reader-shell')?.classList.contains('hidden'), false);
});

test('runtime script keeps app chrome rendering out of innerHTML and shows the full settings fields', async () => {
	const { elements, innerHtmlWrites } = await createBrowserHarness({
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				return new Response('SID=pigeon/live-token\nLSID=null\nAuth=pigeon/live-token', { status: 200 });
			}

			if (input === '/reader/api/0/subscription/list') {
				return Response.json({
					subscriptions: [
						{ id: 'feed/2', title: 'Bravo', iconUrl: 'https://example.com/bravo.ico' },
						{ id: 'feed/1', title: 'Alpha' },
					],
				});
			}

			if (input === '/reader/api/0/unread-count') {
				return Response.json({
					unreadcounts: [
						{ id: 'feed/2', count: 4 },
						{ id: 'feed/1', count: 1 },
					],
				});
			}

			if (String(input).startsWith('/reader/api/0/stream/items/ids?')) {
				return Response.json({
					itemRefs: [{ id: '101' }, { id: '102' }],
				});
			}

			if (input === '/reader/api/0/stream/items/contents' && init?.method === 'POST') {
				return Response.json({
					items: [
						{
							id: 'tag:google.com,2005:reader/item/0000000000000065',
							title: 'First article',
							published: 1_742_460_800,
							origin: { title: 'Alpha' },
							summary: { content: 'Loaded preview' },
							content: { content: '<p>Body</p>' },
						},
					],
				});
			}

			if (input === '/app/status') {
				return Response.json({
					configuredBaseUrl: 'https://pigeon.example',
					currentOrigin: 'https://pigeon.example',
					healthUrl: 'https://pigeon.example/health',
					schemaVersion: '3',
					feeds: {
						activeCount: 2,
						emailCount: 1,
						rssCount: 1,
						failingRssCount: 1,
						failing: [{ title: 'Bravo', error: 'HTTP 500' }],
					},
					items: {
						totalCount: 12,
						unreadCount: 5,
						starredCount: 2,
						newestAt: '2026-03-20T12:00:00.000Z',
						newestEmailAt: '2026-03-20T11:00:00.000Z',
						newestRssAt: '2026-03-20T10:00:00.000Z',
					},
					rss: {
						latestFetchAttemptAt: '2026-03-20T12:05:00.000Z',
					},
				});
			}

			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});

	await elements.get('login-form')?.dispatch('submit');
	await flushBrowserTasks();
	await flushBrowserTasks();
	await elements.get('settings-button')?.dispatch('click');
	await flushBrowserTasks();
	await flushBrowserTasks();

	assert.deepEqual(
		innerHtmlWrites.filter((id) =>
			['views-list', 'folders-list', 'feeds-list', 'articles-list', 'settings-content'].includes(id),
		),
		[],
	);
	assert.match(elements.get('views-list')?.textContent ?? '', /All items/);
	assert.match(elements.get('views-list')?.textContent ?? '', /Unread/);
	assert.match(elements.get('views-list')?.textContent ?? '', /Today/);
	assert.match(elements.get('views-list')?.textContent ?? '', /Recently read/);
	assert.doesNotMatch(elements.get('views-list')?.textContent ?? '', /Alpha/);
	assert.doesNotMatch(elements.get('views-list')?.textContent ?? '', /Bravo/);
	assert.equal(elements.get('folders-list')?.textContent ?? '', '');
	assert.match(elements.get('feeds-list')?.textContent ?? '', /Alpha/);
	assert.match(elements.get('feeds-list')?.textContent ?? '', /Bravo/);
	assert.match(elements.get('feeds-list')?.textContent ?? '', /4/);
	assert.doesNotMatch(elements.get('feeds-list')?.textContent ?? '', /All items/);
	assert.doesNotMatch(elements.get('feeds-list')?.textContent ?? '', /Unread/);
	assert.match(elements.get('settings-content')?.textContent ?? '', /Starred items2/);
	assert.match(elements.get('settings-content')?.textContent ?? '', /Newest email item2026-03-20T11:00:00.000Z/);
	assert.match(elements.get('settings-content')?.textContent ?? '', /Newest RSS item2026-03-20T10:00:00.000Z/);
	assert.match(elements.get('settings-content')?.textContent ?? '', /Failing RSS feed count1/);
});

test('runtime script defaults to light mode, toggles dark mode, and restores the saved preference', async () => {
	const { elements, localStorageState, documentElementAttributes } = await createBrowserHarness();

	assert.equal(documentElementAttributes.get('data-theme'), 'light');
	assert.equal(elements.get('theme-toggle-button')?.textContent, 'Dark mode: Off');
	assert.equal(elements.get('theme-toggle-button')?.getAttribute('aria-pressed'), 'false');
	assert.equal(elements.get('reader-frame')?.srcdoc, createArticleFrameDocument(''));

	await elements.get('theme-toggle-button')?.dispatch('click');

	assert.equal(documentElementAttributes.get('data-theme'), 'dark');
	assert.equal(elements.get('theme-toggle-button')?.textContent, 'Dark mode: On');
	assert.equal(elements.get('theme-toggle-button')?.getAttribute('aria-pressed'), 'true');
	assert.equal(localStorageState.get(THEME_STORAGE_KEY), 'dark');
	assert.equal(elements.get('reader-frame')?.srcdoc, createArticleFrameDocument('', 'dark'));

	const restored = await createBrowserHarness({ storedTheme: 'dark' });
	assert.equal(restored.documentElementAttributes.get('data-theme'), 'dark');
	assert.equal(restored.elements.get('theme-toggle-button')?.textContent, 'Dark mode: On');
	assert.equal(restored.elements.get('theme-toggle-button')?.getAttribute('aria-pressed'), 'true');
	assert.equal(restored.elements.get('reader-frame')?.srcdoc, createArticleFrameDocument('', 'dark'));
});

test('runtime script toggles and restores title-only article list mode', async () => {
	const { elements, localStorageState } = await createBrowserHarness({
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				return new Response('SID=pigeon/live-token\nLSID=null\nAuth=pigeon/live-token', { status: 200 });
			}

			if (input === '/reader/api/0/subscription/list') {
				return Response.json({
					subscriptions: [{ id: 'feed/1', title: 'Alpha' }],
				});
			}

			if (input === '/reader/api/0/unread-count') {
				return Response.json({
					unreadcounts: [{ id: 'feed/1', count: 1 }],
				});
			}

			if (String(input).startsWith('/reader/api/0/stream/items/ids?')) {
				return Response.json({
					itemRefs: [{ id: '301' }],
				});
			}

			if (input === '/reader/api/0/stream/items/contents' && init?.method === 'POST') {
				return Response.json({
					items: [
						{
							id: 'tag:google.com,2005:reader/item/000000000000012d',
							title: 'Title-only article',
							published: 1_742_460_800,
							origin: { title: 'Alpha' },
							summary: { content: 'This preview should disappear.' },
							content: { content: '<p>Body</p><img src="https://cdn.example/hidden.jpg" />' },
						},
					],
				});
			}

			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});

	assert.equal(elements.get('article-list-mode-button')?.textContent, 'Title-only list: Off');
	assert.equal(elements.get('article-list-mode-button')?.getAttribute('aria-pressed'), 'false');

	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() =>
		Boolean(findDescendantByClass(findListButtonByItemId(elements.get('articles-list'), '301'), 'article-preview')),
	);

	await elements.get('article-list-mode-button')?.dispatch('click');
	const titleOnlyCard = findListButtonByItemId(elements.get('articles-list'), '301');

	assert.equal(elements.get('article-list-mode-button')?.textContent, 'Title-only list: On');
	assert.equal(elements.get('article-list-mode-button')?.getAttribute('aria-pressed'), 'true');
	assert.equal(localStorageState.get('pigeon.browser.article-list-mode'), 'titles');
	assert.ok(titleOnlyCard?.classList.contains('is-text-only'));
	assert.match(findDescendantByClass(titleOnlyCard, 'article-title')?.textContent ?? '', /Title-only article/);
	assert.equal(findDescendantByClass(titleOnlyCard, 'article-preview'), undefined);
	assert.equal(findDescendantByClass(titleOnlyCard, 'article-meta'), undefined);
	assert.equal(findDescendantByAttribute(titleOnlyCard, 'data-card-hero', 'true'), undefined);

	await elements.get('article-list-mode-button')?.dispatch('click');
	const previewCard = findListButtonByItemId(elements.get('articles-list'), '301');

	assert.equal(elements.get('article-list-mode-button')?.textContent, 'Title-only list: Off');
	assert.equal(elements.get('article-list-mode-button')?.getAttribute('aria-pressed'), 'false');
	assert.equal(localStorageState.get('pigeon.browser.article-list-mode'), 'preview');
	assert.match(findDescendantByClass(previewCard, 'article-preview')?.textContent ?? '', /This preview should disappear/);
	assert.match(findDescendantByClass(previewCard, 'article-meta')?.textContent ?? '', /Alpha/);
	assert.equal(
		findDescendantByAttribute(previewCard, 'data-card-hero', 'true')?.getAttribute('src'),
		'https://cdn.example/hidden.jpg',
	);

	const restored = await createBrowserHarness({ storedArticleListMode: 'titles' });
	assert.equal(restored.elements.get('article-list-mode-button')?.textContent, 'Title-only list: On');
	assert.equal(restored.elements.get('article-list-mode-button')?.getAttribute('aria-pressed'), 'true');
});

test('runtime script renders hero-image cards only for loaded articles whose content includes one', async () => {
	const { elements } = await createBrowserHarness({
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				return new Response('SID=pigeon/live-token\nLSID=null\nAuth=pigeon/live-token', { status: 200 });
			}

			if (input === '/reader/api/0/subscription/list') {
				return Response.json({
					subscriptions: [{ id: 'feed/1', title: 'Alpha' }],
				});
			}

			if (input === '/reader/api/0/unread-count') {
				return Response.json({
					unreadcounts: [{ id: 'feed/1', count: 2 }],
				});
			}

			if (String(input).startsWith('/reader/api/0/stream/items/ids?')) {
				return Response.json({
					itemRefs: [{ id: '101' }, { id: '102' }],
				});
			}

			if (input === '/reader/api/0/stream/items/contents' && init?.method === 'POST') {
				return Response.json({
					items: [
						{
							id: 'tag:google.com,2005:reader/item/0000000000000065',
							title: 'Hero story',
							published: 1_742_460_800,
							origin: { title: 'Alpha' },
							summary: { content: 'Hero preview' },
							content: { content: '<p>Body</p><img src="https://cdn.example/hero.jpg" />' },
						},
						{
							id: 'tag:google.com,2005:reader/item/0000000000000066',
							title: 'Text story',
							published: 1_742_460_860,
							origin: { title: 'Alpha' },
							summary: { content: 'Text preview' },
							content: { content: '<p>Body only</p>' },
						},
					],
				});
			}

			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});

	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() =>
		findDescendantByAttribute(findListButtonByItemId(elements.get('articles-list'), '101'), 'data-card-hero', 'true')?.getAttribute('src') ===
		'https://cdn.example/hero.jpg',
	);

	const heroCard = findListButtonByItemId(elements.get('articles-list'), '101');
	const textOnlyCard = findListButtonByItemId(elements.get('articles-list'), '102');

	assert.equal(
		findDescendantByAttribute(heroCard, 'data-card-hero', 'true')?.getAttribute('src'),
		'https://cdn.example/hero.jpg',
	);
	assert.equal(findDescendantByAttribute(textOnlyCard, 'data-card-hero', 'true'), undefined);
});

test('runtime script falls back to a text-first card layout and keeps preview metadata visible when no image is available', async () => {
	const { elements } = await createBrowserHarness({
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				return new Response('SID=pigeon/live-token\nLSID=null\nAuth=pigeon/live-token', { status: 200 });
			}

			if (input === '/reader/api/0/subscription/list') {
				return Response.json({
					subscriptions: [{ id: 'feed/1', title: 'Alpha' }],
				});
			}

			if (input === '/reader/api/0/unread-count') {
				return Response.json({
					unreadcounts: [{ id: 'feed/1', count: 1 }],
				});
			}

			if (String(input).startsWith('/reader/api/0/stream/items/ids?')) {
				return Response.json({
					itemRefs: [{ id: '201' }],
				});
			}

			if (input === '/reader/api/0/stream/items/contents' && init?.method === 'POST') {
				return Response.json({
					items: [
						{
							id: 'tag:google.com,2005:reader/item/00000000000000c9',
							title: 'Text-first article',
							published: 1_742_460_800,
							origin: { title: 'Alpha' },
							summary: { content: 'Preview stays visible' },
							content: { content: '<p>No image here.</p>' },
						},
					],
				});
			}

			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});

	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => Boolean(findListButtonByItemId(elements.get('articles-list'), '201')));

	const articleCard = findListButtonByItemId(elements.get('articles-list'), '201');

	assert.ok(articleCard?.classList.contains('is-text-only'));
	assert.equal(findDescendantByAttribute(articleCard, 'data-card-hero', 'true'), undefined);
	assert.match(findDescendantByClass(articleCard, 'article-title')?.textContent ?? '', /Text-first article/);
	assert.match(findDescendantByClass(articleCard, 'article-preview')?.textContent ?? '', /Preview stays visible/);
	assert.match(findDescendantByClass(articleCard, 'article-meta')?.textContent ?? '', /Alpha/);
	assert.match(findDescendantByClass(articleCard, 'article-meta')?.textContent ?? '', /\d{1,2}:\d{2}/);
});

test('runtime script keeps real views and real feeds separated with intact counts', async () => {
	const { elements } = await createBrowserHarness({
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				return new Response('SID=pigeon/live-token\nLSID=null\nAuth=pigeon/live-token', { status: 200 });
			}

			if (input === '/reader/api/0/subscription/list') {
				return Response.json({
					subscriptions: [
						{ id: 'feed/2', title: 'Bravo' },
						{ id: 'feed/1', title: 'Alpha' },
					],
				});
			}

			if (input === '/reader/api/0/unread-count') {
				return Response.json({
					unreadcounts: [
						{ id: 'feed/2', count: 4 },
						{ id: 'feed/1', count: 1 },
					],
				});
			}

			if (String(input).startsWith('/reader/api/0/stream/items/ids?')) {
				return Response.json({
					itemRefs: [{ id: '101' }],
				});
			}

			if (input === '/reader/api/0/stream/items/contents' && init?.method === 'POST') {
				return Response.json({
					items: [
						{
							id: 'tag:google.com,2005:reader/item/0000000000000065',
							title: 'First article',
							published: 1_742_460_800,
							origin: { title: 'Alpha' },
							summary: { content: 'Loaded preview' },
							content: { content: '<p>Body</p>' },
						},
					],
				});
			}

			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});

	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => Boolean(findListButtonByViewId(elements.get('feeds-list'), 'feed/2')));

	assert.match(findListButtonByViewId(elements.get('views-list'), 'all')?.textContent ?? '', /All items/);
	assert.match(findListButtonByViewId(elements.get('views-list'), 'all')?.textContent ?? '', /5/);
	assert.match(findListButtonByViewId(elements.get('views-list'), 'unread')?.textContent ?? '', /Unread/);
	assert.match(findListButtonByViewId(elements.get('views-list'), 'unread')?.textContent ?? '', /5/);
	assert.match(findListButtonByViewId(elements.get('views-list'), 'today')?.textContent ?? '', /Today/);
	assert.match(findListButtonByViewId(elements.get('views-list'), 'recent')?.textContent ?? '', /Recently read/);
	assert.equal(findListButtonByViewId(elements.get('views-list'), 'feed/1'), undefined);
	assert.equal(findListButtonByViewId(elements.get('views-list'), 'feed/2'), undefined);
	assert.equal(findListButtonByViewId(elements.get('folders-list'), 'feed/1'), undefined);
	assert.equal(findListButtonByViewId(elements.get('folders-list'), 'feed/2'), undefined);
	assert.match(findListButtonByViewId(elements.get('feeds-list'), 'feed/1')?.textContent ?? '', /Alpha/);
	assert.match(findListButtonByViewId(elements.get('feeds-list'), 'feed/1')?.textContent ?? '', /1/);
	assert.match(findListButtonByViewId(elements.get('feeds-list'), 'feed/2')?.textContent ?? '', /Bravo/);
	assert.match(findListButtonByViewId(elements.get('feeds-list'), 'feed/2')?.textContent ?? '', /4/);
	assert.equal(findListButtonByViewId(elements.get('feeds-list'), 'all'), undefined);
	assert.equal(findListButtonByViewId(elements.get('feeds-list'), 'unread'), undefined);
});

test('runtime Today view filters received timestamps in the local day and stops at the older page', async () => {
	const now = new Date(2026, 2, 20, 12, 0, 0, 0).getTime();
	const bounds = getLocalDayBounds(new Date(now));
	const contentFor = (id: string, title: string, published: number) => ({
		id: `tag:google.com,2005:reader/item/${Number(id).toString(16).padStart(16, '0')}`,
		title,
		published,
		origin: { title: 'Alpha' },
		summary: { content: `${title} preview` },
		content: { content: `<p>${title} body</p>` },
	});
	const contentById = {
		'1': contentFor('1', 'Previous-day article', bounds.startSeconds - 1),
		'2': contentFor('2', 'At-midnight article', bounds.startSeconds),
		'3': contentFor('3', 'Same-day article', bounds.endSeconds - 1),
		'4': contentFor('4', 'Next-day article', bounds.endSeconds),
	};
	const idRequests: Array<string | null> = [];
	const { elements } = await createBrowserHarness({
		now,
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				return new Response('SID=pigeon/live-token\nLSID=null\nAuth=pigeon/live-token', { status: 200 });
			}

			if (input === '/reader/api/0/subscription/list') {
				return Response.json({ subscriptions: [{ id: 'feed/1', title: 'Alpha' }] });
			}

			if (input === '/reader/api/0/unread-count') {
				return Response.json({ unreadcounts: [{ id: 'feed/1', count: 1 }] });
			}

			if (String(input).startsWith('/reader/api/0/stream/items/ids?')) {
				const url = new URL(`https://pigeon.example${String(input)}`);
				const continuation = url.searchParams.get('c');
				idRequests.push(continuation);
				return continuation
					? Response.json({ itemRefs: [{ id: '1' }] })
					: Response.json({
							itemRefs: [{ id: '4' }, { id: '3' }, { id: '2' }],
							continuation: 'older-page',
						});
			}

			if (input === '/reader/api/0/stream/items/contents' && init?.method === 'POST') {
				const ids = [...(init.body?.getAll('i') ?? [])].map(String);
				return Response.json({ items: ids.map((id) => contentById[id as keyof typeof contentById]) });
			}

			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});

	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => Boolean(findListButtonByViewId(elements.get('views-list'), 'today')));

	await findListButtonByViewId(elements.get('views-list'), 'today')?.dispatch('click');
	await waitForBrowserCondition(
		() =>
			(elements.get('articles-heading')?.textContent ?? '') === 'Today' &&
			elements.get('articles-list')?.children.length === 2,
	);

	assert.deepEqual(idRequests, [null, null, 'older-page']);
	assert.equal(elements.get('articles-status')?.textContent, '2 articles');
	assert.equal(findListButtonByItemId(elements.get('articles-list'), '1'), undefined);
	assert.ok(findListButtonByItemId(elements.get('articles-list'), '2'));
	assert.ok(findListButtonByItemId(elements.get('articles-list'), '3'));
	assert.equal(findListButtonByItemId(elements.get('articles-list'), '4'), undefined);
	assert.equal(elements.get('reader-title')?.textContent, 'Same-day article');

	await findListButtonByItemId(elements.get('articles-list'), '2')?.dispatch('click');
	assert.equal(elements.get('reader-title')?.textContent, 'At-midnight article');
});

test('runtime script hides all-read feeds when the unread filter is active', async () => {
	const { elements } = await createBrowserHarness({
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				return new Response('SID=pigeon/live-token\nLSID=null\nAuth=pigeon/live-token', { status: 200 });
			}

			if (input === '/reader/api/0/subscription/list') {
				return Response.json({
					subscriptions: [
						{ id: 'feed/1', title: 'Read Inbox' },
						{ id: 'feed/2', title: 'Unread Inbox' },
						{
							id: 'feed/3',
							title: 'Read Folder Feed',
							categories: [{ id: 'user/-/label/Newsletters', label: 'Newsletters' }],
						},
						{
							id: 'feed/4',
							title: 'Unread Folder Feed',
							categories: [{ id: 'user/-/label/Newsletters', label: 'Newsletters' }],
						},
					],
				});
			}

			if (input === '/reader/api/0/unread-count') {
				return Response.json({
					unreadcounts: [
						{ id: 'feed/1', count: 0 },
						{ id: 'feed/2', count: 2 },
						{ id: 'feed/3', count: 0 },
						{ id: 'feed/4', count: 3 },
					],
				});
			}

			if (String(input).startsWith('/reader/api/0/stream/items/ids?')) {
				return Response.json({
					itemRefs: [{ id: '101' }],
				});
			}

			if (input === '/reader/api/0/stream/items/contents' && init?.method === 'POST') {
				return Response.json({
					items: [
						{
							id: 'tag:google.com,2005:reader/item/0000000000000065',
							title: 'Unread article',
							published: 1_742_460_800,
							origin: { title: 'Unread Inbox' },
							summary: { content: 'Unread preview' },
							content: { content: '<p>Body</p>' },
						},
					],
				});
			}

			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});

	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => Boolean(findListButtonByViewId(elements.get('feeds-list'), 'feed/2')));

	assert.match(findListButtonByViewId(elements.get('feeds-list'), 'feed/1')?.textContent ?? '', /Read Inbox/);
	assert.match(findListButtonByViewId(elements.get('feeds-list'), 'feed/1')?.textContent ?? '', /0/);
	assert.match(findListButtonByViewId(elements.get('feeds-list'), 'feed/2')?.textContent ?? '', /Unread Inbox/);
	assert.match(findListButtonByViewId(elements.get('feeds-list'), 'feed/2')?.textContent ?? '', /2/);

	await findFolderToggleButton(elements.get('folders-list'), 'user/-/label/Newsletters')?.dispatch('click');
	await waitForBrowserCondition(() =>
		Boolean(findListButtonByViewId(elements.get('folders-list'), 'feed/3')) &&
		Boolean(findListButtonByViewId(elements.get('folders-list'), 'feed/4')),
	);

	await findListButtonByViewId(elements.get('views-list'), 'unread')?.dispatch('click');
	await waitForBrowserCondition(() => (elements.get('articles-heading')?.textContent ?? '') === 'Unread');

	assert.equal(findListButtonByViewId(elements.get('feeds-list'), 'feed/1'), undefined);
	assert.match(findListButtonByViewId(elements.get('feeds-list'), 'feed/2')?.textContent ?? '', /Unread Inbox/);
	assert.equal(findListButtonByViewId(elements.get('folders-list'), 'feed/3'), undefined);
	assert.match(findListButtonByViewId(elements.get('folders-list'), 'feed/4')?.textContent ?? '', /Unread Folder Feed/);
	assert.match(elements.get('feeds-status')?.textContent ?? '', /Uncategorized feeds/);
});

test('runtime unread filtering hides empty folders and restores the full library after view transitions', async () => {
	const { elements } = await createBrowserHarness({
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				return new Response('SID=pigeon/live-token\nLSID=null\nAuth=pigeon/live-token', { status: 200 });
			}

			if (input === '/reader/api/0/subscription/list') {
				return Response.json({
					subscriptions: [
						{ id: 'feed/1', title: 'Read Inbox' },
						{ id: 'feed/2', title: 'Unread Inbox' },
						{
							id: 'feed/3',
							title: 'Read Folder Feed',
							categories: [{ id: 'user/-/label/Newsletters', label: 'Newsletters' }],
						},
						{
							id: 'feed/4',
							title: 'Unread Folder Feed',
							categories: [{ id: 'user/-/label/Newsletters', label: 'Newsletters' }],
						},
						{
							id: 'feed/5',
							title: 'Empty Folder Feed',
							categories: [{ id: 'user/-/label/Read Only', label: 'Read Only' }],
						},
					],
				});
			}

			if (input === '/reader/api/0/unread-count') {
				return Response.json({
					unreadcounts: [
						{ id: 'feed/1', count: 0 },
						{ id: 'feed/2', count: 2 },
						{ id: 'feed/3', count: 0 },
						{ id: 'feed/4', count: 3 },
						{ id: 'feed/5', count: 0 },
					],
				});
			}

			if (String(input).startsWith('/reader/api/0/stream/items/ids?')) {
				return Response.json({ itemRefs: [] });
			}

			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});

	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => Boolean(findListButtonByViewId(elements.get('feeds-list'), 'feed/2')));

	assert.match(findListButtonByViewId(elements.get('folders-list'), 'user/-/label/Newsletters')?.textContent ?? '', /Newsletters/);
	assert.match(findListButtonByViewId(elements.get('folders-list'), 'user/-/label/Read Only')?.textContent ?? '', /Read Only/);
	await findFolderToggleButton(elements.get('folders-list'), 'user/-/label/Newsletters')?.dispatch('click');
	await waitForBrowserCondition(() => Boolean(findListButtonByViewId(elements.get('folders-list'), 'feed/4')));

	await findListButtonByViewId(elements.get('views-list'), 'unread')?.dispatch('click');
	await waitForBrowserCondition(() => (elements.get('articles-heading')?.textContent ?? '') === 'Unread');
	assert.equal(findListButtonByViewId(elements.get('feeds-list'), 'feed/1'), undefined);
	assert.equal(findListButtonByViewId(elements.get('folders-list'), 'user/-/label/Read Only'), undefined);
	assert.equal(findListButtonByViewId(elements.get('folders-list'), 'feed/3'), undefined);
	assert.ok(findListButtonByViewId(elements.get('feeds-list'), 'feed/2'));
	assert.ok(findListButtonByViewId(elements.get('folders-list'), 'feed/4'));

	await findListButtonByViewId(elements.get('folders-list'), 'user/-/label/Newsletters')?.dispatch('click');
	await waitForBrowserCondition(() => (elements.get('articles-heading')?.textContent ?? '') === 'Newsletters');
	assert.ok(findListButtonByViewId(elements.get('feeds-list'), 'feed/1'));
	assert.ok(findListButtonByViewId(elements.get('folders-list'), 'user/-/label/Read Only'));
	assert.ok(findListButtonByViewId(elements.get('folders-list'), 'feed/3'));

	await findListButtonByViewId(elements.get('views-list'), 'unread')?.dispatch('click');
	await waitForBrowserCondition(() => (elements.get('articles-heading')?.textContent ?? '') === 'Unread');
	assert.equal(findListButtonByViewId(elements.get('feeds-list'), 'feed/1'), undefined);
	assert.equal(findListButtonByViewId(elements.get('folders-list'), 'user/-/label/Read Only'), undefined);

	await findListButtonByViewId(elements.get('views-list'), 'all')?.dispatch('click');
	await waitForBrowserCondition(() => (elements.get('articles-heading')?.textContent ?? '') === 'All items');
	assert.ok(findListButtonByViewId(elements.get('feeds-list'), 'feed/1'));
	assert.ok(findListButtonByViewId(elements.get('folders-list'), 'user/-/label/Read Only'));

	await findListButtonByViewId(elements.get('views-list'), 'unread')?.dispatch('click');
	await waitForBrowserCondition(() => (elements.get('articles-heading')?.textContent ?? '') === 'Unread');
	assert.equal(findListButtonByViewId(elements.get('feeds-list'), 'feed/1'), undefined);

	await findListButtonByViewId(elements.get('views-list'), 'recent')?.dispatch('click');
	await waitForBrowserCondition(() => (elements.get('articles-heading')?.textContent ?? '') === 'Recently read');
	assert.ok(findListButtonByViewId(elements.get('feeds-list'), 'feed/1'));
	assert.ok(findListButtonByViewId(elements.get('folders-list'), 'user/-/label/Read Only'));

	await findListButtonByViewId(elements.get('views-list'), 'unread')?.dispatch('click');
	await waitForBrowserCondition(() => (elements.get('articles-heading')?.textContent ?? '') === 'Unread');
	assert.equal(findListButtonByViewId(elements.get('feeds-list'), 'feed/1'), undefined);

	await findListButtonByViewId(elements.get('feeds-list'), 'feed/2')?.dispatch('click');
	await waitForBrowserCondition(() => (elements.get('articles-heading')?.textContent ?? '') === 'Unread Inbox');
	assert.ok(findListButtonByViewId(elements.get('feeds-list'), 'feed/1'));
	assert.ok(findListButtonByViewId(elements.get('folders-list'), 'user/-/label/Read Only'));
});

test('runtime unread filtering renders empty folder and feed states when every count is zero', async () => {
	const { elements } = await createBrowserHarness({
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				return new Response('SID=pigeon/live-token\nLSID=null\nAuth=pigeon/live-token', { status: 200 });
			}

			if (input === '/reader/api/0/subscription/list') {
				return Response.json({
					subscriptions: [
						{ id: 'feed/1', title: 'Read Inbox' },
						{
							id: 'feed/2',
							title: 'Read Folder Feed',
							categories: [{ id: 'user/-/label/Read Only', label: 'Read Only' }],
						},
					],
				});
			}

			if (input === '/reader/api/0/unread-count') {
				return Response.json({ unreadcounts: [{ id: 'feed/1', count: 0 }, { id: 'feed/2', count: 0 }] });
			}

			if (String(input).startsWith('/reader/api/0/stream/items/ids?')) {
				return Response.json({ itemRefs: [] });
			}

			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});

	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => Boolean(findListButtonByViewId(elements.get('feeds-list'), 'feed/1')));
	await findListButtonByViewId(elements.get('views-list'), 'unread')?.dispatch('click');
	await waitForBrowserCondition(() => (elements.get('articles-heading')?.textContent ?? '') === 'Unread');

	assert.equal(elements.get('folders-list')?.textContent, '');
	assert.equal(elements.get('feeds-list')?.textContent, '');
	assert.equal(elements.get('folders-status')?.textContent, 'No tagged feeds with unread items.');
	assert.equal(elements.get('feeds-status')?.textContent, 'No uncategorized feeds with unread items.');
});

test('runtime script lets column resizer drags persist reader column widths', async () => {
	const { elements, localStorageState, dispatchDocumentPointer } = await createBrowserHarness({
		storedToken: 'live-token',
		fetchImpl: async (input, init) => {
			if (input === '/app/status') {
				return new Response(null, { status: 200 });
			}

			if (input === '/reader/api/0/subscription/list') {
				return Response.json({ subscriptions: [] });
			}

			if (input === '/reader/api/0/unread-count') {
				return Response.json({ unreadcounts: [] });
			}

			if (String(input).startsWith('/reader/api/0/stream/items/ids?')) {
				return Response.json({ itemRefs: [] });
			}

			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});
	const grid = elements.get('reader-grid');
	const sidebarResizer = elements.get('sidebar-column-resizer');
	const dragStreamResizer = elements.get('stream-column-resizer');

	await waitForBrowserCondition(() => elements.get('reader-shell')?.classList.contains('hidden') === false);

	await sidebarResizer?.dispatch('pointerdown', { clientX: 400, pointerId: 1 });
	assert.ok(sidebarResizer?.classList.contains('is-dragging'));
	assert.equal(dispatchDocumentPointer('pointermove', 480), true);
	dispatchDocumentPointer('pointerup', 480);

	assert.equal(grid?.style.getPropertyValue('--sidebar-column-width'), '496px');
	assert.equal(sidebarResizer?.classList.contains('is-dragging'), false);
	assert.equal(JSON.parse(localStorageState.get('pigeon.browser.column-widths') ?? '{}').sidebar, 496);

	await dragStreamResizer?.dispatch('pointerdown', { clientX: 600, pointerId: 2 });
	assert.equal(dispatchDocumentPointer('pointermove', 560), true);
	dispatchDocumentPointer('pointerup', 560);

	assert.equal(grid?.style.getPropertyValue('--stream-column-width'), '484px');
	assert.deepEqual(JSON.parse(localStorageState.get('pigeon.browser.column-widths') ?? '{}'), {
		sidebar: 496,
		stream: 484,
	});
});

test('runtime script applies stored column widths only after the reader grid is visible', async () => {
	let harnessElements: Map<string, ReturnType<typeof createElement>> | null = null;
	const { elements, localStorageState } = await createBrowserHarness({
		storedColumnWidths: { sidebar: 520, stream: 640 },
		readerGridWidth: () => (harnessElements?.get('reader-shell')?.classList.contains('hidden') ? 0 : 900),
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				return new Response('SID=pigeon/live-token\nLSID=null\nAuth=pigeon/live-token', { status: 200 });
			}

			if (input === '/reader/api/0/subscription/list') {
				return Response.json({ subscriptions: [] });
			}

			if (input === '/reader/api/0/unread-count') {
				return Response.json({ unreadcounts: [] });
			}

			if (String(input).startsWith('/reader/api/0/stream/items/ids?')) {
				return Response.json({ itemRefs: [] });
			}

			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});
	harnessElements = elements;
	const grid = elements.get('reader-grid');

	assert.equal(grid?.style.getPropertyValue('--sidebar-column-width'), '');
	assert.equal(grid?.style.getPropertyValue('--stream-column-width'), '');
	assert.deepEqual(JSON.parse(localStorageState.get('pigeon.browser.column-widths') ?? '{}'), {
		sidebar: 520,
		stream: 640,
	});

	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => !elements.get('reader-shell')?.classList.contains('hidden'));

	assert.equal(grid?.style.getPropertyValue('--sidebar-column-width'), '224px');
	assert.equal(grid?.style.getPropertyValue('--stream-column-width'), '340px');
	assert.deepEqual(JSON.parse(localStorageState.get('pigeon.browser.column-widths') ?? '{}'), {
		sidebar: 520,
		stream: 640,
	});
});

test('runtime script does not overwrite saved column widths during responsive window resizes', async () => {
	let readerGridWidth = 1440;
	const { elements, localStorageState, dispatchWindowEvent } = await createBrowserHarness({
		storedColumnWidths: { sidebar: 496, stream: 484 },
		readerGridWidth: () => readerGridWidth,
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				return new Response('SID=pigeon/live-token\nLSID=null\nAuth=pigeon/live-token', { status: 200 });
			}

			if (input === '/reader/api/0/subscription/list') {
				return Response.json({ subscriptions: [] });
			}

			if (input === '/reader/api/0/unread-count') {
				return Response.json({ unreadcounts: [] });
			}

			if (String(input).startsWith('/reader/api/0/stream/items/ids?')) {
				return Response.json({ itemRefs: [] });
			}

			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});
	const grid = elements.get('reader-grid');

	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => grid?.style.getPropertyValue('--sidebar-column-width') === '496px');

	readerGridWidth = 1000;
	dispatchWindowEvent('resize');
	assert.equal(grid?.style.getPropertyValue('--sidebar-column-width'), '224px');
	assert.equal(grid?.style.getPropertyValue('--stream-column-width'), '440px');
	assert.deepEqual(JSON.parse(localStorageState.get('pigeon.browser.column-widths') ?? '{}'), {
		sidebar: 496,
		stream: 484,
	});

	readerGridWidth = 1440;
	dispatchWindowEvent('resize');
	assert.equal(grid?.style.getPropertyValue('--sidebar-column-width'), '496px');
	assert.equal(grid?.style.getPropertyValue('--stream-column-width'), '484px');
	assert.deepEqual(JSON.parse(localStorageState.get('pigeon.browser.column-widths') ?? '{}'), {
		sidebar: 496,
		stream: 484,
	});
});

test('runtime script lets keyboard users resize columns and exposes separator values', async () => {
	const { elements, localStorageState } = await createBrowserHarness({
		storedToken: 'live-token',
		fetchImpl: async (input, init) => {
			if (input === '/app/status') {
				return new Response(null, { status: 200 });
			}

			if (input === '/reader/api/0/subscription/list') {
				return Response.json({ subscriptions: [] });
			}

			if (input === '/reader/api/0/unread-count') {
				return Response.json({ unreadcounts: [] });
			}

			if (String(input).startsWith('/reader/api/0/stream/items/ids?')) {
				return Response.json({ itemRefs: [] });
			}

			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});
	const grid = elements.get('reader-grid');
	const sidebarResizer = elements.get('sidebar-column-resizer');
	const keyboardStreamResizer = elements.get('stream-column-resizer');

	await waitForBrowserCondition(() => elements.get('reader-shell')?.classList.contains('hidden') === false);

	assert.equal(sidebarResizer?.hasEventListener('keydown'), true);
	assert.equal(sidebarResizer?.getAttribute('aria-valuenow'), '416');
	await sidebarResizer?.dispatch('keydown', {
		key: 'ArrowRight',
		preventDefault() {},
	});

	assert.equal(grid?.style.getPropertyValue('--sidebar-column-width'), '432px');
	assert.equal(grid?.style.getPropertyValue('--stream-column-width'), '524px');
	assert.equal(sidebarResizer?.getAttribute('aria-valuemin'), '224');
	assert.equal(sidebarResizer?.getAttribute('aria-valuemax'), '520');
	assert.equal(sidebarResizer?.getAttribute('aria-valuenow'), '432');
	assert.equal(sidebarResizer?.getAttribute('aria-valuetext'), '432 pixels');
	assert.deepEqual(JSON.parse(localStorageState.get('pigeon.browser.column-widths') ?? '{}'), {
		sidebar: 432,
		stream: 524,
	});

	await keyboardStreamResizer?.dispatch('keydown', {
		key: 'ArrowLeft',
		preventDefault() {},
	});

	assert.equal(grid?.style.getPropertyValue('--stream-column-width'), '508px');
	assert.equal(keyboardStreamResizer?.getAttribute('aria-valuemin'), '288');
	assert.equal(keyboardStreamResizer?.getAttribute('aria-valuemax'), '640');
	assert.equal(keyboardStreamResizer?.getAttribute('aria-valuenow'), '508');
	assert.deepEqual(JSON.parse(localStorageState.get('pigeon.browser.column-widths') ?? '{}'), {
		sidebar: 432,
		stream: 508,
	});

	await sidebarResizer?.dispatch('keydown', {
		key: 'Home',
		preventDefault() {},
	});

	assert.equal(grid?.style.getPropertyValue('--sidebar-column-width'), '224px');
	assert.equal(sidebarResizer?.getAttribute('aria-valuenow'), '224');
	assert.deepEqual(JSON.parse(localStorageState.get('pigeon.browser.column-widths') ?? '{}'), {
		sidebar: 224,
		stream: 508,
	});
});

test('runtime script expands folder feeds and requests the folder label stream when selected', async () => {
	const streamRequests: string[] = [];
	const { elements } = await createBrowserHarness({
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				return new Response('SID=pigeon/live-token\nLSID=null\nAuth=pigeon/live-token', { status: 200 });
			}

			if (input === '/reader/api/0/subscription/list') {
				return Response.json({
					subscriptions: [
						{
							id: 'feed/1',
							title: 'Alpha',
							categories: [{ id: 'user/-/label/Daily Reads', label: 'Daily Reads' }],
						},
						{
							id: 'feed/2',
							title: 'Bravo',
							categories: [{ id: 'user/-/label/Daily Reads', label: 'Daily Reads' }],
						},
						{ id: 'feed/3', title: 'Charlie' },
					],
				});
			}

			if (input === '/reader/api/0/unread-count') {
				return Response.json({
					unreadcounts: [
						{ id: 'feed/1', count: 2 },
						{ id: 'feed/2', count: 1 },
						{ id: 'feed/3', count: 4 },
					],
				});
			}

			if (String(input).startsWith('/reader/api/0/stream/items/ids?')) {
				streamRequests.push(String(input));
				return Response.json({
					itemRefs: [{ id: '101' }],
				});
			}

			if (input === '/reader/api/0/stream/items/contents' && init?.method === 'POST') {
				return Response.json({
					items: [
						{
							id: 'tag:google.com,2005:reader/item/0000000000000065',
							title: 'Folder article',
							published: 1_742_460_800,
							origin: { title: 'Alpha' },
							summary: { content: 'Loaded preview' },
							content: { content: '<p>Body</p>' },
						},
					],
				});
			}

			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});

	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => Boolean(findListButtonByViewId(elements.get('folders-list'), 'user/-/label/Daily Reads')));

	assert.match(findListButtonByViewId(elements.get('folders-list'), 'user/-/label/Daily Reads')?.textContent ?? '', /Daily Reads/);
	assert.match(findListButtonByViewId(elements.get('folders-list'), 'user/-/label/Daily Reads')?.textContent ?? '', /3/);
	assert.equal(findListButtonByViewId(elements.get('folders-list'), 'feed/1'), undefined);
	assert.match(findListButtonByViewId(elements.get('feeds-list'), 'feed/3')?.textContent ?? '', /Charlie/);
	assert.match(findListButtonByViewId(elements.get('feeds-list'), 'feed/3')?.textContent ?? '', /4/);

	await findListButtonByViewId(elements.get('folders-list'), 'user/-/label/Daily Reads')?.dispatch('click');
	const folderRequestUrl = new URL(`https://pigeon.example${streamRequests.at(-1) ?? ''}`);
	assert.equal(folderRequestUrl.searchParams.get('s'), 'user/-/label/Daily Reads');
	assert.equal(folderRequestUrl.searchParams.get('xt'), null);

	const requestCountBeforeToggle = streamRequests.length;
	await findFolderToggleButton(elements.get('folders-list'), 'user/-/label/Daily Reads')?.dispatch('click');
	await waitForBrowserCondition(() => Boolean(findListButtonByViewId(elements.get('folders-list'), 'feed/1')));
	assert.equal(streamRequests.length, requestCountBeforeToggle);
	assert.match(findListButtonByViewId(elements.get('folders-list'), 'feed/1')?.textContent ?? '', /Alpha/);
	assert.match(findListButtonByViewId(elements.get('folders-list'), 'feed/2')?.textContent ?? '', /Bravo/);
	assert.doesNotMatch(findListButtonByViewId(elements.get('folders-list'), 'feed/1')?.textContent ?? '', /Daily Reads/);
	assert.doesNotMatch(findListButtonByViewId(elements.get('folders-list'), 'feed/2')?.textContent ?? '', /Daily Reads/);

	await findFolderToggleButton(elements.get('folders-list'), 'user/-/label/Daily Reads')?.dispatch('click');
	await waitForBrowserCondition(() => !findListButtonByViewId(elements.get('folders-list'), 'feed/1'));
});

test('stale status responses do not overwrite logout state or suppress a later settings fetch', async () => {
	const firstStatus = createDeferred<Response>();
	const statusCalls: string[] = [];
	let loginCount = 0;
	const { elements } = await createBrowserHarness({
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				loginCount += 1;
				const token = loginCount === 1 ? 'first-token' : 'second-token';
				return new Response(`SID=pigeon/${token}\nLSID=null\nAuth=pigeon/${token}`, { status: 200 });
			}

			if (input === '/reader/api/0/subscription/list') {
				return Response.json({ subscriptions: [] });
			}

			if (input === '/reader/api/0/unread-count') {
				return Response.json({ unreadcounts: [] });
			}

			if (String(input).startsWith('/reader/api/0/stream/items/ids?')) {
				return Response.json({ itemRefs: [] });
			}

			if (input === '/app/status') {
				statusCalls.push(`status-${statusCalls.length + 1}`);
				if (statusCalls.length === 1) {
					return firstStatus.promise;
				}
				return Response.json({
					configuredBaseUrl: 'https://pigeon.example',
					currentOrigin: 'https://pigeon.example',
					healthUrl: 'https://pigeon.example/health',
					schemaVersion: '3',
					feeds: { activeCount: 0, emailCount: 0, rssCount: 0, failingRssCount: 0, failing: [] },
					items: {
						totalCount: 0,
						unreadCount: 0,
						starredCount: 0,
						newestAt: null,
						newestEmailAt: null,
						newestRssAt: null,
					},
					rss: { latestFetchAttemptAt: null },
				});
			}

			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});

	await elements.get('login-form')?.dispatch('submit');
	await flushBrowserTasks();
	await flushBrowserTasks();

	await elements.get('settings-button')?.dispatch('click');
	await flushBrowserTasks();

	await elements.get('logout-button')?.dispatch('click');
	firstStatus.resolve(
		Response.json({
			configuredBaseUrl: 'https://stale.example',
			currentOrigin: 'https://stale.example',
			healthUrl: 'https://stale.example/health',
			schemaVersion: '3',
			feeds: { activeCount: 9, emailCount: 9, rssCount: 9, failingRssCount: 9, failing: [] },
			items: {
				totalCount: 9,
				unreadCount: 9,
				starredCount: 9,
				newestAt: '2026-03-20T12:00:00.000Z',
				newestEmailAt: '2026-03-20T12:00:00.000Z',
				newestRssAt: '2026-03-20T12:00:00.000Z',
			},
			rss: { latestFetchAttemptAt: '2026-03-20T12:00:00.000Z' },
		}),
	);
	await flushBrowserTasks();
	await flushBrowserTasks();

	assert.equal(elements.get('settings-content')?.textContent, 'Open settings to load status.');

	await elements.get('login-form')?.dispatch('submit');
	await flushBrowserTasks();
	await flushBrowserTasks();
	await elements.get('settings-button')?.dispatch('click');
	await flushBrowserTasks();
	await flushBrowserTasks();

	assert.deepEqual(statusCalls, ['status-1', 'status-2']);
	assert.match(elements.get('settings-content')?.textContent ?? '', /Configured BASE_URLhttps:\/\/pigeon\.example/);
});

test('load-more does not duplicate an in-flight chunk and advances after the first chunk settles', async () => {
	const firstContentResponse = createDeferred<Response>();
	const contentRequests: string[][] = [];
	const { elements } = await createBrowserHarness({
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				return new Response('SID=pigeon/live-token\nLSID=null\nAuth=pigeon/live-token', { status: 200 });
			}

			if (input === '/reader/api/0/subscription/list') {
				return Response.json({
					subscriptions: [{ id: 'feed/1', title: 'Alpha' }],
				});
			}

			if (input === '/reader/api/0/unread-count') {
				return Response.json({
					unreadcounts: [{ id: 'feed/1', count: 25 }],
				});
			}

			if (String(input).startsWith('/reader/api/0/stream/items/ids?')) {
				return Response.json({
					itemRefs: Array.from({ length: 25 }, (_, index) => ({ id: String(index + 1) })),
				});
			}

			if (input === '/reader/api/0/stream/items/contents' && init?.method === 'POST') {
				const ids = Array.from((init.body as FormData).values()).map(String);
				contentRequests.push(ids);
				if (contentRequests.length === 1) {
					return firstContentResponse.promise;
				}
				return Response.json({
					items: ids.map((id) => ({
						id: `tag:google.com,2005:reader/item/${Number(id).toString(16).padStart(16, '0')}`,
						title: `Article ${id}`,
						published: 1_742_460_800,
						origin: { title: 'Alpha' },
						summary: { content: `Preview ${id}` },
						content: { content: `<p>Body ${id}</p>` },
					})),
				});
			}

			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});

	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => contentRequests.length === 1);
	const loadMoreToggleCalls = () =>
		elements.get('load-more-button')?.toggleCalls.filter((call) => call.name === 'hidden').map((call) => call.force) ?? [];

	assert.ok(loadMoreToggleCalls().includes(false));
	assert.equal(elements.get('load-more-button')?.disabled, true);
	assert.deepEqual(contentRequests, [Array.from({ length: 20 }, (_, index) => String(index + 1))]);

	await elements.get('load-more-button')?.dispatch('click');
	await flushBrowserTasks();
	await flushBrowserTasks();

	assert.deepEqual(contentRequests, [Array.from({ length: 20 }, (_, index) => String(index + 1))]);

	firstContentResponse.resolve(
		Response.json({
			items: Array.from({ length: 20 }, (_, index) => {
				const id = String(index + 1);
				return {
					id: `tag:google.com,2005:reader/item/${Number(id).toString(16).padStart(16, '0')}`,
					title: `Article ${id}`,
					published: 1_742_460_800,
					origin: { title: 'Alpha' },
					summary: { content: `Preview ${id}` },
					content: { content: `<p>Body ${id}</p>` },
				};
			}),
		}),
	);
	await waitForBrowserCondition(() => elements.get('load-more-button')?.disabled === false);

	await elements.get('load-more-button')?.dispatch('click');
	await waitForBrowserCondition(() => contentRequests.length === 2);

	assert.ok(loadMoreToggleCalls().filter((force) => force === false).length >= 2);
	assert.deepEqual(contentRequests[1], ['21', '22', '23', '24', '25']);
});

test('load-more fetches continuation pages beyond 50 items without duplicating boundary ids', async () => {
	const idRequests: Array<string | null> = [];
	const contentRequests: string[][] = [];
	const { elements } = await createBrowserHarness({
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				return new Response('SID=pigeon/live-token\nLSID=null\nAuth=pigeon/live-token', { status: 200 });
			}

			if (input === '/reader/api/0/subscription/list') {
				return Response.json({ subscriptions: [{ id: 'feed/1', title: 'Alpha' }] });
			}

			if (input === '/reader/api/0/unread-count') {
				return Response.json({ unreadcounts: [{ id: 'feed/1', count: 55 }] });
			}

			if (String(input).startsWith('/reader/api/0/stream/items/ids?')) {
				const url = new URL(`https://pigeon.example${String(input)}`);
				const continuation = url.searchParams.get('c');
				idRequests.push(continuation);
				if (!continuation) {
					return Response.json({
						itemRefs: Array.from({ length: 50 }, (_, index) => ({ id: String(index + 1) })),
						continuation: 'page-2',
					});
				}
				if (continuation === 'page-2') {
					return Response.json({
						itemRefs: [{ id: '50' }],
						continuation: 'page-3',
					});
				}
				assert.equal(continuation, 'page-3');
				return Response.json({
					itemRefs: Array.from({ length: 6 }, (_, index) => ({ id: String(index + 50) })),
				});
			}

			if (input === '/reader/api/0/stream/items/contents' && init?.method === 'POST') {
				const ids = Array.from((init.body as FormData).values()).map(String);
				contentRequests.push(ids);
				return Response.json({
					items: ids.map((id) => ({
						id: `tag:google.com,2005:reader/item/${Number(id).toString(16).padStart(16, '0')}`,
						title: `Article ${id}`,
						published: 1_742_460_800,
						origin: { title: 'Alpha' },
						summary: { content: `Preview ${id}` },
						content: { content: `<p>Body ${id}</p>` },
					})),
				});
			}

			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});

	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(
		() => contentRequests.length === 1 && elements.get('load-more-button')?.disabled === false,
	);
	await elements.get('load-more-button')?.dispatch('click');
	await waitForBrowserCondition(
		() => contentRequests.length === 2 && elements.get('load-more-button')?.disabled === false,
	);
	await elements.get('load-more-button')?.dispatch('click');
	await waitForBrowserCondition(
		() => contentRequests.length === 3 && elements.get('load-more-button')?.disabled === false,
	);
	await elements.get('load-more-button')?.dispatch('click');
	await elements.get('load-more-button')?.dispatch('click');
	await waitForBrowserCondition(
		() => idRequests.length === 2 && elements.get('load-more-button')?.disabled === false,
	);
	assert.equal(contentRequests.length, 3);
	assert.equal(elements.get('load-more-button')?.classList.contains('hidden'), false);

	await elements.get('load-more-button')?.dispatch('click');
	await elements.get('load-more-button')?.dispatch('click');
	await waitForBrowserCondition(() => idRequests.length === 3 && contentRequests.length === 4);

	assert.deepEqual(idRequests, [null, 'page-2', 'page-3']);
	assert.deepEqual(contentRequests[3], ['51', '52', '53', '54', '55']);
	assert.match(elements.get('articles-list')?.textContent ?? '', /Article 51/);
	assert.equal(elements.get('load-more-button')?.classList.contains('hidden'), true);
});

test('pagination stops when a duplicate-only page repeats its continuation token', async () => {
	const idRequests: Array<string | null> = [];
	const { elements } = await createBrowserHarness({
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				return new Response('SID=pigeon/live-token\nLSID=null\nAuth=pigeon/live-token', { status: 200 });
			}
			if (input === '/reader/api/0/subscription/list') {
				return Response.json({ subscriptions: [{ id: 'feed/1', title: 'Alpha' }] });
			}
			if (input === '/reader/api/0/unread-count') {
				return Response.json({ unreadcounts: [{ id: 'feed/1', count: 1 }] });
			}
			if (String(input).startsWith('/reader/api/0/stream/items/ids?')) {
				const url = new URL(`https://pigeon.example${String(input)}`);
				const continuation = url.searchParams.get('c');
				idRequests.push(continuation);
				return Response.json({
					itemRefs: [{ id: '1' }],
					continuation: 'same-page',
				});
			}
			if (input === '/reader/api/0/stream/items/contents' && init?.method === 'POST') {
				return Response.json({
					items: [
						{
							id: 'tag:google.com,2005:reader/item/0000000000000001',
							title: 'Article 1',
							published: 1_742_460_800,
							origin: { title: 'Alpha' },
							summary: { content: 'Preview 1' },
							content: { content: '<p>Body 1</p>' },
						},
					],
				});
			}
			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});

	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => elements.get('load-more-button')?.disabled === false);
	await elements.get('load-more-button')?.dispatch('click');
	await waitForBrowserCondition(
		() => idRequests.length === 2 && elements.get('load-more-button')?.classList.contains('hidden') === true,
	);
	await elements.get('load-more-button')?.dispatch('click');
	await flushBrowserTasks();

	assert.deepEqual(idRequests, [null, 'same-page']);
});

test('a stale continuation response cannot append items after switching views', async () => {
	const staleContinuationResponse = createDeferred<Response>();
	const contentRequests: string[][] = [];
	let continuationRequests = 0;
	const { elements } = await createBrowserHarness({
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				return new Response('SID=pigeon/live-token\nLSID=null\nAuth=pigeon/live-token', { status: 200 });
			}

			if (input === '/reader/api/0/subscription/list') {
				return Response.json({
					subscriptions: [
						{ id: 'feed/1', title: 'Alpha' },
						{ id: 'feed/2', title: 'Bravo' },
					],
				});
			}

			if (input === '/reader/api/0/unread-count') {
				return Response.json({
					unreadcounts: [
						{ id: 'feed/1', count: 2 },
						{ id: 'feed/2', count: 1 },
					],
				});
			}

			if (String(input).startsWith('/reader/api/0/stream/items/ids?')) {
				const url = new URL(`https://pigeon.example${String(input)}`);
				if (url.searchParams.get('s') === 'feed/2') {
					return Response.json({ itemRefs: [{ id: '301' }] });
				}
				if (url.searchParams.get('c')) {
					continuationRequests += 1;
					return staleContinuationResponse.promise;
				}
				return Response.json({ itemRefs: [{ id: '101' }], continuation: 'older-items' });
			}

			if (input === '/reader/api/0/stream/items/contents' && init?.method === 'POST') {
				const ids = Array.from((init.body as FormData).values()).map(String);
				contentRequests.push(ids);
				return Response.json({
					items: ids.map((id) => ({
						id: `tag:google.com,2005:reader/item/${Number(id).toString(16).padStart(16, '0')}`,
						title: `Article ${id}`,
						published: 1_742_460_800,
						origin: { title: id === '301' ? 'Bravo' : 'Alpha' },
						summary: { content: `Preview ${id}` },
						content: { content: `<p>Body ${id}</p>` },
					})),
				});
			}

			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});

	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => contentRequests.length === 1);
	await elements.get('load-more-button')?.dispatch('click');
	await waitForBrowserCondition(() => continuationRequests === 1);

	const bravoFeedButton = findListButtonByViewId(elements.get('feeds-list'), 'feed/2');
	await bravoFeedButton?.dispatch('click');
	await waitForBrowserCondition(() => contentRequests.some((ids) => ids.includes('301')));
	staleContinuationResponse.resolve(Response.json({ itemRefs: [{ id: '102' }] }));
	await flushBrowserTasks();
	await flushBrowserTasks();

	assert.match(elements.get('articles-list')?.textContent ?? '', /Article 301/);
	assert.doesNotMatch(elements.get('articles-list')?.textContent ?? '', /Article 102/);
});

test('switching views during an in-flight content load still fetches bodies for the new view', async () => {
	const allItemsContentResponse = createDeferred<Response>();
	const contentRequests: string[][] = [];
	const { elements } = await createBrowserHarness({
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				return new Response('SID=pigeon/live-token\nLSID=null\nAuth=pigeon/live-token', { status: 200 });
			}

			if (input === '/reader/api/0/subscription/list') {
				return Response.json({
					subscriptions: [
						{ id: 'feed/1', title: 'Alpha' },
						{ id: 'feed/2', title: 'Bravo' },
					],
				});
			}

			if (input === '/reader/api/0/unread-count') {
				return Response.json({
					unreadcounts: [
						{ id: 'feed/1', count: 1 },
						{ id: 'feed/2', count: 1 },
					],
				});
			}

			if (String(input).startsWith('/reader/api/0/stream/items/ids?')) {
				const url = new URL(`https://pigeon.example${String(input)}`);
				const streamId = url.searchParams.get('s');
				if (streamId === 'feed/2') {
					return Response.json({
						itemRefs: [{ id: '301' }],
					});
				}
				return Response.json({
					itemRefs: [{ id: '101' }, { id: '102' }],
				});
			}

			if (input === '/reader/api/0/stream/items/contents' && init?.method === 'POST') {
				const ids = Array.from((init.body as FormData).values()).map(String);
				contentRequests.push(ids);
				if (contentRequests.length === 1) {
					return allItemsContentResponse.promise;
				}
				return Response.json({
					items: ids.map((id) => ({
						id: `tag:google.com,2005:reader/item/${Number(id).toString(16).padStart(16, '0')}`,
						title: `Article ${id}`,
						published: 1_742_460_800,
						origin: { title: id === '301' ? 'Bravo' : 'Alpha' },
						summary: { content: `Preview ${id}` },
						content: { content: `<p>Body ${id}</p>` },
					})),
				});
			}

			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});

	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => contentRequests.length === 1);

	const feedsList = elements.get('feeds-list');
	const bravoFeedButton = findListButtonByViewId(feedsList, 'feed/2');
	await bravoFeedButton?.dispatch('click');
	await waitForBrowserCondition(() => contentRequests.length === 2);

	assert.deepEqual(contentRequests[0], ['101', '102']);
	assert.deepEqual(contentRequests[1], ['301']);
	assert.match(elements.get('reader-title')?.textContent ?? '', /Article 301/);
	assert.match(elements.get('reader-meta')?.textContent ?? '', /Bravo/);

	allItemsContentResponse.resolve(
		Response.json({
			items: [
				{
					id: 'tag:google.com,2005:reader/item/0000000000000065',
					title: 'Article 101',
					published: 1_742_460_800,
					origin: { title: 'Alpha' },
					summary: { content: 'Preview 101' },
					content: { content: '<p>Body 101</p>' },
				},
			],
		}),
	);
	await flushBrowserTasks();
	await flushBrowserTasks();

	assert.match(elements.get('articles-list')?.textContent ?? '', /Article 301/);
	assert.doesNotMatch(elements.get('reader-title')?.textContent ?? '', /Article 101/);
});

test('runtime script keeps the active article title and metadata outside the iframe while the iframe holds the full body', async () => {
	const articleBody = '<article><p>Full body copy that belongs in the frame.</p><p>Second paragraph.</p></article>';
	const { elements } = await createBrowserHarness({
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				return new Response('SID=pigeon/live-token\nLSID=null\nAuth=pigeon/live-token', { status: 200 });
			}

			if (input === '/reader/api/0/subscription/list') {
				return Response.json({
					subscriptions: [{ id: 'feed/1', title: 'Alpha' }],
				});
			}

			if (input === '/reader/api/0/unread-count') {
				return Response.json({
					unreadcounts: [{ id: 'feed/1', count: 1 }],
				});
			}

			if (String(input).startsWith('/reader/api/0/stream/items/ids?')) {
				return Response.json({
					itemRefs: [{ id: '101' }],
				});
			}

			if (input === '/reader/api/0/stream/items/contents' && init?.method === 'POST') {
				return Response.json({
					items: [
						{
							id: 'tag:google.com,2005:reader/item/0000000000000065',
							title: 'Reader polish story',
							published: 1_742_460_800,
							origin: { title: 'Alpha' },
							summary: { content: 'Short summary' },
							content: { content: articleBody },
						},
					],
				});
			}

			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});

	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(
		() => (elements.get('reader-frame')?.srcdoc ?? '') === createArticleFrameDocument(articleBody),
	);

	assert.match(elements.get('reader-title')?.textContent ?? '', /Reader polish story/);
	assert.match(elements.get('reader-meta')?.textContent ?? '', /Alpha/);
	assert.match(elements.get('reader-meta')?.textContent ?? '', /2025/);
	assert.equal(elements.get('reader-frame')?.srcdoc, createArticleFrameDocument(articleBody));
	assert.doesNotMatch(elements.get('reader-title')?.textContent ?? '', /Full body copy that belongs in the frame/);
	assert.doesNotMatch(elements.get('reader-meta')?.textContent ?? '', /Full body copy that belongs in the frame/);
});

test('runtime script re-renders the active article frame with dark styles when enabled', async () => {
	const articleBody = '<article><p>Frame content keeps links readable.</p><p><a href="https://example.com">Open original</a></p></article>';
	const { elements } = await createBrowserHarness({
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				return new Response('SID=pigeon/live-token\nLSID=null\nAuth=pigeon/live-token', { status: 200 });
			}

			if (input === '/reader/api/0/subscription/list') {
				return Response.json({
					subscriptions: [{ id: 'feed/1', title: 'Alpha' }],
				});
			}

			if (input === '/reader/api/0/unread-count') {
				return Response.json({
					unreadcounts: [{ id: 'feed/1', count: 1 }],
				});
			}

			if (String(input).startsWith('/reader/api/0/stream/items/ids?')) {
				return Response.json({
					itemRefs: [{ id: '101' }],
				});
			}

			if (input === '/reader/api/0/stream/items/contents' && init?.method === 'POST') {
				return Response.json({
					items: [
						{
							id: 'tag:google.com,2005:reader/item/0000000000000065',
							title: 'Dark frame story',
							published: 1_742_460_800,
							origin: { title: 'Alpha' },
							summary: { content: 'Short summary' },
							content: { content: articleBody },
						},
					],
				});
			}

			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});

	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(
		() => (elements.get('reader-frame')?.srcdoc ?? '') === createArticleFrameDocument(articleBody),
	);

	await elements.get('theme-toggle-button')?.dispatch('click');

	await waitForBrowserCondition(
		() => (elements.get('reader-frame')?.srcdoc ?? '') === createArticleFrameDocument(articleBody, 'dark'),
	);

	assert.equal(elements.get('reader-frame')?.srcdoc, createArticleFrameDocument(articleBody, 'dark'));
	assert.match(elements.get('reader-frame')?.srcdoc ?? '', /<html lang="en" data-theme="dark">/);
	assert.match(elements.get('reader-frame')?.srcdoc ?? '', /--frame-link:\s*#8ab4ff/);
});

test('runtime script uses j and k to move between articles while keeping the active reader state in sync', async () => {
	const { elements, dispatchKeydown } = await createBrowserHarness({
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				return new Response('SID=pigeon/live-token\nLSID=null\nAuth=pigeon/live-token', { status: 200 });
			}

			if (input === '/reader/api/0/subscription/list') {
				return Response.json({
					subscriptions: [{ id: 'feed/1', title: 'Alpha' }],
				});
			}

			if (input === '/reader/api/0/unread-count') {
				return Response.json({
					unreadcounts: [{ id: 'feed/1', count: 3 }],
				});
			}

			if (String(input).startsWith('/reader/api/0/stream/items/ids?')) {
				return Response.json({
					itemRefs: [{ id: '101' }, { id: '102' }, { id: '103' }],
				});
			}

			if (input === '/reader/api/0/stream/items/contents' && init?.method === 'POST') {
				return Response.json({
					items: ['101', '102', '103'].map((id) => ({
						id: `tag:google.com,2005:reader/item/${Number(id).toString(16).padStart(16, '0')}`,
						title: `Article ${id}`,
						published: 1_742_460_800 + Number(id),
						origin: { title: 'Alpha' },
						summary: { content: `Preview ${id}` },
						content: { content: `<article><p>Body ${id}</p></article>` },
					})),
				});
			}

			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});

	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => (elements.get('reader-title')?.textContent ?? '') === 'Article 101');

	assert.equal(dispatchKeydown('j'), true);
	await waitForBrowserCondition(() => (elements.get('reader-title')?.textContent ?? '') === 'Article 102');
	assert.ok(findListButtonByItemId(elements.get('articles-list'), '102')?.classList.contains('is-active'));
	assert.equal(
		elements.get('reader-frame')?.srcdoc,
		createArticleFrameDocument('<article><p>Body 102</p></article>'),
	);

	assert.equal(dispatchKeydown('j'), true);
	await waitForBrowserCondition(() => (elements.get('reader-title')?.textContent ?? '') === 'Article 103');
	assert.ok(findListButtonByItemId(elements.get('articles-list'), '103')?.classList.contains('is-active'));

	assert.equal(dispatchKeydown('j'), false);
	await flushBrowserTasks();
	assert.equal(elements.get('reader-title')?.textContent, 'Article 103');

	assert.equal(dispatchKeydown('k'), true);
	await waitForBrowserCondition(() => (elements.get('reader-title')?.textContent ?? '') === 'Article 102');
	assert.ok(findListButtonByItemId(elements.get('articles-list'), '102')?.classList.contains('is-active'));
});

test('runtime script moves focus to the reader shell on login so j and k work immediately', async () => {
	const { elements, dispatchKeydown, getActiveElement } = await createBrowserHarness({
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				return new Response('SID=pigeon/live-token\nLSID=null\nAuth=pigeon/live-token', { status: 200 });
			}

			if (input === '/reader/api/0/subscription/list') {
				return Response.json({
					subscriptions: [{ id: 'feed/1', title: 'Alpha' }],
				});
			}

			if (input === '/reader/api/0/unread-count') {
				return Response.json({
					unreadcounts: [{ id: 'feed/1', count: 2 }],
				});
			}

			if (String(input).startsWith('/reader/api/0/stream/items/ids?')) {
				return Response.json({
					itemRefs: [{ id: '101' }, { id: '102' }],
				});
			}

			if (input === '/reader/api/0/stream/items/contents' && init?.method === 'POST') {
				return Response.json({
					items: ['101', '102'].map((id) => ({
						id: `tag:google.com,2005:reader/item/${Number(id).toString(16).padStart(16, '0')}`,
						title: `Article ${id}`,
						published: 1_742_460_800 + Number(id),
						origin: { title: 'Alpha' },
						summary: { content: `Preview ${id}` },
						content: { content: `<article><p>Body ${id}</p></article>` },
					})),
				});
			}

			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});

	elements.get('password-input')?.focus();
	assert.equal(getActiveElement(), elements.get('password-input'));

	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => (elements.get('reader-title')?.textContent ?? '') === 'Article 101');

	assert.equal(getActiveElement(), elements.get('reader-shell'));
	assert.equal(dispatchKeydown('j'), true);
	await waitForBrowserCondition(() => (elements.get('reader-title')?.textContent ?? '') === 'Article 102');
	assert.ok(findListButtonByItemId(elements.get('articles-list'), '102')?.classList.contains('is-active'));
});

test('runtime script ignores j and k when typing in editable controls or contenteditable regions', async () => {
	const { elements, dispatchKeydown } = await createBrowserHarness({
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				return new Response('SID=pigeon/live-token\nLSID=null\nAuth=pigeon/live-token', { status: 200 });
			}

			if (input === '/reader/api/0/subscription/list') {
				return Response.json({
					subscriptions: [{ id: 'feed/1', title: 'Alpha' }],
				});
			}

			if (input === '/reader/api/0/unread-count') {
				return Response.json({
					unreadcounts: [{ id: 'feed/1', count: 2 }],
				});
			}

			if (String(input).startsWith('/reader/api/0/stream/items/ids?')) {
				return Response.json({
					itemRefs: [{ id: '101' }, { id: '102' }],
				});
			}

			if (input === '/reader/api/0/stream/items/contents' && init?.method === 'POST') {
				return Response.json({
					items: ['101', '102'].map((id) => ({
						id: `tag:google.com,2005:reader/item/${Number(id).toString(16).padStart(16, '0')}`,
						title: `Article ${id}`,
						published: 1_742_460_800 + Number(id),
						origin: { title: 'Alpha' },
						summary: { content: `Preview ${id}` },
						content: { content: `<article><p>Body ${id}</p></article>` },
					})),
				});
			}

			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});

	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => (elements.get('reader-title')?.textContent ?? '') === 'Article 101');

	const textareaTarget = createElement('', [], 'textarea');
	const selectTarget = createElement('', [], 'select');
	const editableTarget = createElement();
	editableTarget.setAttribute('contenteditable', 'true');

	assert.equal(dispatchKeydown('j', textareaTarget), false);
	assert.equal(dispatchKeydown('j', selectTarget), false);
	assert.equal(dispatchKeydown('j', editableTarget), false);
	await flushBrowserTasks();

	assert.equal(elements.get('reader-title')?.textContent, 'Article 101');
	assert.ok(findListButtonByItemId(elements.get('articles-list'), '101')?.classList.contains('is-active'));
});

test('runtime script handles j and k from the article frame without stealing focus from article links', async () => {
	const { elements, dispatchFrameKeydown } = await createBrowserHarness({
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				return new Response('SID=pigeon/live-token\nLSID=null\nAuth=pigeon/live-token', { status: 200 });
			}

			if (input === '/reader/api/0/subscription/list') {
				return Response.json({
					subscriptions: [{ id: 'feed/1', title: 'Alpha' }],
				});
			}

			if (input === '/reader/api/0/unread-count') {
				return Response.json({
					unreadcounts: [{ id: 'feed/1', count: 2 }],
				});
			}

			if (String(input).startsWith('/reader/api/0/stream/items/ids?')) {
				return Response.json({
					itemRefs: [{ id: '101' }, { id: '102' }],
				});
			}

			if (input === '/reader/api/0/stream/items/contents' && init?.method === 'POST') {
				return Response.json({
					items: ['101', '102'].map((id) => ({
						id: `tag:google.com,2005:reader/item/${Number(id).toString(16).padStart(16, '0')}`,
						title: `Article ${id}`,
						published: 1_742_460_800 + Number(id),
						origin: { title: 'Alpha' },
						summary: { content: `Preview ${id}` },
						content: { content: `<article><p>Body ${id}</p></article>` },
					})),
				});
			}

			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});

	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => (elements.get('reader-title')?.textContent ?? '') === 'Article 101');

	const frameLinkTarget = createElement('', [], 'a');
	assert.equal(dispatchFrameKeydown('j', frameLinkTarget), true);
	await waitForBrowserCondition(() => (elements.get('reader-title')?.textContent ?? '') === 'Article 102');
	assert.ok(findListButtonByItemId(elements.get('articles-list'), '102')?.classList.contains('is-active'));
});

test('runtime script ignores j and k from editable targets inside the article frame', async () => {
	const { elements, dispatchFrameKeydown } = await createBrowserHarness({
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				return new Response('SID=pigeon/live-token\nLSID=null\nAuth=pigeon/live-token', { status: 200 });
			}

			if (input === '/reader/api/0/subscription/list') {
				return Response.json({
					subscriptions: [{ id: 'feed/1', title: 'Alpha' }],
				});
			}

			if (input === '/reader/api/0/unread-count') {
				return Response.json({
					unreadcounts: [{ id: 'feed/1', count: 2 }],
				});
			}

			if (String(input).startsWith('/reader/api/0/stream/items/ids?')) {
				return Response.json({
					itemRefs: [{ id: '101' }, { id: '102' }],
				});
			}

			if (input === '/reader/api/0/stream/items/contents' && init?.method === 'POST') {
				return Response.json({
					items: ['101', '102'].map((id) => ({
						id: `tag:google.com,2005:reader/item/${Number(id).toString(16).padStart(16, '0')}`,
						title: `Article ${id}`,
						published: 1_742_460_800 + Number(id),
						origin: { title: 'Alpha' },
						summary: { content: `Preview ${id}` },
						content: { content: `<article><p>Body ${id}</p></article>` },
					})),
				});
			}

			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});

	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => (elements.get('reader-title')?.textContent ?? '') === 'Article 101');

	const frameTextareaTarget = createElement('', [], 'textarea');
	const frameEditableTarget = createElement();
	frameEditableTarget.setAttribute('contenteditable', 'true');

	assert.equal(dispatchFrameKeydown('j', frameTextareaTarget), false);
	assert.equal(dispatchFrameKeydown('j', frameEditableTarget), false);
	await flushBrowserTasks();

	assert.equal(elements.get('reader-title')?.textContent, 'Article 101');
	assert.ok(findListButtonByItemId(elements.get('articles-list'), '101')?.classList.contains('is-active'));
});
