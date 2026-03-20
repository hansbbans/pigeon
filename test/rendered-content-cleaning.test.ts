import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { generateAtomFeed } from '../src/feed';
import { handleGreaderRequest } from '../src/greader';
import { createPreviewText } from '../src/preview-text';
import { generateApiToken } from '../src/api-auth';

const STYLE_RULES = 'p,div,ul,li{max-width:600px;color:#222;}';
const HTML_WITH_STYLE = `<!doctype html><html><head><style>${STYLE_RULES}</style><script>console.log('ignore me')</script></head><body><!-- hidden --><p>Hello from a stored item.</p></body></html>`;

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
	assert.match(xml, /<style>p,div,ul,li\{max-width:600px;color:#222;\}<\/style>/);
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
	assert.match(payload.items[0].content.content, /<style>p,div,ul,li\{max-width:600px;color:#222;\}<\/style>/);
	assert.match(payload.items[0].content.content, /<p>Hello from a stored item\.<\/p>/);
});
