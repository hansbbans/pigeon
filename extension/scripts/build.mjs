// Builds the extension into dist/<browser>/, loadable unpacked.
// Usage: node scripts/build.mjs [--browser chromium|safari] [--outdir <dir>] [--watch]   (default: every browser, into dist/)
//
// Each browser has its own manifest in manifests/<browser>.json; the code is
// shared and talks to the browser through webextension-polyfill
// (src/browser-api.ts). Adding Firefox later means adding a manifest and an
// entry in BROWSERS (scripts/build-config.mjs), not restructuring the code. dist/safari is the web
// extension inside the Safari container app (safari/, scripts/build-safari.sh).
import { build, context } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BROWSERS, ENTRY_POINTS, parseBuildArgs, renderManifest, root, USAGE, UsageError } from './build-config.mjs';

let parsed;
try {
	parsed = parseBuildArgs(process.argv.slice(2));
} catch (error) {
	if (!(error instanceof UsageError)) throw error;
	console.error(`${error.message}\n${USAGE}`);
	process.exit(2);
}
const { browsers: selected, outdir: distRoot, watch } = parsed;
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const defuddleVersion = JSON.parse(readFileSync(join(root, 'node_modules/defuddle/package.json'), 'utf8')).version;

for (const name of selected) {
	const browser = BROWSERS[name];
	const outdir = join(distRoot, name);
	rmSync(outdir, { recursive: true, force: true });
	mkdirSync(outdir, { recursive: true });

	const manifest = renderManifest(name, pkg.version);
	writeFileSync(join(outdir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
	cpSync(join(root, 'static'), outdir, { recursive: true });
	cpSync(join(root, 'THIRD_PARTY_NOTICES.md'), join(outdir, 'THIRD_PARTY_NOTICES.md'));

	const options = {
		absWorkingDir: root,
		entryPoints: ENTRY_POINTS,
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
