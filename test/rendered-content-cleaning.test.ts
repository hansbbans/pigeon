import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { generateAtomFeed } from '../src/feed';
import { handleGreaderRequest } from '../src/greader';
import { createPreviewText } from '../src/preview-text';
import { createRenderedContent } from '../src/rendered-content';
import { generateApiToken } from '../src/api-auth';

const STYLE_RULES = 'p,div,ul,li{max-width:600px;color:#222;}';
const HTML_WITH_STYLE = `<!doctype html><html><head><style>${STYLE_RULES}</style><script>console.log('ignore me')</script></head><body><!-- hidden --><p>Hello from a stored item.</p></body></html>`;
const FULL_EMAIL_HTML = `<!doctype html><html><head><style>table{table-layout:fixed}.muted{color:#666}</style><script>console.log('ignore me')</script></head><body><div id="preview-text"><span style="display:none;max-height:0;overflow:hidden">Hidden preview copy</span></div><table role="presentation" style="width:100%;table-layout:fixed"><tbody><tr><td><p style="text-align:left">Hello from a stored item.</p><ul><li>First bullet</li></ul><a href="https://example.com/read">Read more</a></td></tr></tbody></table></body></html>`;
const FULL_EMAIL_HTML_WITH_TRACKER_SIBLING = `<!doctype html><html><body><table role="presentation" style="width:100%;table-layout:fixed"><tbody><tr><td><p>Tracker sibling should not block unwrap.</p></td></tr></tbody></table><img src="https://example.open.convertkit-mail.com/open" alt=""></body></html>`;
const WRAPPED_EMAIL_HTML = `<!doctype html><html><body><div class="email-content"><table role="presentation" style="width:100%;margin:0 auto"><tbody><tr><td><p>Wrapped hello.</p><p>Still readable.</p></td></tr></tbody></table></div><div class="email-body-footer"><p>Unsubscribe</p></div><img src="https://example.open.convertkit-mail.com/open" alt=""></body></html>`;
const HTML_FRAGMENT = '<div class="card"><p>Hello from a fragment.</p></div>';

async function generateAuthHeader(password: string): Promise<string> {
	const token = await generateApiToken(password);
	return `GoogleLogin auth=pigeon/${token}`;
}

class FakePreparedStatement {
	private readonly sql: string;
	private readonly items: unknown[];
	private readonly feeds: unknown[];

	constructor(sql: string, items: unknown[], feeds: unknown[]) {
		this.sql = sql;
		this.items = items;
		this.feeds = feeds;
	}

	bind(..._values: unknown[]): this {
		return this;
	}

	async first<T>(): Promise<T | null> {
		if (this.sql === "SELECT value FROM _meta WHERE key = 'schema_version'") {
			return { value: '12' } as T;
		}

		throw new Error(`Unexpected SQL in first(): ${this.sql}`);
	}

	async all<T>(): Promise<{ results: T[] }> {
		if (this.sql === 'PRAGMA table_info(feeds)') {
			return {
				results: [
					'source_type',
					'source_url',
					'fetch_interval_minutes',
					'last_fetched_at',
					'fetch_error',
					'etag',
					'last_modified',
					'icon_url',
					'site_url',
					'category',
				].map((name) => ({ name })) as T[],
			};
		}

		if (this.sql === 'PRAGMA table_info(items)') {
			return { results: [{ name: 'original_url' }] as T[] };
		}

		if (this.sql.includes('SELECT i.rowid, i.id, i.feed_key')) {
			return { results: this.items as T[] };
		}

		if (this.sql.includes('SELECT rowid, feed_key, display_name, custom_title, category, source_url, site_url FROM feeds')) {
			return { results: this.feeds as T[] };
		}

		if (this.sql.includes('JOIN feed_tags ft')) {
			return { results: [] as T[] };
		}

		if (this.sql.includes('SELECT feed_key, category')) {
			return { results: this.feeds as T[] };
		}

		throw new Error(`Unexpected SQL in test: ${this.sql}`);
	}

	async run(): Promise<void> {
		if (
			this.sql.startsWith('CREATE TABLE IF NOT EXISTS _meta') ||
			this.sql.startsWith('INSERT OR IGNORE INTO _meta') ||
			this.sql.startsWith('ALTER TABLE feeds ADD COLUMN ') ||
			this.sql.startsWith('ALTER TABLE items ADD COLUMN ') ||
			this.sql.startsWith('CREATE INDEX IF NOT EXISTS idx_feeds_next_fetch') ||
			this.sql.startsWith('CREATE INDEX IF NOT EXISTS idx_feeds_refresh_due') ||
			this.sql.startsWith('CREATE UNIQUE INDEX IF NOT EXISTS idx_feeds_canonical_url') ||
			this.sql.startsWith('CREATE TABLE IF NOT EXISTS feed_url_aliases') ||
			this.sql.startsWith('CREATE INDEX IF NOT EXISTS idx_feed_url_aliases_') ||
			this.sql.startsWith('CREATE TABLE IF NOT EXISTS refresh_activity') ||
			this.sql.startsWith('CREATE INDEX IF NOT EXISTS idx_refresh_activity_') ||
			this.sql.startsWith('CREATE TABLE IF NOT EXISTS item_statuses') ||
			this.sql.startsWith('CREATE INDEX IF NOT EXISTS idx_item_statuses_') ||
			this.sql.startsWith('INSERT OR IGNORE INTO item_statuses') ||
			this.sql.startsWith('CREATE TRIGGER IF NOT EXISTS trg_items_') ||
			this.sql.startsWith('CREATE TABLE IF NOT EXISTS sync_changes') ||
			this.sql.startsWith('CREATE INDEX IF NOT EXISTS idx_sync_changes_') ||
			this.sql.startsWith('CREATE TABLE IF NOT EXISTS mutation_receipts') ||
			this.sql.startsWith('CREATE INDEX IF NOT EXISTS idx_mutation_receipts_') ||
			this.sql.startsWith('CREATE TRIGGER IF NOT EXISTS trg_sync_') ||
			this.sql.startsWith('INSERT INTO sync_changes') ||
			this.sql.startsWith('CREATE TABLE IF NOT EXISTS feed_tags') ||
			this.sql.startsWith('CREATE INDEX IF NOT EXISTS idx_feed_tags_label') ||
			this.sql.includes('CREATE TABLE IF NOT EXISTS engagement_events') ||
			this.sql.startsWith('ALTER TABLE engagement_events ADD COLUMN destination_host') ||
			this.sql.includes('CREATE INDEX IF NOT EXISTS idx_engagement_events_') ||
			(this.sql.startsWith('INSERT OR IGNORE INTO feed_tags') && this.sql.includes('SELECT feed_key, category')) ||
			this.sql.startsWith('UPDATE _meta SET value')
		) {
			return;
		}

		throw new Error(`Unexpected SQL in run(): ${this.sql}`);
	}
}

function createEnv() {
	const items = [
		{
			rowid: 1,
			id: '9c2772b1-1e53-4de8-89a6-77af6fb9c104',
			feed_key: 'sender-example-com',
			from_name: 'Example Sender',
			subject: 'Styled newsletter',
			html_content: HTML_WITH_STYLE,
			text_content: ' Hello from a stored item. ',
			original_url: 'https://example.com/posts/styled-newsletter',
			received_at: '2026-03-20T12:34:56.000Z',
			is_read: 0,
			is_starred: 0,
		},
	];

	const feeds = [
		{
			rowid: 42,
			feed_key: 'sender-example-com',
			display_name: 'Example Sender',
			custom_title: null,
			category: null,
			source_url: 'https://example.com/feed.xml',
			site_url: 'https://example.com/',
		},
	];

	return {
		API_PASSWORD: 'secret-password',
		BASE_URL: 'https://pigeon.example',
		DB: {
			prepare(sql: string) {
				return new FakePreparedStatement(sql, items, feeds);
			},
		},
	};
}

test('createPreviewText prefers stored plain text when present', () => {
	assert.equal(
		createPreviewText({
			textContent: ' Hello from a stored item. ',
			htmlContent: HTML_WITH_STYLE,
		}),
		'Hello from a stored item.',
	);
});

test('createPreviewText strips CSS text when html is the only preview source', () => {
	assert.equal(
		createPreviewText({
			htmlContent: HTML_WITH_STYLE,
		}),
		'Hello from a stored item.',
	);
});

test('createRenderedContent unwraps full email documents into reader-friendly fragments', () => {
	const rendered = createRenderedContent({
		htmlContent: FULL_EMAIL_HTML,
	});

	assert.doesNotMatch(rendered, /<!doctype|<html|<head|<body|<table|Hidden preview copy|table-layout:fixed/i);
	assert.match(rendered, /<p style="text-align:left">Hello from a stored item\.<\/p>/);
	assert.match(rendered, /<li>First bullet<\/li>/);
	assert.match(rendered, /<a href="https:\/\/example\.com\/read">Read more<\/a>/);
});

test('createRenderedContent unwraps email wrappers even when a tracker image is a sibling node', () => {
	const rendered = createRenderedContent({
		htmlContent: FULL_EMAIL_HTML_WITH_TRACKER_SIBLING,
	});

	assert.match(rendered, /Tracker sibling should not block unwrap\./);
	assert.doesNotMatch(rendered, /<table|open\.convertkit-mail\.com/i);
});

test('createRenderedContent leaves existing html fragments unchanged', () => {
	assert.equal(
		createRenderedContent({
			htmlContent: HTML_FRAGMENT,
		}),
		HTML_FRAGMENT,
	);
});

test('createRenderedContent resolves relative links against an imported item original URL', () => {
	const rendered = createRenderedContent({
		htmlContent:
			'<p><a href="/marginalrevolution/2026/05/example.html#comments">Comments</a><img src="../images/chart.png" srcset="/images/chart.png 1x, https://cdn.example/chart@2x.png 2x"></p>',
		originalUrl: 'https://marginalrevolution.com/marginalrevolution/2026/05/example.html',
	});

	assert.match(
		rendered,
		/<a href="https:\/\/marginalrevolution\.com\/marginalrevolution\/2026\/05\/example\.html#comments">Comments<\/a>/,
	);
	assert.match(
		rendered,
		/<img src="https:\/\/marginalrevolution\.com\/marginalrevolution\/2026\/images\/chart\.png" srcset="https:\/\/marginalrevolution\.com\/images\/chart\.png 1x, https:\/\/cdn\.example\/chart@2x\.png 2x">/,
	);
});

test('createRenderedContent prefers email-content wrappers and drops footer chrome', () => {
	const rendered = createRenderedContent({
		htmlContent: WRAPPED_EMAIL_HTML,
	});

	assert.match(rendered, /<p>Wrapped hello\.<\/p>/);
	assert.match(rendered, /<p>Still readable\.<\/p>/);
	assert.doesNotMatch(rendered, /<table|email-body-footer|Unsubscribe|open\.convertkit-mail\.com/i);
});

test('createPreviewText preserves plain text that uses angle brackets', () => {
	assert.equal(
		createPreviewText({
			htmlContent: 'Contact <support@example.com> for help and use <code> blocks carefully.',
		}),
		'Contact <support@example.com> for help and use <code> blocks carefully.',
	);
});

test('createPreviewText truncates long previews to a readable excerpt', () => {
	const longText = 'Preview text '.repeat(40);
	const preview = createPreviewText({
		textContent: longText,
	});

	assert.ok(preview.length <= 283);
	assert.match(preview, /\.\.\.$/);
});

test('generateAtomFeed adds a clean text summary while keeping full HTML content', async () => {
	const xml = await generateAtomFeed(
		{
			feed_key: 'sender-example-com',
			display_name: 'Example Sender',
			from_email: 'sender@example.com',
			custom_title: null,
		},
		[
			{
				id: '9c2772b1-1e53-4de8-89a6-77af6fb9c104',
				subject: 'Styled newsletter',
				html_content: HTML_WITH_STYLE,
				text_content: ' Hello from a stored item. ',
				original_url: 'https://example.com/posts/styled-newsletter',
				from_name: 'Example Sender',
				from_email: 'sender@example.com',
				received_at: '2026-03-20T12:34:56.000Z',
			},
		],
		'https://pigeon.example',
	);

	assert.match(xml, /<summary type="text">Hello from a stored item\.<\/summary>/);
	assert.match(xml, /<entry xml:base="https:\/\/example\.com\/posts\/styled-newsletter">/);
	assert.match(xml, /<link href="https:\/\/example\.com\/posts\/styled-newsletter"\/>/);
	assert.match(xml, /<content type="html"><!\[CDATA\[/);
	assert.match(xml, /<p>Hello from a stored item\.<\/p>/);
	assert.doesNotMatch(xml, /<!doctype|<html|<head|<body/i);
});

test('handleGreaderRequest returns the full cleaned article body in both summary and content for reader clients', async () => {
	const form = new FormData();
	form.append('i', '1');

	const request = new Request('https://pigeon.example/reader/api/0/stream/items/contents', {
		method: 'POST',
		headers: {
			Authorization: await generateAuthHeader('secret-password'),
		},
		body: form,
	});

	const response = await handleGreaderRequest(request, createEnv() as never);
	assert.equal(response.status, 200);

	const payload = await response.json();
	assert.equal(payload.items.length, 1);
	assert.match(payload.items[0].summary.content, /<p>Hello from a stored item\.<\/p>/);
	assert.equal(payload.items[0].alternate[0].href, 'https://example.com/posts/styled-newsletter');
	assert.equal(payload.items[0].summary.content, payload.items[0].content.content);
	assert.match(payload.items[0].content.content, /<p>Hello from a stored item\.<\/p>/);
	assert.doesNotMatch(payload.items[0].content.content, /<!doctype|<html|<head|<body/i);
});

test('handleGreaderRequest accepts item ids passed in the query string for stream/items/contents', async () => {
	const request = new Request('https://pigeon.example/reader/api/0/stream/items/contents?i=1', {
		method: 'GET',
		headers: {
			Authorization: await generateAuthHeader('secret-password'),
		},
	});

	const response = await handleGreaderRequest(request, createEnv() as never);
	assert.equal(response.status, 200);

	const payload = await response.json();
	assert.equal(payload.items.length, 1);
	assert.match(payload.items[0].summary.content, /<p>Hello from a stored item\.<\/p>/);
});

test('handleGreaderRequest accepts raw urlencoded item ids even without a form content type', async () => {
	const request = new Request('https://pigeon.example/reader/api/0/stream/items/contents', {
		method: 'POST',
		headers: {
			Authorization: await generateAuthHeader('secret-password'),
		},
		body: 'i=1',
	});

	const response = await handleGreaderRequest(request, createEnv() as never);
	assert.equal(response.status, 200);

	const payload = await response.json();
	assert.equal(payload.items.length, 1);
	assert.match(payload.items[0].summary.content, /<p>Hello from a stored item\.<\/p>/);
});
