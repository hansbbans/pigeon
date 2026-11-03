import * as assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { generateApiToken } from '../src/api-auth';
import { handleCronTrigger, runDailyRetention } from '../src/cron-handler';
import app from '../src/index';
import { handleRecommendations, RecommendationSessions } from '../src/recommendations';
import {
	MAX_SAVED_HTML_BYTES,
	normalizePublished,
	normalizeSavedUrl,
	SAVED_FEED_KEY,
	savedMessageId,
} from '../src/saved-items';
import { createSchemaDatabase } from './helpers/sqlite-d1';

const PASSWORD = 'saved-password';
const BASE_URL = 'https://pigeon.example';
const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

async function setup() {
	const { database, db } = createSchemaDatabase();
	database.exec(`INSERT INTO feeds (feed_key, display_name, source_type, source_url)
		VALUES ('blog', 'Blog', 'rss', 'https://blog.example.com/feed.xml')`);
	const sessions = new RecommendationSessions();
	const env = {
		API_PASSWORD: PASSWORD,
		BASE_URL,
		ITEMS_PER_FEED: '50',
		DB: db,
		RECOMMENDATIONS: { getByName: () => ({ fetch: (request: Request) => handleRecommendations(request, env as never, sessions) }) },
	};
	const token = await generateApiToken(PASSWORD);
	const request = (path: string, init: RequestInit = {}) => {
		const headers = new Headers(init.headers);
		headers.set('Authorization', `GoogleLogin auth=pigeon/${token}`);
		return app.fetch(new Request(`${BASE_URL}${path}`, { ...init, headers }), env as never);
	};
	const send = (method: string, path: string, body: unknown) => request(path, {
		method,
		headers: { 'Content-Type': 'application/json' },
		body: typeof body === 'string' ? body : JSON.stringify(body),
	});
	const save = async (body: unknown) => {
		const response = await send('POST', '/api/v1/saved', body);
		return { status: response.status, body: await response.json() as Record<string, unknown> };
	};
	const putContent = async (id: string, body: unknown) => {
		const response = await send('PUT', `/api/v1/saved/${encodeURIComponent(id)}/content`, body);
		return { status: response.status, body: await response.json() as Record<string, unknown> };
	};
	const mutate = async (mutations: unknown[]) => {
		const response = await send('POST', '/api/v1/mutations', { mutations });
		return await response.json() as { results: Array<{ status: string; error?: string }> };
	};
	const sync = async (cursor = '') => {
		const response = await request(`/api/v1/sync?limit=200${cursor ? `&cursor=${cursor}` : ''}`);
		return await response.json() as { cursor: string; changes: Array<{ entityType: string; entityId: string; operation: string; payload: Record<string, unknown> | null }> };
	};
	const item = (id: string) => database.prepare('SELECT * FROM items WHERE id = ?').get(id) as Record<string, unknown> | undefined;
	const syncCount = () => (database.prepare('SELECT COUNT(*) AS count FROM sync_changes').get() as { count: number }).count;
	const syncEvents = (since: number) => database.prepare('SELECT entity_type, operation FROM sync_changes WHERE sequence > ? ORDER BY sequence')
		.all(since).map((row) => ({ ...row })) as Array<{ entity_type: string; operation: string }>;
	const head = () => (database.prepare('SELECT COALESCE(MAX(sequence), 0) AS head FROM sync_changes').get() as { head: number }).head;
	return { database, db, env, request, send, save, putContent, mutate, sync, item, syncCount, syncEvents, head };
}

const ARTICLE_HTML = '<article><h1>Slow software</h1><p>A long essay about patience.</p></article>';

test('normalizeSavedUrl drops fragments and tracking parameters but keeps real ones', () => {
	assert.equal(
		normalizeSavedUrl(' https://Example.com/post?id=7&utm_source=x&UTM_Medium=y&fbclid=1&gclid=2&mc_cid=3&mc_eid=4&ref_src=5&igshid=6#comments ').url,
		'https://example.com/post?id=7',
	);
	assert.equal(normalizeSavedUrl('https://example.com/a?utm_campaign=z').url, 'https://example.com/a');
	assert.equal(normalizeSavedUrl('http://example.com:80/a').url, 'http://example.com/a');
	// `si` and `feature` are only tracking on YouTube.
	assert.equal(normalizeSavedUrl('https://example.com/a?si=1&feature=2').url, 'https://example.com/a?si=1&feature=2');
	assert.equal(normalizeSavedUrl('https://www.youtube.com/@channel?si=abc&feature=share').url, 'https://www.youtube.com/@channel');
	assert.equal(normalizeSavedUrl('https://example.com/a').mediaKind, 'text');
});

test('normalizeSavedUrl collapses YouTube video links to the canonical watch URL', () => {
	const canonical = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
	for (const input of [
		'https://www.youtube.com/watch?v=dQw4w9WgXcQ&si=abc&feature=share&t=42',
		'https://youtu.be/dQw4w9WgXcQ?si=xyz',
		'https://m.youtube.com/watch?v=dQw4w9WgXcQ#t=10',
		'https://www.youtube.com/shorts/dQw4w9WgXcQ',
		'http://youtube.com/watch?v=dQw4w9WgXcQ',
	]) {
		assert.deepEqual(normalizeSavedUrl(input), { url: canonical, mediaKind: 'video' }, input);
	}
});

test('normalizeSavedUrl rejects what cannot be saved', () => {
	for (const input of [
		undefined, 42, '', '   ', 'not a url', 'ftp://example.com/file', 'javascript:alert(1)', 'mailto:a@example.com',
		'https://user:pass@example.com/', `https://example.com/${'a'.repeat(2048)}`,
	]) {
		assert.throws(() => normalizeSavedUrl(input), undefined, String(input));
	}
});

test('savedMessageId is saved: plus the SHA-256 of the normalized URL', async () => {
	const id = await savedMessageId('https://example.com/post');
	assert.match(id, /^saved:[0-9a-f]{64}$/);
	assert.equal(id, await savedMessageId('https://example.com/post'));
	assert.notEqual(id, await savedMessageId('https://example.com/other'));
});

test('normalizePublished keeps only date-shaped values, as ISO 8601 UTC', () => {
	const now = new Date('2026-11-03T12:00:00.000Z');
	assert.equal(normalizePublished('2026-10-01T10:00:00+02:00', now), '2026-10-01T08:00:00.000Z');
	assert.equal(normalizePublished('2026-10-01T10:00:00Z', now), '2026-10-01T10:00:00.000Z');
	assert.equal(normalizePublished('2026-10-01T10:00', now), '2026-10-01T10:00:00.000Z');
	assert.equal(normalizePublished('2026-10-01', now), '2026-10-01T00:00:00.000Z');
	for (const value of ['An hour ago', '1', 'yesterday', '2026-13-45', '2027-01-01', '1800-01-01', '', 7, null]) {
		assert.equal(normalizePublished(value, now), undefined, String(value));
	}
});

test('a bare save creates the Read It Later feed and a pending item', async () => {
	const state = await setup();
	const { status, body } = await state.save({ url: 'https://example.com/essays/slow-software/?utm_source=newsletter' });
	assert.equal(status, 201);
	assert.equal(body.created, true);
	assert.equal(body.state, 'pending');
	assert.equal(body.url, 'https://example.com/essays/slow-software/');
	assert.match(body.id as string, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	assert.match(body.readerId as string, /^tag:google\.com,2005:reader\/item\/[0-9a-f]{16}$/);

	const feed = state.database.prepare('SELECT * FROM feeds WHERE feed_key = ?').get(SAVED_FEED_KEY) as Record<string, unknown>;
	assert.equal(feed.display_name, 'Read It Later');
	assert.equal(feed.source_type, 'saved');
	assert.equal(feed.is_active, 1);
	const row = state.item(body.id as string)!;
	assert.equal(row.feed_key, SAVED_FEED_KEY);
	assert.equal(row.subject, 'example.com/essays/slow-software');
	assert.equal(row.html_content, '');
	assert.equal(row.original_url, 'https://example.com/essays/slow-software/');
	assert.equal(row.message_id, await savedMessageId('https://example.com/essays/slow-software/'));
	assert.equal(row.extraction_state, 'pending');
	assert.equal(row.media_kind, 'text');
	assert.equal(row.is_read, 0);

	const page = await state.sync();
	const feedChange = page.changes.find((change) => change.entityType === 'feed' && change.entityId === SAVED_FEED_KEY);
	assert.equal(feedChange?.payload?.sourceType, 'saved');
	assert.equal(feedChange?.payload?.title, 'Read It Later');
	const blog = page.changes.find((change) => change.entityType === 'feed' && change.entityId === 'blog');
	assert.equal(blog?.payload?.sourceType, 'rss');
	const article = page.changes.find((change) => change.entityType === 'article' && change.entityId === body.id);
	assert.equal(article?.payload?.feedKey, SAVED_FEED_KEY);
	assert.equal(article?.payload?.source, 'Read It Later');
	assert.equal(article?.payload?.extractionState, 'pending');
	assert.equal(article?.payload?.title, 'example.com/essays/slow-software');
});

test('a bare save uses the shared title until extraction', async () => {
	const state = await setup();
	const { body } = await state.save({ url: 'https://example.com/', title: '  Example \n Home  ' });
	assert.equal(state.item(body.id as string)!.subject, 'Example Home');
	const host = await state.save({ url: 'https://example.org/' });
	assert.equal(state.item(host.body.id as string)!.subject, 'example.org');
});

test('re-saving a URL dedupes, marks it unread, and bumps the saved time', async (t) => {
	const state = await setup();
	t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-01T10:00:00.000Z') });
	const first = await state.save({ url: 'https://example.com/a#intro' });
	await state.mutate([{ id: 'read-1', kind: 'set_read', itemIds: [first.body.id], value: true }]);
	assert.equal(state.item(first.body.id as string)!.is_read, 1);

	t.mock.timers.setTime(Date.parse('2026-11-02T10:00:00.000Z'));
	const before = state.head();
	const again = await state.save({ url: 'https://example.com/a?utm_medium=email' });
	assert.equal(again.status, 200);
	assert.equal(again.body.created, false);
	assert.equal(again.body.id, first.body.id);
	assert.equal(again.body.readerId, first.body.readerId);
	const row = state.item(first.body.id as string)!;
	assert.equal(row.is_read, 0);
	assert.equal(row.received_at, '2026-11-02T10:00:00.000Z');
	assert.equal((state.database.prepare('SELECT COUNT(*) AS count FROM items').get() as { count: number }).count, 1);
	assert.deepEqual(state.syncEvents(before), [
		{ entity_type: 'article', operation: 'upsert' },
		{ entity_type: 'status', operation: 'upsert' },
	]);

	// Unread already: only the saved time changes, so only one article event and no status event.
	t.mock.timers.setTime(Date.parse('2026-11-03T10:00:00.000Z'));
	const beforeUnread = state.head();
	await state.save({ url: 'https://example.com/a' });
	assert.deepEqual(state.syncEvents(beforeUnread), [{ entity_type: 'article', operation: 'upsert' }]);
	// The feed already exists and is active, so the feed upsert writes nothing.
	assert.equal((state.database.prepare("SELECT COUNT(*) AS count FROM sync_changes WHERE entity_type = 'feed' AND entity_id = ?").get(SAVED_FEED_KEY) as { count: number }).count, 1);
});

test('saving reactivates a saved feed that an older client unsubscribed from', async () => {
	const state = await setup();
	await state.save({ url: 'https://example.com/a' });
	state.database.exec(`UPDATE feeds SET is_active = 0 WHERE feed_key = '${SAVED_FEED_KEY}'`);
	await state.save({ url: 'https://example.com/b' });
	assert.equal((state.database.prepare('SELECT is_active FROM feeds WHERE feed_key = ?').get(SAVED_FEED_KEY) as { is_active: number }).is_active, 1);
});

test('a save with content stores the extraction and its metadata', async () => {
	const state = await setup();
	const { status, body } = await state.save({
		url: 'https://example.com/slow',
		title: 'Shared title',
		content: {
			html: ARTICLE_HTML,
			title: 'Slow software',
			wordCount: 2412.4,
			author: 'Ada  Lovelace',
			published: '2026-10-01T10:00:00+02:00',
			image: 'https://example.com/cover.jpg',
			site: 'Example Essays',
			mediaKind: 'text',
		},
	});
	assert.equal(status, 201);
	assert.equal(body.state, 'done');
	assert.equal(body.contentTooLarge, undefined);
	const row = state.item(body.id as string)!;
	assert.equal(row.html_content, ARTICLE_HTML);
	assert.equal(row.subject, 'Slow software');
	assert.equal(row.word_count, 2412);
	assert.equal(row.author, 'Ada Lovelace');
	assert.equal(row.from_name, null);
	assert.equal(row.published_at, '2026-10-01T08:00:00.000Z');
	assert.equal(row.image_url, 'https://example.com/cover.jpg');
	assert.equal(row.site_name, 'Example Essays');
	assert.equal(row.content_size, new TextEncoder().encode(ARTICLE_HTML).byteLength);

	const article = (await state.sync()).changes.find((change) => change.entityType === 'article')!;
	assert.equal(article.payload?.author, 'Ada Lovelace');
	assert.equal(article.payload?.html, ARTICLE_HTML);
	assert.equal(article.payload?.extractionState, 'done');
	assert.equal(article.payload?.publishedAt, '2026-10-01T08:00:00.000Z');
	assert.equal(article.payload?.imageURL, 'https://example.com/cover.jpg');
	assert.equal(article.payload?.siteName, 'Example Essays');
	assert.equal(article.payload?.wordCount, 2412);
	assert.equal(article.payload?.mediaKind, 'text');

	const greader = await state.request('/reader/api/0/stream/items/contents', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams([['i', String(Number.parseInt((body.readerId as string).slice(-16), 16))]]).toString(),
	});
	const [greaderItem] = (await greader.json() as { items: Array<Record<string, unknown>> }).items;
	assert.equal(greaderItem.author, 'Ada Lovelace');
	assert.equal(greaderItem.extractionState, 'done');
	assert.equal(greaderItem.imageUrl, 'https://example.com/cover.jpg');
	assert.equal(greaderItem.siteName, 'Example Essays');
	assert.equal(greaderItem.publishedAt, '2026-10-01T08:00:00.000Z');
});

test('unusable metadata is dropped rather than rejected', async () => {
	const state = await setup();
	const { status, body } = await state.save({
		url: 'https://example.com/messy',
		content: { html: ARTICLE_HTML, published: 'An hour ago', image: 'javascript:alert(1)', wordCount: -5, durationSeconds: 'long', author: '   ' },
	});
	assert.equal(status, 201);
	const row = state.item(body.id as string)!;
	assert.equal(row.published_at, null);
	assert.equal(row.image_url, null);
	assert.equal(row.word_count, null);
	assert.equal(row.duration_seconds, null);
	assert.equal(row.author, null);
	const article = (await state.sync()).changes.find((change) => change.entityType === 'article')!;
	assert.equal('publishedAt' in article.payload!, false);
	assert.equal('imageURL' in article.payload!, false);
});

test('oversize content is not stored and the item stays pending', async () => {
	const state = await setup();
	const html = `<p>${'é'.repeat(MAX_SAVED_HTML_BYTES / 2)}</p>`;
	const { status, body } = await state.save({ url: 'https://example.com/huge', content: { html, title: 'Huge', wordCount: 450_000 } });
	assert.equal(status, 201);
	assert.equal(body.state, 'pending');
	assert.equal(body.contentTooLarge, true);
	const row = state.item(body.id as string)!;
	assert.equal(row.html_content, '');
	assert.equal(row.extraction_state, 'pending');
	assert.equal(row.subject, 'Huge');

	// A done item keeps its stored body when a later upload is too large.
	await state.putContent(body.id as string, { html: ARTICLE_HTML });
	const later = await state.putContent(body.id as string, { html });
	assert.equal(later.status, 200);
	assert.equal(later.body.state, 'done');
	assert.equal(later.body.contentTooLarge, true);
	assert.equal(state.item(body.id as string)!.html_content, ARTICLE_HTML);
});

test('content upload completes a pending item; an identical upload writes nothing', async () => {
	const state = await setup();
	const saved = await state.save({ url: 'https://example.com/later', title: 'Later' });
	const id = saved.body.id as string;
	const versionBefore = state.item(id)!.content_version as number;

	const first = await state.putContent(id, { html: ARTICLE_HTML, title: 'Slow software', wordCount: 900, site: 'Example' });
	assert.equal(first.status, 200);
	assert.deepEqual(first.body, { id, readerId: saved.body.readerId, url: 'https://example.com/later', state: 'done', updated: true });
	const row = state.item(id)!;
	assert.equal(row.extraction_state, 'done');
	assert.equal(row.html_content, ARTICLE_HTML);
	assert.equal(row.subject, 'Slow software');
	assert.equal(row.content_version, versionBefore + 1);

	const before = state.syncCount();
	const repeat = await state.putContent(id, { html: ARTICLE_HTML, title: 'Slow software', wordCount: 900, site: 'Example' });
	assert.equal(repeat.body.updated, false);
	assert.equal(state.syncCount(), before);
	assert.equal(state.item(id)!.content_version, versionBefore + 1);

	// The reader ID works as the path id too.
	const byReaderId = await state.putContent(saved.body.readerId as string, { html: ARTICLE_HTML, wordCount: 901 });
	assert.equal(byReaderId.body.updated, true);
	assert.equal(state.item(id)!.word_count, 901);
});

test('a re-save with content updates the stored extraction', async () => {
	const state = await setup();
	const saved = await state.save({ url: 'https://example.com/x' });
	const again = await state.save({ url: 'https://example.com/x', content: { html: ARTICLE_HTML, title: 'X' } });
	assert.equal(again.status, 200);
	assert.equal(again.body.created, false);
	assert.equal(again.body.state, 'done');
	assert.equal(state.item(saved.body.id as string)!.html_content, ARTICLE_HTML);
});

test('extraction failure is reported, and a re-save retries it', async () => {
	const state = await setup();
	const saved = await state.save({ url: 'https://example.com/paywall' });
	const id = saved.body.id as string;
	const failed = await state.putContent(id, { failed: true });
	assert.equal(failed.status, 200);
	assert.equal(failed.body.state, 'failed');
	assert.equal(failed.body.updated, true);
	assert.equal(state.item(id)!.extraction_state, 'failed');
	const repeat = await state.putContent(id, { failed: true });
	assert.equal(repeat.body.updated, false);

	const resaved = await state.save({ url: 'https://example.com/paywall' });
	assert.equal(resaved.body.state, 'pending');
	assert.equal(state.item(id)!.extraction_state, 'pending');

	// A failure report never downgrades a finished extraction.
	await state.putContent(id, { html: ARTICLE_HTML });
	const late = await state.putContent(id, { failed: true });
	assert.equal(late.body.state, 'done');
	assert.equal(late.body.updated, false);
	assert.equal(state.item(id)!.extraction_state, 'done');
});

test('YouTube saves are videos; their content needs no html', async () => {
	const state = await setup();
	const saved = await state.save({ url: 'https://youtu.be/dQw4w9WgXcQ?si=share' });
	assert.equal(saved.body.url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
	assert.equal(saved.body.state, 'pending');
	const id = saved.body.id as string;
	assert.equal(state.item(id)!.media_kind, 'video');
	const content = await state.putContent(id, {
		title: 'Never Gonna Give You Up', author: 'Rick Astley', site: 'YouTube',
		image: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg', durationSeconds: 213, mediaKind: 'text',
	});
	assert.equal(content.body.state, 'done');
	const row = state.item(id)!;
	assert.equal(row.media_kind, 'video');
	assert.equal(row.duration_seconds, 213);
	assert.equal(row.html_content, '');
	// Same video under another link shape is the same item.
	const again = await state.save({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&feature=youtu.be' });
	assert.equal(again.body.id, id);
});

test('save and content requests are validated', async () => {
	const state = await setup();
	assert.equal((await state.save({ url: 'ftp://example.com/x' })).status, 400);
	assert.equal((await state.save({})).status, 400);
	assert.equal((await state.save([])).status, 400);
	assert.equal((await state.save('{not json')).status, 400);
	assert.equal((await state.save({ url: 'https://example.com/x', title: 5 })).status, 400);
	assert.equal((await state.save({ url: 'https://example.com/x', content: 'html' })).status, 400);
	assert.equal((await state.save({ url: 'https://example.com/x', content: { html: 5 } })).status, 400);
	assert.equal((await state.save({ url: 'https://example.com/x', content: { title: 'No body' } })).status, 400);
	const huge = await state.send('POST', '/api/v1/saved', JSON.stringify({ url: 'https://example.com/x', content: { html: 'a'.repeat(2_000_001) } }));
	assert.equal(huge.status, 413);
	assert.equal((await state.send('GET', '/api/v1/saved', undefined)).status, 405);
	assert.equal((await state.db.database.prepare('SELECT COUNT(*) AS count FROM items').get() as { count: number }).count, 0);

	const saved = await state.save({ url: 'https://example.com/ok' });
	const id = saved.body.id as string;
	assert.equal((await state.putContent(id, { failed: false })).status, 400);
	assert.equal((await state.putContent(id, { failed: true, html: ARTICLE_HTML })).status, 400);
	assert.equal((await state.putContent(id, { wordCount: 5 })).status, 400);
	assert.equal((await state.putContent('3e6fad85-8a4b-4cbf-ad84-4c5a6f7e8d94', { html: ARTICLE_HTML })).status, 404);
	assert.equal((await state.putContent('not-an-id', { html: ARTICLE_HTML })).status, 404);
	state.database.exec(`INSERT INTO items (id, feed_key, subject, html_content, message_id, received_at)
		VALUES ('4f7abe96-9b5c-4dc0-be95-5d6b7a8f9ea5', 'blog', 'Feed post', '<p>x</p>', 'rss-1', '2026-11-01T00:00:00.000Z')`);
	assert.equal((await state.putContent('4f7abe96-9b5c-4dc0-be95-5d6b7a8f9ea5', { html: ARTICLE_HTML })).status, 404);
	assert.equal(state.item('4f7abe96-9b5c-4dc0-be95-5d6b7a8f9ea5')!.html_content, '<p>x</p>');
	assert.equal((await state.send('POST', `/api/v1/saved/${id}/content`, { html: ARTICLE_HTML })).status, 405);

	const unauthenticated = await app.fetch(new Request(`${BASE_URL}/api/v1/saved`, { method: 'POST', body: '{}' }), state.env as never);
	assert.equal(unauthenticated.status, 401);
});

test('archive and unarchive are the read mutation', async () => {
	const state = await setup();
	const { body } = await state.save({ url: 'https://example.com/archive-me' });
	const archived = await state.mutate([{ id: 'archive-1', kind: 'set_read', itemIds: [body.id], value: true }]);
	assert.equal(archived.results[0].status, 'applied');
	assert.equal(state.item(body.id as string)!.is_read, 1);
	const restored = await state.mutate([{ id: 'archive-2', kind: 'set_read', itemIds: [body.readerId], value: false }]);
	assert.equal(restored.results[0].status, 'applied');
	assert.equal(state.item(body.id as string)!.is_read, 0);
});

test('remove_saved deletes the item and sync tells every client', async () => {
	const state = await setup();
	const keep = await state.save({ url: 'https://example.com/keep' });
	const drop = await state.save({ url: 'https://example.com/drop' });
	const dropId = drop.body.id as string;
	await state.mutate([{ id: 'read-drop', kind: 'set_read', itemIds: [dropId], value: true }]);
	state.database.prepare(`INSERT INTO item_transcripts (item_id, html, text) VALUES (?, '<p>t</p>', 't')`).run(dropId);
	const synced = await state.sync();
	const eventsBefore = state.syncCount();

	const removed = await state.mutate([{ id: 'remove-1', kind: 'remove_saved', itemIds: [drop.body.readerId] }]);
	assert.equal(removed.results[0].status, 'applied');
	assert.equal(state.item(dropId), undefined);
	assert.ok(state.item(keep.body.id as string));
	for (const table of ['item_statuses', 'item_transcripts', 'engagement_events']) {
		assert.equal((state.database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE item_id = ?`).get(dropId) as { count: number }).count, 0, table);
	}
	// The log only grows.
	assert.equal(state.syncCount(), eventsBefore + 1);

	const page = await state.sync(synced.cursor);
	assert.deepEqual(page.changes.map(({ entityType, entityId, operation, payload }) => ({ entityType, entityId, operation, payload })), [
		{ entityType: 'article', entityId: dropId, operation: 'delete', payload: null },
	]);
	// A full sync from the start compacts the item's earlier events behind its delete.
	const full = await state.sync();
	assert.deepEqual(full.changes.filter((change) => change.entityId === dropId).map((change) => change.operation), ['delete']);

	// Replays and retries under a new id both succeed.
	assert.equal((await state.mutate([{ id: 'remove-1', kind: 'remove_saved', itemIds: [dropId] }])).results[0].status, 'already_applied');
	assert.equal((await state.mutate([{ id: 'remove-2', kind: 'remove_saved', itemIds: [dropId] }])).results[0].status, 'applied');
	assert.equal(state.syncCount(), eventsBefore + 1);

	// Saving the URL again brings it back under the same id.
	const back = await state.save({ url: 'https://example.com/drop' });
	assert.equal(back.status, 201);
	assert.equal(back.body.id, dropId);
	const after = await state.sync(page.cursor);
	assert.deepEqual(after.changes.map((change) => [change.entityType, change.operation]), [['article', 'upsert'], ['status', 'upsert']]);
});

test('remove_saved refuses items outside Read It Later', async () => {
	const state = await setup();
	state.database.exec(`INSERT INTO items (id, feed_key, subject, html_content, message_id, received_at)
		VALUES ('4f7abe96-9b5c-4dc0-be95-5d6b7a8f9ea5', 'blog', 'Feed post', '<p>x</p>', 'rss-1', '2026-11-01T00:00:00.000Z')`);
	const saved = await state.save({ url: 'https://example.com/keep' });
	const result = await state.mutate([{ id: 'remove-feed-item', kind: 'remove_saved', itemIds: [saved.body.id, '4f7abe96-9b5c-4dc0-be95-5d6b7a8f9ea5'] }]);
	assert.equal(result.results[0].status, 'failed');
	assert.match(result.results[0].error ?? '', /not a saved item/);
	assert.ok(state.item('4f7abe96-9b5c-4dc0-be95-5d6b7a8f9ea5'));
	assert.ok(state.item(saved.body.id as string));
	const empty = await state.send('POST', '/api/v1/mutations', { mutations: [{ id: 'remove-none', kind: 'remove_saved', itemIds: [] }] });
	assert.equal(empty.status, 400);
});

test('retention never prunes Read It Later bodies', async () => {
	const state = await setup();
	await state.save({ url: 'https://example.com/seed' });
	const insert = state.database.prepare(
		`INSERT INTO items (id, feed_key, subject, html_content, message_id, received_at, is_read)
		 VALUES (?, ?, ?, '<p>Body</p>', ?, ?, 1)`,
	);
	for (let index = 0; index < 205; index++) {
		const receivedAt = new Date(Date.parse('2024-01-01T00:00:00.000Z') + index * 60_000).toISOString();
		insert.run(`saved-${index}`, SAVED_FEED_KEY, `Saved ${index}`, `saved:${index}`, receivedAt);
		insert.run(`rss-${index}`, 'blog', `Post ${index}`, `rss:${index}`, receivedAt);
	}
	assert.equal(await runDailyRetention(state.db as never, new Date('2026-11-03T00:00:00.000Z')), true);
	const pruned = (feedKey: string) => (state.database.prepare(
		'SELECT COUNT(*) AS count FROM items WHERE feed_key = ? AND content_pruned_at IS NOT NULL',
	).get(feedKey) as { count: number }).count;
	assert.equal(pruned('blog'), 5);
	assert.equal(pruned(SAVED_FEED_KEY), 0);
});

test('the cron never refreshes the saved feed', async () => {
	const state = await setup();
	state.database.exec("UPDATE feeds SET is_active = 0 WHERE feed_key = 'blog'");
	await state.save({ url: 'https://example.com/a' });
	let fetches = 0;
	globalThis.fetch = (async () => {
		fetches += 1;
		return new Response('', { status: 500 });
	}) as typeof fetch;
	await handleCronTrigger(state.env as never);
	assert.equal(fetches, 0);
	const feed = state.database.prepare('SELECT refresh_lease_until, last_attempt_at, last_fetched_at FROM feeds WHERE feed_key = ?')
		.get(SAVED_FEED_KEY) as Record<string, unknown>;
	assert.deepEqual({ ...feed }, { refresh_lease_until: null, last_attempt_at: null, last_fetched_at: null });
	assert.equal((state.database.prepare('SELECT COUNT(*) AS count FROM refresh_activity').get() as { count: number }).count, 0);
});

test('saved items stay out of Today, All, folders, starred, recommendations, stale feeds and OPML', async () => {
	const state = await setup();
	state.database.exec(`INSERT INTO feed_tags (feed_key, label) VALUES ('blog', 'Reading');
		INSERT INTO items (id, feed_key, subject, html_content, message_id, received_at, is_starred)
		VALUES ('4f7abe96-9b5c-4dc0-be95-5d6b7a8f9ea5', 'blog', 'Feed post', '<p>x</p>', 'rss-1', '2026-11-01T00:00:00.000Z', 1)`);
	const saved = await state.save({ url: 'https://example.com/saved' });
	state.database.prepare('UPDATE items SET is_starred = 1 WHERE id = ?').run(saved.body.id);
	const savedRowid = Number.parseInt((saved.body.readerId as string).slice(-16), 16);
	const feedRowid = (state.database.prepare('SELECT rowid FROM feeds WHERE feed_key = ?').get(SAVED_FEED_KEY) as { rowid: number }).rowid;
	const ids = async (query: string) => {
		const response = await state.request(`/api/v1/browser/articles?${query}`);
		assert.equal(response.status, 200, query);
		return (await response.json() as { itemIds: string[] }).itemIds.map(Number);
	};
	const feedItemRowid = (state.database.prepare("SELECT rowid FROM items WHERE feed_key = 'blog'").get() as { rowid: number }).rowid;
	assert.deepEqual(await ids('stream=all'), [feedItemRowid]);
	assert.deepEqual(await ids('stream=all&since=2026-01-01T00:00:00.000Z&before=2030-01-01T00:00:00.000Z'), [feedItemRowid]);
	assert.deepEqual(await ids('stream=user/-/label/Reading'), [feedItemRowid]);
	assert.deepEqual(await ids('stream=starred'), [feedItemRowid]);
	assert.deepEqual(await ids('stream=saved'), [savedRowid]);
	assert.deepEqual(await ids('stream=saved&filter=read'), []);
	assert.deepEqual(await ids(`stream=feed/${feedRowid}`), [savedRowid]);

	for (const view of ['unread', 'starred', 'for-you']) {
		const response = await state.request(`/api/v1/recommendations?view=${view}`);
		const items = (await response.json() as { items: Array<{ feedKey: string }> }).items;
		assert.equal(items.some((entry) => entry.feedKey === SAVED_FEED_KEY), false, view);
	}

	state.database.exec(`UPDATE items SET received_at = '2020-01-01T00:00:00.000Z';
		UPDATE feeds SET first_seen_at = '2020-01-01T00:00:00.000Z'`);
	const stale = await (await state.request('/api/v1/stale-feeds?days=90')).json() as { feeds: Array<{ feedKey: string }> };
	assert.deepEqual(stale.feeds.map((feed) => feed.feedKey), ['blog']);

	// The public Atom feed and feed list never expose the reading list.
	const atom = await app.fetch(new Request(`${BASE_URL}/feed/${SAVED_FEED_KEY}`), state.env as never);
	assert.equal(atom.status, 404);
	const feedList = await (await app.fetch(new Request(`${BASE_URL}/feeds`), state.env as never)).json() as { feeds: Array<{ feed_key: string }> };
	assert.deepEqual(feedList.feeds.map((feed) => feed.feed_key), ['blog']);

	const opml = await (await state.request('/feeds/opml')).text();
	assert.equal(opml.includes('Read It Later'), false);
	assert.equal(opml.includes('Blog'), true);

	// Older Google Reader clients still see it as an ordinary feed.
	const subscriptions = await (await state.request('/reader/api/0/subscription/list')).json() as { subscriptions: Array<{ title: string; sourceType: string }> };
	assert.deepEqual(subscriptions.subscriptions.map((feed) => [feed.title, feed.sourceType]).sort(), [['Blog', 'rss'], ['Read It Later', 'saved']]);
});
