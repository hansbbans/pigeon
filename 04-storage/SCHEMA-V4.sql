-- Add original_url column to items table so readers can open the source article
ALTER TABLE items ADD COLUMN original_url TEXT;

UPDATE _meta SET value = '4' WHERE key = 'schema_version';
