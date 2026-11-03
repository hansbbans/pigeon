import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	WORD_COUNT_SOURCE_LIMIT,
	countItemWords,
	countWordsInHtml,
	countWordsInText,
} from '../src/word-count';
import { mediaKindForUrl } from '../src/youtube';

test('counts words in HTML, with tags acting as word boundaries', () => {
	assert.equal(countWordsInHtml('<p>Hello <b>big</b> world</p>'), 3);
	assert.equal(countWordsInHtml('<p>one</p><p>two</p>'), 2);
	assert.equal(countWordsInHtml('<p>in<b>line</b></p>'), 2);
	assert.equal(countWordsInHtml(''), 0);
});

test('skips head, style, script, template and comments', () => {
	const html = `<html><head><title>Ignored title words</title><style>p { color: red }</style></head>
		<body><!-- a hidden comment --><script>var x = "not words";</script>
		<template><p>template words</p></template><p>Visible words here</p></body></html>`;
	assert.equal(countWordsInHtml(html), 3);
});

test('treats non-breaking space entities as whitespace and other entities as letters', () => {
	assert.equal(countWordsInHtml('a&nbsp;b'), 2);
	assert.equal(countWordsInHtml('a&#160;b&#xa0;c'), 3);
	assert.equal(countWordsInHtml('caf&eacute; &amp; bar'), 3);
});

test('counts whitespace-separated words in plain text', () => {
	assert.equal(countWordsInText('  one\ntwo\tthree '), 3);
	assert.equal(countWordsInText(''), 0);
});

test('caps the scan so a huge newsletter stays inside the CPU budget', () => {
	const html = `<p>${'word '.repeat(200_000)}</p>`;
	const started = performance.now();
	const count = countWordsInHtml(html);
	const elapsed = performance.now() - started;
	assert.equal(count, countWordsInHtml(html.slice(0, WORD_COUNT_SOURCE_LIMIT)));
	assert.equal(count, 60_000);
	assert.ok(elapsed < 50, `scan took ${elapsed} ms`);
});

test('countItemWords prefers HTML, falls back to text, and handles missing bodies', () => {
	assert.equal(countItemWords('<p>three html words</p>', 'two text'), 3);
	assert.equal(countItemWords('', 'two words'), 2);
	assert.equal(countItemWords(null, null), 0);
});

test('mediaKindForUrl marks YouTube video links as video', () => {
	assert.equal(mediaKindForUrl('https://youtu.be/dQw4w9WgXcQ'), 'video');
	assert.equal(mediaKindForUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'video');
	assert.equal(mediaKindForUrl('https://www.youtube.com/@channel'), 'text');
	assert.equal(mediaKindForUrl('https://example.com/a'), 'text');
	assert.equal(mediaKindForUrl(null), 'text');
});
