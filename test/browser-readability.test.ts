import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { BROWSER_READABILITY_SOURCE, escapeBrowserReadabilityScript, renderBrowserReadabilityScript } from '../src/browser-readability';
import { renderBrowserAppClientScript } from '../src/browser-app-client';
import { DEFUDDLE_SOURCE } from '../src/browser-defuddle-source';
import { JSDOM } from 'jsdom';

test('browser Readability preserves the exact native source and complete Apache notice', () => {
	assert.equal(BROWSER_READABILITY_SOURCE, readFileSync(new URL('../ios/PigeonReader/PigeonReader/Resources/Readability.js', import.meta.url), 'utf8'));
	assert.match(BROWSER_READABILITY_SOURCE, /Copyright \(c\) 2010 Arc90 Inc/);
	assert.match(BROWSER_READABILITY_SOURCE, /http:\/\/www.apache.org\/licenses\/LICENSE-2.0/);
});

test('emitted bundle is inline-script safe, executable, and does not fetch or require DOM until extraction', () => {
	const window: any = {};
	const script = renderBrowserReadabilityScript();
	assert.ok(!/<\/script|<!--/i.test(script));
	assert.ok(!/<\/script|<!--/i.test(escapeBrowserReadabilityScript('literal </SCRIPT><script><!--payload')));
	runInNewContext(script, { window, URL, TextEncoder, fetch() { throw new Error('No network allowed'); } });
	assert.equal(typeof window.__PIGEON_READING_TOOLS__.extract, 'function');
	for (const url of ['javascript:alert(1)', 'https://user:pass@public.example', 'http://127.0.0.1', 'http://2130706433', 'http://[::1]', 'https://host.local']) {
		assert.throws(() => window.__PIGEON_READING_TOOLS__.extract('<p>article</p>', url), /public article URL/);
	}
	assert.throws(() => window.__PIGEON_READING_TOOLS__.extract('x'.repeat(5_000_001), 'https://public.example'), /too large/);
	assert.throws(() => window.__PIGEON_READING_TOOLS__.extract('<p>article</p>', 'https://public.example'), /sanitizer/);
});

// Browser smoke runs separately because npm's parallel Worker suite must not
// launch/control native browsers. Root opens the printed fixture with CUA.
// PIGEON_READABILITY_CUA_SMOKE=1 npx tsx --test test/browser-readability.test.ts
test('CUA browser smoke extracts known article with no source resource requests', { skip: process.env.PIGEON_READABILITY_CUA_SMOKE !== '1' }, async (t) => {
	const probes: string[] = [];
	let fixture = '';
	let resolveReport!: (value: any) => void;
	let rejectReport!: (error: Error) => void;
	const reportReady = new Promise<any>((resolve, reject) => { resolveReport = resolve; rejectReport = reject; });
	const server = createServer((request, response) => {
		if (request.url === '/report' && request.method === 'POST') {
			let body = '';
			request.on('data', (chunk) => { body += chunk.toString(); if (body.length > 100_000) request.destroy(); });
			request.on('end', () => { try { resolveReport(JSON.parse(body)); response.end('reported'); } catch { rejectReport(new Error('Invalid browser smoke report')); response.writeHead(400).end(); } });
			return;
		}
		if (request.url !== '/') probes.push(request.url || 'unknown');
		response.setHeader('Content-Type', 'text/html; charset=utf-8');
		response.end(request.url === '/' ? fixture : '<p>resource probe</p>');
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
	const port = (server.address() as { port: number }).port;
	const paragraph = 'The carefully reported article explains how a community restored its public library, with specific details about books, volunteers, and reading. '.repeat(12);
	const html = `<html><head><title>A carefully reported library restoration</title><meta name="author" content="Ada Reader"><style>body{background:url(http://127.0.0.1:${port}/style-probe)}</style><link rel="stylesheet" href="http://127.0.0.1:${port}/stylesheet-probe"></head><body>
		<script>window.__SOURCE_EXECUTED__=true</script><article><h1>A carefully reported library restoration</h1><p>${paragraph}</p>
		<img src="/images/library.jpg" onerror="window.__SOURCE_EXECUTED__=true"><p>${paragraph}</p><a href="../next">Read the next story</a>
		<img src="http://127.0.0.1:${port}/image-probe"><video src="http://127.0.0.1:${port}/video-probe" autoplay></video>
		<iframe src="http://127.0.0.1:${port}/iframe-probe"></iframe><svg><image href="http://127.0.0.1:${port}/svg-probe"/></svg>
		<a href="jav&#x61;script:alert(1)" onclick="evil()">unsafe link</a><p>${paragraph}</p></article></body></html>`;
	const sourceData = JSON.stringify(html).replace(/</g, '\\u003c');
	fixture = '<!doctype html><html><body><script>' + renderBrowserAppClientScript() + '</script><script>' + renderBrowserReadabilityScript() + '</script><script>' +
		`try {
			const parsed = window.__PIGEON_READING_TOOLS__.extract(${sourceData}, 'https://news.example/section/story');
			const probe = document.createElement('template'); probe.innerHTML = parsed.content;
			const report = {title:parsed.title, text:parsed.textContent, content:parsed.content, executed:Boolean(window.__SOURCE_EXECUTED__), unsafeCount:probe.content.querySelectorAll('script,iframe,style,link,svg,[onclick],[onerror]').length};
			const result = document.createElement('pre'); result.id='result'; result.textContent=JSON.stringify(report); document.body.append(result);
			fetch('/report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(report)});
		} catch (error) { const report={error:error.message}; const result=document.createElement('pre'); result.id='result'; result.textContent=JSON.stringify(report); document.body.append(result); fetch('/report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(report)}); }` + '</script></body></html>';
	console.log(`Open this Readability smoke fixture with CUA: http://127.0.0.1:${port}/`);
	const deadline = setTimeout(() => rejectReport(new Error('CUA did not open the browser fixture within 120 seconds')), 120_000);
	const report = await reportReady.finally(() => clearTimeout(deadline));
	assert.equal(report.error, undefined);
	assert.equal(report.title, 'A carefully reported library restoration');
	assert.match(report.text, /books, volunteers, and reading/);
	assert.match(report.content, /src="https:\/\/news.example\/images\/library.jpg"/);
	assert.match(report.content, /href="https:\/\/news.example\/next"/);
	assert.ok(!/javascript:|onerror=|onclick=|data-pigeon-resource/i.test(report.content));
	assert.equal(report.executed, false); assert.equal(report.unsafeCount, 0);
	assert.deepEqual(probes.filter((path) => path.includes('probe')), [], 'inert source parsing must not request resource probes');
});

// Real-DOM extraction tests run the emitted reading-tools script, the browser
// client sanitizer and the vendored Defuddle bundle inside a jsdom window.
// (happy-dom makes Defuddle fail internally and return the whole page.)
function readingWindow(options: { defuddle?: boolean } = {}) {
	const { window } = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://pigeon.example/app', runScripts: 'outside-only' });
	(window as any).TextEncoder = TextEncoder;
	let fetchCalls = 0;
	(window as any).fetch = () => { fetchCalls += 1; throw new Error('No network allowed'); };
	window.eval(renderBrowserAppClientScript());
	window.eval(renderBrowserReadabilityScript());
	if (options.defuddle !== false) window.eval(DEFUDDLE_SOURCE);
	return { window: window as any, fetchCalls: () => fetchCalls };
}
const readerFixture = (name: string) => readFileSync(new URL(`./fixtures/reader/${name}.html`, import.meta.url), 'utf8');
const essayURL = 'https://essays.example/2025/restoring-libraries';

test('extract prefers Defuddle and returns metadata', () => {
	const { window, fetchCalls } = readingWindow();
	const result = window.__PIGEON_READING_TOOLS__.extract(readerFixture('essay-footnotes'), essayURL);
	assert.equal(result.extractor, 'defuddle');
	assert.ok(result.wordCount > 300, `wordCount ${result.wordCount}`);
	assert.equal(result.published, '2025-04-02T00:00:00.000Z');
	assert.equal(result.site, 'Example Essays');
	assert.equal(result.byline, 'Ada Reader');
	assert.equal(result.image, 'https://essays.example/images/library.jpg');
	assert.equal(result.url, essayURL);
	assert.match(result.content, /volunteers over many seasons/);
	assert.doesNotMatch(result.content, /Get new essays by email/);
	assert.equal(window.__PIGEON_READING_TOOLS__.hasDefuddle(), true);
	assert.equal(fetchCalls(), 0, 'no network during extraction');
});

test('footnote links stay in-page', () => {
	const { window } = readingWindow();
	const { content } = window.__PIGEON_READING_TOOLS__.extract(readerFixture('essay-footnotes'), essayURL);
	assert.match(content, /href="#fn:1"/);
	assert.doesNotMatch(content, /href="https?:[^"]*#fn/);
	assert.match(content, /id="fn:1"/);
	assert.match(content, /id="fnref:1"/);
	const probe = window.document.createElement('template');
	probe.innerHTML = content;
	for (const link of probe.content.querySelectorAll('a[href^="#"]')) assert.equal(link.getAttribute('target'), '_self');
});

test('code language survives', () => {
	const { window } = readingWindow();
	const { content } = window.__PIGEON_READING_TOOLS__.extract(readerFixture('code-post'), 'https://code.example/dates');
	assert.match(content, /data-lang="python"|class="language-python"/);
	assert.match(content, /fromisoformat/);
});

test('falls back to Readability when Defuddle is absent', () => {
	const { window } = readingWindow({ defuddle: false });
	const result = window.__PIGEON_READING_TOOLS__.extract(readerFixture('substack-post'), 'https://ledger.example/p/shipping');
	assert.equal(window.__PIGEON_READING_TOOLS__.hasDefuddle(), false);
	assert.equal(result.extractor, 'readability');
	assert.match(result.content, /Underwriters price each voyage/);
	assert.ok(result.wordCount > 100);
	assert.equal(result.published, '2026-10-28T13:00:00.000Z');
});

test('falls back to Readability when Defuddle throws or returns thin text', () => {
	for (const Fake of [
		class { parse(): never { throw new Error('boom'); } },
		class { parse() { return { content: '<p>hi</p>' }; } },
		// Defuddle catches its own internal errors and returns the whole page.
		class { parse() { return { content: `<p>${'whole page '.repeat(40)}</p>`, debug: { errors: ['TypeError: x'] } }; } },
	]) {
		const { window } = readingWindow({ defuddle: false });
		window.Defuddle = Fake;
		const result = window.__PIGEON_READING_TOOLS__.extract(readerFixture('essay-footnotes'), essayURL);
		assert.equal(result.extractor, 'readability');
		assert.match(result.content, /volunteers over many seasons/);
	}
});

test('size and element caps run before Defuddle', () => {
	const { window } = readingWindow({ defuddle: false });
	let parseCalls = 0;
	window.Defuddle = class { parse() { parseCalls += 1; return { content: '' }; } };
	const tools = window.__PIGEON_READING_TOOLS__;
	assert.throws(() => tools.extract('x'.repeat(5_000_001), essayURL), /too large/);
	assert.throws(() => tools.extract('<p>a</p>'.repeat(10_001), essayURL), /too many elements/);
	assert.equal(parseCalls, 0);
});

test('Defuddle still exposes the internal error set the fallback relies on', () => {
	const { window } = readingWindow();
	const doc = window.document.implementation.createHTMLDocument('');
	const instance = new window.Defuddle(doc, { url: essayURL });
	instance.parse();
	assert.ok(instance._parseErrors instanceof window.Set || instance._parseErrors instanceof Set, 'upgrade check: Defuddle _parseErrors moved');
});

test('unknown presentational tags are unwrapped, not deleted with their text', () => {
	const { window } = readingWindow();
	const essay = 'Great work comes from curiosity, delight, and the desire to do something impressive over many years. '.repeat(20);
	const html = `<html><head><title>How to Do Great Work</title></head><body><table><tr><td><font size="2" face="verdana">${essay}<br><br><center><font>${essay}</font></center></font></td></tr></table><style>.x{color:red}</style><custom-widget>${'Widget text stays readable for the reader here. '.repeat(3)}</custom-widget></body></html>`;
	const result = window.__PIGEON_READING_TOOLS__.extract(html, 'https://essays.example/greatwork');
	assert.ok(result.wordCount > 300, `wordCount ${result.wordCount} via ${result.extractor}`);
	assert.match(result.content, /desire to do something impressive/);
	assert.doesNotMatch(result.content, /<font|<center|color:red/);
});

test('same-page links that Defuddle made absolute become in-page fragments again', () => {
	// In browsers the wrapper's <base href> makes a.href absolute and Defuddle
	// copies it, turning footnotes like PG's #f1n into links to the original site.
	const url = 'https://essays.example/greatwork.html';
	const text = 'Curiosity drives the best work, sustained over years of patient effort and delight. '.repeat(10);
	const { window } = readingWindow({ defuddle: false });
	window.Defuddle = class { parse() { return { content: `<p>${text}[<a href="${url}#f1n">1</a>] <a href="${url}?ref=x#f2n">2</a> <a href="https://essays.example/other.html#f1n">other</a></p><p><a name="f1n">1</a> A note.</p>` }; } };
	const { content, extractor } = window.__PIGEON_READING_TOOLS__.extract('<p>source</p>', url);
	assert.equal(extractor, 'defuddle');
	assert.doesNotMatch(content, /href="https:\/\/essays\.example\/greatwork\.html#/);
	assert.match(content, /href="#f1n"[^>]*target="_self"|target="_self"[^>]*href="#f1n"/);
	// Different page, or same path with a different query: stays external.
	assert.match(content, /href="https:\/\/essays\.example\/greatwork\.html\?ref=x#f2n"/);
	assert.match(content, /href="https:\/\/essays\.example\/other\.html#f1n"/);
});

test('named note anchors survive as scroll targets and never gain an href', () => {
	const { window } = readingWindow();
	const body = 'Curiosity drives the best work, sustained over years of patient effort and delight. '.repeat(25);
	const html = `<html><head><title>Great Work</title></head><body><table><tr><td><font size="2">${body}[<a href="#f1n"><font color="#999999">1</font></a>] ${body}<br><br><b>Notes</b><br><br>[<a name="f1n"><font color="#000000">1</font></a>] A note about curiosity.</font></td></tr></table></body></html>`;
	const { content, extractor } = window.__PIGEON_READING_TOOLS__.extract(html, 'https://essays.example/greatwork.html');
	assert.equal(extractor, 'defuddle');
	assert.match(content, /<a[^>]*\b(id|name)="f1n"/, 'note target kept');
	const probe = window.document.createElement('template');
	probe.innerHTML = content;
	const target = probe.content.querySelector('[id="f1n"], [name="f1n"]');
	assert.equal(target?.hasAttribute('href'), false, 'a name-only anchor must not become a link');
});

test('a script-rendered page with no article fails instead of showing the page title', () => {
	const { window } = readingWindow();
	assert.throws(() => window.__PIGEON_READING_TOOLS__.extract(readerFixture('thin-script-page'), 'https://app.example/'), /No readable article content/);
});

test('fragment links whose target did not survive extraction keep pointing at the original page', () => {
	const url = 'https://essays.example/post';
	const text = 'Curiosity drives the best work, sustained over years of patient effort and delight. '.repeat(10);
	const { window } = readingWindow({ defuddle: false });
	window.Defuddle = class { parse() { return { content: `<p>${text}<a href="#comments">comments</a> <a href="${url}#footnote-1">1</a> <a href="#kept">kept</a></p><h2 title="pigeon-in-page-target:kept">Kept</h2><p title="pigeon-in-page-target:evil&quot; x">x</p>` }; } };
	const { content } = window.__PIGEON_READING_TOOLS__.extract(`<p id="kept">k</p><p id="evil" x">e</p><a href="#kept">k</a>`, url);
	assert.match(content, /href="https:\/\/essays\.example\/post#comments"/);
	assert.match(content, /href="https:\/\/essays\.example\/post#footnote-1"/);
	assert.match(content, /href="#kept"[^>]*target="_self"/);
	assert.match(content, /<h2 id="kept">/);
	assert.doesNotMatch(content, /evil/);
});

test('odd fragment characters cannot break extraction', () => {
	const url = 'https://essays.example/post';
	const text = 'Curiosity drives the best work, sustained over years of patient effort and delight. '.repeat(10);
	const { window } = readingWindow({ defuddle: false });
	window.Defuddle = class { parse() { return { content: `<p>${text}<a href="#a%0Ab">x</a> <a href="#a]b&quot;">y</a> <a href="#%E0%A4%A">z</a></p>` }; } };
	const { content, extractor } = window.__PIGEON_READING_TOOLS__.extract('<p>source</p>', url);
	assert.equal(extractor, 'defuddle');
	assert.match(content, /Curiosity drives/);
});

test('images survive Defuddle extraction with their original sources', () => {
	const { window } = readingWindow();
	const text = '<p>' + 'The library was restored by volunteers over many seasons of careful work. '.repeat(15) + '</p>';
	const html = `<html><head><title>Photos</title></head><body><article><h1>Photos</h1>${text}<figure><img src="/images/one.jpg" alt="One" title="First photo"><figcaption>One</figcaption></figure>${text}<img data-src="https://cdn.example/two.jpg" alt="Two">${text}</article></body></html>`;
	const result = window.__PIGEON_READING_TOOLS__.extract(html, 'https://essays.example/photos');
	assert.equal(result.extractor, 'defuddle');
	assert.match(result.content, /<img[^>]*src="https:\/\/essays\.example\/images\/one\.jpg"/);
	assert.match(result.content, /<img[^>]*src="https:\/\/cdn\.example\/two\.jpg"/);
	assert.match(result.content, /title="First photo"/);
	assert.doesNotMatch(result.content, /pigeon\.invalid|pigeon-in-page-target|data-pigeon-resource/);
});

test('image-led posts with little text still extract', () => {
	const { window } = readingWindow();
	const html = '<html><head><title>Comic 123</title></head><body><article><h1>Comic 123</h1><img src="/comics/123.png" alt="Comic"><p>Short caption.</p></article></body></html>';
	const result = window.__PIGEON_READING_TOOLS__.extract(html, 'https://comics.example/123');
	assert.match(result.content, /comics\/123\.png/);
});

test('footnote targets that already have a title keep their id and their title', () => {
	const { window } = readingWindow();
	const text = 'Curiosity drives the best work, sustained over years of patient effort and delight. '.repeat(12);
	const html = `<html><head><title>Notes</title></head><body><article><h1>Notes</h1><p>${text}<a href="#note-a">a</a></p><p>${text}</p><p id="note-a" title="Note one">The note.</p></article></body></html>`;
	const { content } = window.__PIGEON_READING_TOOLS__.extract(html, 'https://essays.example/post');
	assert.match(content, /href="#note-a"[^>]*target="_self"/);
	assert.match(content, /<p[^>]*id="note-a"/);
	assert.match(content, /title="Note one"/);
});

test('extract returns plain text only when the caller asks for it', () => {
	const { window } = readingWindow();
	const plain = window.__PIGEON_READING_TOOLS__.extract(readerFixture('essay-footnotes'), essayURL);
	assert.equal('text' in plain, false, 'reader mode does not pay for a full textContent pass');
	const withText = window.__PIGEON_READING_TOOLS__.extract(readerFixture('essay-footnotes'), essayURL, { withText: true });
	assert.match(withText.text, /volunteers over many seasons/);
	assert.doesNotMatch(withText.text, /</);
	assert.doesNotMatch(withText.text, /\s{2,}/);
});
