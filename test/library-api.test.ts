import * as assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { handleLibraryArticles, handleLibraryListing, LIBRARY_ARTICLES_MAX_IDS } from '../src/library-api';
import { handleIncrementalSync, SYNC_PAGE_BODY_BUDGET } from '../src/sync-api';
import { createSchemaDatabase } from './helpers/sqlite-d1';

const NOW = new Date('2026-11-20T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

interface ListingBody {
	snapshotCursor: string;
	continuation: string | null;
	feeds: Array<{ feedKey: string }>;
	articles: Array<Record<string, unknown> & { id: string }>;
}

function fixture() {
	const { database, db } = createSchemaDatabase();
	return { database, env: { DB: db } as never };
}

function daysAgo(days: number): string {
	return new Date(NOW.getTime() - days * DAY).toISOString();
}

function insertFeeds(database: DatabaseSync): void {
	database.prepare(
		`INSERT INTO feeds (rowid, feed_key, display_name, source_type, source_url, site_url)
		 VALUES (1, 'design-weekly', 'Design Weekly', 'rss', 'https://feeds.example.com/design.xml', 'https://example.com')`,
	).run();
	database.prepare(
		`INSERT INTO feeds (rowid, feed_key, display_name, source_type)
		 VALUES (2, 'pigeon:saved', 'Read It Later', 'saved')`,
	).run();
}

function insertItem(
	database: DatabaseSync,
	id: string,
	options: { receivedAt: string; isRead?: boolean; isStarred?: boolean; feedKey?: string },
): void {
	database.prepare(
		`INSERT INTO items (id, feed_key, from_name, subject, html_content, text_content, original_url,
		  message_id, received_at, is_read, is_starred)
		 VALUES (?, ?, 'Ada', ?, '<p>Body of ' || ?, 'Body', 'https://example.com/' || ?, ?, ?, ?, ?)`,
	).run(
		id,
		options.feedKey ?? 'design-weekly',
		`Title ${id}`,
		id,
		id,
		`message-${id}`,
		options.receivedAt,
		options.isRead ? 1 : 0,
		options.isStarred ? 1 : 0,
	);
}

async function listing(env: never, query: Record<string, string> = {}): Promise<Response> {
	const url = new URL('https://pigeon.example/api/v1/library');
	for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
	return handleLibraryListing(new Request(url), env, NOW);
}

async function listingBody(env: never, query: Record<string, string> = {}): Promise<ListingBody> {
	const response = await listing(env, query);
	assert.equal(response.status, 200, await response.clone().text());
	return response.json() as Promise<ListingBody>;
}

test('listing returns unread, starred, saved and recent read articles but not old read ones', async () => {
	const state = fixture();
	insertFeeds(state.database);
	insertItem(state.database, 'unread-old', { receivedAt: daysAgo(60) });
	insertItem(state.database, 'read-old', { receivedAt: daysAgo(30), isRead: true });
	insertItem(state.database, 'read-recent', { receivedAt: daysAgo(2), isRead: true });
	insertItem(state.database, 'starred-read-old', { receivedAt: daysAgo(90), isRead: true, isStarred: true });
	insertItem(state.database, 'saved-read-old', { receivedAt: daysAgo(90), isRead: true, feedKey: 'pigeon:saved' });

	const body = await listingBody(state.env);

	assert.deepEqual(
		new Set(body.articles.map((article) => article.id)),
		new Set(['unread-old', 'read-recent', 'starred-read-old', 'saved-read-old']),
	);
	assert.equal(body.feeds.length, 2);
	assert.equal(body.continuation, null);
	state.database.close();
});

test('listing pages are keyset ordered, carry one snapshot cursor, and end with a null continuation', async () => {
	const state = fixture();
	insertFeeds(state.database);
	for (let index = 1; index <= 5; index += 1) {
		insertItem(state.database, `unread-${index}`, { receivedAt: daysAgo(index) });
	}
	const maxSequence = (state.database.prepare('SELECT MAX(sequence) AS sequence FROM sync_changes').get() as {
		sequence: number;
	}).sequence;

	const first = await listingBody(state.env, { limit: '2' });
	insertItem(state.database, 'arrived-during-listing', { receivedAt: daysAgo(0) });
	const second = await listingBody(state.env, { limit: '2', continuation: first.continuation ?? '' });
	const third = await listingBody(state.env, { limit: '2', continuation: second.continuation ?? '' });

	assert.equal(first.snapshotCursor, `v1:${maxSequence}`);
	assert.equal(second.snapshotCursor, first.snapshotCursor);
	assert.equal(third.snapshotCursor, first.snapshotCursor);
	assert.equal(first.feeds.length, 2);
	assert.deepEqual(second.feeds, []);
	assert.deepEqual(third.feeds, []);
	const ids = [...first.articles, ...second.articles, ...third.articles].map((article) => article.id);
	assert.deepEqual(ids.slice(0, 5), ['unread-1', 'unread-2', 'unread-3', 'unread-4', 'unread-5']);
	assert.equal(new Set(ids).size, ids.length);
	const lastPage = third.continuation === null ? third : await listingBody(state.env, {
		limit: '2',
		continuation: third.continuation,
	});
	assert.equal(lastPage.continuation, null);
	state.database.close();
});

test('listing article payloads carry no body fields and otherwise match sync', async () => {
	const state = fixture();
	insertFeeds(state.database);
	insertItem(state.database, 'unread-1', { receivedAt: daysAgo(1) });

	const body = await listingBody(state.env);
	const syncResponse = await handleIncrementalSync(new Request('https://pigeon.example/api/v1/sync?limit=200'), state.env);
	const syncBody = await syncResponse.json() as {
		changes: Array<{ entityType: string; entityId: string; payload: Record<string, unknown> }>;
	};
	const syncArticle = syncBody.changes.find((change) => change.entityType === 'article' && change.entityId === 'unread-1');

	const article = body.articles[0];
	assert.ok(article);
	assert.ok(syncArticle);
	assert.equal(article.html, undefined);
	assert.equal(article.text, undefined);
	assert.equal(article.isPaywalled, undefined);
	const { html: _html, text: _text, isPaywalled: _isPaywalled, ...syncMetadata } = syncArticle.payload;
	assert.deepEqual(article, syncMetadata);
	assert.match(article.receivedAt as string, /^\d{4}-\d{2}-\d{2}T.*Z$/);
	state.database.close();
});

test('listing rejects a malformed continuation', async () => {
	const state = fixture();
	const response = await listing(state.env, { continuation: 'bogus' });
	assert.equal(response.status, 400);
	state.database.close();
});

async function fetchArticles(env: never, body: unknown): Promise<Response> {
	return handleLibraryArticles(new Request('https://pigeon.example/api/v1/library/articles', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	}), env);
}

interface ArticlesBody {
	articles: Array<Record<string, unknown> & { id: string; html?: string }>;
	missing: string[];
}

function insertBodyOfLength(database: DatabaseSync, id: string, totalLength: number): void {
	// html + text together make up the body size the page budget counts.
	const half = Math.floor(totalLength / 2);
	database.prepare(
		`INSERT INTO items (id, feed_key, subject, html_content, text_content, message_id, received_at)
		 VALUES (?, 'design-weekly', ?, ?, ?, ?, ?)`,
	).run(id, `Title ${id}`, 'h'.repeat(half), 't'.repeat(totalLength - half), `message-${id}`, daysAgo(1));
}

test('article fetch returns full payloads in request order', async () => {
	const state = fixture();
	insertFeeds(state.database);
	insertItem(state.database, 'first', { receivedAt: daysAgo(3) });
	insertItem(state.database, 'second', { receivedAt: daysAgo(1) });

	const response = await fetchArticles(state.env, { ids: ['second', 'first'] });
	assert.equal(response.status, 200);
	const body = await response.json() as ArticlesBody;

	assert.deepEqual(body.articles.map((article) => article.id), ['second', 'first']);
	assert.equal(body.articles[0]?.html, '<p>Body of second');
	assert.equal(body.articles[0]?.text, 'Body');
	assert.equal(body.articles[0]?.isPaywalled, false);
	assert.deepEqual(body.missing, []);
	state.database.close();
});

test('article fetch reports ids with no item as missing', async () => {
	const state = fixture();
	insertFeeds(state.database);
	insertItem(state.database, 'present', { receivedAt: daysAgo(1) });

	const body = await (await fetchArticles(state.env, { ids: ['gone', 'present'] })).json() as ArticlesBody;

	assert.deepEqual(body.articles.map((article) => article.id), ['present']);
	assert.deepEqual(body.missing, ['gone']);
	state.database.close();
});

test('article fetch trims to the body budget but always returns the first article', async () => {
	const state = fixture();
	insertFeeds(state.database);
	const share = Math.floor(SYNC_PAGE_BODY_BUDGET * 0.4);
	insertBodyOfLength(state.database, 'a', share);
	insertBodyOfLength(state.database, 'b', share);
	insertBodyOfLength(state.database, 'c', share);
	insertBodyOfLength(state.database, 'huge', SYNC_PAGE_BODY_BUDGET * 2);

	const trimmed = await (await fetchArticles(state.env, { ids: ['a', 'b', 'c'] })).json() as ArticlesBody;
	const oversized = await (await fetchArticles(state.env, { ids: ['huge', 'a'] })).json() as ArticlesBody;

	assert.deepEqual(trimmed.articles.map((article) => article.id), ['a', 'b']);
	assert.deepEqual(trimmed.missing, []);
	assert.deepEqual(oversized.articles.map((article) => article.id), ['huge']);
	assert.deepEqual(oversized.missing, []);
	state.database.close();
});

test('article fetch rejects an empty list, more than 50 ids, and a malformed body', async () => {
	const state = fixture();
	const tooMany = Array.from({ length: LIBRARY_ARTICLES_MAX_IDS + 1 }, (_, index) => `id-${index}`);

	assert.equal((await fetchArticles(state.env, { ids: [] })).status, 400);
	assert.equal((await fetchArticles(state.env, { ids: tooMany })).status, 400);
	assert.equal((await fetchArticles(state.env, { ids: [1, 2] })).status, 400);
	assert.equal((await fetchArticles(state.env, 'nope')).status, 400);
	state.database.close();
});

test('article fetch reports an item whose feed is gone as missing instead of dropping it silently', async () => {
	const state = fixture();
	insertFeeds(state.database);
	state.database.exec('PRAGMA foreign_keys = OFF');
	insertItem(state.database, 'orphan', { receivedAt: daysAgo(1), feedKey: 'deleted-feed' });

	const body = await (await fetchArticles(state.env, { ids: ['orphan'] })).json() as ArticlesBody;

	assert.deepEqual(body.articles, []);
	assert.deepEqual(body.missing, ['orphan']);
	state.database.close();
});
