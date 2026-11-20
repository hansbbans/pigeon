import * as assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { handleLibraryListing } from '../src/library-api';
import { handleIncrementalSync } from '../src/sync-api';
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
