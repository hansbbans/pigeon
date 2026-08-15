import * as assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { collectCandidateUrls, discoverFeeds, handleFeedDiscovery } from '../src/feed-discovery';
import { generateApiToken } from '../src/api-auth';

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function rss(title: string, siteUrl = 'https://example.com/'): string {
	return `<rss version="2.0"><channel><title>${title}</title><link>${siteUrl}</link></channel></rss>`;
}

test('accepts a direct feed even when its content type is generic', async () => {
	globalThis.fetch = (async () =>
		new Response(rss('Direct Feed'), {
			status: 200,
			headers: { 'Content-Type': 'text/plain' },
		})) as typeof fetch;

	const result = await discoverFeeds('feeds.example.com/news.xml');
	assert.equal(result.input_url, 'https://feeds.example.com/news.xml');
	assert.equal(result.candidates.length, 1);
	assert.deepEqual(result.candidates[0], {
		url: 'https://feeds.example.com/news.xml',
		title: 'Direct Feed',
		format: 'rss2',
		site_url: 'https://example.com/',
		source: 'direct',
		score: 200,
		aliases: [],
	});
});

test('extracts tolerant alternate links, resolves relative URLs, and ignores unsafe candidates', () => {
	const candidates = collectCandidateUrls(
		`<html><head>
			<link TITLE='Primary &amp; News' HREF='../rss.xml?x=1&amp;y=2' TYPE='application/rss+xml' REL='alternate stylesheet'>
			<link rel="alternate" href="http://127.0.0.1/private" type="application/atom+xml">
			<link rel="alternate" href="/not-a-feed" type="text/html">
		</head></html>`,
		new URL('https://www.example.com/blog/index.html'),
	);

	assert.equal(candidates[0]?.url.href, 'https://www.example.com/rss.xml?x=1&y=2');
	assert.equal(candidates[0]?.title, 'Primary & News');
	assert.equal(candidates[0]?.source, 'alternate');
	assert.equal(candidates.some((candidate) => candidate.url.hostname === '127.0.0.1'), false);
	assert.equal(candidates.some((candidate) => candidate.url.pathname === '/feed/'), true);
});

test('ranks valid alternates above fallbacks and isolates candidate failures', async () => {
	const html = `<html><head>
		<link rel="alternate" type="application/atom+xml" title="Broken" href="/broken.xml">
		<link rel="alternate" type="application/feed+json" title="JSON News" href="/news.json">
	</head></html>`;
	globalThis.fetch = (async (input) => {
		const url = new URL(String(input));
		if (url.pathname === '/') {
			return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } });
		}
		if (url.pathname === '/news.json') {
			return Response.json({
				version: 'https://jsonfeed.org/version/1.1',
				title: 'JSON News',
				home_page_url: 'https://example.com/news',
				items: [],
			});
		}
		if (url.pathname === '/feed/') {
			return new Response(rss('Fallback Feed'), {
				status: 200,
				headers: { 'Content-Type': 'application/rss+xml' },
			});
		}
		if (url.pathname === '/broken.xml') {
			return new Response('<html>broken</html>', {
				status: 200,
				headers: { 'Content-Type': 'text/html' },
			});
		}
		return new Response('missing', { status: 404 });
	}) as typeof fetch;

	const result = await discoverFeeds('https://example.com/');
	assert.deepEqual(
		result.candidates.map((candidate) => [candidate.title, candidate.source, candidate.score]),
		[
			['JSON News', 'alternate', 110],
			['Fallback Feed', 'fallback', 60],
		],
	);
	assert.equal(result.failures.some((failure) => failure.url.endsWith('/broken.xml')), true);
	assert.equal(result.failures.length, 4);
});

test('limits concurrent candidate fetches to four', async () => {
	const alternateLinks = Array.from(
		{ length: 8 },
		(_, index) => `<link rel="alternate" type="application/rss+xml" href="/feed-${index}.xml">`,
	).join('');
	let active = 0;
	let maximumActive = 0;
	globalThis.fetch = (async (input) => {
		const url = new URL(String(input));
		if (url.pathname === '/') {
			return new Response(`<html><head>${alternateLinks}</head></html>`, {
				status: 200,
				headers: { 'Content-Type': 'text/html' },
			});
		}
		active += 1;
		maximumActive = Math.max(maximumActive, active);
		await new Promise((resolve) => setTimeout(resolve, 5));
		active -= 1;
		return new Response(rss(url.pathname), {
			status: 200,
			headers: { 'Content-Type': 'application/rss+xml' },
		});
	}) as typeof fetch;

	const result = await discoverFeeds('https://example.com/');
	assert.equal(result.candidates.length, 12);
	assert.equal(maximumActive, 4);
});

test('discovery API requires authentication and redacts URLs in errors', async () => {
	const env = { API_PASSWORD: 'secret-password' } as never;
	const unauthenticated = await handleFeedDiscovery(
		new Request('https://pigeon.example/feeds/discover', {
			method: 'POST',
			body: JSON.stringify({ url: 'https://example.com' }),
		}),
		env,
	);
	assert.equal(unauthenticated.status, 401);

	globalThis.fetch = (async () => new Response('nope', { status: 500 })) as typeof fetch;
	const token = await generateApiToken('secret-password');
	const authenticated = await handleFeedDiscovery(
		new Request('https://pigeon.example/feeds/discover', {
			method: 'POST',
			headers: {
				Authorization: `GoogleLogin auth=pigeon/${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ url: 'https://sensitive.example/path?token=secret' }),
		}),
		env,
	);
	assert.equal(authenticated.status, 400);
	assert.doesNotMatch(await authenticated.text(), /sensitive|token=secret/i);
});
