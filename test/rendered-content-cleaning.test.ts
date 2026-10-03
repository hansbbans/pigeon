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
			return { value: '13' } as T;
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

function createEnv(htmlContent = HTML_WITH_STYLE) {
	const items = [
		{
			rowid: 1,
			id: '9c2772b1-1e53-4de8-89a6-77af6fb9c104',
			feed_key: 'sender-example-com',
			from_name: 'Example Sender',
			subject: 'Styled newsletter',
			html_content: htmlContent,
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

test('article previews decode HTML entities once and preserve literal entity examples', () => {
	assert.equal(createPreviewText({ htmlContent: '<p>&amp;lt;code&amp;gt; &amp;amp; &amp;#x1f4aa; &#x1f4aa; &#38;amp;</p>' }), '&lt;code&gt; &amp; &#x1f4aa; 💪 &amp;');
	assert.equal(createPreviewText({ htmlContent: '<p>&#x110000; &#55296; &#xzz; &unknown;</p>' }), '&#x110000; &#55296; &#xzz; &unknown;');
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

test('email cleaning preserves article images whose dimensions begin with one', () => {
	const images = [
		'<img src="https://images.example/width-100.jpg" width="100">',
		"<img src='https://images.example/height-1200.jpg' height='1200'>",
		'<img src="https://images.example/width-1920.jpg" width=1920>',
		'<img src="https://images.example/width-percent.jpg" width="100%">',
		'<img src="https://images.example/height-percent.jpg" height="1%">',
		'<img src="https://images.example/data-width.jpg" data-width="1">',
		'<img src="https://images.example/alt-width.jpg" alt=\'Diagram with width="1" marker\'>',
	];
	const rendered = createRenderedContent({ htmlContent: `<html><body><p>Article images</p>${images.join('')}
		<img src="https://images.example/pixel-width.gif" width="1">
		<img src="https://images.example/pixel-height.gif" height=1>
		<img src="https://images.example/pixel-px.gif" height='1px'>
		</body></html>` });
	for (const image of images) assert.ok(rendered.includes(image), image);
	assert.doesNotMatch(rendered, /pixel-width|pixel-height|pixel-px/);
});

test('createRenderedContent leaves existing html fragments unchanged', () => {
	assert.equal(
		createRenderedContent({
			htmlContent: HTML_FRAGMENT,
		}),
		HTML_FRAGMENT,
	);
});

test('semantic HTML article fragments retain their heading, quotation and preformatted markup', () => {
	for (const html of [
		'<h2>Today’s notes</h2>',
		'<blockquote>A quotation from the article.</blockquote>',
		'<pre>line one\nline two</pre>',
		'<figure><figcaption>An illustration caption.</figcaption></figure>',
		'<dl><dt>Term</dt><dd>A definition.</dd></dl>',
	]) {
		assert.equal(createRenderedContent({ htmlContent: html }), html);
	}
	const plain = 'Use <code> blocks or <h2> headings and contact <support@example.com> for help.';
	const rendered = createRenderedContent({ htmlContent: plain });
	assert.match(rendered, /&lt;code&gt;/);
	assert.match(rendered, /&lt;h2&gt;/);
	assert.match(rendered, /&lt;support@example.com&gt;/);
});

test('unknown tags with semantic-name prefixes remain literal plain text', () => {
	for (const plain of ['<h2-not-a-tag>Literal example</h2-not-a-tag>', '<pre:syntax>Literal example</pre:syntax>', '<h2\u00a0suffix>Literal example</h2\u00a0suffix>']) {
		const rendered = createRenderedContent({ htmlContent: plain });
		assert.ok(rendered.includes(plain.replaceAll('<', '&lt;').replaceAll('>', '&gt;')));
		assert.match(rendered, /data-pigeon-rendered="plain-text"/);
	}
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

test('Atom and GReader article bodies retain ordinary newsletter images while dropping tracking pixels', async () => {
	const image = '<img src="https://images.example/article.jpg" width="1200" height="100">';
	const html = `<html><body><p>Article with an illustration.</p>${image}<img src="https://images.example/tracker.gif" width="1" height="1"></body></html>`;
	const xml = await generateAtomFeed(
		{ feed_key: 'sender-example-com', display_name: 'Example Sender', from_email: 'sender@example.com', custom_title: null },
		[{ id: '9c2772b1-1e53-4de8-89a6-77af6fb9c104', subject: 'Illustrated newsletter', html_content: html,
			text_content: null, original_url: null, from_name: 'Example Sender', from_email: 'sender@example.com', received_at: '2026-10-01T12:00:00.000Z' }],
		'https://pigeon.example',
	);
	assert.ok(xml.includes(image));
	assert.doesNotMatch(xml, /tracker\.gif/);
	const response = await handleGreaderRequest(new Request('https://pigeon.example/reader/api/0/stream/items/contents?i=1', {
		headers: { Authorization: await generateAuthHeader('secret-password') },
	}), createEnv(html) as never);
	assert.equal(response.status, 200);
	const body = await response.json() as { items: { content: { content: string }; summary: { content: string } }[] };
	assert.equal(body.items.length, 1);
	assert.ok(body.items[0].content.content.includes(image));
	assert.doesNotMatch(body.items[0].content.content, /tracker\.gif/);
	assert.equal(body.items[0].content.content, body.items[0].summary.content);
});

test('Atom and GReader preserve semantic HTML fragments as formatted article bodies', async () => {
	for (const html of ['<h2>Article heading</h2>', '<blockquote>Quoted text.</blockquote>', '<pre>first line\nsecond line</pre>']) {
		const xml = await generateAtomFeed(
			{ feed_key: 'sender-example-com', display_name: 'Example Sender', from_email: null, custom_title: null },
			[{ id: '9c2772b1-1e53-4de8-89a6-77af6fb9c104', subject: 'Formatted article', html_content: html,
				text_content: null, original_url: null, from_name: 'Example Sender', from_email: null, received_at: '2026-10-01T12:00:00.000Z' }],
			'https://pigeon.example',
		);
		assert.ok(xml.includes(`<content type="html"><![CDATA[${html}]]></content>`));
		const response = await handleGreaderRequest(new Request('https://pigeon.example/reader/api/0/stream/items/contents?i=1', {
			headers: { Authorization: await generateAuthHeader('secret-password') },
		}), createEnv(html) as never);
		assert.equal(response.status, 200);
		const body = await response.json() as { items: { content: { content: string }; summary: { content: string } }[] };
		assert.equal(body.items[0].content.content, html);
		assert.equal(body.items[0].summary.content, html);
	}
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


test('reader URL rewriting preserves visible examples, quoted attributes and custom data', () => {
 const html = `<p>Examples href="/example" src='/image' poster="/poster" srcset="/small.png 1x, /large.png 2x"</p><video title="Example poster='/literal' >" data-poster="/custom" poster="/real.jpg"></video><img alt='srcset="/literal.png 1x"' data-srcset="/custom.png 1x" srcset="/small.png 1x, /large.png 2x">`;
 const expected = `<p>Examples href="/example" src='/image' poster="/poster" srcset="/small.png 1x, /large.png 2x"</p><video title="Example poster='/literal' >" data-poster="/custom" poster="https://example.com/real.jpg"></video><img alt='srcset="/literal.png 1x"' data-srcset="/custom.png 1x" srcset="https://example.com/small.png 1x, https://example.com/large.png 2x">`;
 assert.equal(createRenderedContent({ htmlContent: html, originalUrl: 'https://example.com/article' }), expected);
});

test('reader URL rewriting keeps existing raw-text cleaning and SVG links', () => {
 const html = '<p>Body</p><!-- <a href="/comment"> --><script/><a href="/literal">example</a></script><svg><style/><image href="/icon.svg"/></svg><a href="/real">Real</a>';
 const expected = '<div data-pigeon-rendered="email-fragment" style="text-align:left"><p>Body</p><svg><style/><image href="https://example.com/icon.svg"/></svg><a href="https://example.com/real">Real</a></div>';
 assert.equal(createRenderedContent({ htmlContent: html, originalUrl: 'https://example.com/article' }), expected);
});


test('reader URL rewriting preserves comments and textarea examples on the unmodified HTML path', () => {
 const html = '<p>Body</p><!-- <a href="/comment"> --><textarea><a href="/literal">example</a></textarea><a href="/real">Real</a>';
 const expected = '<p>Body</p><!-- <a href="/comment"> --><textarea><a href="/literal">example</a></textarea><a href="https://example.com/real">Real</a>';
 assert.equal(createRenderedContent({ htmlContent: html, originalUrl: 'https://example.com/article' }), expected);
});


test('reader URL callbacks retain quoted entity URLs, fragment links and unquoted attributes', () => {
 const html = `<p><a href='/story?a=1&amp;b=2'>Story</a><a href="#section">Section</a><img src=/unquoted.png><img src="data:image/png;base64,AAAA"></p>`;
 assert.equal(createRenderedContent({ htmlContent: html, originalUrl: 'https://example.com/article' }), `<p><a href='https://example.com/story?a=1&amp;b=2'>Story</a><a href="#section">Section</a><img src=/unquoted.png><img src="data:image/png;base64,AAAA"></p>`);
});


test('reader URL rewriting resumes after self-closing MathML style and title', () => {
 const html = '<p>Body</p><math><style/><title/><mtext>Math</mtext></math><a href="/real">Real</a>';
 const expected = '<div data-pigeon-rendered="email-fragment" style="text-align:left"><p>Body</p><math><style/><title/><mtext>Math</mtext></math><a href="https://example.com/real">Real</a></div>';
 assert.equal(createRenderedContent({ htmlContent: html, originalUrl: 'https://example.com/article' }), expected);
});
