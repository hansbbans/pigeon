-- SCHEMA V3: Add favicon support
-- Add icon_url column to feeds table for feed icons/favicons

ALTER TABLE feeds ADD COLUMN icon_url TEXT;

-- Update schema version
UPDATE _meta SET value = '3' WHERE key = 'schema_version';
