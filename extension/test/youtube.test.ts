import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseIsoDuration, youtubeVideoId } from '../src/core/youtube';

test('youtubeVideoId matches the Worker rules', () => {
	const id = 'dQw4w9WgXcQ';
	for (const url of [`https://www.youtube.com/watch?v=${id}&t=10`, `https://m.youtube.com/watch?v=${id}`, `https://youtu.be/${id}?si=x`, `https://youtube.com/shorts/${id}`, `https://www.youtube.com/live/${id}`]) {
		assert.equal(youtubeVideoId(url), id, url);
	}
	for (const url of ['https://www.youtube.com/', 'https://www.youtube.com/@channel', 'https://www.youtube.com/watch?v=short', 'https://example.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com:8443/watch?v=dQw4w9WgXcQ', null]) {
		assert.equal(youtubeVideoId(url), null, String(url));
	}
});

test('parseIsoDuration reads schema.org durations', () => {
	assert.equal(parseIsoDuration('PT18M3S'), 1083);
	assert.equal(parseIsoDuration('PT1H2M3S'), 3723);
	assert.equal(parseIsoDuration('PT45S'), 45);
	assert.equal(parseIsoDuration('P1DT1S'), 86401);
	assert.equal(parseIsoDuration(' pt2m '), 120);
	for (const value of ['P0D', 'PT0S', 'PT', 'P', '18:03', '', null, 42]) assert.equal(parseIsoDuration(value), null, String(value));
});
