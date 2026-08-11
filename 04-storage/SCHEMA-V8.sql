-- Pigeon schema v8: privacy-safe outbound destination hosts.

ALTER TABLE engagement_events ADD COLUMN destination_host TEXT;

UPDATE _meta SET value = '8' WHERE key = 'schema_version';
