import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorizationHeader, clientLogin, parseClientLoginResponse, postSave } from '../src/core/api';
import { AUTH, mockFetch, ORIGIN, savedReply } from './helpers/fakes';

test('parseClientLoginResponse reads the Auth line', () => {
	assert.equal(parseClientLoginResponse('SID=pigeon/abc\nLSID=null\nAuth=pigeon/abc'), 'pigeon/abc');
	assert.equal(parseClientLoginResponse('SID=x\r\nAuth=pigeon/def\r\n'), 'pigeon/def');
	assert.equal(parseClientLoginResponse('<html>Not Pigeon</html>'), null);
	assert.equal(authorizationHeader('pigeon/abc'), 'GoogleLogin auth=pigeon/abc');
});

test('clientLogin posts the Passwd form field and returns the token', async () => {
	const { fetch, requests } = mockFetch(() => new Response('SID=pigeon/tok\nLSID=null\nAuth=pigeon/tok'));
	assert.deepEqual(await clientLogin(fetch, ORIGIN, 'p&ss=word'), { ok: true, auth: 'pigeon/tok' });
	assert.equal(requests[0].url, `${ORIGIN}/accounts/ClientLogin`);
	assert.equal(requests[0].method, 'POST');
	assert.equal(requests[0].headers['content-type'], 'application/x-www-form-urlencoded');
	assert.equal(new URLSearchParams(requests[0].body).get('Passwd'), 'p&ss=word');
});

test('clientLogin reports a wrong password, an unreachable server and a non-Pigeon reply', async () => {
	const bad = await clientLogin(mockFetch(() => new Response('Error=BadAuthentication', { status: 401 })).fetch, ORIGIN, 'x');
	assert.equal(bad.ok === false && bad.reason, 'badPassword');
	const offline = await clientLogin(mockFetch(() => 'network-error').fetch, ORIGIN, 'x');
	assert.equal(offline.ok === false && offline.reason, 'network');
	const other = await clientLogin(mockFetch(() => new Response('<html></html>')).fetch, ORIGIN, 'x');
	assert.equal(other.ok === false && other.reason, 'server');
	const down = await clientLogin(mockFetch(() => new Response('', { status: 503 })).fetch, ORIGIN, 'x');
	assert.equal(down.ok === false && down.reason, 'server');
});

test('postSave sends JSON with the GoogleLogin header and classifies replies', async () => {
	const { fetch, requests } = mockFetch([
		() => savedReply('pending'),
		() => new Response('Unauthorized', { status: 401 }),
		() => Response.json({ error: 'url must use http or https' }, { status: 400 }),
		() => new Response('too big', { status: 413 }),
		() => new Response('', { status: 503 }),
		() => new Response('Not found', { status: 404 }),
		() => 'network-error',
		() => new Response('<html>captive portal</html>'),
	]);
	const body = { url: 'https://example.com/a' };
	assert.equal((await postSave(fetch, ORIGIN, AUTH, body)).kind, 'ok');
	assert.equal(requests[0].url, `${ORIGIN}/api/v1/saved`);
	assert.equal(requests[0].headers.authorization, `GoogleLogin auth=${AUTH}`);
	assert.equal(requests[0].headers['content-type'], 'application/json');
	assert.deepEqual(JSON.parse(requests[0].body), body);
	assert.equal((await postSave(fetch, ORIGIN, AUTH, body)).kind, 'unauthorized');
	assert.deepEqual(await postSave(fetch, ORIGIN, AUTH, body), { kind: 'rejected', status: 400, message: 'url must use http or https' });
	assert.equal((await postSave(fetch, ORIGIN, AUTH, body)).kind, 'rejected');
	assert.equal((await postSave(fetch, ORIGIN, AUTH, body)).kind, 'retry');
	assert.equal((await postSave(fetch, ORIGIN, AUTH, body)).kind, 'retry');
	assert.equal((await postSave(fetch, ORIGIN, AUTH, body)).kind, 'retry');
	assert.equal((await postSave(fetch, ORIGIN, AUTH, body)).kind, 'retry');
});
