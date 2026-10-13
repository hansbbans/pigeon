import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { BROWSER_READABILITY_SOURCE, escapeBrowserReadabilityScript, renderBrowserReadabilityScript } from '../src/browser-readability';
import { renderBrowserAppClientScript } from '../src/browser-app-client';

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
