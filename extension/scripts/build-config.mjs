// What scripts/build.mjs builds, without building it: the browsers, the
// bundle entry points, manifest rendering and argument parsing. Kept apart so
// test/manifest.test.ts can check the manifests without running esbuild.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export const BROWSERS = {
	chromium: { manifest: 'manifests/chromium.json', target: ['chrome116'] },
	// Safari 17: scripting.executeScript returns results from then on (see browser_specific_settings).
	safari: { manifest: 'manifests/safari.json', target: ['safari17'] },
};

/** Bundles written next to the manifest: `<name>.js`. */
export const ENTRY_POINTS = {
	background: 'src/background/index.ts',
	extract: 'src/page/inject.ts',
	options: 'src/options/index.ts',
};

/** The manifest written to dist/<browser>/manifest.json: the browser's manifest with the package version. */
export function renderManifest(name, version) {
	const browser = BROWSERS[name];
	if (!browser) throw new Error(`Unknown browser "${name}". Known: ${Object.keys(BROWSERS).join(', ')}`);
	return { ...JSON.parse(readFileSync(join(root, browser.manifest), 'utf8')), version };
}

export const USAGE = `Usage: node scripts/build.mjs [--browser ${Object.keys(BROWSERS).join('|')}] [--outdir <dir>] [--watch]`;

export class UsageError extends Error {}

/** Parses the build's arguments; anything unknown, missing or repeated is a UsageError. */
export function parseBuildArgs(args) {
	const options = { browsers: Object.keys(BROWSERS), outdir: join(root, 'dist'), watch: false };
	const seen = new Set();
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (seen.has(arg)) throw new UsageError(`${arg} was given twice.`);
		seen.add(arg);
		if (arg === '--watch') {
			options.watch = true;
		} else if (arg === '--browser' || arg === '--outdir') {
			const value = args[++i];
			if (value === undefined || value.startsWith('--') || value === '') throw new UsageError(`${arg} needs a value.`);
			if (arg === '--browser') {
				if (!Object.hasOwn(BROWSERS, value)) throw new UsageError(`Unknown browser "${value}". Known: ${Object.keys(BROWSERS).join(', ')}.`);
				options.browsers = [value];
			} else {
				options.outdir = resolve(value);
			}
		} else {
			throw new UsageError(`Unknown argument "${arg}".`);
		}
	}
	return options;
}
