import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { generateAtomFeed } from '../src/feed';
import { parseFeed } from '../src/rss-parser';
import { generateOpml } from '../src/opml';

test('JSON Feed content cannot inject characters forbidden in Atom XML', async () => {
	const parsed = parseFeed(JSON.stringify({
		version: 'https://jsonfeed.org/version/1.1',
		title: 'Feed\u0000 title 😀',
		items: [{
			id: 'item-1', title: 'Article\u0001 title 😀',
			content_html: '<p>Body\u000B text 😀</p>',
			authors: [{ name: 'Author\uFFFF\uD800 name 😀' }],
			date_published: '2026-10-02T12:00:00Z',
		}],
	}));
	const xml = await generateAtomFeed({
		feed_key: 'test-feed', display_name: parsed.title, from_email: null, custom_title: null,
	}, parsed.items.map((item) => ({
		id: 'd66a8e7c-1047-4bd5-8b89-8105e491ed37', subject: item.title,
		html_content: item.content, from_name: item.author ?? null, from_email: null,
		received_at: item.pubDate!,
	})), 'https://pigeon.example');
	assert.doesNotMatch(xml, /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF\uFFFE\uFFFF]/u);
	assert.match(xml, /Feed title 😀/);
	assert.match(xml, /Article title 😀/);
	assert.match(xml, /Body text 😀/);
	assert.match(xml, /Author name 😀/);
});

test('OPML export removes forbidden XML characters from feed and folder names', () => {
	const xml = generateOpml([{
		feed_key: 'test-feed', display_name: 'Feed\u0000 title 😀', custom_title: null,
		category: 'Folder\u0001 name 😀', site_url: 'https://example.com/?a=1&b=2',
	}], 'https://pigeon.example');
	assert.doesNotMatch(xml, /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF\uFFFE\uFFFF]/u);
	assert.match(xml, /Feed title 😀/);
	assert.match(xml, /Folder name 😀/);
	assert.match(xml, /a=1&amp;b=2/);
});
