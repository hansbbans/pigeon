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

test('requireApiAuth rejects the SHA-256("") token when the password is unset or empty', async () => {
	const emptyToken = await generateApiToken('');
	const request = () => new Request('https://example.com/feeds/subscribe', {
		headers: { Authorization: `GoogleLogin auth=pigeon/${emptyToken}` },
	});

	assert.equal((await requireApiAuth(request(), ''))?.status, 401);
	assert.equal((await requireApiAuth(request(), undefined as unknown as string))?.status, 401);
});

test('requireApiAuth rejects tokens that differ only in length or a trailing byte', async () => {
	const token = await generateApiToken('secret-password');
	for (const candidate of [token.slice(0, -1), `${token}0`, `${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`, '']) {
		const request = new Request('https://example.com/feeds/subscribe', {
			headers: { Authorization: `GoogleLogin auth=pigeon/${candidate}` },
		});
		assert.equal((await requireApiAuth(request, 'secret-password'))?.status, 401, candidate);
	}
});

test('constantTimeEqual compares strings without accepting prefixes or different lengths', async () => {
	const { constantTimeEqual } = await import('../src/api-auth');
	assert.equal(constantTimeEqual('abc', 'abc'), true);
	assert.equal(constantTimeEqual('abc', 'abd'), false);
	assert.equal(constantTimeEqual('abc', 'ab'), false);
	assert.equal(constantTimeEqual('', ''), true);
	assert.equal(constantTimeEqual('😀', '😀'), true);
	assert.equal(constantTimeEqual('😀', '😁'), false);
});

test('GReader routes refuse the empty-password token when API_PASSWORD is unset', async () => {
	const { handleGreaderRequest } = await import('../src/greader');
	const emptyToken = await generateApiToken('');
	for (const API_PASSWORD of ['', undefined]) {
		const env = { API_PASSWORD, DB: {} } as never;
		const tokenResponse = await handleGreaderRequest(new Request('https://example.com/reader/api/0/token', {
			headers: { Authorization: `GoogleLogin auth=pigeon/${emptyToken}` },
		}), env);
		assert.equal(tokenResponse.status, 401);
		const loginResponse = await handleGreaderRequest(
			new Request('https://example.com/accounts/ClientLogin?Passwd=', { method: 'GET' }),
			env,
		);
		assert.equal(loginResponse.status, 401);
	}
});
