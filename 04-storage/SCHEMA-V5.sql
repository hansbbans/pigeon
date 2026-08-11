-- Add site_url column to feeds table so feed homepages stay separate from feed URLs
ALTER TABLE feeds ADD COLUMN site_url TEXT;

UPDATE _meta SET value = '5' WHERE key = 'schema_version';
