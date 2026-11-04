import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
type Manifest = Record<string, unknown> & {
	permissions: string[];
	host_permissions: string[];
	optional_host_permissions: string[];
	background: Record<string, unknown>;
	icons: Record<string, string>;
	action: { default_icon: Record<string, string> };
	options_ui: { page: string };
	browser_specific_settings?: { safari?: { strict_min_version?: string } };
};
const read = (path: string): Manifest => JSON.parse(readFileSync(path, 'utf8'));
const chromium = read(join(root, 'manifests/chromium.json'));
const safari = read(join(root, 'manifests/safari.json'));

/** Keys allowed to differ between the two manifests; everything else must match so the builds stay in step. */
const CHROMIUM_ONLY = ['minimum_chrome_version'];
const SAFARI_ONLY = ['browser_specific_settings'];
const DIFFERING = ['options_ui'];

test('the Safari manifest matches Chromium apart from the keys Safari handles differently', () => {
	const strip = (manifest: Manifest, drop: string[]) => Object.fromEntries(Object.entries(manifest).filter(([key]) => !drop.includes(key) && !DIFFERING.includes(key)));
	assert.deepEqual(strip(safari, SAFARI_ONLY), strip(chromium, CHROMIUM_ONLY));
	assert.equal(safari.options_ui.page, chromium.options_ui.page);
});

test('the Safari manifest uses only what Safari 17 supports', () => {
	assert.equal(safari.manifest_version, 3);
	assert.equal(safari.browser_specific_settings?.safari?.strict_min_version, '17.0');
	for (const key of Object.keys(safari)) assert.ok(!key.startsWith('minimum_chrome') && key !== 'side_panel' && key !== 'key' && key !== 'update_url', key);
	// Safari 15.4+ runs a service worker background; it has no persistent background pages in MV3.
	assert.deepEqual(safari.background, { service_worker: 'background.js' });
	// Safari always opens options in a tab and warns about open_in_tab.
	assert.deepEqual(safari.options_ui, { page: 'options.html' });
	const supported = new Set(['activeTab', 'scripting', 'contextMenus', 'storage', 'alarms']);
	for (const permission of safari.permissions) assert.ok(supported.has(permission), permission);
	assert.deepEqual(safari.host_permissions, ['https://pigeon.hanscho.com/*']);
});

const outdir = mkdtempSync(join(tmpdir(), 'pigeon-extension-build-'));
after(() => rmSync(outdir, { recursive: true, force: true }));

test('the build writes every browser with the package version and every file its manifest names', () => {
	execFileSync(process.execPath, [join(root, 'scripts/build.mjs'), '--outdir', outdir], { cwd: root, stdio: 'pipe' });
	const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
	for (const browser of ['chromium', 'safari']) {
		const dir = join(outdir, browser);
		const manifest = read(join(dir, 'manifest.json'));
		assert.equal(manifest.version, version, browser);
		const files = [
			String(manifest.background.service_worker),
			manifest.options_ui.page,
			'options.js',
			'options.css',
			'extract.js', // injected by the background with scripting.executeScript
			'THIRD_PARTY_NOTICES.md',
			...Object.values(manifest.icons),
			...Object.values(manifest.action.default_icon),
		];
		for (const file of files) assert.ok(existsSync(join(dir, file)), `${browser}: ${file}`);
	}
	assert.deepEqual(read(join(outdir, 'safari/manifest.json')).browser_specific_settings, safari.browser_specific_settings);
	assert.equal(read(join(outdir, 'chromium/manifest.json')).browser_specific_settings, undefined);
});
