import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildRssItemStatements } from '../src/rss-fetcher';

async function storedContent(content: string, attachmentUrl: string): Promise<string> {
	const bound: unknown[][] = [];
	const db = {
		prepare: () => ({
			bind: (...values: unknown[]) => {
				bound.push(values);
				return {};
			},
		}),
	};
	await buildRssItemStatements(
		db as never,
		'attachment-feed',
		{ link: 'https://example.com/', sourceUrl: 'https://example.com/feed.xml' },
		[{
			guid: 'item-1',
			title: 'Item',
			link: 'https://example.com/item',
			content,
			attachments: [{ url: attachmentUrl, mimeType: 'image/jpeg' }],
		}],
		'2026-10-19T00:00:00.000Z',
	);
	return String(bound[0][6]);
}

test('does not re-append an attachment whose URL appears HTML-escaped in content', async () => {
	const attachmentUrl = 'https://cdn.example.com/image.jpg?w=600&h=400';
	const html = await storedContent(
		'<p>Body</p><img src="https://cdn.example.com/image.jpg?w=600&amp;h=400">',
		attachmentUrl,
	);
	assert.equal(html.match(/<img /g)?.length, 1, html);
});

test('appends an attachment that is not already present in content', async () => {
	const html = await storedContent('<p>Body</p>', 'https://cdn.example.com/other.jpg?w=600&h=400');
	assert.match(html, /<figure><img src="https:\/\/cdn\.example\.com\/other\.jpg\?w=600&amp;h=400"/);
});
