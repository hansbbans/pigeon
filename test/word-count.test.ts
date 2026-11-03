import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { WORD_COUNT_SOURCE_LIMIT, countWordsInHtml } from '../src/word-count';
import { mediaKindForFeedItem } from '../src/youtube';

test('counts words in HTML, with tags acting as word boundaries', () => {
	assert.equal(countWordsInHtml('<p>Hello <b>big</b> world</p>'), 3);
	assert.equal(countWordsInHtml('<p>one</p><p>two</p>'), 2);
	assert.equal(countWordsInHtml('<p>in<b>line</b></p>'), 2);
	assert.equal(countWordsInHtml('plain text without tags'), 4);
	assert.equal(countWordsInHtml(''), 0);
});

test('skips head, style, script, template and comments', () => {
	const html = `<html><head><title>Ignored title words</title><style>p { color: red }</style></head>
		<body><!-- a hidden comment --><script>var x = "not words";</script>
		<template><p>template words</p></template><p>Visible words here</p></body></html>`;
	assert.equal(countWordsInHtml(html), 3);
});

test('an unclosed raw-text element or a stray bracket does not swallow the body', () => {
	assert.equal(countWordsInHtml('<html><head><meta charset="utf-8"><body><p>three body words</p></body>'), 3);
	assert.equal(countWordsInHtml('<head/><p>two words</p>'), 2);
	assert.equal(countWordsInHtml('<style>p{}<p>still counted here</p>'), 4);
	assert.equal(countWordsInHtml('<p>a < b and more</p>'), 5);
	assert.equal(countWordsInHtml('<p>ends with a <'), 4);
	assert.equal(countWordsInHtml('<!-- unterminated comment <p>two words</p>'), 2);
});

test('treats non-breaking space entities as whitespace and other entities as letters', () => {
	assert.equal(countWordsInHtml('a&nbsp;b'), 2);
	assert.equal(countWordsInHtml('a&#160;b&#xa0;c'), 3);
	assert.equal(countWordsInHtml('caf&eacute; &amp; bar'), 3);
});

test('caps the scan so a huge newsletter stays cheap', () => {
	const html = `<p>${'word '.repeat(200_000)}</p>`;
	assert.equal(countWordsInHtml(html), countWordsInHtml(html.slice(0, WORD_COUNT_SOURCE_LIMIT)));
	assert.equal(countWordsInHtml(html), 60_000);
});

test('countWordsInHtml is self-contained so the browser client can emit it', () => {
	const emitted = new Function(`return (${countWordsInHtml.toString()})`)() as typeof countWordsInHtml;
	assert.equal(emitted('<head><title>x</title></head><p>Hello <b>big</b> world</p>'), 3);
});

test('only videos from a YouTube channel feed count as video', () => {
	const channelFeed = 'https://www.youtube.com/feeds/videos.xml?channel_id=UCabcdefghijklmnopqrstuv';
	assert.equal(mediaKindForFeedItem(channelFeed, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'video');
	assert.equal(mediaKindForFeedItem(channelFeed, 'https://www.youtube.com/@channel'), 'text');
	// A link blog pointing at a talk is still something to read.
	assert.equal(mediaKindForFeedItem('https://daringfireball.net/feeds/main', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'text');
	assert.equal(mediaKindForFeedItem(null, 'https://youtu.be/dQw4w9WgXcQ'), 'text');
});

test('malformed markup never makes the scan quadratic', () => {
	for (const html of ['<a'.repeat(150_000), '<!--x>'.repeat(50_000), '<script x>'.repeat(30_000), '<style>'.repeat(40_000)]) {
		const started = performance.now();
		countWordsInHtml(html);
		const elapsed = performance.now() - started;
		assert.ok(elapsed < 200, `${html.slice(0, 10)}… took ${elapsed} ms`);
	}
});
