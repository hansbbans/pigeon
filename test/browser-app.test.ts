import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { generateApiToken } from '../src/api-auth';
import app from '../src/index';

function createEnv() {
	return {
		API_PASSWORD: 'secret-password',
		BASE_URL: 'https://pigeon.example',
		ITEMS_PER_FEED: '50',
		DB: {
			prepare() {
				throw new Error('DB should not be used in these route tests');
			},
		},
	};
}

test('GET /app returns an HTML shell', async () => {
	const response = await app.fetch(
		new Request('https://pigeon.example/app'),
		createEnv() as never,
	);

	assert.equal(response.status, 200);
	assert.equal(response.headers.get('Content-Type'), 'text/html; charset=utf-8');
	assert.match(await response.text(), /id="app"/);
});

test('GET /app/ returns the same HTML shell as /app', async () => {
	const response = await app.fetch(
		new Request('https://pigeon.example/app/'),
		createEnv() as never,
	);

	assert.equal(response.status, 200);
	assert.equal(response.headers.get('Content-Type'), 'text/html; charset=utf-8');
	assert.match(await response.text(), /id="app"/);
});

test('GET /app/status requires auth', async () => {
	const response = await app.fetch(
		new Request('https://pigeon.example/app/status'),
		createEnv() as never,
	);

	assert.equal(response.status, 401);
});

test('GET /app/status returns placeholder JSON when authenticated', async () => {
	const token = await generateApiToken('secret-password');
	const response = await app.fetch(
		new Request('https://pigeon.example/app/status', {
			headers: {
				Authorization: `GoogleLogin auth=pigeon/${token}`,
			},
		}),
		createEnv() as never,
	);

	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { status: 'ok' });
});
