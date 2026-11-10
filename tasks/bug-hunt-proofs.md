# Audit 2026-11-09: tests for the findings that were not fixed

Companion to `tasks/bug-hunt.md`. Each test fails on `main` at 895f74a unless marked **not run**.
Worker, web and extension tests were run by the auditors and seen to fail. The iOS tests were written by reading the code and have **not been run** (the shared Mac was saturated by CI); run each one before trusting its finding.

## Worker

### Reader id reused after `remove_saved` (`src/mutation-api.ts:310`)
New file, `npx tsx --test test/<file>.test.ts`. Fails: `reader id was reused for a different article`; the edit-tag stars the new article.

```ts
import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateApiToken } from '../src/api-auth';
import app from '../src/index';
import { createSchemaDatabase } from './helpers/sqlite-d1';

const PASSWORD = 'hunt-password';
const BASE_URL = 'https://pigeon.example';

async function setup() {
	const { database, db } = createSchemaDatabase();
	database.exec(`INSERT INTO feeds (feed_key, display_name, source_type, source_url)
		VALUES ('blog', 'Blog', 'rss', 'https://blog.example.com/feed.xml')`);
	const env = { API_PASSWORD: PASSWORD, BASE_URL, ITEMS_PER_FEED: '50', DB: db };
	const token = await generateApiToken(PASSWORD);
	const request = (path: string, init: RequestInit = {}) => {
		const headers = new Headers(init.headers);
		headers.set('Authorization', `GoogleLogin auth=pigeon/${token}`);
		return app.fetch(new Request(`${BASE_URL}${path}`, { ...init, headers }), env as never);
	};
	const json = (method: string, path: string, body: unknown) => request(path, {
		method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
	});
	const form = (path: string, body: Record<string, string>) => request(path, {
		method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString(),
	});
	const mutate = async (mutations: unknown[]) =>
		await (await json('POST', '/api/v1/mutations', { mutations })).json() as { results: Array<{ status: string; error?: string }> };
	const save = async (url: string) =>
		await (await json('POST', '/api/v1/saved', { url, content: { html: `<p>${url}</p>`, title: `Saved ${url}` } })).json() as { id: string; readerId: string };
	const insertArticle = (id: string, subject: string, isRead = 0) => database.prepare(
		`INSERT INTO items (id, feed_key, subject, html_content, message_id, received_at, is_read)
		 VALUES (?, 'blog', ?, '<p>body</p>', ?, ?, ?)`,
	).run(id, subject, `m-${id}`, new Date().toISOString(), isRead);
	const count = (sql: string) => (database.prepare(sql).get() as { n: number }).n;
	return { database, request, json, form, mutate, save, insertArticle, count };
}

test('after remove_saved the next ingested article does not reuse the removed reader id', async () => {
	const s = await setup();
	const saved = await s.save('https://example.com/removed');
	const ids = async () => (await (await s.request('/reader/api/0/stream/items/ids?s=user/-/state/com.google/reading-list&n=10')).json() as { itemRefs: Array<{ id: string }> }).itemRefs.map((ref) => ref.id);
	const before = await ids();
	await s.mutate([{ id: 'rm-2', kind: 'remove_saved', itemIds: [saved.id] }]);
	s.insertArticle('22222222-2222-4222-8222-222222222222', 'A brand new article');
	await s.form('/reader/api/0/edit-tag', { i: saved.readerId, a: 'user/-/state/com.google/starred' });
	assert.equal(s.count("SELECT is_starred AS n FROM items WHERE id = '22222222-2222-4222-8222-222222222222'"), 0, 'a star aimed at the removed item landed on the new article');
	assert.notDeepEqual(await ids(), before, 'reader id was reused for a different article');
});

// Decision items, same setup(): both fail today and both are pinned by existing tests.
test('set_read for a removed saved item does not fail on every replay', async () => {
	const s = await setup();
	const saved = await s.save('https://example.com/a');
	await s.mutate([{ id: 'rm-1', kind: 'remove_saved', itemIds: [saved.id] }]);
	const queued = { id: 'read-offline-1', kind: 'set_read', itemIds: [saved.id], value: true };
	await s.mutate([queued]);
	assert.notEqual((await s.mutate([queued])).results[0].status, 'failed');
});

test('set_read on an already-read item appends no status sync event', async () => {
	const s = await setup();
	s.insertArticle('33333333-3333-4333-8333-333333333333', 'Already read', 1);
	const before = s.count('SELECT COUNT(*) AS n FROM sync_changes');
	await s.mutate([{ id: 'noop-1', kind: 'set_read', itemIds: ['33333333-3333-4333-8333-333333333333'], value: true }]);
	assert.equal(s.count('SELECT COUNT(*) AS n FROM sync_changes') - before, 0);
});
```

### RSS refresh: oldest-first feeds, guid-less shared links, no-op feed sync rows (`src/rss-fetcher.ts`)
Add to `test/rss-refresh-redirects-duplicates.test.ts`, which already has `setup()`, `serve()`, `rss()` and `item()`. The third test needs `site_url` in `feedRow`'s SELECT only if the fix compares against it; the clean fix is a `WHEN` clause on `trg_sync_feed_update` at the next schema bump.

```ts
test('a feed listed oldest-first with more than 50 entries still delivers its newest entry', async () => {
	const s = setup();
	const dated = (n: number) => `<item><guid>post-${n}</guid><title>Post ${n}</title><link>https://example.com/post-${n}</link><pubDate>${new Date(Date.UTC(2026, 8, n)).toUTCString()}</pubDate><description>body</description></item>`;
	serve(() => rss(Array.from({ length: 60 }, (_, index) => dated(index + 1)).join('')));
	await fetchAndStoreRssFeed(s.env, s.feedRow());
	assert.equal(s.count("SELECT COUNT(*) AS n FROM items WHERE subject = 'Post 60'"), 1, 'newest entry (Post 60) was not stored');
});

test('guid-less items that share one link are stored as separate articles', async () => {
	const s = setup();
	const entry = (n: number) => `<item><title>Release ${n}</title><link>https://example.com/changelog</link><pubDate>2026-11-0${n}T00:00:00Z</pubDate><description>Notes for release ${n}</description></item>`;
	serve(() => rss(entry(3) + entry(2) + entry(1)));
	await fetchAndStoreRssFeed(s.env, s.feedRow());
	assert.equal(s.count('SELECT COUNT(*) AS n FROM items'), 3);
});

test('refreshes that change no feed metadata write no feed sync change', async () => {
	const s = setup();
	const body = rss(item('a', 'A', 'alpha'));
	serve(() => body);
	assert.equal((await fetchAndStoreRssFeed(s.env, s.feedRow())).outcome, 'success');
	const feedChanges = () => s.count("SELECT COUNT(*) AS n FROM sync_changes WHERE entity_type = 'feed'");
	const before = feedChanges();
	for (let poll = 0; poll < 3; poll += 1) assert.equal((await fetchAndStoreRssFeed(s.env, s.feedRow())).outcome, 'unchanged');
	assert.equal(feedChanges() - before, 0);
});
```

Probes (plain scripts, outputs in comments):

```ts
import { computeNextFetchAt } from '../src/refresh-policy';
import { createRenderedContent } from '../src/rendered-content';

const completed = new Date('2026-11-09T10:00:08.000Z');
const nextTick = Date.parse('2026-11-09T11:00:00.000Z');
let late = 0;
for (let i = 0; i < 1000; i += 1) {
	if (Date.parse(computeNextFetchAt(completed, { feedKey: `example-com-feed-${i}-0123456789abcdef01234567`, fetchIntervalMinutes: 60, consecutiveFailures: 0, outcome: 'success' })) > nextTick) late += 1;
}
console.log(late); // 518: about half of 60-minute feeds miss the next hourly tick

console.log(createRenderedContent({ originalUrl: 'https://example.com/post', htmlContent: '<figure><img src="https://example.com/hero.jpg" alt="hero"></figure><div class="main-content"><p>First paragraph of the article body, long enough to count.</p></div><p>Second section that sits after the wrapper div.</p>' }));
// Only the .main-content paragraph survives: the hero image and the second section are dropped.
```

## Web reader

All use `test/helpers/browser-app-client-harness.ts`.

### One failed request latches offline mode (`src/browser-app.ts:1546-1547, 4611`)
`test/browser-app-client-actions.test.ts`. Fails: `no reader request reached the network after the failure`.

```ts
function offlineTools(count = 2) {
	const rows = Array.from({ length: count + 2 }, (_, index) => ({ ...browserRegressionItem(String(index + 1), Date.UTC(2026, 9, 12, 12) / 1000 + index), id: String(index + 1), categories: [] as string[] }));
	const library = { close() {}, async sync() {}, async replay() { return { applied: 0, pending: 0 }; }, async storeBodies() {}, async savePosition() {}, async getPosition() { return 0; },
		async stats() { return { articles: rows.length, savedBodies: rows.length, pending: 0, bodyBytes: 100, lastSync: '2026-10-12T12:00:00Z' }; },
		async feeds() { return [{ feedKey: 'today-source', streamId: 'feed/1', title: 'Today source', isActive: true, folders: [] }]; },
		async contents(ids: string[]) { return { items: rows.filter((row) => ids.includes(row.id)).map((row) => ({ ...row, offlineSaved: true })) }; },
		async query(query: any) { const offset = query.offset || 0, limit = query.limit || 50; return { itemIds: rows.slice(offset, offset + limit).map((row) => row.id), total: rows.length, hasMore: offset + limit < rows.length }; },
		async queueMutation() { return { id: 'queued' }; }, async confirmState() { return { saved: true }; }, async clearCache() {}, async freeOlderReadUnstarred() { return { freed: 0 }; } };
	return { library, accountHash: async () => 'account-hash', hasAccount: async () => true, create: async () => library };
}

test('one failed request does not leave an online reader in offline mode until reload', async (t) => {
	let failNext = false;
	let network: string[] = [];
	const { database, harness } = await createStatefulArticleBrowser({ offlineTools: offlineTools(), fetchOverride: async (input, _init, next) => {
		if (failNext && input.startsWith('/reader/api/0/stream/items/ids?')) { failNext = false; throw new TypeError('Connection reset'); }
		network.push(input);
		return next();
	} });
	t.after(() => database.close());
	const banner = harness.elements.get('offline-mode-banner')!;
	assert.equal(banner.classList.contains('hidden'), true, 'starts online');
	failNext = true;
	harness.setVisibility('visible');
	await waitForBrowserCondition(() => !banner.classList.contains('hidden'), 100);
	for (let visit = 0; visit < 3; visit++) {
		network = [];
		harness.setVisibility('visible');
		await flushBrowserTasks();
		await flushBrowserTasks();
	}
	assert.ok(network.some((input) => input.startsWith('/reader/api/0/')), 'no reader request reached the network after the failure; requests seen: ' + JSON.stringify(network));
	assert.equal(banner.classList.contains('hidden'), true, 'still in offline mode: ' + banner.textContent);
});
```

### Mark all as read downloads every body (`src/browser-app.ts:4663-4721`)
`test/browser-app-client-actions.test.ts`. Fails: `requested 400 article bodies in 20 requests after 4 list pages`.

```ts
test('Mark all as read in All items does not download every already-read article', async (t) => {
	let listRequests = 0, bodyRequests = 0, bodiesRequested = 0, counting = false;
	const { database, harness, mutations } = await createStatefulArticleBrowser({ count: 398, fetchOverride: async (input, init, next) => {
		if (counting && input.startsWith('/api/v1/browser/articles?')) listRequests += 1;
		if (counting && input.endsWith('/stream/items/contents')) { bodyRequests += 1; bodiesRequested += (init?.body as unknown as FormData).getAll('i').length; }
		return next();
	} });
	t.after(() => database.close());
	database.exec("UPDATE items SET is_read=1 WHERE id NOT IN ('today-1','today-2','today-3')");
	harness.elements.get('refresh-view-button')!.dispatch('click');
	await waitForBrowserCondition(() => harness.elements.get('mark-all-as-read-button')!.disabled === false, 1000);
	counting = true;
	harness.elements.get('mark-all-as-read-button')!.dispatch('click');
	await waitForBrowserCondition(() => /Marked 3 articles read/.test(harness.elements.get('article-query-status')!.textContent), 5000);
	assert.equal(mutations.at(-1)!.itemIds.length, 3);
	assert.ok(bodiesRequested <= 3, `marking 3 unread articles read requested ${bodiesRequested} article bodies in ${bodyRequests} requests after ${listRequests} list pages`);
});
```

### Filtered views re-download every body on revalidation (`src/browser-app.ts:3848-3853`)
`test/browser-app-client-refresh.test.ts`. Fails: `filtered view re-requested 42 bodies on one tab focus`.

```ts
test('returning to the tab re-downloads no unchanged bodies, with or without a read filter', async (t) => {
	let bodies = 0;
	const { database, harness } = await createStatefulArticleBrowser({ count: 40, fetchOverride: async (input, init, next) => {
		if (input.endsWith('/stream/items/contents')) bodies += (init?.body as unknown as FormData).getAll('i').length;
		return next();
	} });
	t.after(() => database.close());
	const settle = async () => { for (let turn = 0; turn < 6; turn++) await flushBrowserTasks(); await waitForBrowserCondition(() => { const cache = harness.getCacheSizes(); return cache.active === 0 && cache.pending === 0 && cache.membership === 0; }, 500); };
	await settle();
	bodies = 0;
	harness.setVisibility('visible');
	await settle();
	assert.equal(bodies, 0, 'default All view');
	harness.elements.get('article-read-filter')!.value = 'unread';
	harness.elements.get('article-read-filter')!.dispatch('change');
	await waitForBrowserCondition(() => renderedArticleIds(harness).length === 42, 200);
	await settle();
	const cached = harness.getCacheSizes().bodies;
	bodies = 0;
	harness.setVisibility('visible');
	await settle();
	assert.equal(bodies, 0, `filtered view re-requested ${bodies} bodies on one tab focus although all ${cached} were cached and unchanged`);
});
```

### One pending-mutation slot drops actions (`src/browser-app.ts:4580, 4871`)
`test/browser-app-client-actions.test.ts`. Fails: opened stories 7, 6, 5, 4; only 4 and 7 read.

```ts
test('"Mark read when opened" marks every article opened with J', async (t) => {
	const { database, harness, mutations } = await createStatefulArticleBrowser({ policy: 'opened', count: 6 });
	t.after(() => database.close());
	const settle = async () => { await waitForBrowserCondition(() => harness.elements.get('mark-unread-button')!.disabled === false && harness.getCacheSizes().membership === 0 && harness.getCacheSizes().pending === 0, 500); await flushBrowserTasks(); };
	await settle();
	harness.dispatchKeydown('j'); harness.dispatchKeydown('j'); harness.dispatchKeydown('j');
	await settle(); await settle();
	const read = (database.prepare("SELECT group_concat(subject, ',') AS list FROM (SELECT subject FROM items WHERE is_read=1 ORDER BY rowid)").get() as any).list;
	const opened = ['Story 4', 'Story 5', 'Story 6', 'Story 7'];
	assert.deepEqual(String(read).split(',').filter((title) => opened.includes(title)), opened, 'read on the server: ' + read + '; edit-tag calls: ' + mutations.length);
});
```

## Extension

`extension/test/save.test.ts` and `extension/test/badge.test.ts`; `cd extension && npx tsx --test test/<file>`.

```ts
// Extraction from another page is stored under the clicked URL (src/core/save.ts:59-70).
test('an extraction read from another page is not sent as the content of the tab URL', async () => {
	const store = await signedInStore();
	const { fetch, requests } = mockFetch(() => savedReply('done'));
	const fromOtherPage: PageExtraction = { url: 'https://example.com/b', title: 'B', content: { html: '<p>Body of B</p>', text: 'Body of B', title: 'B', mediaKind: 'text' } };
	await savePage({ url: 'https://example.com/a', title: 'A' }, async () => fromOtherPage, { fetch, store });
	const sent = JSON.parse(requests[0].body);
	assert.ok(!(sent.url === 'https://example.com/a' && sent.content?.html === '<p>Body of B</p>'), `sent ${JSON.stringify(sent)}`);
});

// Double click sends the page twice (src/background/index.ts:94-103). The guard belongs in saveTab.
test('a double click sends the page once', async () => {
	const store = await signedInStore();
	const { fetch, requests } = mockFetch(() => savedReply('done'));
	const page = { url: 'https://example.com/a', title: 'A' };
	const extraction: PageExtraction = { url: page.url, content: { html: '<p>Body</p>', text: 'Body', mediaKind: 'text' } };
	await Promise.all([savePage(page, async () => extraction, { fetch, store }), savePage(page, async () => extraction, { fetch, store })]);
	assert.equal(requests.length, 1);
});

// A result shown without a tab id sticks on the global badge (src/core/badge.ts:46).
type Color = string | [number, number, number, number];
class FakeAction implements ActionApi {
	global = { text: '', color: [0, 0, 0, 0] as Color, title: DEFAULT_TITLE };
	async setBadgeText({ tabId, text }: { tabId?: number; text: string | null }) { if (tabId === undefined) this.global.text = text ?? ''; }
	async setBadgeBackgroundColor({ tabId, color }: { tabId?: number; color: Color }) { if (tabId === undefined) this.global.color = color; }
	async getBadgeBackgroundColor() { return this.global.color; }
	async setTitle({ tabId, title }: { tabId?: number; title: string }) { if (tabId === undefined) this.global.title = title; }
	async getTitle() { return this.global.title; }
}

test('a result shown without a tab id clears after its timeout too', async () => {
	const action = new FakeAction();
	const timers: Array<() => void> = [];
	const badge = new Badge(action, new MemoryStore(), (callback) => timers.push(callback));
	await badge.setQueued(0);
	await badge.showOnTab(undefined, '×', '#6b7280', 'Only web pages can be saved to Pigeon.', 5_000);
	for (const timer of timers.splice(0)) timer();
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.deepEqual({ text: action.global.text, title: action.global.title, timers: timers.length }, { text: '', title: DEFAULT_TITLE, timers: 0 });
});
```

## iOS (none of these have been run)

Run with the command in the repo `CLAUDE.md`, adding `-only-testing:PigeonReaderTests`. A test that passes on current code means its finding is wrong: delete both.

### `PigeonReaderTests/Core/StructuredHTMLSanitizerTests.swift`

```swift
// Sanitizer drops the rest of an article after a void blocked tag (StructuredHTMLSanitizer.swift:73-79).
@Test
func voidBlockedElementsDoNotSwallowTheRestOfTheArticle() {
	let html = #"<p>Before</p><picture><source type="image/webp" srcset="https://cdn.example/a.webp"><img src="https://cdn.example/a.jpg" alt="Photo"></picture><p>After the image</p><ul><li><input type="checkbox" disabled> Task</li></ul><meta itemprop="position" content="1"><p>End</p>"#
	let sanitized = StructuredHTMLSanitizer.sanitize(html: html, baseURL: nil)
	#expect(sanitized.contains("<p>Before</p>"))
	#expect(sanitized.contains(#"src="https://cdn.example/a.jpg""#))
	#expect(sanitized.contains("After the image"))
	#expect(sanitized.contains("Task"))
	#expect(sanitized.contains("<p>End</p>"))
	#expect(sanitized.contains("<source") == false && sanitized.contains("<input") == false && sanitized.contains("<meta") == false)
}

// Article web view never recovers from WebContent termination (StructuredHTMLView.swift).
@MainActor
@Test
func articleWebViewHandlesContentProcessTermination() {
	let coordinator = StructuredHTMLView.Coordinator(
		onLink: { _ in }, onImage: { _, _ in }, onImageFailure: { _ in }, onLayout: { _ in }, onHeight: { _ in },
	)
	#expect(coordinator.responds(to: #selector(WKNavigationDelegate.webViewWebContentProcessDidTerminate(_:))))
}
```

### `PigeonReaderTests/Core/OfflineLibraryStoreTests.swift`

```swift
// contentVersion is never persisted, so the body cache is lost on relaunch (OfflineLibraryStore.swift:1870-1895).
@Test func cachedArticlesKeepTheServerContentVersion() async throws {
	let store = OfflineLibraryStore.inMemory()
	var article = makeArticle(id: "versioned")
	article.contentVersion = "v7"
	try await store.saveArticles([article], collectionID: "feed/daily", accountID: "account-a")
	let snapshot = try await store.loadSnapshot(accountID: "account-a")
	#expect(snapshot.articlesByCollection["feed/daily"]?.first?.contentVersion == "v7")
}

// An article with an empty title fails every sync page containing it (OfflineLibraryStore.swift:1308-1316).
@Test func articleWithAnEmptyTitleDoesNotFailTheSyncPage() async throws {
	let store = OfflineLibraryStore.inMemory()
	let receivedAt = Date(timeIntervalSince1970: 1_000)
	let payload = IncrementalSyncPayload(
		feedKey: "daily", streamId: nil, title: "", feedURL: nil, siteURL: nil, iconURL: nil,
		isActive: nil, folders: nil, id: "article-untitled", readerId: "reader-untitled", source: "Daily",
		author: nil, html: "<p>Body</p>", text: nil, originalURL: nil, receivedAt: receivedAt,
		isRead: false, isStarred: false, isBodyPruned: false, itemId: nil, updatedAt: nil,
		version: nil, mutationId: nil,
	)
	try await store.apply(
		IncrementalSyncPage(cursor: "v1:untitled", hasMore: false, changes: [
			IncrementalSyncChange(sequence: 1, entityType: .article, entityId: "article-untitled", operation: .upsert, changedAt: receivedAt, payload: payload),
		]),
		accountID: "account-a",
	)
	let snapshot = try await store.loadSnapshot(accountID: "account-a")
	#expect(snapshot.cursor == "v1:untitled")
	#expect(snapshot.integrity.state != .needsRepair)
	#expect(snapshot.articlesByCollection[ReaderSection.unread.rawValue]?.map(\.id) == ["article-untitled"])
}

// A pending star on a Read It Later item bumps Unread and Today counts (OfflineLibraryStore.swift:1659-1703).
@Test func starringAnUnreadSavedItemDoesNotCountItAsUnreadNews() async throws {
	let store = OfflineLibraryStore.inMemory()
	let receivedAt = Date(timeIntervalSince1970: 1_000)
	let payload = IncrementalSyncPayload(
		feedKey: SavedItems.feedKey, streamId: nil, title: "Saved link", feedURL: nil, siteURL: nil, iconURL: nil,
		isActive: nil, folders: nil, id: "saved-1", readerId: "reader-saved-1", source: SavedItems.title,
		author: nil, html: "<p>Body</p>", text: nil, originalURL: nil, receivedAt: receivedAt,
		isRead: false, isStarred: false, isBodyPruned: false, itemId: nil, updatedAt: nil,
		version: nil, mutationId: nil,
	)
	try await store.apply(
		IncrementalSyncPage(cursor: "v1:saved", hasMore: false, changes: [
			IncrementalSyncChange(sequence: 1, entityType: .article, entityId: "saved-1", operation: .upsert, changedAt: receivedAt, payload: payload),
		]),
		accountID: "account-a",
	)
	try await store.saveNavigation(
		ReaderNavigationCatalog.make(subscriptions: [], unreadCounts: [], smartCounts: ReaderNavigationSmartCounts(forYou: 0, today: 0, unread: 5, starred: 0, saved: 1)),
		accountID: "account-a",
	)
	try await store.enqueue(
		OfflineMutation(id: "star-saved", kind: .setStarred, itemIds: ["reader-saved-1"], value: true, scope: .single),
		accountID: "account-a",
	)
	let navigation = try #require(try await store.loadSnapshot(accountID: "account-a").navigation)
	#expect(navigation.item(withID: ReaderSection.unread.rawValue)?.unreadCount == 5)
	#expect(navigation.item(withID: ReaderSection.saved.rawValue)?.unreadCount == 1)
	#expect(navigation.item(withID: ReaderSection.starred.rawValue)?.unreadCount == 1)
}

// A mutation the server can never apply is retried forever (OfflineMutationReplayer.swift:152-162).
@Test func mutationTheServerCanNeverApplyDoesNotStayQueuedForever() async throws {
	let store = OfflineLibraryStore.inMemory()
	try await store.enqueue(OfflineMutation(id: "mutation-gone", kind: .setRead, itemIds: ["reader-gone"], value: true, scope: .single), accountID: "account-a")
	let session = PigeonSession(baseURL: try #require(URL(string: "https://pigeon.test")), token: "token")
	let client = PigeonAPIClient(session: session, httpClient: UnknownItemHTTPClient())
	let replayer = OfflineMutationReplayer(store: store)
	for _ in 0..<10 { _ = try await replayer.replay(accountID: "account-a", apiClient: client) }
	#expect(try await store.pendingMutations(accountID: "account-a", limit: 100).isEmpty)
}

// File scope. Answers as the Worker does for an item that no longer exists (resolveItems in src/mutation-api.ts).
private actor UnknownItemHTTPClient: HTTPClient {
	func data(for request: URLRequest) async throws -> (Data, URLResponse) {
		let body = try #require(request.httpBody)
		let envelope = try JSONDecoder().decode(OfflineMutationEnvelope.self, from: body)
		let results = envelope.mutations.map { mutation in
			["mutationId": mutation.id, "status": "failed", "error": "Unknown item \(mutation.itemIds.first ?? "")"]
		}
		let responseBody = try JSONSerialization.data(withJSONObject: ["results": results])
		let url = try #require(request.url)
		let response = try #require(HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil))
		return (responseBody, response)
	}
}
```

### `PigeonReaderTests/Core/ReaderViewExtractorTests.swift`

```swift
// Reader View decodes every page as UTF-8 (ReaderViewExtractor.swift:57).
@Test
func honoursTheResponseCharsetWhenThePageIsNotUTF8() async throws {
	let paragraph = String(repeating: "Le café était fermé à la clientèle. ", count: 8)
	let html = "<!doctype html><html><head><title>Café society</title></head><body><article><h1>Café society</h1><p>\(paragraph)</p></article></body></html>"
	let extractor = ReaderViewExtractor(httpClient: Latin1HTTPClient(body: try #require(html.data(using: .isoLatin1))))
	let document = try await extractor.extract(from: try #require(URL(string: "https://example.com/latin1")))
	#expect(document.title == "Café society")
	#expect(document.textContent?.contains("clientèle") == true)
}

// File scope.
private actor Latin1HTTPClient: HTTPClient {
	private let body: Data
	init(body: Data) { self.body = body }
	func data(for request: URLRequest) async throws -> (Data, URLResponse) {
		let url = try #require(request.url)
		let response = try #require(HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "text/html; charset=ISO-8859-1"]))
		return (body, response)
	}
}
```

### `PigeonReaderTests/App/ReaderAppModelTests.swift` (inside `struct ReaderAppModelTests`)

`cleanupOfflineBodies()` is the smallest public trigger of the generation change that every sync merge performs.

```swift
// A sync merge drops a queued toggle (ReaderAppModel.swift:8187-8193).
@Test(.timeLimit(.minutes(1)))
func readToggleQueuedBehindAnotherMutationSurvivesASnapshotReload() async throws {
	let session = try makeSession(token: "toggle-generation-race")
	let accountID = session.storageIdentity
	let store = PausingOfflineLibraryStore()
	let navigation = ReaderNavigationState(items: [.smart(.forYou, unreadCount: 2), .smart(.unread, unreadCount: 2), .smart(.starred)])
	let first = makeArticle(id: "first-story", receivedAt: 2)
	let second = makeArticle(id: "second-story", receivedAt: 1)
	try await store.saveNavigation(navigation, accountID: accountID)
	try await store.saveArticles([first, second], collectionID: ReaderSection.forYou.rawValue, accountID: accountID)
	let model = try makeModel(httpClient: MockHTTPClient(shouldFail: true), session: session, offlineStore: store)
	model.setNavigation(navigation, markAsLoaded: true)
	model.setArticles([first, second], for: .forYou)
	model.select(section: .forYou)

	await store.pauseNextArticleSave()
	let star = Task { await model.setStarred(first, starred: true) }
	await store.waitUntilArticleSaveIsPaused()
	let read = Task { await model.setRead(second, read: true) }
	for _ in 0..<10 { await Task.yield() }
	let generationBefore = model.libraryGeneration
	await model.cleanupOfflineBodies()
	#expect(model.libraryGeneration != generationBefore)
	await store.resumeArticleSave()
	await star.value
	await read.value

	let pending = try await store.pendingMutations(accountID: accountID, limit: 100)
	#expect(pending.contains { $0.mutation.kind == .setRead && $0.mutation.itemIds == [second.readerId] })
	#expect(model.allArticles(for: .forYou).first { $0.id == second.id }?.isRead == true)
}

// Mark All on a folder returns silently when a merge lands during discovery (ReaderAppModel.swift:4980-4997).
@Test(.timeLimit(.minutes(1)))
func folderMarkAllSurvivesASnapshotReloadDuringDiscovery() async throws {
	let folder = makePaginationCollection()
	let child = ReaderNavigationItem(
		id: "feed/1::\(folder.id)", title: "News", streamID: "feed/1", kind: .feed,
		unreadCount: 3, parentID: folder.id, feedKey: "feed/1", iconURL: nil, smartSection: nil,
	)
	let httpClient = PaginationHTTPClient(streamID: folder.streamID, originStreamID: "feed/1")
	let store = OfflineLibraryStore.inMemory()
	let model = try makeModel(httpClient: httpClient, offlineStore: store)
	let accountID = try #require(model.session?.storageIdentity)
	let navigation = ReaderNavigationState(items: [folder, child])
	let cached = makeArticle(id: "newest", feedKey: "feed/1")
	try await store.saveNavigation(navigation, accountID: accountID)
	try await store.saveArticles([cached], collectionID: folder.id, accountID: accountID)
	model.setNavigation(navigation, markAsLoaded: true)
	model.setArticles([cached], for: folder)
	model.select(item: folder)
	model.articleFilter = .all

	await httpClient.pauseNextItemIDRequest()
	let operation = Task { await model.markAllStoriesAsRead(in: folder) }
	await httpClient.waitUntilItemIDRequestIsPaused()
	let generationBefore = model.libraryGeneration
	await model.cleanupOfflineBodies()
	#expect(model.libraryGeneration != generationBefore)
	await httpClient.resumeItemIDRequest()
	await operation.value

	let pending = try await store.pendingMutations(accountID: accountID, limit: 100)
	#expect(pending.count == 1)
	#expect(model.navigation.item(withID: folder.id)?.unreadCount == 0)
}

// Read It Later open makes every foreground refresh show Offline (ReaderAppModel.swift:1260-1272).
@Test func lifecycleRefreshWithReadItLaterOpenDoesNotReportOffline() async throws {
	let model = try makeModel(httpClient: MockHTTPClient(), offlineSynchronizationEnabled: false)
	model.select(section: .saved)
	model.setApplicationActive(true)
	let accountID = try #require(model.session?.storageIdentity)
	await model.performLifecycleRefresh(accountID: accountID)
	#expect(model.isOffline == false)
}

// Undo of a bulk read over-counts (ReaderAppModel.swift:8131-8141).
@Test func undoingABulkReadAfterRestoringOneStoryByHandKeepsCountsInStepWithTheList() async throws {
	let model = try makeModel(httpClient: MockHTTPClient(shouldFail: true), offlineSynchronizationEnabled: false)
	let feed = ReaderNavigationItem(id: "feed/7", title: "Feed", streamID: "feed/7", kind: .feed, unreadCount: 3, parentID: nil, feedKey: "daily", iconURL: nil, smartSection: nil)
	model.setNavigation(ReaderNavigationState(items: [feed, .smart(.unread, unreadCount: 3)]))
	let stories = (0..<3).map { makeArticle(id: "undo-\($0)", receivedAt: 1_786_272_000 - Double($0)) }
	model.setArticles(stories, for: feed)
	model.select(item: feed)
	model.setArticleFilter(.all, for: feed)

	await model.markStoriesBelowAsRead(stories[0], in: feed)
	#expect(model.navigation.item(withID: feed.id)?.unreadCount == 1)
	await model.setRead(stories[1], read: false)
	#expect(model.navigation.item(withID: feed.id)?.unreadCount == 2)
	await model.undoLastBulkRead()

	#expect(model.allArticles(for: feed).count(where: { $0.isRead == false }) == 3)
	#expect(model.navigation.item(withID: feed.id)?.unreadCount == 3)
	#expect(model.navigation.item(withID: ReaderSection.unread.rawValue)?.unreadCount == 3)
}

// Stale-feed Undo is re-entrant (ReaderAppModel.swift:3622-3669).
@Test func undoingAStaleFeedUnsubscribeTwiceRestoresTheFeedOnce() async throws {
	let store = OfflineLibraryStore.inMemory()
	let model = try makeModel(httpClient: MockHTTPClient(shouldFail: true), offlineStore: store)
	let removed = makeSubscription(id: "feed/1", key: "daily", title: "Daily", folder: "Design")
	let retained = makeSubscription(id: "feed/2", key: "weekly", title: "Weekly", folder: nil)
	installSubscriptions([removed, retained], on: model)
	let accountID = try #require(model.session).storageIdentity
	try await store.saveSubscriptions(model.subscriptions, accountID: accountID)
	try await store.saveNavigation(model.navigation, accountID: accountID)
	let stale = StaleFeed(
		feedKey: removed.feedKey, streamId: removed.id, title: removed.title, sourceType: "rss",
		sourceURL: nil, siteURL: nil, lastArticleAt: nil, lastSuccessAt: nil, httpStatus: nil, archived: false,
	)
	#expect(await model.unsubscribeStaleFeeds([stale]))

	async let first: Void = model.undoStaleFeedAction()
	async let second: Void = model.undoStaleFeedAction()
	_ = await (first, second)

	#expect(model.subscriptions.filter { $0.id == removed.id }.count == 1)
	let pending = try await store.pendingMutations(accountID: accountID, limit: 100)
	#expect(pending.filter { $0.mutation.kind == .restoreFeed }.count == 1)
}

// A case-only folder rename is rejected (ReaderAppModel.swift:3826).
@Test func folderRenameAllowsChangingOnlyLetterCase() async throws {
	let store = OfflineLibraryStore.inMemory()
	let model = try makeModel(httpClient: MockHTTPClient(shouldFail: true), offlineStore: store)
	installSubscriptions([makeSubscription(id: "feed/1", key: "daily", title: "Daily", folder: "design")], on: model)

	let succeeded = await model.renameFolder("design", to: "Design")

	#expect(succeeded)
	#expect(model.folderNavigationItems.map(\.title) == ["Design"])
	let pending = try await store.pendingMutations(accountID: try #require(model.session).storageIdentity, limit: 100)
	#expect(pending.first?.mutation.folders == ["Design"])
}
```

### Manual checks (view logic, no unit test)
- Search cleared by sync: open a feed, search for a matching word, then More → Settings → "Free space from older read articles" → Done. The search field is empty and the full list is back.
- Personalization topics lost: with topics A, B, C saved, open Personalization, go back, slow the network, reopen and immediately add "D". The server then holds only D.
- Website mode: open an article → mode menu → Website → tap Done. Nothing happens.
- ⌘S on the reader screen with a hardware keyboard: stars or sends "More like this", undefined which.
