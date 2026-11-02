import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTH_STORAGE_KEY, createArticleFrameDocument, getLocalDayBounds } from '../src/browser-app-client';
import {
	collectBrowserWindowIds,
	createBrowserHarness,
	createDeferred,
	createElement,
	findListButtonByItemId,
	findListButtonByViewId,
	flushBrowserTasks,
	waitForBrowserCondition,
	waitForTodayWindow,
} from './helpers/browser-app-client-harness';

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
	assert.match(elements.get('reader-source-label')?.textContent ?? '', /Alpha/);
	assert.match(elements.get('reader-source-note')?.textContent ?? '', /2025/);
	assert.equal(elements.get('reader-frame')?.srcdoc, createArticleFrameDocument(articleBody));
	assert.doesNotMatch(elements.get('reader-title')?.textContent ?? '', /Full body copy that belongs in the frame/);
	assert.doesNotMatch(elements.get('reader-meta')?.textContent ?? '', /Full body copy that belongs in the frame/);
});

test('runtime YouTube player reuses the same iframe across rerenders and clears on article changes and logout', async () => {
	const videoUrl = 'https://www.youtube.com/watch?v=M1q063UD-gw';
	const { elements } = await createBrowserHarness({
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				return new Response('SID=pigeon/live-token\nLSID=null\nAuth=pigeon/live-token', { status: 200 });
			}

			if (input === '/reader/api/0/subscription/list') {
				return Response.json({
					subscriptions: [{ id: 'feed/1', title: 'Google for Developers' }],
				});
			}

			if (input === '/reader/api/0/unread-count') {
				return Response.json({ unreadcounts: [{ id: 'feed/1', count: 2 }] });
			}

			if (String(input).startsWith('/reader/api/0/stream/items/ids?')) {
				return Response.json({ itemRefs: [{ id: '101' }, { id: '102' }] });
			}

			if (input === '/reader/api/0/stream/items/contents' && init?.method === 'POST') {
				return Response.json({
					items: [
						{
							id: 'tag:google.com,2005:reader/item/0000000000000065',
							title: 'A YouTube video',
							published: 1_742_460_800,
							origin: { title: 'Google for Developers' },
							summary: { content: 'Video summary' },
							content: { content: '<p>Video body</p>' },
							alternate: [{ href: videoUrl }],
						},
						{
							id: 'tag:google.com,2005:reader/item/0000000000000066',
							title: 'A regular article',
							published: 1_742_460_700,
							origin: { title: 'Google for Developers' },
							summary: { content: 'Article summary' },
							content: { content: '<p>Article body</p>' },
							alternate: [{ href: 'https://example.com/story' }],
						},
					],
				});
			}

			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});

	await elements.get('login-form')?.dispatch('submit');
	const playerContainer = elements.get('reader-player-container');
	const playerShell = elements.get('reader-player-shell');
	const playerFallback = elements.get('reader-player-fallback');
	assert.ok(playerContainer);
	assert.ok(playerShell);
	assert.ok(playerFallback);
	await waitForBrowserCondition(() => playerContainer.children.length === 1);

	const firstFrame = playerContainer.children[0];
	assert.ok(firstFrame);
	assert.equal(firstFrame.tagName, 'IFRAME');
	assert.equal(firstFrame.getAttribute('src'), 'https://www.youtube.com/embed/M1q063UD-gw?controls=1');
	assert.equal(firstFrame.getAttribute('referrerpolicy'), 'strict-origin-when-cross-origin');
	assert.equal(firstFrame.getAttribute('allowfullscreen'), '');
	assert.equal(playerFallback.getAttribute('href'), videoUrl);
	assert.equal(playerShell.classList.contains('hidden'), false);

	await elements.get('theme-toggle-button')?.dispatch('click');
	await waitForBrowserCondition(() => (elements.get('reader-frame')?.srcdoc ?? '').includes('data-theme="dark"'));
	assert.equal(playerContainer.children[0], firstFrame);

	const regularArticle = findListButtonByItemId(elements.get('articles-list'), '102');
	assert.ok(regularArticle);
	await regularArticle.dispatch('click');
	await waitForBrowserCondition(() => elements.get('reader-title')?.textContent === 'A regular article');
	assert.equal(playerContainer.children.length, 0);
	assert.equal(playerShell.classList.contains('hidden'), true);

	const videoArticle = findListButtonByItemId(elements.get('articles-list'), '101');
	assert.ok(videoArticle);
	await videoArticle.dispatch('click');
	await waitForBrowserCondition(() => playerContainer.children.length === 1);
	assert.notEqual(playerContainer.children[0], firstFrame);

	await elements.get('logout-button')?.dispatch('click');
	assert.equal(playerContainer.children.length, 0);
	assert.equal(playerShell.classList.contains('hidden'), true);
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
	assert.match(elements.get('reader-frame')?.srcdoc ?? '', /--frame-link:\s*#8fb3e8/);
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

test('cached view entry restores selection and scroll while refreshing new and revised articles', async () => {
	let allRootRequests = 0;
	let feedRootRequests = 0;
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
				return Response.json({ unreadcounts: [{ id: 'feed/1', count: 2 }] });
			}
			if (String(input).startsWith('/reader/api/0/stream/contents?') &&
				new URL(`https://pigeon.example${String(input)}`).searchParams.get('s') === 'feed/1') {
				feedRootRequests += 1;
				return Response.json({ items: ['1', '2'].map((id) => ({
						id: `tag:google.com,2005:reader/item/${Number(id).toString(16).padStart(16, '0')}`,
						title: `Article ${id}`,
						published: 1_742_460_800,
						origin: { title: 'Alpha' },
						summary: { content: `Preview ${id}` },
						content: { content: `<p>Body ${id}</p>` },
					})) });
			}
			if (String(input).startsWith('/reader/api/0/stream/items/ids?')) {
				const url = new URL(`https://pigeon.example${String(input)}`);
				const streamId = url.searchParams.get('s');
				if (streamId === 'feed/1') {
					feedRootRequests += 1;
					return Response.json({ itemRefs: [{ id: '1' }, { id: '2' }] });
				}
				allRootRequests += 1;
				return allRootRequests === 1
					? Response.json({ itemRefs: [{ id: '1' }, { id: '2' }] })
					: Response.json({ itemRefs: [{ id: '3' }, { id: '1' }] });
			}
			if (input === '/reader/api/0/stream/items/contents' && init?.method === 'POST') {
				const ids = [...(init.body?.getAll('i') ?? [])].map(String);
				contentRequests.push(ids);
				return Response.json({
					items: ids.map((id) => ({
						id: `tag:google.com,2005:reader/item/${Number(id).toString(16).padStart(16, '0')}`,
						title: id === '1' && contentRequests.length > 1 ? 'Article 1 revised' : `Article ${id}`,
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
	await waitForBrowserCondition(() => allRootRequests === 1 && contentRequests.length === 1);
	const articlesListShell = elements.get('articles-list-shell');
	if (!articlesListShell) throw new Error('Missing article list shell');
	articlesListShell.scrollTop = 123;

	const feedButton = findListButtonByViewId(elements.get('feeds-list'), 'feed/1');
	await feedButton?.dispatch('click');
	await waitForBrowserCondition(() => feedRootRequests === 1 && (elements.get('articles-heading')?.textContent ?? '') === 'Alpha');
	const allButton = findListButtonByViewId(elements.get('views-list'), 'all');
	await allButton?.dispatch('click');
	await waitForBrowserCondition(() => allRootRequests === 2 && contentRequests.length === 2);
	await waitForBrowserCondition(() => (elements.get('articles-list')?.textContent ?? '').includes('Article 1 revised'));

	assert.match(elements.get('articles-list')?.textContent ?? '', /Article 3/);
	assert.match(elements.get('articles-list')?.textContent ?? '', /Article 1 revised/);
	assert.equal(articlesListShell.scrollTop, 123);
	assert.ok(findListButtonByItemId(elements.get('articles-list'), '1')?.classList.contains('is-active'));
	assert.deepEqual(contentRequests, [['1', '2'], ['3', '1']]);
});

test('reader refreshes keep the frame position for unchanged and revised articles but reset on selection changes', async () => {
	let membershipRequests = 0;
	let contentRequests = 0;
	let reviseFirstArticle = false;
	const {
		elements,
		dispatchDocumentEvent,
		dispatchReaderFrameScroll,
		getReaderFrameScrollTop,
	} = await createBrowserHarness({
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				return new Response('SID=pigeon/live-token\nLSID=null\nAuth=pigeon/live-token', { status: 200 });
			}
			if (input === '/reader/api/0/subscription/list') {
				return Response.json({ subscriptions: [{ id: 'feed/1', title: 'Alpha' }] });
			}
			if (input === '/reader/api/0/unread-count') {
				return Response.json({ unreadcounts: [{ id: 'feed/1', count: 3 }] });
			}
			if (String(input).startsWith('/reader/api/0/stream/items/ids?')) {
				membershipRequests += 1;
				return membershipRequests === 1
					? Response.json({ itemRefs: [{ id: '1' }, { id: '2' }] })
					: Response.json({ itemRefs: [{ id: '1' }, { id: '2' }, { id: '3' }] });
			}
			if (input === '/reader/api/0/stream/items/contents' && init?.method === 'POST') {
				contentRequests += 1;
				const ids = [...(init.body?.getAll('i') ?? [])].map(String);
				return Response.json({
					items: ids.map((id) => ({
						id: `tag:google.com,2005:reader/item/${Number(id).toString(16).padStart(16, '0')}`,
						title: `Article ${id}`,
						published: 1_742_460_800,
						origin: { title: 'Alpha' },
						summary: { content: `Preview ${id}` },
						content: {
							content:
								id === '1' && reviseFirstArticle
									? '<article><p>Body 1 revised</p></article>'
									: `<article><p>Body ${id}</p></article>`,
						},
					})),
				});
			}
			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});

	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(
		() => membershipRequests === 1 && contentRequests === 1 && (elements.get('reader-frame')?.srcdoc ?? '').includes('Body 1'),
	);
	await flushBrowserTasks();
	dispatchReaderFrameScroll(240);
	assert.equal(getReaderFrameScrollTop(), 240);
	const initialDocument = elements.get('reader-frame')?.srcdoc;

	dispatchDocumentEvent('visibilitychange');
	await waitForBrowserCondition(() => membershipRequests === 2 && contentRequests === 2);
	assert.equal(elements.get('reader-frame')?.srcdoc, initialDocument);
	assert.equal(getReaderFrameScrollTop(), 240);

	reviseFirstArticle = true;
	dispatchDocumentEvent('visibilitychange');
	await waitForBrowserCondition(
		() => membershipRequests === 3 && contentRequests === 3 && (elements.get('reader-frame')?.srcdoc ?? '').includes('Body 1 revised'),
	);
	await flushBrowserTasks();
	assert.equal(getReaderFrameScrollTop(), 240);

	const secondArticleButton = findListButtonByItemId(elements.get('articles-list'), '2');
	assert.ok(secondArticleButton);
	await secondArticleButton?.dispatch('click');
	await waitForBrowserCondition(() => (elements.get('reader-frame')?.srcdoc ?? '').includes('Body 2'));
	assert.equal(getReaderFrameScrollTop(), 0);
});

test('foreground and reconnect revalidation share one in-flight membership request', async () => {
	let rootRequests = 0;
	let releaseRefresh: ((response: Response) => void) | null = null;
	const refreshResponse = new Promise<Response>((resolve) => {
		releaseRefresh = resolve;
	});
	const { elements, dispatchDocumentEvent, dispatchWindowEvent } = await createBrowserHarness({
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
				rootRequests += 1;
				return rootRequests === 1 ? Response.json({ itemRefs: [{ id: '1' }] }) : refreshResponse;
			}
			if (input === '/reader/api/0/stream/items/contents' && init?.method === 'POST') {
				return Response.json({
					items: [{
						id: 'tag:google.com,2005:reader/item/0000000000000001',
						title: 'Article 1',
						published: 1_742_460_800,
						origin: { title: 'Alpha' },
						summary: { content: 'Preview 1' },
						content: { content: '<p>Body 1</p>' },
					}],
				});
			}
			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});

	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => rootRequests === 1 && (elements.get('articles-list')?.textContent ?? '').includes('Article 1'));

	dispatchDocumentEvent('visibilitychange');
	dispatchWindowEvent('online');
	await elements.get('views-list')?.children[0]?.children[0]?.dispatch('click');
	await waitForBrowserCondition(() => rootRequests === 2);
	await flushBrowserTasks();
	assert.equal(rootRequests, 2);

	releaseRefresh?.(Response.json({ itemRefs: [{ id: '1' }] }));
	await waitForBrowserCondition(() => rootRequests === 2 && (elements.get('articles-status')?.textContent ?? '') === '1 article');
});

test('offline foreground keeps the cached view and logout invalidates late responses', async () => {
	let rootRequests = 0;
	let contentRequests = 0;
	let releaseLateContent: ((response: Response) => void) | null = null;
	const lateContent = new Promise<Response>((resolve) => {
		releaseLateContent = resolve;
	});
	const { elements, setOnline, dispatchDocumentEvent } = await createBrowserHarness({
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
			if (String(input).startsWith('/reader/api/0/stream/contents?')) {
				rootRequests += 1;
				return Response.json({ items: [{
					id: 'tag:google.com,2005:reader/item/0000000000000001',
					title: 'Article 1',
					published: 1_742_460_800,
					origin: { title: 'Alpha' },
					content: { content: '<p>Body 1</p>' },
				}] });
			}
			if (String(input).startsWith('/reader/api/0/stream/items/ids?')) {
				rootRequests += 1;
				return Response.json({ itemRefs: [{ id: '1' }] });
			}
			if (input === '/reader/api/0/stream/items/contents' && init?.method === 'POST') {
				contentRequests += 1;
				return contentRequests === 1 ? lateContent : Response.json({ items: [] });
			}
			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});

	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => rootRequests === 1 && elements.get('reader-title')?.textContent === 'Article 1');
	dispatchDocumentEvent('visibilitychange');
	await waitForBrowserCondition(() => rootRequests === 2 && contentRequests === 1);
	setOnline(false);
	dispatchDocumentEvent('visibilitychange');
	await flushBrowserTasks();
	assert.equal(rootRequests, 2);
	assert.equal(elements.get('articles-status')?.textContent, 'Offline · showing cached articles.');

	await elements.get('logout-button')?.dispatch('click');
	releaseLateContent?.(Response.json({ items: [{
		id: 'tag:google.com,2005:reader/item/0000000000000001',
		title: 'Late article',
		published: 1_742_460_800,
		origin: { title: 'Alpha' },
		summary: { content: 'Late preview' },
		content: { content: '<p>Late body</p>' },
	}] }));
	await flushBrowserTasks();
	assert.equal(elements.get('login-screen')?.classList.contains('hidden'), false);
	assert.equal(elements.get('reader-shell')?.classList.contains('hidden'), true);
	assert.equal(elements.get('articles-list')?.children.length, 0);
});

test('a late unauthorized response from an old session cannot log out a new session', async () => {
	const oldStatusResponse = createDeferred<Response>();
	let loginCount = 0;
	let statusCount = 0;
	const { elements, storage } = await createBrowserHarness({
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				loginCount += 1;
				const token = loginCount === 1 ? 'old-token' : 'new-token';
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
				statusCount += 1;
				if (statusCount === 1) {
					return oldStatusResponse.promise;
				}
				return Response.json({ ok: true });
			}
			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});

	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => storage.get(AUTH_STORAGE_KEY) === 'old-token');
	await elements.get('settings-button')?.dispatch('click');
	await waitForBrowserCondition(() => statusCount === 1);

	await elements.get('logout-button')?.dispatch('click');
	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => storage.get(AUTH_STORAGE_KEY) === 'new-token');
	assert.equal(elements.get('reader-shell')?.classList.contains('hidden'), false);

	oldStatusResponse.resolve(new Response('Unauthorized', { status: 401 }));
	await flushBrowserTasks();
	await flushBrowserTasks();

	assert.equal(storage.get(AUTH_STORAGE_KEY), 'new-token');
	assert.equal(elements.get('reader-shell')?.classList.contains('hidden'), false);
});

test('large refreshes keep content requests bounded and do not refetch evicted pages', async () => {
	const itemIds = Array.from({ length: 560 }, (_, index) => String(index + 1));
	let membershipRequests = 0;
	let contentRequests = 0;
	let activeContentRequests = 0;
	let maximumConcurrentContentRequests = 0;
	const harness = await createBrowserHarness({
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
			if (String(input).startsWith('/reader/api/0/stream/contents?')) {
				membershipRequests += 1;
				return Response.json({ items: itemIds.slice(0, 50).map((id) => ({
						id: `tag:google.com,2005:reader/item/${Number(id).toString(16).padStart(16, '0')}`,
						title: `Article ${id}`,
						published: 1_742_460_800,
						origin: { title: 'Alpha' },
						summary: { content: `Preview ${id}` },
						content: { content: `<p>Body ${id}</p>` },
					})) });
			}
			if (String(input).startsWith('/reader/api/0/stream/items/ids?')) {
				membershipRequests += 1;
				return Response.json({ itemRefs: itemIds.map((id) => ({ id })) });
			}
			if (input === '/reader/api/0/stream/items/contents' && init?.method === 'POST') {
				const ids = [...(init.body?.getAll('i') ?? [])].map(String);
				contentRequests += 1;
				activeContentRequests += 1;
				maximumConcurrentContentRequests = Math.max(maximumConcurrentContentRequests, activeContentRequests);
				await new Promise((resolve) => setTimeout(resolve, 2));
				activeContentRequests -= 1;
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

	const { elements, dispatchDocumentEvent } = harness;
	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => membershipRequests === 1 && elements.get('reader-title')?.textContent === 'Article 1');
	assert.equal(contentRequests, 0);
	dispatchDocumentEvent('visibilitychange');
	await waitForBrowserCondition(() => membershipRequests === 2 && contentRequests === 10 && activeContentRequests === 0, 100);
	await collectBrowserWindowIds(harness);
	for (let page = 0; page < 2; page += 1) {
		elements.get('article-newer-button')!.dispatch('click');
		await waitForTodayWindow(harness);
	}
	const settledRequestCount = contentRequests;
	await flushBrowserTasks();
	await flushBrowserTasks();

	assert.equal(maximumConcurrentContentRequests, 2);
	assert.equal(contentRequests, settledRequestCount);
	assert.match(elements.get('articles-list')?.textContent ?? '', /Article 1/);
	const olderArticleButton = findListButtonByItemId(elements.get('articles-list'), '2');
	assert.ok(olderArticleButton);
	await olderArticleButton?.dispatch('click');
	await waitForBrowserCondition(
		() => contentRequests === settledRequestCount + 1 && (elements.get('reader-frame')?.srcdoc ?? '').includes('Body 2'),
	);
	assert.equal(elements.get('reader-title')?.textContent, 'Article 2');
});

test('runtime Today pagination continues after the full body cache reaches its cap', async () => {
	const now = new Date(2026, 2, 20, 12, 0, 0, 0).getTime();
	const bounds = getLocalDayBounds(new Date(now));
	const todayIds = Array.from({ length: 551 }, (_, index) => String(index + 1));
	const olderId = '552';
	const pageIds = [...todayIds, olderId];
	let rootRequests = 0;
	let todayMembershipRequests = 0;
	let contentRequests = 0;
	const harness = await createBrowserHarness({
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
				if (!continuation) {
					rootRequests += 1;
					if (rootRequests === 1) {
						return Response.json({ itemRefs: [{ id: '900' }] });
					}
				}

				todayMembershipRequests += 1;
				const pageIndex = continuation ? Number(continuation.slice(1)) : 0;
				const start = pageIndex * 50;
				const itemRefs = pageIds.slice(start, start + 50).map((id) => ({ id }));
				const nextStart = start + itemRefs.length;
				return Response.json({
					itemRefs,
					...(nextStart < pageIds.length ? { continuation: `p${pageIndex + 1}` } : {}),
				});
			}
			if (input === '/reader/api/0/stream/items/contents' && init?.method === 'POST') {
				contentRequests += 1;
				const ids = [...(init.body?.getAll('i') ?? [])].map(String);
				return Response.json({
					items: ids.map((id) => ({
						id: `tag:google.com,2005:reader/item/${Number(id).toString(16).padStart(16, '0')}`,
						title: `Article ${id}`,
						published: id === olderId ? bounds.startSeconds - 1 : bounds.startSeconds + 1,
						origin: { title: 'Alpha' },
						summary: { content: `Preview ${id}` },
						content: { content: `<p>Body ${id}</p>` },
					})),
				});
			}
			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});

	const { elements } = harness;
	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => (elements.get('articles-list')?.textContent ?? '').includes('Article 900'));
	await findListButtonByViewId(elements.get('views-list'), 'today')?.dispatch('click');
	await waitForBrowserCondition(() => Boolean(findListButtonByItemId(elements.get('articles-list'), '200')), 400);
	await waitForTodayWindow(harness);
	for (let page = 0; page < 2; page += 1) {
		elements.get('article-older-button')!.dispatch('click');
		await waitForTodayWindow(harness);
	}

	assert.equal(todayMembershipRequests, 12);
	assert.ok(contentRequests >= 29);
	assert.ok(findListButtonByItemId(elements.get('articles-list'), '551'));
	assert.equal(findListButtonByItemId(elements.get('articles-list'), olderId), undefined);
});

test('a failed refresh keeps the last usable membership page and cached articles', async () => {
	let membershipRequests = 0;
	let contentRequests = 0;
	const { elements, dispatchDocumentEvent } = await createBrowserHarness({
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
				membershipRequests += 1;
				return membershipRequests === 1
					? Response.json({ itemRefs: [{ id: '1' }, { id: '2' }] })
					: Response.json({ itemRefs: [{ id: '3' }] });
			}
			if (input === '/reader/api/0/stream/items/contents' && init?.method === 'POST') {
				contentRequests += 1;
				if (contentRequests > 1) {
					return new Response('temporary failure', { status: 503 });
				}
				const ids = [...(init.body?.getAll('i') ?? [])].map(String);
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
	await waitForBrowserCondition(() => membershipRequests === 1 && (elements.get('articles-list')?.textContent ?? '').includes('Article 1'));
	dispatchDocumentEvent('visibilitychange');
	await waitForBrowserCondition(
		() => membershipRequests === 2 && (elements.get('articles-status')?.textContent ?? '').includes('Refresh failed'),
	);

	assert.match(elements.get('articles-list')?.textContent ?? '', /Article 1/);
	assert.match(elements.get('articles-list')?.textContent ?? '', /Article 2/);
	assert.doesNotMatch(elements.get('articles-list')?.textContent ?? '', /Article 3/);
});

test('200 content responses must include every requested item before refresh membership changes', async () => {
	let membershipRequests = 0;
	let contentRequests = 0;
	const { elements, dispatchDocumentEvent } = await createBrowserHarness({
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
				membershipRequests += 1;
				if (membershipRequests === 1) {
					return Response.json({ itemRefs: [{ id: '1' }, { id: '2' }] });
				}
				return membershipRequests === 2
					? Response.json({ itemRefs: [{ id: '3' }, { id: '1' }] })
					: Response.json({ itemRefs: [{ id: '4' }] });
			}
			if (input === '/reader/api/0/stream/items/contents' && init?.method === 'POST') {
				contentRequests += 1;
				const ids = [...(init.body?.getAll('i') ?? [])].map(String);
				if (contentRequests === 2) {
					return Response.json({
						items: [
							{
								id: 'tag:google.com,2005:reader/item/0000000000000001',
								title: 'Article 1 revised',
								published: 1_742_460_800,
								origin: { title: 'Alpha' },
								summary: { content: 'Preview 1 revised' },
								content: { content: '<p>Body 1 revised</p>' },
							},
						],
					});
				}
				if (contentRequests === 3) {
					return Response.json({ items: [] });
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
	await waitForBrowserCondition(() => membershipRequests === 1 && contentRequests === 1);

	dispatchDocumentEvent('visibilitychange');
	await waitForBrowserCondition(
		() => membershipRequests === 2 && contentRequests === 2 && (elements.get('articles-status')?.textContent ?? '').includes('Refresh failed'),
	);
	assert.match(elements.get('articles-list')?.textContent ?? '', /Article 1/);
	assert.match(elements.get('articles-list')?.textContent ?? '', /Article 2/);
	assert.doesNotMatch(elements.get('articles-list')?.textContent ?? '', /Article 3/);

	dispatchDocumentEvent('visibilitychange');
	await waitForBrowserCondition(
		() => membershipRequests === 3 && contentRequests === 3 && (elements.get('articles-status')?.textContent ?? '').includes('Refresh failed'),
	);
	assert.match(elements.get('articles-list')?.textContent ?? '', /Article 1/);
	assert.match(elements.get('articles-list')?.textContent ?? '', /Article 2/);
	assert.doesNotMatch(elements.get('articles-list')?.textContent ?? '', /Article 4/);
});

test('old account inventory responses cannot populate a newer session', async () => {
	const oldSubscriptions = createDeferred<Response>();
	const oldUnreadCounts = createDeferred<Response>();
	let loginCount = 0;
	let subscriptionCalls = 0;
	let unreadCountCalls = 0;
	const { elements } = await createBrowserHarness({
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				loginCount += 1;
				const token = loginCount === 1 ? 'old-token' : 'new-token';
				return new Response(`SID=pigeon/${token}\nLSID=null\nAuth=pigeon/${token}`, { status: 200 });
			}
			if (input === '/reader/api/0/subscription/list') {
				subscriptionCalls += 1;
				return subscriptionCalls === 1
					? oldSubscriptions.promise
					: Response.json({ subscriptions: [{ id: 'feed/new', title: 'New account feed' }] });
			}
			if (input === '/reader/api/0/unread-count') {
				unreadCountCalls += 1;
				return unreadCountCalls === 1
					? oldUnreadCounts.promise
					: Response.json({ unreadcounts: [{ id: 'feed/new', count: 1 }] });
			}
			if (String(input).startsWith('/reader/api/0/stream/items/ids?')) {
				return Response.json({ itemRefs: [] });
			}
			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});

	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => subscriptionCalls === 1 && unreadCountCalls === 1);
	await elements.get('logout-button')?.dispatch('click');
	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(
		() => Boolean(findListButtonByViewId(elements.get('feeds-list'), 'feed/new')),
	);

	oldSubscriptions.resolve(Response.json({ subscriptions: [{ id: 'feed/old', title: 'Old account feed' }] }));
	oldUnreadCounts.resolve(Response.json({ unreadcounts: [{ id: 'feed/old', count: 1 }] }));
	await flushBrowserTasks();
	await flushBrowserTasks();

	assert.ok(findListButtonByViewId(elements.get('feeds-list'), 'feed/new'));
	assert.equal(findListButtonByViewId(elements.get('feeds-list'), 'feed/old'), undefined);
});

test('revalidation fetches a selected preserved-tail body that was evicted from the cache', async () => {
	const allIds = Array.from({ length: 560 }, (_, index) => String(index + 1));
	const feedIds = Array.from({ length: 600 }, (_, index) => String(index + 1001));
	let allMembershipRequests = 0;
	let feedMembershipRequests = 0;
	let phase = 'all';
	let feedContentRequests = 0;
	const contentRequests: string[][] = [];
	const harness = await createBrowserHarness({
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
			if (String(input).startsWith('/reader/api/0/stream/contents?')) {
				const streamId = new URL(`https://pigeon.example${String(input)}`).searchParams.get('s');
				const pageIds = streamId === 'feed/1' ? feedIds : allIds;
				if (streamId === 'feed/1') feedMembershipRequests += 1;
				else allMembershipRequests += 1;
				return Response.json({ items: pageIds.slice(0, 50).map((id) => ({
						id: `tag:google.com,2005:reader/item/${Number(id).toString(16).padStart(16, '0')}`,
						title: `Article ${id}`,
						published: 1_742_460_800,
						origin: { title: 'Alpha' },
						summary: { content: `Preview ${id}` },
						content: { content: `<p>Body ${id}</p>` },
					})) });
			}
			if (String(input).startsWith('/reader/api/0/stream/items/ids?')) {
				const url = new URL(`https://pigeon.example${String(input)}`);
				const streamId = url.searchParams.get('s');
				if (streamId === 'feed/1') {
					feedMembershipRequests += 1;
					return Response.json({ itemRefs: feedIds.map((id) => ({ id })) });
				}

				allMembershipRequests += 1;
				return allMembershipRequests <= 2
					? Response.json({ itemRefs: allIds.map((id) => ({ id })) })
					: Response.json({
							itemRefs: allIds.slice(0, 50).map((id) => ({ id })),
							continuation: 'tail',
						});
			}
			if (input === '/reader/api/0/stream/items/contents' && init?.method === 'POST') {
				const ids = [...(init.body?.getAll('i') ?? [])].map(String);
				contentRequests.push(ids);
				if (phase === 'feed') {
					feedContentRequests += 1;
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

	const { elements, dispatchDocumentEvent } = harness;
	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => allMembershipRequests === 1 && elements.get('reader-title')?.textContent === 'Article 1');
	assert.equal(contentRequests.length, 0);
	dispatchDocumentEvent('visibilitychange');
	await waitForBrowserCondition(() => contentRequests.length >= 10, 120);
	await collectBrowserWindowIds(harness);
	for (let page = 0; page < 2; page += 1) {
		elements.get('article-newer-button')!.dispatch('click');
		await waitForTodayWindow(harness);
	}

	await findListButtonByItemId(elements.get('articles-list'), '60')?.dispatch('click');
	await waitForBrowserCondition(() => (elements.get('reader-title')?.textContent ?? '') === 'Article 60');

	phase = 'feed';
	await findListButtonByViewId(elements.get('feeds-list'), 'feed/1')?.dispatch('click');
	await waitForBrowserCondition(() => feedMembershipRequests === 1 && elements.get('reader-title')?.textContent === 'Article 1001');
	assert.equal(feedContentRequests, 0);
	dispatchDocumentEvent('visibilitychange');
	await waitForBrowserCondition(() => feedContentRequests >= 10, 140);
	await collectBrowserWindowIds(harness);

	phase = 'all-refresh';
	const refreshStart = contentRequests.length;
	await findListButtonByViewId(elements.get('views-list'), 'all')?.dispatch('click');
	await waitForBrowserCondition(
		() => allMembershipRequests >= 3 && contentRequests.slice(refreshStart).some((ids) => ids.includes('60')),
		100,
	);

	assert.ok(contentRequests.slice(refreshStart).some((ids) => ids.includes('60')));
	assert.equal(elements.get('reader-title')?.textContent, 'Article 60');
});

test('switching views retries a shared failed body request for the new view', async () => {
	const firstContent = createDeferred<Response>();
	let contentRequests = 0;
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
				return Response.json({ unreadcounts: [{ id: 'feed/1', count: 1 }, { id: 'feed/2', count: 1 }] });
			}
			if (String(input).startsWith('/reader/api/0/stream/items/ids?')) {
				return Response.json({ itemRefs: [{ id: '1' }] });
			}
			if (input === '/reader/api/0/stream/items/contents' && init?.method === 'POST') {
				contentRequests += 1;
				if (contentRequests === 1) {
					return firstContent.promise;
				}
				return Response.json({ items: [{
					id: 'tag:google.com,2005:reader/item/0000000000000001',
					title: 'Article 1',
					published: 1_742_460_800,
					origin: { title: 'Bravo' },
					summary: { content: 'Preview 1' },
					content: { content: '<p>Body 1</p>' },
				}] });
			}
			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});

	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => contentRequests === 1);
	await findListButtonByViewId(elements.get('feeds-list'), 'feed/2')?.dispatch('click');
	await waitForBrowserCondition(() => Boolean(findListButtonByViewId(elements.get('feeds-list'), 'feed/2')));
	firstContent.reject(new Error('temporary body failure'));
	await waitForBrowserCondition(() => contentRequests === 2 && (elements.get('reader-title')?.textContent ?? '') === 'Article 1');

	assert.equal(contentRequests, 2);
	assert.equal(elements.get('reader-title')?.textContent, 'Article 1');
});

test('logout keeps old body requests counted until their network work settles', async () => {
	const oldBodies = [createDeferred<Response>(), createDeferred<Response>()];
	let loginCount = 0;
	let contentRequests = 0;
	let activeNetworkRequests = 0;
	let maximumNetworkRequests = 0;
	const itemIds = Array.from({ length: 60 }, (_, index) => String(index + 1));
	const contentFor = (id: string) => ({
		id: `tag:google.com,2005:reader/item/${Number(id).toString(16).padStart(16, '0')}`,
		title: `Article ${id}`,
		published: 1_742_460_800,
		origin: { title: 'Alpha' },
		summary: { content: `Preview ${id}` },
		content: { content: `<p>Body ${id}</p>` },
	});
	const { elements, dispatchDocumentEvent } = await createBrowserHarness({
		fetchImpl: async (input, init) => {
			if (input === '/accounts/ClientLogin' && init?.method === 'POST') {
				loginCount += 1;
				const token = loginCount === 1 ? 'old-token' : 'new-token';
				return new Response(`SID=pigeon/${token}\nLSID=null\nAuth=pigeon/${token}`, { status: 200 });
			}
			if (input === '/reader/api/0/subscription/list') {
				return Response.json({ subscriptions: [{ id: 'feed/1', title: 'Alpha' }] });
			}
			if (input === '/reader/api/0/unread-count') {
				return Response.json({ unreadcounts: [{ id: 'feed/1', count: 1 }] });
			}
			if (String(input).startsWith('/reader/api/0/stream/contents?')) {
				return Response.json({ items: itemIds.slice(0, 50).map(contentFor) });
			}
			if (String(input).startsWith('/reader/api/0/stream/items/ids?')) {
				return Response.json({ itemRefs: itemIds.map((id) => ({ id })) });
			}
			if (input === '/reader/api/0/stream/items/contents' && init?.method === 'POST') {
				contentRequests += 1;
				activeNetworkRequests += 1;
				maximumNetworkRequests = Math.max(maximumNetworkRequests, activeNetworkRequests);
				if (contentRequests <= oldBodies.length) {
					return oldBodies[contentRequests - 1].promise.then(
						(response) => {
							activeNetworkRequests -= 1;
							return response;
						},
						(error) => {
							activeNetworkRequests -= 1;
							throw error;
						},
					);
				}
				activeNetworkRequests -= 1;
				const ids = [...(init.body?.getAll('i') ?? [])].map(String);
				return Response.json({ items: ids.map(contentFor) });
			}
			throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`);
		},
	});

	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => (elements.get('reader-title')?.textContent ?? '') === 'Article 1');
	assert.equal(contentRequests, 0);
	dispatchDocumentEvent('visibilitychange');
	await waitForBrowserCondition(() => contentRequests === 2 && activeNetworkRequests === 2);

	await elements.get('logout-button')?.dispatch('click');
	await elements.get('login-form')?.dispatch('submit');
	await waitForBrowserCondition(() => loginCount === 2 && (elements.get('reader-title')?.textContent ?? '') === 'Article 1');
	dispatchDocumentEvent('visibilitychange');
	await flushBrowserTasks();
	await flushBrowserTasks();
	assert.equal(contentRequests, 2, 'new session body work waits behind the old requests');

	oldBodies[0].resolve(Response.json({ items: [] }));
	oldBodies[1].resolve(Response.json({ items: [] }));
	await waitForBrowserCondition(() => contentRequests > 2 && (elements.get('reader-title')?.textContent ?? '') === 'Article 1', 100);

	assert.equal(maximumNetworkRequests, 2);
	assert.equal(elements.get('reader-title')?.textContent, 'Article 1');
});
