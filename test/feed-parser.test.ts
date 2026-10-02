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

test('Atom namespace prefixes preserve feed, entry, author, link and media fields', () => {
	const feed = parseFeed(`<a:feed xmlns:a="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/">
	 <a:title>Prefixed Feed</a:title><a:link href="https://example.com/"/><a:author><a:name>Ada</a:name></a:author>
	 <a:entry><a:id>story</a:id><a:title>Prefixed Article</a:title><a:updated>2026-10-02T12:00:00Z</a:updated><a:link href="/story"/>
	 <a:content type="html">&lt;p&gt;Body&lt;/p&gt;</a:content><a:link rel="enclosure" href="/audio.mp3" type="audio/mpeg"/></a:entry>
	 <a:entry><yt:videoId>dQw4w9WgXcQ</yt:videoId><a:title>Video</a:title><media:group><media:description>Media description</media:description><media:thumbnail url="https://example.com/thumb.jpg"/></media:group></a:entry>
	 </a:feed>`);
	assert.equal(feed.title, 'Prefixed Feed');
	assert.equal(feed.link, 'https://example.com/');
	assert.deepEqual(feed.items[0], {
		guid: 'story', title: 'Prefixed Article', pubDate: '2026-10-02T12:00:00.000Z', link: 'https://example.com/story', content: '<p>Body</p>', author: 'Ada',
		attachments: [{ url: 'https://example.com/audio.mp3', mimeType: 'audio/mpeg', title: undefined }],
	});
	assert.equal(feed.items[1].guid, 'yt:video:dQw4w9WgXcQ');
	assert.equal(feed.items[1].content, '<p>Media description</p>');
	assert.equal(feed.items[1].attachments[0].url, 'https://example.com/thumb.jpg');
});

test('Atom namespace redeclarations stay local and foreign element names remain distinct', () => {
	const feed = parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom" xmlns:a="http://www.w3.org/2005/Atom" xmlns:other="https://example.com/foreign">
	 <title>Namespaces</title>
	 <entry xmlns:a="https://example.com/foreign" xmlns:b="http://www.w3.org/2005/Atom"><id>first</id><a:title>Foreign title</a:title><title xmlns="https://example.com/foreign">Foreign default title</title><b:title>Correct title</b:title><a:content>Foreign body</a:content><b:content type="html">&lt;p&gt;Correct body&lt;/p&gt;</b:content></entry>
	 <a:entry><a:id>second</a:id><other:title>Foreign title</other:title><a:title>Inherited prefix</a:title><a:content type="html">&lt;p&gt;Second&lt;/p&gt;</a:content></a:entry>
	 <other:entry><other:id>ignored</other:id><other:title>Extension</other:title></other:entry>
	 <entry xmlns="https://example.com/foreign"><id>ignored-default</id><title>Extension</title></entry>
	 </feed>`);
	assert.deepEqual(feed.items.map((item) => [item.guid, item.title, item.content]), [
		['first', 'Correct title', '<p>Correct body</p>'], ['second', 'Inherited prefix', '<p>Second</p>'],
	]);
	assert.throws(() => parseFeed('<other:feed xmlns:other="https://example.com/foreign"><other:title>Foreign</other:title></other:feed>'), /Unsupported feed format/);
	const rss = parseFeed('<rss version="2.0" xmlns:a="http://www.w3.org/2005/Atom"><channel><title>RSS</title><a:link href="https://example.com/atom"/><link>https://example.com/rss</link><item><guid>one</guid><description>RSS body</description></item></channel></rss>');
	assert.equal(rss.link, 'https://example.com/rss');
});

test('large inherited namespace scopes keep local redeclarations and unusual prefix names independent', () => {
	const declarations = Array.from({ length: 25_000 }, (_, index) => `xmlns:p${index}="https://example.com/extension/${index}"`).join(' ');
	const entries = Array.from({ length: 50 }, (_, index) => `<entry xmlns:a="http://www.w3.org/2005/Atom"><id>${index}</id><a:title>Article ${index}</a:title><content>Body</content></entry>`).join('');
	const feed = parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom" xmlns:__proto__="http://www.w3.org/2005/Atom" xmlns:constructor="http://www.w3.org/2005/Atom" ${declarations}><__proto__:title>Large feed</__proto__:title><constructor:author><constructor:name>Ada</constructor:name></constructor:author>${entries}</feed>`);
	assert.equal(feed.title, 'Large feed');
	assert.equal(feed.items.length, 50);
	assert.deepEqual(feed.items.map((item) => [item.title, item.author]), Array.from({ length: 50 }, (_, index) => [`Article ${index}`, 'Ada']));
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

test('Atom XHTML bodies preserve mixed text, entities, and namespace inheritance', () => {
 for (const prefix of ['', 'a:']) {
  const declaration = prefix ? 'xmlns:a="http://www.w3.org/2005/Atom"' : 'xmlns="http://www.w3.org/2005/Atom"';
  const feed = parseFeed(`<${prefix}feed ${declaration} xmlns:h="http://www.w3.org/1999/xhtml"><${prefix}title>Feed</${prefix}title><${prefix}entry><${prefix}id>one</${prefix}id><${prefix}content type="xhtml"><h:div><h:p>Before <h:b>bold</h:b> after &amp; &lt;literal&gt;.</h:p></h:div></${prefix}content></${prefix}entry></${prefix}feed>`);
  assert.equal(feed.items[0].content, '<p>Before <b>bold</b> after &amp; &lt;literal&gt;.</p>');
 }
});

test('Atom XHTML summaries preserve repeated children and CDATA', () => {
 const feed = parseFeed('<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>one</id><summary type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>First</p> between <p><![CDATA[A < B]]></p> end</div></summary></entry></feed>');
 assert.equal(feed.items[0].content, '<p>First</p> between <p>A &lt; B</p> end');
});

test('XHTML normalization preserves foreign content fields and ordinary RSS extension names', () => {
 const atom = parseFeed('<a:feed xmlns:a="http://www.w3.org/2005/Atom" xmlns:f="urn:foreign"><a:entry><a:id>one</a:id><f:content type="xhtml"><div>wrong</div></f:content><a:content type="html">&lt;p&gt;right&lt;/p&gt;</a:content></a:entry></a:feed>');
 assert.equal(atom.items[0].content, '<p>right</p>');
 const rss = parseFeed('<rss xmlns:a="urn:foreign"><channel><title>Feed</title><item><guid>one</guid><a:content type="xhtml"><div>wrong</div></a:content><description>right</description></item></channel></rss>');
 assert.equal(rss.items[0].content, 'right');
});

test('Atom XHTML rejects oversized and excessively dense bodies before constructing a second feed tree', () => {
 const wrap = (body: string) => `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>one</id><content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">${body}</div></content></entry></feed>`;
 assert.throws(() => parseFeed(wrap('a'.repeat(1_000_001))), /parsing limit/);
 assert.throws(() => parseFeed(wrap('<span>x</span>'.repeat(20_001))), /element limit/);
 assert.equal(parseFeed(wrap('a'.repeat(100_000))).items[0].content.length, 100_000);
});

test('Atom XHTML requires one correctly namespaced div and counts UTF-8 bytes', () => {
 const wrap = (body: string) => `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>one</id><content type="xhtml">${body}</content></entry></feed>`;
 assert.throws(() => parseFeed(wrap('<div xmlns="urn:foreign">wrong</div>')), /XHTML div/);
 assert.throws(() => parseFeed(wrap('<div xmlns="http://www.w3.org/1999/xhtml">one</div><div xmlns="http://www.w3.org/1999/xhtml">two</div>')), /XHTML div/);
 assert.throws(() => parseFeed(wrap(`<div xmlns="http://www.w3.org/1999/xhtml">${'😀'.repeat(250_001)}</div>`)), /parsing limit/);
});

test('XHTML empty non-void elements close before following text while HTML void elements remain unpaired', () => {
 const feed = parseFeed('<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>one</id><content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><span style="color:red"/>Normal<br/><img src="image.png"/><div/>After</div></content></entry></feed>');
 assert.equal(feed.items[0].content, '<span style="color:red"></span>Normal<br><img src="image.png"><div></div>After');
});

test('XHTML inline SVG and MathML inherited prefixes serialize as HTML-recognized element names', () => {
 const feed = parseFeed('<feed xmlns="http://www.w3.org/2005/Atom" xmlns:s="http://www.w3.org/2000/svg" xmlns:m="http://www.w3.org/1998/Math/MathML"><entry><id>one</id><content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><s:svg viewBox="0 0 10 10"><s:circle cx="5" cy="5" r="3"/></s:svg><m:math><m:mi>x</m:mi></m:math></div></content></entry></feed>');
 assert.equal(feed.items[0].content, '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="3"></circle></svg><math><mi>x</mi></math>');
});

test('Namespace-less Atom compatibility does not let foreign default namespaces masquerade as fields', () => {
 const feed = parseFeed('<feed xmlns:h="http://www.w3.org/1999/xhtml"><title xmlns="urn:foreign">Wrong feed</title><title>Right feed</title><entry><id>one</id><title xmlns="urn:foreign">Wrong title</title><title>Right title</title><author xmlns="urn:foreign"><name>Wrong author</name></author><content xmlns="urn:foreign" type="html">wrong</content><content type="xhtml"><h:div><h:p>Right body</h:p></h:div></content></entry></feed>');
 assert.equal(feed.title, 'Right feed');
 assert.equal(feed.items[0].title, 'Right title');
 assert.equal(feed.items[0].author, undefined);
 assert.equal(feed.items[0].content, '<p>Right body</p>');
});

test('A feed root in a foreign namespace is not detected as Atom', () => {
 assert.throws(() => parseFeed('<feed xmlns="urn:foreign"><title>Not Atom</title><entry><id>one</id><content>Wrong</content></entry></feed>'), /Unsupported feed format/);
});
