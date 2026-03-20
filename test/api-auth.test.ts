import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { generateApiToken, requireApiAuth } from '../src/api-auth';

test('generateApiToken returns the expected SHA-256 hex digest', async () => {
	assert.equal(
		await generateApiToken('abc'),
		'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
	);
});

test('requireApiAuth accepts the expected authorization header', async () => {
	const token = await generateApiToken('secret-password');
	const request = new Request('https://example.com/feeds/subscribe', {
		headers: {
			Authorization: `GoogleLogin auth=pigeon/${token}`,
		},
	});

	assert.equal(await requireApiAuth(request, 'secret-password'), null);
});

test('requireApiAuth rejects missing or invalid authorization headers', async () => {
	const missingAuthRequest = new Request('https://example.com/feeds/subscribe');
	const invalidAuthRequest = new Request('https://example.com/feeds/subscribe', {
		headers: {
			Authorization: 'GoogleLogin auth=pigeon/not-the-right-token',
		},
	});

	assert.equal((await requireApiAuth(missingAuthRequest, 'secret-password'))?.status, 401);
	assert.equal((await requireApiAuth(invalidAuthRequest, 'secret-password'))?.status, 401);
});
