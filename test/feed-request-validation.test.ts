import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { generateApiToken } from '../src/api-auth';
import { handleFeedDiscovery } from '../src/feed-discovery';
import { handleSubscribe } from '../src/subscribe';

test('feed subscription and discovery reject non-object JSON instead of throwing', async () => {
	const token = await generateApiToken('password');
	const env = { API_PASSWORD: 'password' };
	for (const handler of [handleSubscribe, handleFeedDiscovery]) {
		for (const value of [null, [], true, 12, 'https://example.com/feed.xml', {}, { url: [] }, { url: '   ' }]) {
			const response = await handler(new Request('https://pigeon.example/feeds/subscribe', {
				method: 'POST', headers: { Authorization: `GoogleLogin auth=pigeon/${token}` }, body: JSON.stringify(value),
			}), env as never);
			assert.equal(response.status, 400);
		}
	}
	const response = await handleSubscribe(new Request('https://pigeon.example/feeds/subscribe', {
		method: 'POST', headers: { Authorization: `GoogleLogin auth=pigeon/${token}` },
		body: JSON.stringify({ url: 'https://example.com/feed.xml', category: 12 }),
	}), env as never);
	assert.equal(response.status, 400);
	assert.match(await response.text(), /category must be a string/);
});
