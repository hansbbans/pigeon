import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { parseFeed, type FeedFormat } from '../src/rss-parser';

interface CorpusCase {
	name: string;
	source: string;
	sourceUrl?: string;
	expectedFormat?: FeedFormat;
	expectedItems?: number;
	expectedError?: boolean;
}

const corpus = JSON.parse(
	readFileSync(new URL('./fixtures/feed-corpus.json', import.meta.url), 'utf8'),
) as CorpusCase[];

test('checked-in feed corpus contains at least 50 representative documents', () => {
	assert.ok(corpus.length >= 50);
	assert.deepEqual(
		new Set(corpus.flatMap((fixture) => fixture.expectedFormat ?? [])),
		new Set<FeedFormat>(['rss2', 'rss1', 'atom', 'json']),
	);
});

for (const fixture of corpus) {
	test(`feed corpus: ${fixture.name}`, () => {
		if (fixture.expectedError) {
			assert.throws(() => parseFeed(fixture.source, { sourceUrl: fixture.sourceUrl }));
			return;
		}

		const feed = parseFeed(fixture.source, { sourceUrl: fixture.sourceUrl });
		assert.equal(feed.format, fixture.expectedFormat);
		assert.equal(feed.items.length, fixture.expectedItems);
	});
}

test('invalid feed dates remain absent instead of becoming newly arrived now', () => {
	const fixture = corpus.find((candidate) => candidate.name === 'rss2-3');
	assert.ok(fixture);

	const feed = parseFeed(fixture.source, { sourceUrl: fixture.sourceUrl });
	assert.equal(feed.items[0]?.pubDate, undefined);
});

test('relative links resolve against the feed home page', () => {
	const fixture = corpus.find((candidate) => candidate.name === 'rss2-1');
	assert.ok(fixture);

	const feed = parseFeed(fixture.source, { sourceUrl: fixture.sourceUrl });
	assert.equal(feed.items[0]?.link, 'https://example.com/posts/1');
});

test('valid empty Atom and JSON feeds are accepted', () => {
	for (const name of ['atom-4', 'json-4']) {
		const fixture = corpus.find((candidate) => candidate.name === name);
		assert.ok(fixture);
		assert.equal(parseFeed(fixture.source, { sourceUrl: fixture.sourceUrl }).items.length, 0);
	}
});

test('relative enclosure and media URLs resolve against the feed home page', () => {
	const expectedUrls = new Map([
		['rss2-relative-media', ['https://example.com/images/photo.jpg', 'https://example.com/audio/episode.mp3']],
		['atom-relative-enclosure', ['https://example.com/audio/episode.mp3']],
		['rss1-relative-media', ['https://example.com/images/thumb.jpg']],
		['json-relative-attachment', ['https://example.com/audio/show.mp3']],
	]);

	for (const [name, urls] of expectedUrls) {
		const fixture = corpus.find((candidate) => candidate.name === name);
		assert.ok(fixture);
		const feed = parseFeed(fixture.source, { sourceUrl: fixture.sourceUrl });
		assert.deepEqual(feed.items[0]?.attachments.map((attachment) => attachment.url).sort(), urls.sort());
	}
});

test('newsletter HTML, duplicate ids, and missing ids remain deterministic parser inputs', () => {
	const newsletter = corpus.find((candidate) => candidate.name === 'rss2-newsletter-content');
	const duplicates = corpus.find((candidate) => candidate.name === 'rss2-duplicate-identifiers');
	const missing = corpus.find((candidate) => candidate.name === 'rss2-missing-identifiers');
	assert.ok(newsletter);
	assert.ok(duplicates);
	assert.ok(missing);

	assert.match(parseFeed(newsletter.source, { sourceUrl: newsletter.sourceUrl }).items[0]?.content ?? '', /<table>/);
	assert.deepEqual(
		parseFeed(duplicates.source, { sourceUrl: duplicates.sourceUrl }).items.map((item) => item.guid),
		['same-guid', 'same-guid'],
	);
	const parsedMissing = parseFeed(missing.source, { sourceUrl: missing.sourceUrl }).items[0];
	assert.equal(parsedMissing?.guid, '');
	assert.equal(parsedMissing?.pubDate, undefined);
});
