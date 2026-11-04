import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { BROWSERS, ENTRY_POINTS, parseBuildArgs, renderManifest, root, UsageError } from '../scripts/build-config.mjs';

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

test('every browser renders with the package version and names only files the build writes', () => {
	const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
	const bundles = new Set(Object.keys(ENTRY_POINTS).map((name) => `${name}.js`));
	for (const browser of Object.keys(BROWSERS)) {
		const manifest = renderManifest(browser, version) as Manifest;
		assert.equal(manifest.version, version, browser);
		// The build copies static/ and writes one bundle per entry point; extract.js is injected by the background.
		for (const file of [String(manifest.background.service_worker), 'options.js', 'extract.js']) assert.ok(bundles.has(file), `${browser}: ${file}`);
		for (const file of [manifest.options_ui.page, 'options.css', ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)]) {
			assert.ok(existsSync(join(root, 'static', file)), `${browser}: static/${file}`);
		}
	}
	assert.deepEqual(renderManifest('safari', version).browser_specific_settings, safari.browser_specific_settings);
	assert.equal(renderManifest('chromium', version).browser_specific_settings, undefined);
	assert.throws(() => renderManifest('firefox', version), /Unknown browser/);
});

test('the build rejects unknown, missing and repeated arguments', () => {
	assert.deepEqual(parseBuildArgs([]), { browsers: ['chromium', 'safari'], outdir: join(root, 'dist'), watch: false });
	assert.deepEqual(parseBuildArgs(['--browser', 'safari', '--outdir', '/tmp/x', '--watch']), { browsers: ['safari'], outdir: '/tmp/x', watch: true });
	for (const args of [['--browser'], ['--browser', 'firefox'], ['--browser', '--watch'], ['--outdir'], ['--outdir', ''], ['--bogus'], ['safari'], ['--watch', '--watch'], ['--browser', 'safari', '--browser', 'chromium']]) {
		assert.throws(() => parseBuildArgs(args), UsageError, args.join(' '));
	}
});
