import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { handleIncomingEmail } from '../src/email-handler';

class EmailDatabase {
	readonly database = new DatabaseSync(':memory:');

	constructor() {
		this.database.exec(readFileSync(new URL('../04-storage/SCHEMA.sql', import.meta.url), 'utf8'));
	}

	prepare(sql: string) {
		let values: unknown[] = [];
		const statement = {
			bind(...bound: unknown[]) { values = bound; return statement; },
			async first<T>() { return (this.database.prepare(sql).get(...values) ?? null) as T | null; },
			async all<T>() { return { results: this.database.prepare(sql).all(...values) as T[] }; },
			async run() { return { meta: this.database.prepare(sql).run(...values) }; },
			database: this.database,
		};
		return statement;
	}

	async batch(statements: Array<{ run(): Promise<unknown> }>) {
		this.database.exec('BEGIN');
		try {
			for (const statement of statements) await statement.run();
			this.database.exec('COMMIT');
		} catch (error) {
			this.database.exec('ROLLBACK');
			throw error;
		}
	}
}

async function deliver(db: EmailDatabase, id: string, date: string, content = 'Newsletter body', contentType = 'text/plain; charset=UTF-8') {
	const raw = [
		'From: Newsletter <news@example.com>',
		'To: pigeon@example.com',
		'Subject: Newsletter',
		`Date: ${date}`,
		`Message-ID: <${id}@example.com>`,
		'MIME-Version: 1.0',
		`Content-Type: ${contentType}`,
		'',
		content,
	].join('\r\n');
	await handleIncomingEmail({
		from: 'news@example.com', to: 'pigeon@example.com', raw: new Blob([raw]).stream(),
	} as unknown as ForwardableEmailMessage, {
		DB: db, BASE_URL: 'https://pigeon.example', ITEMS_PER_FEED: '50', API_PASSWORD: 'password',
	} as never);
}

test('duplicate delivery does not inflate feed counts or reset an existing item status', async () => {
	const db = new EmailDatabase();
	try {
		await deliver(db, 'same-message', 'Fri, 02 Oct 2026 12:00:00 +0000');
		db.database.exec('UPDATE items SET is_read = 1, is_starred = 1');
		await deliver(db, 'same-message', 'Fri, 02 Oct 2026 12:00:00 +0000');
		const feed = db.database.prepare('SELECT item_count FROM feeds').get();
		assert.equal(feed?.item_count, 1);
		const items = db.database.prepare('SELECT is_read, is_starred FROM items').all();
		assert.equal(items.length, 1);
		assert.equal(items[0].is_read, 1);
		assert.equal(items[0].is_starred, 1);
	} finally { db.database.close(); }
});

test('an older email arriving later preserves the newest feed timestamp', async () => {
	const db = new EmailDatabase();
	try {
		await deliver(db, 'newer', 'Fri, 02 Oct 2026 12:00:00 +0000');
		await deliver(db, 'older', 'Thu, 01 Oct 2026 12:00:00 +0000');
		const feed = db.database.prepare('SELECT item_count, last_item_at FROM feeds').get();
		assert.equal(feed?.item_count, 2);
		assert.equal(feed?.last_item_at, '2026-10-02T12:00:00.000Z');
	} finally { db.database.close(); }
});

test('large plain text emails stay within the combined D1 content budget without breaking UTF-8', async () => {
	const db = new EmailDatabase();
	try {
		const content = '😀'.repeat(300_000);
		await deliver(db, 'large', 'Fri, 02 Oct 2026 12:00:00 +0000', content);
		const item = db.database.prepare('SELECT html_content, text_content, content_size FROM items').get();
		assert.ok(item);
		const html = String(item.html_content);
		const text = String(item.text_content);
		const storedBytes = new Blob([html, text]).size;
		assert.ok(storedBytes <= 900_000, `Stored content was ${storedBytes} bytes`);
		assert.equal(item.content_size, storedBytes);
		assert.ok(text.length > 0);
		assert.ok(content.startsWith(text));
		assert.doesNotMatch(html + text, /\uFFFD/);
	} finally { db.database.close(); }
});

test('plain text below the single-field limit is still bounded when stored in two fields', async () => {
	const db = new EmailDatabase();
	try {
		await deliver(db, 'two-copies', 'Fri, 02 Oct 2026 12:00:00 +0000', 'a'.repeat(600_000));
		const item = db.database.prepare('SELECT html_content, text_content, content_size FROM items').get();
		assert.ok(item);
		assert.equal(new Blob([String(item.html_content), String(item.text_content)]).size, 900_000);
		assert.equal(item.content_size, 900_000);
	} finally { db.database.close(); }
});

test('oversized HTML-only email retains bounded content when no plain-text alternative exists', async () => {
	const db = new EmailDatabase();
	try {
		await deliver(db, 'html-only', 'Fri, 02 Oct 2026 12:00:00 +0000', `<p>${'😀'.repeat(300_000)}</p>`, 'text/html; charset=UTF-8');
		const item = db.database.prepare('SELECT html_content, text_content, content_size FROM items').get();
		assert.ok(item);
		const html = String(item.html_content);
		assert.ok(html.startsWith('<p>😀'));
		assert.ok(new Blob([html]).size <= 900_000);
		assert.equal(item.text_content, null);
		assert.equal(item.content_size, new Blob([html]).size);
		assert.doesNotMatch(html, /\uFFFD/);
	} finally { db.database.close(); }
});
