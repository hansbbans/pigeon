#!/usr/bin/env node
// On-demand visual check of the web UI at / (not run in CI).
//
//   npm run visual:check                       # starts both Workers locally, like `npm run dev`
//   npm run visual:check -- --base-url <url>   # checks an already-running server
//
// Takes full-page screenshots at 375, 768 and 1280 px into visual-check/ and exits 1
// on any console error, page error, failed request or non-2xx response. The
// cards-* pages repeat the reader in the Cards look (pigeon.browser.look), in
// light and dark: Home, a folder's cards, a smart view, a feed's day cards and an open story.
//
// Auth: when this script starts the Workers itself it gives them a throwaway
// API_PASSWORD (and an empty env file, so .dev.vars is never read) plus a fresh,
// local D1 in a temp directory, seeded with a few made-up folders, feeds and
// stories (seedSql) so the lists have something to draw. With --base-url,
// signed-in pages need the password in PIGEON_API_PASSWORD; without it they are
// skipped with a message.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';

const WIDTHS = [375, 768, 1280];
const HEIGHT = 900;
const OUT_DIR = resolve('visual-check');

const { values: args } = parseArgs({
	options: {
		'base-url': { type: 'string' },
		help: { type: 'boolean', short: 'h' },
	},
});
if (args.help) {
	console.log('Usage: npm run visual:check [-- --base-url http://127.0.0.1:8787]');
	console.log('Signed-in pages against --base-url need PIGEON_API_PASSWORD in the environment.');
	process.exit(0);
}

// DOM clicks, once the target is there: on narrow widths the sidebar is off-screen.
const clickFirst = (selector) => async (page) => {
	await page.locator(selector).first().waitFor({ state: 'attached', timeout: 15000 });
	await page.evaluate((target) => document.querySelector(target).click(), selector);
};
const openFolder = clickFirst('#folders-list .list-button[data-view-id="user/-/label/Newsletters"]');
const cards = { 'pigeon.browser.look': 'cards' };
const darkCards = { ...cards, 'pigeon.browser.theme': 'dark' };

// Each page is a state of the single-page app at /. `auth` pages sign in first;
// `storage` is put in localStorage before the app starts.
const PAGES = [
	{ name: 'login', auth: false, ready: '#login-screen:not(.hidden)' },
	{ name: 'reader', auth: true, ready: '#reader-shell:not(.hidden)' },
	{
		name: 'settings', auth: true, ready: '#settings-panel:not(.hidden)',
		// DOM click: on narrow widths the sidebar (and its footer buttons) is off-screen.
		open: (page) => page.evaluate(() => document.getElementById('settings-button').click()),
	},
	{
		name: 'library', auth: true, ready: '#library-panel:not(.hidden)',
		open: (page) => page.evaluate(() => document.getElementById('library-button').click()),
	},
	{ name: 'cards-home', auth: true, storage: cards, ready: '#reader-grid[data-page="home"] .cards-home-folder' },
	{ name: 'cards-home-dark', auth: true, storage: darkCards, ready: '#reader-grid[data-page="home"] .cards-home-folder' },
	{ name: 'cards-folder', auth: true, storage: cards, open: openFolder, ready: '#articles-list.is-cards .cards-card.is-today .article-card' },
	{ name: 'cards-folder-dark', auth: true, storage: darkCards, open: openFolder, ready: '#articles-list.is-cards .cards-card.is-today .article-card' },
	{
		name: 'cards-view', auth: true, storage: cards, ready: '#articles-list.is-cards .cards-card.is-flat .article-card',
		open: clickFirst('#views-list .list-button[data-view-id="all"]'),
	},
	{
		name: 'cards-feed', auth: true, storage: cards, ready: '#articles-list.is-cards .cards-card.is-earlier .article-card',
		open: async (page) => {
			await openFolder(page);
			await clickFirst('.cards-card .article-feed-header-button')(page);
		},
	},
	{
		name: 'cards-story', auth: true, storage: cards, ready: '#reader-grid[data-mobile-pane="reader"] #reader-title:not(:empty)',
		open: async (page) => {
			await openFolder(page);
			await clickFirst('.cards-card .article-card')(page);
		},
	},
];

const children = [];
let tempDir = null;

async function main() {
	let baseUrl = args['base-url']?.replace(/\/+$/, '');
	let password = process.env.PIGEON_API_PASSWORD || null;
	if (password) redactions.push(password);
	if (!baseUrl) {
		password = randomBytes(18).toString('base64url');
		redactions.push(password);
		baseUrl = await startLocalWorkers(password);
	}
	console.log(`[visual-check] base URL ${baseUrl}`);

	rmSync(OUT_DIR, { recursive: true, force: true });
	mkdirSync(OUT_DIR, { recursive: true });

	const browser = await chromium.launch();
	const failures = [];
	const shots = [];
	const skipped = new Set();
	try {
		for (const width of WIDTHS) {
			for (const spec of PAGES) {
				if (spec.auth && !password) {
					skipped.add(spec.name);
					continue;
				}
				const result = await checkPage(browser, baseUrl, spec, width, password);
				failures.push(...result.failures.map((f) => `${spec.name} @${width}px: ${f}`));
				if (result.file) shots.push(result.file);
			}
		}
	} finally {
		await browser.close();
	}

	for (const name of skipped) {
		console.log(`[visual-check] SKIPPED ${name}: needs a signed-in session; set PIGEON_API_PASSWORD to check it against --base-url.`);
	}
	console.log(`[visual-check] ${shots.length} screenshots in ${OUT_DIR}`);
	for (const file of shots) console.log(`  ${file}`);
	if (failures.length) {
		console.error(`[visual-check] FAILED (${failures.length}):`);
		for (const failure of failures) console.error(`  ${failure}`);
		return 1;
	}
	console.log('[visual-check] OK: no console errors, failed requests or non-2xx responses.');
	return 0;
}

async function checkPage(browser, baseUrl, spec, width, password) {
	const failures = [];
	const context = await browser.newContext({ viewport: { width, height: HEIGHT } });
	if (spec.storage) {
		await context.addInitScript((entries) => {
			for (const [key, value] of Object.entries(entries)) window.localStorage.setItem(key, value);
		}, spec.storage);
	}
	const page = await context.newPage();
	const origin = new URL(baseUrl).origin;
	page.on('console', (msg) => {
		if (msg.type() === 'error') failures.push(`console error: ${msg.text()}`);
	});
	page.on('pageerror', (error) => failures.push(`page error: ${error.message}`));
	page.on('requestfailed', (request) => {
		const reason = request.failure()?.errorText || 'unknown';
		// Aborted requests are the app cancelling its own fetches, not failures.
		if (!reason.includes('ERR_ABORTED')) failures.push(`request failed: ${request.method()} ${request.url()} (${reason})`);
	});
	page.on('response', (response) => {
		const status = response.status();
		// Redirects are followed and reported by their final response.
		if ((status < 200 || status >= 300) && !(status >= 301 && status <= 308)) {
			const url = response.url();
			failures.push(`HTTP ${status}: ${response.request().method()} ${url.startsWith(origin) ? url.slice(origin.length) : url}`);
		}
	});

	let file = null;
	try {
		const response = await page.goto(`${baseUrl}/`, { waitUntil: 'load' });
		if (!response?.ok()) throw new Error(`GET / returned ${response?.status()}`);
		if (spec.auth) {
			await page.locator('#login-screen:not(.hidden)').waitFor({ timeout: 15000 });
			await page.fill('#password-input', password);
			await page.click('#login-button');
			await page.locator('#reader-shell:not(.hidden)').waitFor({ timeout: 15000 });
		}
		if (spec.open) await spec.open(page);
		await page.locator(spec.ready).first().waitFor({ timeout: 15000 });
		await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
		file = join(OUT_DIR, `${spec.name}-${width}.png`);
		await page.screenshot({ path: file, fullPage: true });
	} catch (error) {
		failures.push(`did not render: ${error.message.split('\n')[0]}`);
	} finally {
		await context.close();
	}
	return { failures, file };
}

// Same two Workers as scripts/dev-workers.mjs, on free ports, with a throwaway
// password and an empty local D1 so the check never touches real data or .dev.vars.
async function startLocalWorkers(password) {
	tempDir = mkdtempSync(join(tmpdir(), 'pigeon-visual-check-'));
	const envFile = join(tempDir, 'empty.env');
	writeFileSync(envFile, '');
	const persist = join(tempDir, 'state');
	// A brand-new D1 must be initialized from SCHEMA.sql; the Worker only migrates existing ones.
	await run(resolve('node_modules/.bin/wrangler'), ['d1', 'execute', 'pigeon-db', '--local', '--persist-to', persist, '--config', 'wrangler.toml', '--file', '04-storage/SCHEMA.sql']);
	const seedFile = join(tempDir, 'seed.sql');
	writeFileSync(seedFile, seedSql(new Date()));
	await run(resolve('node_modules/.bin/wrangler'), ['d1', 'execute', 'pigeon-db', '--local', '--persist-to', persist, '--config', 'wrangler.toml', '--file', seedFile]);
	const [helperPort, mainPort, helperInspector, mainInspector] = await freePorts(4);
	const common = ['--local', '--persist-to', persist, '--env-file', envFile, '--show-interactive-dev-session=false', '--ip', '127.0.0.1'];
	startWorker('recommendations', ['dev', '--config', 'wrangler.recommendations.toml', ...common, '--port', String(helperPort), '--inspector-port', String(helperInspector)]);
	await waitForHealth(`http://127.0.0.1:${helperPort}`, 60000, false);
	startWorker('main', ['dev', '--config', 'wrangler.toml', ...common, '--port', String(mainPort), '--inspector-port', String(mainInspector), '--var', `API_PASSWORD:${password}`]);
	const baseUrl = `http://127.0.0.1:${mainPort}`;
	await waitForHealth(baseUrl, 60000, true);
	return baseUrl;
}

// Made-up newsletters in three folders and one on its own, with stories from
// today back to last month, so folders show Today, Last 7 Days, feed cards and
// Older, and a feed shows Today, Yesterday and Earlier. Email feeds, so the
// local Worker never fetches anything.
function seedSql(now) {
	const quote = (value) => (value === null ? 'NULL' : `'${String(value).replace(/'/g, "''")}'`);
	const feeds = [
		['stratechery', 'Stratechery', 'Newsletters'],
		['dense-discovery', 'Dense Discovery', 'Newsletters'],
		['money-stuff', 'Money Stuff', 'Newsletters'],
		['platformer', 'Platformer', 'Newsletters'],
		['the-verge', 'The Verge', 'Technology'],
		['six-colors', 'Six Colors', 'Technology'],
		['sidebar-io', 'Sidebar', 'Design'],
		['kottke', 'Kottke', null],
	];
	const hours = (count) => new Date(now.getTime() - count * 3_600_000).toISOString();
	const stories = [
		['stratechery', 'The Aggregator’s dilemma, revisited for an age of agents', 0.5],
		['dense-discovery', 'Issue 312: Quiet tools, loud cities', 1],
		['money-stuff', 'The bond market wants a word', 1.5],
		['platformer', 'Inside the moderation team that runs on spreadsheets', 2],
		['stratechery', 'An interview about chips, power and the next data centre', 3],
		['money-stuff', 'Who owns the index?', 4],
		['dense-discovery', 'A field guide to slower software', 26],
		['stratechery', 'Why the platform shift is slower than it looks', 30],
		['platformer', 'The week the feeds went quiet', 50],
		['money-stuff', 'Private credit, public worries', 75],
		['dense-discovery', 'Issue 311: Gardens and graphs', 120],
		['stratechery', 'Integration and its discontents', 140],
		['platformer', 'What the new rules mean for small forums', 260],
		['the-verge', 'The best laptops for reading on a train', 2],
		['six-colors', 'A week with the new tablet keyboard', 5],
		['the-verge', 'Inside the lab testing tomorrow’s batteries', 28],
		['six-colors', 'Mac shortcuts worth learning this year', 100],
		['sidebar-io', 'Designing calmer tools for people who read every day', 3],
		['sidebar-io', 'Type scales that survive dark mode', 400],
		['kottke', 'A map of every lighthouse on the coast', 6],
		['kottke', 'The slow art of repairing old clocks', 54],
	];
	const lines = [];
	for (const [key, name, folder] of feeds) {
		lines.push(`INSERT INTO feeds (feed_key, display_name, source_type, from_email) VALUES (${quote(key)}, ${quote(name)}, 'email', ${quote(key + '@example.com')});`);
		if (folder) lines.push(`INSERT INTO feed_tags (feed_key, label) VALUES (${quote(key)}, ${quote(folder)});`);
	}
	stories.forEach(([key, subject, age], index) => {
		const body = `<p>${subject}. A made-up story for the visual check.</p><p>${'The quick brown fox jumps over the lazy dog. '.repeat(30)}</p>`;
		lines.push(`INSERT INTO items (id, feed_key, subject, html_content, text_content, received_at, is_read) VALUES (${quote('visual-' + index)}, ${quote(key)}, ${quote(subject)}, ${quote(body)}, ${quote(subject)}, ${quote(hours(age))}, ${index % 5 === 2 ? 1 : 0});`);
	});
	return lines.join('\n') + '\n';
}

function run(command, commandArgs) {
	return new Promise((res, rej) => {
		let log = '';
		const child = spawn(command, commandArgs, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
		child.stdout.on('data', (chunk) => { log += chunk; });
		child.stderr.on('data', (chunk) => { log += chunk; });
		child.on('error', rej);
		child.on('exit', (code) => (code === 0 ? res() : rej(new Error(`${commandArgs.slice(0, 2).join(' ')} failed (${code}):\n${log.slice(-4000)}`))));
	});
}

function startWorker(name, workerArgs) {
	const child = spawn(resolve('node_modules/.bin/wrangler'), workerArgs, {
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
	});
	// Keep wrangler's output (it echoes --var values) out of the console unless it fails.
	let log = '';
	const keep = (chunk) => { log = (log + chunk).slice(-8000); };
	child.stdout.on('data', keep);
	child.stderr.on('data', keep);
	child.on('exit', (code, signal) => {
		if (!stopping) {
			console.error(`[visual-check] wrangler ${name} exited (${signal || code}); last output:\n${redact(log)}`);
			cleanup();
			process.exit(1);
		}
	});
	children.push({ name, child });
}

const redactions = [];
function redact(text) {
	return redactions.reduce((out, secret) => out.split(secret).join('[redacted]'), text);
}

async function waitForHealth(baseUrl, timeoutMs, healthRoute) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(healthRoute ? `${baseUrl}/health` : baseUrl);
			await response.body?.cancel();
			if (!healthRoute || response.ok) return;
		} catch { /* not listening yet */ }
		await new Promise((r) => setTimeout(r, 250));
	}
	throw new Error(`${baseUrl} did not become ready within ${timeoutMs / 1000}s`);
}

async function freePorts(count) {
	const servers = await Promise.all(Array.from({ length: count }, () => new Promise((res, rej) => {
		const server = createServer();
		server.once('error', rej);
		server.listen(0, '127.0.0.1', () => res(server));
	})));
	const ports = servers.map((s) => s.address().port);
	await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
	return ports;
}

let stopping = false;
function cleanup() {
	stopping = true;
	for (const { child } of children) if (child.exitCode === null) child.kill('SIGTERM');
	if (tempDir) rmSync(tempDir, { recursive: true, force: true });
}

process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

main().then((code) => {
	cleanup();
	process.exitCode = code;
	// wrangler children may hold the event loop briefly after SIGTERM.
	setTimeout(() => process.exit(code), 1500).unref();
}).catch((error) => {
	console.error(`[visual-check] ${redact(error.stack || String(error))}`);
	cleanup();
	process.exit(1);
});
