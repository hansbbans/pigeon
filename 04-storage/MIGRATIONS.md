# Migration Strategy

## Approach

D1 has no built-in migration tooling. Pigeon uses a version-based migration runner through `ensureDatabaseSchema` on database-backed Worker paths.

## Current Implementation

The production implementation is in `src/migrations.ts`:

- `ensureDatabaseSchema(env)` coalesces concurrent migration calls for the same D1 binding with a `WeakMap<D1Database, Promise<void>>`.
- It minimally creates `_meta` and the `schema_version` row, then reads the persisted version before doing table, column, index, trigger, or backfill work. A stored version of `12` returns immediately; a newer version fails with an unsupported-version error instead of being downgraded or modified.
- The v12 path uses one ordered, atomic D1 batch: it creates the non-unique `idx_sync_changes_entity` index on `(entity_type, entity_id)`, claims the old version with a private in-batch sentinel, gates the legacy item-status and feed-tag backfills plus the feed, article, and status sync seeds on that sentinel, and records schema version `12` last. A concurrent wrapper that loses the claim performs no source-table backfill scans, and the index keeps the winner's sync existence checks bounded.
- Malformed or out-of-range persisted schema versions are rejected instead of being guessed or silently reset.

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

Call `ensureDatabaseSchema(env)` from the database-backed `fetch()` and `email()` paths. On the first database-backed request after a deployment, pending work is applied; a current database performs only the minimal `_meta` bootstrap and persisted-version read before returning. The `WeakMap` coalesces concurrent calls for the same D1 binding, while the ordered v12 batch claims every source backfill atomically so a second wrapper cannot repeat those scans after the first commits.

Alternatively, run migrations manually via wrangler:
```bash
wrangler d1 execute pigeon-db --file=./04-storage/SCHEMA.sql
```
