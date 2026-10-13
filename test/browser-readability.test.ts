import * as assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
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

const CHROME = process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/chromium';

test('real browser extracts known article without executable markup or source image/media requests', { skip: !existsSync(CHROME) }, async (t) => {
	const profile = mkdtempSync(join(tmpdir(), 'pigeon-readability-test-'));
	t.after(() => rmSync(profile, { recursive: true, force: true }));
	const probes: string[] = [];
	let fixture = '';
	const server = createServer((request, response) => {
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
		} catch (error) { const result=document.createElement('pre'); result.id='result'; result.textContent=JSON.stringify({error:error.message}); document.body.append(result); }` + '</script></body></html>';
	const browser = spawn(CHROME, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync', '--disable-component-update', '--user-data-dir=' + profile, '--virtual-time-budget=1000', '--dump-dom', `http://127.0.0.1:${port}/`], { stdio: ['ignore', 'pipe', 'pipe'] });
	t.after(() => { if (browser.exitCode === null) browser.kill('SIGTERM'); });
	const deadline = setTimeout(() => browser.kill('SIGTERM'), 20_000);
	let output = '';
	browser.stdout.on('data', (chunk) => { output += chunk.toString(); });
	await new Promise<void>((resolve, reject) => { browser.once('error', reject); browser.once('close', (code) => code === 0 ? resolve() : reject(new Error('Headless browser did not complete: ' + code))); }).finally(() => clearTimeout(deadline));
	const match = output.match(/<pre id="result">([\s\S]*?)<\/pre>/);
	assert.ok(match, 'browser did not produce an extraction result');
	const report = JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
	assert.equal(report.error, undefined);
	assert.equal(report.title, 'A carefully reported library restoration');
	assert.match(report.text, /books, volunteers, and reading/);
	assert.match(report.content, /src="https:\/\/news.example\/images\/library.jpg"/);
	assert.match(report.content, /href="https:\/\/news.example\/next"/);
	assert.ok(!/javascript:|onerror=|onclick=|data-pigeon-resource/i.test(report.content));
	assert.equal(report.executed, false); assert.equal(report.unsafeCount, 0);
	assert.deepEqual(probes.filter((path) => path.includes('probe')), [], 'inert source parsing must not request resource probes');
});
