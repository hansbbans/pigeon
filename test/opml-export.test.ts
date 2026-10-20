import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import app from '../src/index';

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

async function exportOpml(setup: (database: DatabaseSync) => void): Promise<string> {
	const database = new DatabaseSync(':memory:');
	database.exec(readFileSync(new URL('../04-storage/SCHEMA.sql', import.meta.url), 'utf8'));
	setup(database);
	const env = { DB: new SqliteD1(database), BASE_URL: 'https://pigeon.example', API_PASSWORD: 'pw' } as never;
	const response = await app.fetch(new Request('https://pigeon.example/feeds/opml'), env);
	assert.equal(response.status, 200);
	return response.text();
}

function insertFeed(
	database: DatabaseSync,
	feedKey: string,
	displayName: string,
	options: { customTitle?: string | null; category?: string | null; sourceUrl?: string | null; siteUrl?: string | null } = {},
): void {
	database.prepare(
		`INSERT INTO feeds (feed_key, display_name, custom_title, category, source_type, source_url, site_url)
		 VALUES (?, ?, ?, ?, 'rss', ?, ?)`,
	).run(feedKey, displayName, options.customTitle ?? null, options.category ?? null, options.sourceUrl ?? null, options.siteUrl ?? null);
}

function folderFeedKeys(opml: string): Map<string, string[]> {
	const folders = new Map<string, string[]>();
	let current = '';
	for (const line of opml.split('\n')) {
		const folder = /^\s*<outline text="([^"]*)" title="[^"]*">$/.exec(line);
		if (folder) {
			current = folder[1];
			continue;
		}
		if (/^\s*<\/outline>$/.test(line)) {
			current = '';
			continue;
		}
		const feed = /xmlUrl="https:\/\/pigeon\.example\/feed\/([^"]+)"/.exec(line);
		if (feed) {
			folders.set(current, [...(folders.get(current) ?? []), feed[1]]);
		}
	}
	return folders;
}

test('OPML export lists a feed under every feed_tags folder plus a legacy category without a tag row', async () => {
	const opml = await exportOpml((database) => {
		insertFeed(database, 'multi', 'Multi', { category: 'Tech' });
		database.exec(`INSERT INTO feed_tags (feed_key, label) VALUES ('multi', 'Tech'), ('multi', 'Design')`);
		insertFeed(database, 'legacy', 'Legacy', { category: 'Old Folder' });
		insertFeed(database, 'loose', 'Loose');
	});

	const folders = folderFeedKeys(opml);
	assert.deepEqual(folders.get('Tech'), ['multi']);
	assert.deepEqual(folders.get('Design'), ['multi']);
	assert.deepEqual(folders.get('Old Folder'), ['legacy']);
	assert.deepEqual(folders.get(''), ['loose']);
	assert.equal(opml.match(/xmlUrl="https:\/\/pigeon\.example\/feed\/multi"/g)?.length, 2);
});

test('OPML export omits htmlUrl instead of falling back to the XML source URL', async () => {
	const opml = await exportOpml((database) => {
		insertFeed(database, 'no-site', 'No Site', { sourceUrl: 'https://example.com/feed.xml' });
		insertFeed(database, 'with-site', 'With Site', { sourceUrl: 'https://example.com/other.xml', siteUrl: 'https://example.com/?a=1&b=2' });
	});

	const noSite = opml.split('\n').find((line) => line.includes('/feed/no-site"'));
	assert.ok(noSite);
	assert.doesNotMatch(noSite, /htmlUrl=/);
	assert.match(opml, /htmlUrl="https:\/\/example\.com\/\?a=1&amp;b=2"/);
});

test('OPML export sorts by the displayed title case-insensitively and escapes XML', async () => {
	const opml = await exportOpml((database) => {
		insertFeed(database, 'zeta', 'Zeta', { customTitle: 'alpha <custom> & co' });
		insertFeed(database, 'beta', 'beta');
		insertFeed(database, 'aardvark', 'Aardvark', { customTitle: 'Charlie' });
		database.exec(`INSERT INTO feed_tags (feed_key, label) VALUES ('zeta', 'R&D'), ('beta', 'R&D'), ('aardvark', 'R&D')`);
	});

	assert.deepEqual(folderFeedKeys(opml).get('R&amp;D'), ['zeta', 'beta', 'aardvark']);
	assert.match(opml, /text="alpha &lt;custom&gt; &amp; co"/);
});
