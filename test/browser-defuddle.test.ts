import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { DEFUDDLE_SOURCE, DEFUDDLE_VERSION } from '../src/browser-defuddle-source';

const require = createRequire(import.meta.url);
const bundlePath = require.resolve('defuddle');
const packageJSON = JSON.parse(readFileSync(new URL('../package.json', `file://${bundlePath}`), 'utf8'));
const iosResource = new URL('../ios/PigeonReader/PigeonReader/Resources/Defuddle.js', import.meta.url);
const iosNotice = new URL('../ios/PigeonReader/PigeonReader/Resources/DEFUDDLE-NOTICE.md', import.meta.url);

test('vendored Defuddle matches the pinned npm bundle on web and iOS', () => {
	assert.match(bundlePath, /defuddle\/dist\/index\.js$/);
	const bundle = readFileSync(bundlePath, 'utf8');
	assert.equal(DEFUDDLE_SOURCE, bundle);
	assert.equal(readFileSync(iosResource, 'utf8'), bundle);
	assert.equal(DEFUDDLE_VERSION, packageJSON.version);
	assert.equal(DEFUDDLE_VERSION, '0.19.6');
});

test('Defuddle notice carries the MIT license', () => {
	const notice = readFileSync(iosNotice, 'utf8');
	assert.match(notice, /MIT/);
	assert.match(notice, /Steph Ango/);
	assert.match(notice, /0\.19\.6/);
});
