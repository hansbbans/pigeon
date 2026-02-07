# Migration Strategy

## Approach

D1 has no built-in migration tooling. We use a simple version-based migration runner that executes on Worker startup.

## Migration Runner

```typescript
interface Migration {
  version: number;
  description: string;
  sql: string[];
}

const migrations: Migration[] = [
  {
    version: 1,
    description: 'Initial schema',
    sql: [
      // All CREATE TABLE statements from SCHEMA.sql
      // Split into individual statements for D1 batch execution
    ]
  },
  // Future migrations go here:
  // {
  //   version: 2,
  //   description: 'Add feed categories',
  //   sql: ['ALTER TABLE feeds ADD COLUMN category TEXT;']
  // }
];

async function runMigrations(db: D1Database): Promise<void> {
  // Ensure meta table exists
  await db.exec(`
    CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT);
    INSERT OR IGNORE INTO _meta (key, value) VALUES ('schema_version', '0');
  `);
  
  // Get current version
  const result = await db.prepare(
    "SELECT value FROM _meta WHERE key = 'schema_version'"
  ).first<{ value: string }>();
  
  const currentVersion = parseInt(result?.value || '0');
  
  // Run pending migrations
  for (const migration of migrations) {
    if (migration.version > currentVersion) {
      console.log(`Running migration v${migration.version}: ${migration.description}`);
      
      const statements = migration.sql.map(sql => db.prepare(sql));
      statements.push(
        db.prepare("UPDATE _meta SET value = ? WHERE key = 'schema_version'")
          .bind(String(migration.version))
      );
      
      await db.batch(statements);
      console.log(`Migration v${migration.version} complete`);
    }
  }
}
```

## Rules

1. Migrations are **append-only** — never edit a migration that's been deployed
2. Each migration is **idempotent** where possible (use `IF NOT EXISTS`, `OR IGNORE`)
3. D1 doesn't support `DROP COLUMN` — to remove a column, create a new table and migrate data
4. Keep migrations small and focused
5. Test migrations locally with `wrangler d1 execute pigeon-db --local --command "..."`

## Running Migrations

Call `runMigrations(env.DB)` at the start of both `fetch()` and `email()` handlers. D1 queries are fast enough that checking the version on every request is negligible. The actual migration SQL only runs once.

Alternatively, run migrations manually via wrangler:
```bash
wrangler d1 execute pigeon-db --file=./04-storage/SCHEMA.sql
```
