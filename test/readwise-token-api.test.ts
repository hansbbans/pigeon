import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { generateApiToken } from '../src/api-auth';
import { handleReadwiseTokenRequest } from '../src/readwise-token-api';

class SqliteStatement {
	private values: unknown[] = [];

	constructor(private readonly database: DatabaseSync, private readonly sql: string) {}

	bind(...values: unknown[]): this {
		this.values = values;
		return this;
	}

	async all<T>(): Promise<{ results: T[] }> {
		return { results: this.database.prepare(this.sql).all(...(this.values as never[])) as T[] };
	}

	async first<T>(): Promise<T | null> {
		return (this.database.prepare(this.sql).get(...(this.values as never[])) as T | undefined) ?? null;
	}

	async run(): Promise<{ meta: { changes: number } }> {
		const result = this.database.prepare(this.sql).run(...(this.values as never[]));
		return { meta: { changes: Number(result.changes) } };
	}
}

class SqliteD1 {
	constructor(readonly database: DatabaseSync) {}

	prepare(sql: string): SqliteStatement {
		return new SqliteStatement(this.database, sql);
	}

	async batch(statements: SqliteStatement[]): Promise<Array<{ meta: { changes: number } }>> {
		this.database.exec('BEGIN IMMEDIATE');
		try {
			const results = [];
			for (const statement of statements) results.push(await statement.run());
			this.database.exec('COMMIT');
			return results;
		} catch (error) {
			this.database.exec('ROLLBACK');
			throw error;
		}
	}
}

const PASSWORD = 'readwise-token-password';
const URL_PATH = 'https://pigeon.example/api/v1/readwise/token';

function fixture() {
	const database = new DatabaseSync(':memory:');
	database.exec(readFileSync(new URL('../04-storage/SCHEMA.sql', import.meta.url), 'utf8'));
	const env = { DB: new SqliteD1(database), BASE_URL: 'https://pigeon.example', API_PASSWORD: PASSWORD } as never;
	return { database, env };
}

async function authHeaders(extra: Record<string, string> = {}): Promise<Record<string, string>> {
	return { Authorization: `GoogleLogin auth=pigeon/${await generateApiToken(PASSWORD)}`, ...extra };
}

async function call(env: never, method: string, body?: unknown, authenticated = true): Promise<Response> {
	const headers = authenticated ? await authHeaders(body === undefined ? {} : { 'Content-Type': 'application/json' }) : {};
	return handleReadwiseTokenRequest(
		new Request(URL_PATH, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
		env,
	);
}

test('readwise token endpoint rejects unauthenticated requests', async () => {
	const { env } = fixture();
	for (const method of ['GET', 'PUT', 'DELETE']) {
		const response = await call(env, method, method === 'PUT' ? { token: 'abc' } : undefined, false);
		assert.equal(response.status, 401, method);
	}
	const wrong = await handleReadwiseTokenRequest(
		new Request(URL_PATH, { headers: { Authorization: 'GoogleLogin auth=pigeon/wrong' } }),
		env,
	);
	assert.equal(wrong.status, 401);
});

test('readwise token endpoint returns null before a token is stored', async () => {
	const { env } = fixture();
	const response = await call(env, 'GET');
	assert.equal(response.status, 200);
	assert.equal(response.headers.get('Cache-Control'), 'no-store');
	assert.deepEqual(await response.json(), { token: null });
});

test('readwise token endpoint round-trips PUT, GET, DELETE', async () => {
	const { env, database } = fixture();

	const put = await call(env, 'PUT', { token: '  rw-secret-token  ' });
	assert.equal(put.status, 200, await put.clone().text());
	assert.equal(put.headers.get('Cache-Control'), 'no-store');
	assert.deepEqual(await put.json(), { token: 'rw-secret-token' });

	const stored = database.prepare("SELECT value FROM _meta WHERE key = 'readwise_token'").get() as { value: string };
	assert.equal(stored.value, 'rw-secret-token');

	const get = await call(env, 'GET');
	assert.equal(get.status, 200);
	assert.equal(get.headers.get('Cache-Control'), 'no-store');
	assert.deepEqual(await get.json(), { token: 'rw-secret-token' });

	const replace = await call(env, 'PUT', { token: 'rw-second' });
	assert.equal(replace.status, 200);
	assert.deepEqual(await (await call(env, 'GET')).json(), { token: 'rw-second' });

	const del = await call(env, 'DELETE');
	assert.equal(del.status, 200);
	assert.equal(del.headers.get('Cache-Control'), 'no-store');
	assert.deepEqual(await del.json(), { token: null });
	assert.deepEqual(await (await call(env, 'GET')).json(), { token: null });

	const deleteAgain = await call(env, 'DELETE');
	assert.equal(deleteAgain.status, 200);

	const schemaVersion = database.prepare("SELECT value FROM _meta WHERE key = 'schema_version'").get() as { value: string };
	assert.ok(schemaVersion.value, 'schema_version row is untouched');
});

test('readwise token endpoint rejects invalid PUT bodies', async () => {
	const { env } = fixture();
	for (const body of [{ token: '' }, { token: '   ' }, { token: 42 }, {}, { token: 'x'.repeat(513) }]) {
		const response = await call(env, 'PUT', body);
		assert.equal(response.status, 400, JSON.stringify(body).slice(0, 40));
		assert.equal(response.headers.get('Cache-Control'), 'no-store');
	}
	const malformed = await handleReadwiseTokenRequest(
		new Request(URL_PATH, { method: 'PUT', headers: await authHeaders({ 'Content-Type': 'application/json' }), body: '{not json' }),
		env,
	);
	assert.equal(malformed.status, 400);
	assert.deepEqual(await (await call(env, 'GET')).json(), { token: null });

	const maxLength = await call(env, 'PUT', { token: 'y'.repeat(512) });
	assert.equal(maxLength.status, 200);
});

test('readwise token endpoint returns 405 for unsupported methods', async () => {
	const { env } = fixture();
	const response = await call(env, 'POST', { token: 'abc' });
	assert.equal(response.status, 405);
	assert.equal(response.headers.get('Allow'), 'GET, PUT, DELETE');
});
