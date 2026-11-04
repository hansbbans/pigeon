import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_PIGEON_URL, isSaveableUrl, normalizePigeonUrl, originPermissionPattern, PigeonUrlError } from '../src/core/config';

test('normalizePigeonUrl keeps only the origin and adds https', () => {
	assert.equal(normalizePigeonUrl(' pigeon.hanscho.com '), 'https://pigeon.hanscho.com');
	assert.equal(normalizePigeonUrl('https://Pigeon.HansCho.com/app/?x=1#y'), 'https://pigeon.hanscho.com');
	assert.equal(normalizePigeonUrl('https://pigeon.example.workers.dev:8443/'), 'https://pigeon.example.workers.dev:8443');
	assert.equal(normalizePigeonUrl(DEFAULT_PIGEON_URL), DEFAULT_PIGEON_URL);
});

test('normalizePigeonUrl allows plain http only for loopback', () => {
	assert.equal(normalizePigeonUrl('http://localhost:8787'), 'http://localhost:8787');
	assert.equal(normalizePigeonUrl('http://127.0.0.1:8787/'), 'http://127.0.0.1:8787');
	assert.throws(() => normalizePigeonUrl('http://pigeon.hanscho.com'), PigeonUrlError);
});

test('normalizePigeonUrl rejects empty, credentials, other schemes and junk', () => {
	for (const input of ['', '   ', 'ftp://pigeon.hanscho.com', 'https://user:pw@pigeon.hanscho.com', 'https://', 'javascript:alert(1)']) {
		assert.throws(() => normalizePigeonUrl(input), PigeonUrlError, input);
	}
});

test('originPermissionPattern drops the port (patterns match every port)', () => {
	assert.equal(originPermissionPattern('https://pigeon.hanscho.com'), 'https://pigeon.hanscho.com/*');
	assert.equal(originPermissionPattern('http://localhost:8787'), 'http://localhost/*');
});

test('isSaveableUrl accepts web pages only', () => {
	assert.equal(isSaveableUrl('https://example.com/a?b=1#c'), true);
	assert.equal(isSaveableUrl('http://example.com'), true);
	for (const url of [undefined, null, '', 'chrome://extensions', 'file:///tmp/a.html', 'about:blank', 'chrome-extension://abc/options.html', 'https://u:p@example.com/', 'not a url', `https://example.com/${'a'.repeat(2048)}`]) {
		assert.equal(isSaveableUrl(url), false, String(url));
	}
});
