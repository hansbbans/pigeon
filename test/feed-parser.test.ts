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

test('Atom plain text content and summaries retain literal markup characters', () => {
	const feed = parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom"><title>Text</title>
	 <entry><id>explicit</id><content type="text">Example: &lt;code&gt; &amp; symbols</content></entry>
	 <entry><id>default</id><content>Example: &lt;code&gt; &amp; symbols</content></entry>
	 <entry><id>summary</id><summary type="text">Example: &lt;code&gt; &amp; symbols</summary></entry>
	 <entry><id>html</id><content type="html">&lt;p&gt;Actual markup &amp;amp; symbols&lt;/p&gt;</content></entry>
	 <entry><id>mime-html</id><content type="text/html">&lt;p&gt;Actual markup&lt;/p&gt;</content></entry>
	 <entry><id>mime-text</id><content type="text/plain">Example: &lt;code&gt; &amp; symbols</content></entry>
	 </feed>`);
	assert.deepEqual(feed.items.map((item) => item.content), [
		'<p>Example: &lt;code&gt; &amp; symbols</p>', '<p>Example: &lt;code&gt; &amp; symbols</p>', '<p>Example: &lt;code&gt; &amp; symbols</p>',
		'<p>Actual markup &amp; symbols</p>', '<p>Actual markup</p>', '<p>Example: &lt;code&gt; &amp; symbols</p>',
	]);
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

test('JSON Feed authors inherit feed defaults while item authors and explicit empty arrays override them', () => {
	const feed = parseFeed(JSON.stringify({
		version: 'https://jsonfeed.org/version/1.1', title: 'Authors', authors: [{ name: 'Feed Author' }], author: { name: 'Legacy feed author' },
		items: [
			{ id: 'inherited', content_text: 'Body' },
			{ id: 'override', content_text: 'Body', authors: [{ name: 'Item Author' }], author: { name: 'Legacy item author' } },
			{ id: 'anonymous', content_text: 'Body', authors: [], author: { name: 'Incorrect legacy fallback' } },
			{ id: 'unnamed-first', content_text: 'Body', authors: [{ url: 'https://example.com' }, { name: 'Named Author' }] },
			{ id: 'null', content_text: 'Body', authors: null, author: null },
		],
	}));
	assert.deepEqual(feed.items.map((item) => item.author), ['Feed Author', 'Item Author', undefined, 'Named Author', 'Feed Author']);
	const legacy = parseFeed(JSON.stringify({ version: 'https://jsonfeed.org/version/1', title: 'Legacy', author: { name: 'Legacy Author' }, items: [{ id: 'one', content_text: 'Body' }] }));
	assert.equal(legacy.items[0].author, 'Legacy Author');
});

test('Atom entries inherit feed authors and retain entry authors when several are declared', () => {
	const feed = parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom"><title>Authors</title><id>authors</id><updated>2026-10-02T12:00:00Z</updated><author><name>Feed Author</name></author>
	 <entry><id>one</id><title>One</title><content>Body</content></entry>
	 <entry><id>two</id><title>Two</title><author><name>Entry Author</name></author><author><name>Second Author</name></author><content>Body</content></entry>
	 <entry><id>three</id><title>Three</title><source><author><name>Source Author</name></author></source><content>Body</content></entry>
	 <entry><id>four</id><title>Four</title><author><name/></author><author><name>Named Author</name></author><content>Body</content></entry></feed>`);
	assert.deepEqual(feed.items.map((item) => item.author), ['Feed Author', 'Entry Author', 'Source Author', 'Named Author']);
});
