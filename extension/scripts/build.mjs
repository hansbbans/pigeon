// Builds the extension into dist/<browser>/, loadable unpacked.
// Usage: node scripts/build.mjs [--browser chromium|safari] [--outdir dist] [--watch]
//
// Each browser has its own manifest in manifests/<browser>.json; the code is
// shared and talks to the browser through webextension-polyfill
// (src/browser-api.ts). Adding Firefox later means adding a manifest and an
// entry in BROWSERS, not restructuring the code. dist/safari is the web
// extension inside the Safari container app (safari/, scripts/build-safari.sh).
import { build, context } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BROWSERS = {
	chromium: { manifest: 'manifests/chromium.json', target: ['chrome116'] },
	// Safari 17: scripting.executeScript returns results from then on (see browser_specific_settings).
	safari: { manifest: 'manifests/safari.json', target: ['safari17'] },
};

const args = process.argv.slice(2);
const watch = args.includes('--watch');
const browserIndex = args.indexOf('--browser');
const selected = browserIndex >= 0 ? [args[browserIndex + 1]] : Object.keys(BROWSERS);
const outdirIndex = args.indexOf('--outdir');
const distRoot = outdirIndex >= 0 ? resolve(args[outdirIndex + 1]) : join(root, 'dist');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const defuddleVersion = JSON.parse(readFileSync(join(root, 'node_modules/defuddle/package.json'), 'utf8')).version;

for (const name of selected) {
	const browser = BROWSERS[name];
	if (!browser) throw new Error(`Unknown browser "${name}". Known: ${Object.keys(BROWSERS).join(', ')}`);
	const outdir = join(distRoot, name);
	rmSync(outdir, { recursive: true, force: true });
	mkdirSync(outdir, { recursive: true });

	const manifest = JSON.parse(readFileSync(join(root, browser.manifest), 'utf8'));
	manifest.version = pkg.version;
	writeFileSync(join(outdir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
	cpSync(join(root, 'static'), outdir, { recursive: true });
	cpSync(join(root, 'THIRD_PARTY_NOTICES.md'), join(outdir, 'THIRD_PARTY_NOTICES.md'));

	const options = {
		absWorkingDir: root,
		entryPoints: {
			background: 'src/background/index.ts',
			extract: 'src/page/inject.ts',
			options: 'src/options/index.ts',
		},
		outdir,
		bundle: true,
		format: 'iife',
		target: browser.target,
		minify: false,
		sourcemap: false,
		legalComments: 'inline',
		banner: { js: `// Save to Pigeon ${pkg.version}. Bundles Defuddle ${defuddleVersion} (MIT) and webextension-polyfill (MPL-2.0); see THIRD_PARTY_NOTICES.md.` },
		logLevel: 'info',
	};
	if (watch) {
		const ctx = await context(options);
		await ctx.watch();
	} else {
		await build(options);
	}
	console.log(`Built ${name} → ${outdir}`);
}
