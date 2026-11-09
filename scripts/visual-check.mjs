#!/usr/bin/env node
// On-demand visual check of the /app web UI (not run in CI).
//
//   npm run visual:check                       # starts both Workers locally, like `npm run dev`
//   npm run visual:check -- --base-url <url>   # checks an already-running server
//
// Takes full-page screenshots at 375, 768 and 1280 px into visual-check/ and exits 1
// on any console error, page error, failed request or non-2xx response.
//
// Auth: when this script starts the Workers itself it gives them a throwaway
// API_PASSWORD (and an empty env file, so .dev.vars is never read) plus a fresh,
// empty local D1 in a temp directory. With --base-url, signed-in pages need the
// password in PIGEON_API_PASSWORD; without it they are skipped with a message.
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

// Each page is a state of the /app single-page app. `auth` pages sign in first.
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
		const response = await page.goto(`${baseUrl}/app`, { waitUntil: 'load' });
		if (!response?.ok()) throw new Error(`GET /app returned ${response?.status()}`);
		if (spec.auth) {
			await page.locator('#login-screen:not(.hidden)').waitFor({ timeout: 15000 });
			await page.fill('#password-input', password);
			await page.click('#login-button');
			await page.locator('#reader-shell:not(.hidden)').waitFor({ timeout: 15000 });
		}
		if (spec.open) await spec.open(page);
		await page.locator(spec.ready).waitFor({ timeout: 15000 });
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
	const [helperPort, mainPort, helperInspector, mainInspector] = await freePorts(4);
	const common = ['--local', '--persist-to', persist, '--env-file', envFile, '--show-interactive-dev-session=false', '--ip', '127.0.0.1'];
	startWorker('recommendations', ['dev', '--config', 'wrangler.recommendations.toml', ...common, '--port', String(helperPort), '--inspector-port', String(helperInspector)]);
	await waitForHealth(`http://127.0.0.1:${helperPort}`, 60000, false);
	startWorker('main', ['dev', '--config', 'wrangler.toml', ...common, '--port', String(mainPort), '--inspector-port', String(mainInspector), '--var', `API_PASSWORD:${password}`]);
	const baseUrl = `http://127.0.0.1:${mainPort}`;
	await waitForHealth(baseUrl, 60000, true);
	return baseUrl;
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
