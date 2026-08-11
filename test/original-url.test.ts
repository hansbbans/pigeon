import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractOriginalUrlFromEmail } from '../src/original-url';

test('extractOriginalUrlFromEmail prefers a canonical link when one is present', () => {
	const url = extractOriginalUrlFromEmail({
		subject: 'A canonical story',
		fromAddress: 'writer@example.com',
		htmlContent: `
			<html>
				<head>
					<link rel="canonical" href="https://example.com/posts/canonical-story" />
				</head>
				<body>
					<a href="https://example.com/newsletter">Newsletter home</a>
				</body>
			</html>
		`,
	});

	assert.equal(url, 'https://example.com/posts/canonical-story');
});

test('extractOriginalUrlFromEmail picks the subject-matching title link over utility links', () => {
	const url = extractOriginalUrlFromEmail({
		subject: 'I am an introvert. This is how I get myself to speak up.',
		fromAddress: 'weskao@substack.com',
		htmlContent: `
			<a href="https://substack.com/redirect/subscribe">Subscribe here</a>
			<a href="https://substack.com/app-link/post?publication_id=289208&post_id=172818809">
				I&#8217;m an introvert. This is how I get myself to speak up.
			</a>
			<a href="https://substack.com/@weskao">Wes Kao</a>
			<a href="https://substack.com/app-link/post?comments=true&post_id=172818809">Comment</a>
			<a href="https://open.substack.com/pub/weskao/p/im-an-introvert-this-is-how-i-get-myself-to-speak-up?redirect=app-store">
				READ IN APP
			</a>
		`,
	});

	assert.equal(url, 'https://substack.com/app-link/post?publication_id=289208&post_id=172818809');
});

test('extractOriginalUrlFromEmail falls back to a view-in-browser link when needed', () => {
	const url = extractOriginalUrlFromEmail({
		subject: 'Can you have child safety and Section 230, too?',
		fromAddress: 'casey@platformer.news',
		htmlContent: `
			<a href="https://www.platformer.news/r/a839729a?m=d31a3c67-05a3-4fdb-b2f7-f41c2a7fbb15">Platformer</a>
			<a href="https://www.platformer.news/r/7b9b05ba?m=d31a3c67-05a3-4fdb-b2f7-f41c2a7fbb15">View in browser</a>
			<a href="https://www.platformer.news/r/1d2c3b4a?m=d31a3c67-05a3-4fdb-b2f7-f41c2a7fbb15">Read this issue</a>
		`,
	});

	assert.equal(url, 'https://www.platformer.news/r/7b9b05ba?m=d31a3c67-05a3-4fdb-b2f7-f41c2a7fbb15');
});

test('extractOriginalUrlFromEmail rejects utility-only link sets', () => {
	const url = extractOriginalUrlFromEmail({
		subject: 'This should stay without a click-through link',
		fromAddress: 'sender@example.com',
		htmlContent: `
			<a href="https://example.com/unsubscribe">Unsubscribe</a>
			<a href="https://example.com/preferences">Manage preferences</a>
			<a href="https://example.com/post?comments=true">Comment</a>
			<a href="https://facebook.com/example">Share on Facebook</a>
		`,
	});

	assert.equal(url, null);
});

test('extractOriginalUrlFromEmail rejects low-confidence unrelated links', () => {
	const url = extractOriginalUrlFromEmail({
		subject: 'Weekly team update',
		fromAddress: 'sender@example.com',
		htmlContent: `
			<a href="https://mail-settings.google.com/mail/vf-123">Change your mail settings</a>
		`,
	});

	assert.equal(url, null);
});
