import assert from 'node:assert/strict';
import { test } from 'node:test';
import Defuddle from 'defuddle';
import { JSDOM } from 'jsdom';
import { utf8Bytes } from '../src/core/payload';
import { durationFromSchema, extractPage, fitToBudget, type DefuddleConstructor } from '../src/page/extract';

const D = Defuddle as unknown as DefuddleConstructor;

function page(html: string, url: string): Document {
	return new JSDOM(html, { url }).window.document;
}

const paragraphs = (count: number, words = 40) =>
	Array.from({ length: count }, (_, i) => `<p>Paragraph ${i} ${'slow software lasts because it is maintained '.repeat(words / 8)}</p>`).join('\n');

const ARTICLE = `<!doctype html><html><head>
<title>Slow software | Example Essays</title>
<meta property="og:site_name" content="Example Essays">
<meta property="og:image" content="/images/slow.jpg">
<meta name="author" content="Ada Lovelace">
<meta property="article:published_time" content="2026-10-28T09:30:00+01:00">
</head><body>
<nav><a href="/">Home</a> <a href="/about">About</a></nav>
<article><h1>Slow software</h1>${paragraphs(12)}</article>
<footer>Subscribe to our newsletter</footer>
</body></html>`;

test('extracts an article with Defuddle: html, text and metadata', () => {
	const url = 'https://example.com/essays/slow';
	const result = extractPage(page(ARTICLE, url), D);
	assert.equal(result.url, url);
	assert.equal(result.title, 'Slow software | Example Essays');
	const content = result.content!;
	assert.ok(content, result.error);
	assert.equal(content.mediaKind, 'text');
	assert.match(content.html!, /Paragraph 11/);
	assert.doesNotMatch(content.html!, /Subscribe to our newsletter/);
	assert.match(content.text!, /^.*Paragraph 0 slow software/);
	assert.doesNotMatch(content.text!, /</);
	assert.equal(content.author, 'Ada Lovelace');
	assert.equal(content.site, 'Example Essays');
	assert.equal(content.image, 'https://example.com/images/slow.jpg');
	assert.equal(content.published, '2026-10-28T09:30:00+01:00');
	assert.ok((content.wordCount ?? 0) > 400);
});

test('a page without readable text yields no content, so the link is saved bare', () => {
	const result = extractPage(page('<html><head><title>Login</title></head><body><form><input></form></body></html>', 'https://example.com/login'), D);
	assert.equal(result.content, undefined);
	assert.equal(result.title, 'Login');
	assert.ok(result.error);
});

test('a Defuddle crash is caught and reported, never thrown', () => {
	class Broken {
		constructor() {}
		parse(): never {
			throw new Error('boom');
		}
	}
	const result = extractPage(page(ARTICLE, 'https://example.com/a'), Broken as unknown as DefuddleConstructor);
	assert.equal(result.content, undefined);
	assert.equal(result.error, 'boom');
});

test('a huge page is trimmed at element boundaries to fit html plus text in the budget', () => {
	const big = ARTICLE.replace(paragraphs(12), paragraphs(4000, 80));
	const result = extractPage(page(big, 'https://example.com/huge'), D);
	const content = result.content!;
	assert.ok(content);
	const size = utf8Bytes(content.html!) + utf8Bytes(content.text!);
	assert.ok(size <= 890_000, `html+text is ${size}`);
	assert.ok(size > 500_000, `trimmed too much: ${size}`);
	assert.ok(content.html!.includes('Paragraph 0 '));
	assert.ok(!content.html!.includes('Paragraph 3999 '), 'the end of the page is cut');
	assert.ok(/<\/p>\s*<\/article><p><em>Pigeon kept the first part/.test(content.html!), 'notice follows a whole element');
});

test('fitToBudget descends into a single oversized block and drops data: images', () => {
	const { document } = new JSDOM('').window;
	const template = document.createElement('template');
	template.innerHTML = `<div><img src="data:image/png;base64,${'A'.repeat(5000)}">${'<p>word word word word</p>'.repeat(2000)}</div>`;
	const fitted = fitToBudget(document, template, 20_000);
	assert.equal(fitted.trimmed, true);
	assert.ok(utf8Bytes(fitted.html) + utf8Bytes(fitted.text) <= 20_000);
	assert.doesNotMatch(fitted.html, /data:image/);
	assert.match(fitted.html, /^<div><p>word/);
	const small = document.createElement('template');
	small.innerHTML = '<p>short</p>';
	assert.deepEqual(fitToBudget(document, small, 20_000), { html: '<p>short</p>', text: 'short', trimmed: false });
});

const VIDEO_ID = 'dQw4w9WgXcQ';
const YOUTUBE = `<!doctype html><html><head><title>Never Gonna Give You Up - YouTube</title>
<meta property="og:title" content="Never Gonna Give You Up">
<meta property="og:image" content="https://i.ytimg.com/vi/${VIDEO_ID}/maxresdefault.jpg">
<meta property="og:url" content="https://www.youtube.com/watch?v=${VIDEO_ID}">
<script type="application/ld+json">${JSON.stringify({
	'@context': 'https://schema.org', '@type': 'VideoObject', '@id': `https://www.youtube.com/watch?v=${VIDEO_ID}`,
	name: 'Never Gonna Give You Up', description: 'The official video.\\nRemastered in 4K.', duration: 'PT3M33S',
	uploadDate: '2009-10-25T06:57:33-07:00', thumbnailUrl: [`https://i.ytimg.com/vi/${VIDEO_ID}/maxresdefault.jpg`],
	author: 'Rick Astley',
})}</script>
</head><body>
<div id="owner"><ytd-channel-name><a href="/@RickAstleyYT">Rick Astley</a></ytd-channel-name></div>
<div id="movie_player"><video></video></div>
</body></html>`;

test('a YouTube watch page saves as a video: title, channel, thumbnail, duration, no article text', () => {
	const result = extractPage(page(YOUTUBE, `https://www.youtube.com/watch?v=${VIDEO_ID}&t=42`), D);
	const content = result.content!;
	assert.ok(content, result.error);
	assert.equal(content.mediaKind, 'video');
	assert.equal(content.title, 'Never Gonna Give You Up');
	assert.equal(content.author, 'Rick Astley');
	assert.equal(content.site, 'Rick Astley');
	assert.equal(content.image, `https://i.ytimg.com/vi/${VIDEO_ID}/maxresdefault.jpg`);
	assert.equal(content.durationSeconds, 213);
	assert.equal(content.wordCount, undefined);
	if (content.html) {
		assert.doesNotMatch(content.html, /<iframe/);
		assert.match(content.text ?? '', /official video/);
	}
});

test('a YouTube page without metadata still saves as a video with the standard thumbnail', () => {
	const bare = `<html><head><title>Something - YouTube</title></head><body></body></html>`;
	const content = extractPage(page(bare, `https://www.youtube.com/watch?v=${VIDEO_ID}`), D).content!;
	assert.equal(content.mediaKind, 'video');
	assert.equal(content.title, 'Something');
	assert.equal(content.site, 'YouTube');
	assert.equal(content.image, `https://i.ytimg.com/vi/${VIDEO_ID}/hqdefault.jpg`);
	assert.equal(content.durationSeconds, undefined);
});

test('YouTube microdata counts only when it names this video; the player is the fallback', () => {
	const microdata = (id: string) => `<html><head><title>V - YouTube</title></head><body>
		<div itemscope itemtype="http://schema.org/VideoObject"><meta itemprop="videoId" content="${id}"><meta itemprop="duration" content="PT2M5S"></div>
		</body></html>`;
	assert.equal(extractPage(page(microdata(VIDEO_ID), `https://www.youtube.com/watch?v=${VIDEO_ID}`), D).content?.durationSeconds, 125);
	assert.equal(extractPage(page(microdata('AAAAAAAAAAA'), `https://www.youtube.com/watch?v=${VIDEO_ID}`), D).content?.durationSeconds, undefined);
});

test('after in-page YouTube navigation, stale og metadata is ignored', () => {
	// Loaded on video A, then navigated (SPA) to B: og:* and JSON-LD still describe A.
	const stale = YOUTUBE.replace('<title>Never Gonna Give You Up - YouTube</title>', '<title>(3) Another Video - YouTube</title>');
	const content = extractPage(page(stale, 'https://www.youtube.com/watch?v=BBBBBBBBBBB'), D).content!;
	assert.equal(content.mediaKind, 'video');
	assert.equal(content.title, 'Another Video');
	assert.equal(content.image, 'https://i.ytimg.com/vi/BBBBBBBBBBB/hqdefault.jpg');
	assert.equal(content.published, undefined);
	assert.equal(content.durationSeconds, undefined);
});

test('Defuddle still has the fallback hook this code watches', () => {
	const instance = new D(page(ARTICLE, 'https://example.com/a'), { url: 'https://example.com/a' });
	assert.equal(typeof instance._fallbackResponse, 'function');
});

test('an error in an optional Defuddle step keeps the extraction; the whole-body fallback does not', () => {
	const good = { content: `<p>${'Readable words here. '.repeat(20)}</p>`, title: 'T' };
	class OptionalStepFailed {
		_parseErrors = new Set(['schema retry failed']);
		_fallbackResponse() { return { content: '<body>everything</body>' }; }
		parse() { return good; }
	}
	assert.ok(extractPage(page(ARTICLE, 'https://example.com/a'), OptionalStepFailed as unknown as DefuddleConstructor).content);
	class MainParseFailed {
		_parseErrors = new Set(['boom']);
		_fallbackResponse() { return { content: `<p>${'Whole body with nav and footer. '.repeat(20)}</p>` }; }
		parse() { return this._fallbackResponse(); }
	}
	const failed = extractPage(page(ARTICLE, 'https://example.com/a'), MainParseFailed as unknown as DefuddleConstructor);
	assert.equal(failed.content, undefined);
});

test('durationFromSchema ignores a stale VideoObject for another video', () => {
	const other = { '@type': 'VideoObject', '@id': 'https://www.youtube.com/watch?v=AAAAAAAAAAA', duration: 'PT10M' };
	const mine = { '@type': 'VideoObject', url: `https://www.youtube.com/watch?v=${VIDEO_ID}`, duration: 'PT1M' };
	assert.equal(durationFromSchema([other], VIDEO_ID), null);
	assert.equal(durationFromSchema({ '@graph': [other, mine] }, VIDEO_ID), 60);
});
