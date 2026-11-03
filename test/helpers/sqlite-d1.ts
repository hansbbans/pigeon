import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/** A minimal D1 adapter over node:sqlite for tests that need real SQL. */
export class SqliteStatement {
	private values: unknown[] = [];

	constructor(
		private readonly database: DatabaseSync,
		readonly sql: string,
		private readonly limits?: { maxQueries: number; queries: number },
	) {}

	bind(...values: unknown[]): this {
		if (values.length > 100) throw new Error('D1 maximum bound parameters exceeded');
		this.values = values;
		return this;
	}

	async all<T>(): Promise<{ results: T[] }> {
		this.recordQuery();
		return { results: this.database.prepare(this.sql).all(...(this.values as never[])) as T[] };
	}

	async first<T>(): Promise<T | null> {
		this.recordQuery();
		return (this.database.prepare(this.sql).get(...(this.values as never[])) as T | undefined) ?? null;
	}

	async run(): Promise<{ meta: { changes: number } }> {
		this.recordQuery();
		const result = this.database.prepare(this.sql).run(...(this.values as never[]));
		return { meta: { changes: Number(result.changes) } };
	}

	async execute(): Promise<{ results: unknown[]; meta: { changes: number } }> {
		const { results } = await this.all();
		const { changes } = this.database.prepare('SELECT changes() AS changes').get() as { changes: number };
		return { results, meta: { changes: Number(changes) } };
	}

	private recordQuery(): void {
		if (this.limits && ++this.limits.queries > this.limits.maxQueries) {
			throw new Error('D1 query budget exceeded');
		}
	}
}

export class SqliteD1 {
	constructor(readonly database: DatabaseSync, readonly limits?: { maxQueries: number; queries: number }) {}

	prepare(sql: string): SqliteStatement {
		return new SqliteStatement(this.database, sql, this.limits);
	}

	async batch(statements: SqliteStatement[]): Promise<Array<{ results: unknown[]; meta: { changes: number } }>> {
		this.database.exec('BEGIN IMMEDIATE');
		try {
			const results = [];
			for (const statement of statements) results.push(await statement.execute());
			this.database.exec('COMMIT');
			return results;
		} catch (error) {
			this.database.exec('ROLLBACK');
			throw error;
		}
	}
}

/** A fresh database built from the current SCHEMA.sql. */
export function createSchemaDatabase(): { database: DatabaseSync; db: SqliteD1 } {
	const database = new DatabaseSync(':memory:');
	database.exec('PRAGMA foreign_keys = ON');
	database.exec(readFileSync(new URL('../../04-storage/SCHEMA.sql', import.meta.url), 'utf8'));
	return { database, db: new SqliteD1(database) };
}

export function articleSyncChanges(database: DatabaseSync): number {
	return (database.prepare("SELECT COUNT(*) AS count FROM sync_changes WHERE entity_type = 'article'").get() as { count: number }).count;
}
