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

	async all<T>(): Promise<{ results: T[] }> {
		if (this.sql.includes('SELECT i.rowid, i.id, i.feed_key')) {
			return { results: this.items as T[] };
		}

		if (this.sql.includes('SELECT rowid, feed_key, display_name, custom_title FROM feeds')) {
			return { results: this.feeds as T[] };
		}

		throw new Error(`Unexpected SQL in test: ${this.sql}`);
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

test('generateAtomFeed adds a clean text summary while keeping full HTML content', () => {
	const xml = generateAtomFeed(
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
				from_name: 'Example Sender',
				from_email: 'sender@example.com',
				received_at: '2026-03-20T12:34:56.000Z',
			},
		],
		'https://pigeon.example',
	);

	assert.match(xml, /<summary type="text">Hello from a stored item\.<\/summary>/);
	assert.match(xml, /<content type="html"><!\[CDATA\[/);
	assert.match(xml, /<p>Hello from a stored item\.<\/p>/);
	assert.doesNotMatch(xml, /<!doctype|<html|<head|<body/i);
});

test('handleGreaderRequest returns clean preview text and preserves full HTML content', async () => {
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
	assert.equal(payload.items[0].summary.content, 'Hello from a stored item.');
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
	assert.equal(payload.items[0].summary.content, 'Hello from a stored item.');
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
	assert.equal(payload.items[0].summary.content, 'Hello from a stored item.');
});
