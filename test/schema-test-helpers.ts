export interface SchemaState {
	schemaVersion: string;
	hasMetaTable: boolean;
	hasFeedsTable: boolean;
	hasItemsTable: boolean;
	hasFeedTagsTable: boolean;
	hasEngagementEventsTable: boolean;
	hasFeedUrlAliasesTable: boolean;
	hasRefreshActivityTable: boolean;
	hasItemStatusesTable: boolean;
	hasSyncChangesTable: boolean;
	hasMutationReceiptsTable: boolean;
	engagementEventColumns: Set<string>;
	feedColumns: Set<string>;
	itemColumns: Set<string>;
	operations: string[];
}

interface SqliteMasterRow {
	name: string;
}

export function createCurrentSchemaState(): SchemaState {
	return {
		schemaVersion: '10',
		hasMetaTable: true,
		hasFeedsTable: true,
		hasItemsTable: true,
		hasFeedTagsTable: true,
		hasEngagementEventsTable: true,
		hasFeedUrlAliasesTable: true,
		hasRefreshActivityTable: true,
		hasItemStatusesTable: true,
		hasSyncChangesTable: true,
		hasMutationReceiptsTable: true,
		engagementEventColumns: new Set(['destination_host']),
		feedColumns: new Set([
			'feed_key',
			'display_name',
			'from_email',
			'source_type',
			'source_url',
			'site_url',
			'fetch_interval_minutes',
			'last_fetched_at',
			'fetch_error',
			'etag',
			'last_modified',
			'first_seen_at',
			'last_item_at',
			'item_count',
			'is_active',
			'custom_title',
			'category',
			'icon_url',
			'canonical_url',
			'feed_format',
			'next_fetch_at',
			'last_attempt_at',
			'last_success_at',
			'consecutive_failures',
			'last_http_status',
			'retry_after_at',
			'content_hash',
			'conditional_checked_at',
			'refresh_lease_until',
			'refresh_lease_token',
			'last_refresh_outcome',
			'last_fetch_duration_ms',
		]),
		itemColumns: new Set([
			'id',
			'feed_key',
			'from_name',
			'from_email',
			'subject',
			'html_content',
			'text_content',
			'original_url',
			'message_id',
			'received_at',
			'created_at',
			'content_size',
			'content_pruned_at',
			'is_read',
			'is_starred',
		]),
		operations: [],
	};
}

export function createLegacySchemaState(): SchemaState {
	const state = createCurrentSchemaState();
	state.schemaVersion = '3';
	state.hasFeedTagsTable = false;
	state.hasEngagementEventsTable = false;
	state.hasFeedUrlAliasesTable = false;
	state.hasRefreshActivityTable = false;
	state.hasItemStatusesTable = false;
	state.hasSyncChangesTable = false;
	state.hasMutationReceiptsTable = false;
	state.engagementEventColumns.clear();
	state.feedColumns.delete('site_url');
	for (const column of [
		'canonical_url',
		'feed_format',
		'next_fetch_at',
		'last_attempt_at',
		'last_success_at',
		'consecutive_failures',
		'last_http_status',
		'retry_after_at',
		'content_hash',
		'conditional_checked_at',
		'refresh_lease_until',
		'refresh_lease_token',
		'last_refresh_outcome',
		'last_fetch_duration_ms',
	]) {
		state.feedColumns.delete(column);
	}
	state.itemColumns.delete('original_url');
	state.itemColumns.delete('content_pruned_at');
	return state;
}

export function maybeHandleSchemaFirst<T>(
	sql: string,
	values: unknown[],
	state: SchemaState,
): { handled: true; value: T | null } | { handled: false } {
	if (sql === "SELECT value FROM _meta WHERE key = 'schema_version'") {
		return {
			handled: true,
			value: (state.hasMetaTable ? { value: state.schemaVersion } : null) as T | null,
		};
	}

	if (sql === "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?") {
		const tableName = String(values[0] ?? '');
		const exists =
			(tableName === 'feeds' && state.hasFeedsTable) ||
			(tableName === 'items' && state.hasItemsTable) ||
			(tableName === 'feed_tags' && state.hasFeedTagsTable) ||
			(tableName === 'engagement_events' && state.hasEngagementEventsTable) ||
			(tableName === 'feed_url_aliases' && state.hasFeedUrlAliasesTable) ||
			(tableName === 'refresh_activity' && state.hasRefreshActivityTable) ||
			(tableName === 'item_statuses' && state.hasItemStatusesTable) ||
			(tableName === 'sync_changes' && state.hasSyncChangesTable) ||
			(tableName === 'mutation_receipts' && state.hasMutationReceiptsTable) ||
			(tableName === '_meta' && state.hasMetaTable);

		return {
			handled: true,
			value: (exists ? ({ name: tableName } satisfies SqliteMasterRow) : null) as T | null,
		};
	}

	return { handled: false };
}

export function maybeHandleSchemaAll<T>(
	sql: string,
	state: SchemaState,
): { handled: true; results: T[] } | { handled: false } {
	if (sql === 'PRAGMA table_info(feeds)') {
		return {
			handled: true,
			results: [...state.feedColumns].map((name) => ({ name })) as T[],
		};
	}

	if (sql === 'PRAGMA table_info(items)') {
		return {
			handled: true,
			results: [...state.itemColumns].map((name) => ({ name })) as T[],
		};
	}

	if (sql === 'PRAGMA table_info(engagement_events)') {
		return {
			handled: true,
			results: [...state.engagementEventColumns].map((name) => ({ name })) as T[],
		};
	}

	return { handled: false };
}

export function maybeHandleSchemaRun(
	sql: string,
	values: unknown[],
	state: SchemaState,
): boolean {
	if (sql.startsWith('CREATE TABLE IF NOT EXISTS _meta')) {
		state.hasMetaTable = true;
		state.operations.push('create-meta');
		return true;
	}

	if (sql.startsWith("INSERT OR IGNORE INTO _meta (key, value) VALUES ('schema_version', '0')")) {
		state.hasMetaTable = true;
		state.schemaVersion ||= '0';
		state.operations.push('seed-meta');
		return true;
	}

	if (sql === 'ALTER TABLE feeds ADD COLUMN site_url TEXT') {
		state.feedColumns.add('site_url');
		state.operations.push('add-site_url');
		return true;
	}

	if (sql === 'ALTER TABLE items ADD COLUMN original_url TEXT') {
		state.itemColumns.add('original_url');
		state.operations.push('add-original_url');
		return true;
	}

	if (sql.startsWith('ALTER TABLE feeds ADD COLUMN ')) {
		const columnName = sql.replace('ALTER TABLE feeds ADD COLUMN ', '').split(/\s+/, 1)[0];
		state.feedColumns.add(columnName);
		state.operations.push(`add-${columnName}`);
		return true;
	}

	if (sql.startsWith('ALTER TABLE items ADD COLUMN ')) {
		const columnName = sql.replace('ALTER TABLE items ADD COLUMN ', '').split(/\s+/, 1)[0];
		state.itemColumns.add(columnName);
		state.operations.push(`add-${columnName}`);
		return true;
	}

	if (sql.startsWith('CREATE INDEX IF NOT EXISTS idx_feeds_next_fetch')) {
		state.operations.push('create-next-fetch-index');
		return true;
	}

	if (sql.startsWith('CREATE INDEX IF NOT EXISTS idx_feeds_refresh_due')) {
		state.operations.push('create-refresh-due-index');
		return true;
	}

	if (sql.startsWith('CREATE UNIQUE INDEX IF NOT EXISTS idx_feeds_canonical_url')) {
		state.operations.push('create-canonical-url-index');
		return true;
	}

	if (sql.startsWith('CREATE TABLE IF NOT EXISTS feed_url_aliases')) {
		state.hasFeedUrlAliasesTable = true;
		state.operations.push('create-feed_url_aliases');
		return true;
	}

	if (sql.startsWith('CREATE TABLE IF NOT EXISTS refresh_activity')) {
		state.hasRefreshActivityTable = true;
		state.operations.push('create-refresh_activity');
		return true;
	}

	if (sql.startsWith('CREATE TABLE IF NOT EXISTS item_statuses')) {
		state.hasItemStatusesTable = true;
		state.operations.push('create-item_statuses');
		return true;
	}

	if (
		sql.startsWith('CREATE INDEX IF NOT EXISTS idx_feed_url_aliases_') ||
		sql.startsWith('CREATE INDEX IF NOT EXISTS idx_refresh_activity_') ||
		sql.startsWith('CREATE INDEX IF NOT EXISTS idx_item_statuses_')
	) {
		state.operations.push('create-v9-index');
		return true;
	}

	if (sql.startsWith('INSERT OR IGNORE INTO item_statuses')) {
		state.operations.push('backfill-item_statuses');
		return true;
	}

	if (sql.startsWith('CREATE TRIGGER IF NOT EXISTS trg_items_')) {
		state.operations.push('create-item-status-trigger');
		return true;
	}

	if (sql.startsWith('CREATE TABLE IF NOT EXISTS sync_changes')) {
		state.hasSyncChangesTable = true;
		state.operations.push('create-sync_changes');
		return true;
	}

	if (sql.startsWith('CREATE TABLE IF NOT EXISTS mutation_receipts')) {
		state.hasMutationReceiptsTable = true;
		state.operations.push('create-mutation_receipts');
		return true;
	}

	if (
		sql.startsWith('CREATE INDEX IF NOT EXISTS idx_sync_changes_') ||
		sql.startsWith('CREATE INDEX IF NOT EXISTS idx_mutation_receipts_')
	) {
		state.operations.push('create-v10-index');
		return true;
	}

	if (sql.startsWith('CREATE TRIGGER IF NOT EXISTS trg_sync_')) {
		state.operations.push('create-sync-trigger');
		return true;
	}

	if (sql.startsWith('INSERT INTO sync_changes')) {
		state.operations.push('seed-sync_changes');
		return true;
	}

	if (sql.startsWith('CREATE TABLE IF NOT EXISTS feed_tags')) {
		state.hasFeedTagsTable = true;
		state.operations.push('create-feed_tags');
		return true;
	}

	if (sql.startsWith('CREATE INDEX IF NOT EXISTS idx_feed_tags_label')) {
		state.operations.push('create-feed_tags-index');
		return true;
	}

	if (sql.startsWith('CREATE TABLE IF NOT EXISTS engagement_events')) {
		state.hasEngagementEventsTable = true;
		state.engagementEventColumns.add('destination_host');
		state.operations.push('create-engagement_events');
		return true;
	}

	if (sql === 'ALTER TABLE engagement_events ADD COLUMN destination_host TEXT') {
		state.engagementEventColumns.add('destination_host');
		state.operations.push('add-destination_host');
		return true;
	}

	if (sql.startsWith('CREATE INDEX IF NOT EXISTS idx_engagement_events_')) {
		state.operations.push(`create-${sql.match(/idx_engagement_events_\w+/)?.[0] ?? 'engagement-index'}`);
		return true;
	}

	if (sql.startsWith('INSERT OR IGNORE INTO feed_tags')) {
		state.operations.push('backfill-feed_tags');
		return true;
	}

	if (sql === "UPDATE _meta SET value = ? WHERE key = 'schema_version'") {
		state.schemaVersion = String(values[0] ?? state.schemaVersion);
		state.operations.push(`set-schema-version:${state.schemaVersion}`);
		return true;
	}

	if (sql.startsWith(`INSERT INTO _meta (key, value) VALUES ('schema_version', ?)`)) {
		state.hasMetaTable = true;
		state.schemaVersion = String(values[0] ?? state.schemaVersion);
		state.operations.push(`set-schema-version:${state.schemaVersion}`);
		return true;
	}

	return false;
}
