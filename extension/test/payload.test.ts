import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSaveAttempts, fitContent, MAX_REQUEST_BYTES, MAX_SAVED_HTML_BYTES, requestBytes, truncateUtf8, utf8Bytes } from '../src/core/payload';

const URL_ = 'https://example.com/essay';

test('truncateUtf8 never splits a character', () => {
	assert.equal(truncateUtf8('héllo', 2), 'h');
	assert.equal(truncateUtf8('héllo', 3), 'hé');
	assert.equal(truncateUtf8('🙂🙂', 5), '🙂');
	assert.equal(truncateUtf8('abc', 10), 'abc');
	assert.equal(truncateUtf8('abc', 0), '');
});

test('a normal extraction is sent whole, with the bare link as fallback', () => {
	const content = { html: '<p>Hello</p>', text: 'Hello', title: 'Essay', wordCount: 1, mediaKind: 'text' as const };
	const [full, bare] = buildSaveAttempts(URL_, 'Tab title', content);
	assert.deepEqual(full, { url: URL_, title: 'Tab title', content });
	assert.deepEqual(bare, { url: URL_, title: 'Essay' });
});

test('text shrinks to what html leaves of the 900 KB budget', () => {
	const html = `<p>${'a'.repeat(800_000)}</p>`;
	const fitted = fitContent({ html, text: 'b'.repeat(500_000) });
	assert.ok(fitted);
	assert.equal(utf8Bytes(fitted.html!) + utf8Bytes(fitted.text!), MAX_SAVED_HTML_BYTES);
});

test('html over the budget turns a text save into a bare link', () => {
	const attempts = buildSaveAttempts(URL_, 'Tab', { html: 'x'.repeat(MAX_SAVED_HTML_BYTES + 1), title: 'Big', mediaKind: 'text' });
	assert.deepEqual(attempts, [{ url: URL_, title: 'Big' }]);
});

test('a video keeps its metadata without html', () => {
	const [full] = buildSaveAttempts('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'Video', { mediaKind: 'video', title: 'V', durationSeconds: 212, html: '   ' });
	assert.deepEqual(full.content, { mediaKind: 'video', title: 'V', durationSeconds: 212 });
});

test('JSON escaping over 2 MB drops text, then content', () => {
	// Control characters escape to six bytes (\\u0001) and quotes to two.
	const html = '"'.repeat(800_000) + '\u0001'.repeat(20_000);
	const [withoutText, fallback] = buildSaveAttempts(URL_, undefined, { html, text: '\u0001'.repeat(80_000) });
	assert.equal(withoutText.content?.text, undefined);
	assert.equal(withoutText.content?.html === html, true);
	assert.ok(requestBytes(withoutText) <= MAX_REQUEST_BYTES);
	assert.deepEqual(fallback, { url: URL_ });
	const attempts = buildSaveAttempts(URL_, 't', { html: '\u0001'.repeat(400_000) });
	assert.deepEqual(attempts, [{ url: URL_, title: 't' }]);
});

test('an empty text field is not sent', () => {
	const fitted = fitContent({ html: '<p>x</p>', text: '  ' });
	assert.deepEqual(fitted, { html: '<p>x</p>' });
});
