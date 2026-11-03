/**
 * Timestamps read from D1 and returned by the JSON APIs.
 *
 * API dates are ISO 8601 UTC. Older rows can still hold SQLite
 * `datetime('now')` values (`YYYY-MM-DD HH:MM:SS`, UTC without `T`/`Z`), and
 * the iOS decoder rejects a whole response when any date is not ISO 8601.
 */

const SQLITE_UTC = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/;
/** The shape the app's ISO8601DateFormatter reads, with or without milliseconds. */
const API_ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

/** Parses a stored timestamp, reading SQLite `datetime('now')` values as UTC. */
function parseDatabaseTimestamp(value: string): Date | null {
	const date = new Date(SQLITE_UTC.test(value) ? `${value.replace(' ', 'T')}Z` : value);
	return Number.isNaN(date.getTime()) ? null : date;
}

/** Canonical ISO 8601 UTC for a stored timestamp; throws when it is unreadable. */
export function toISO8601(value: string): string {
	const date = parseDatabaseTimestamp(value);
	if (!date) throw new Error(`Invalid database timestamp: ${value}`);
	return date.toISOString();
}

/**
 * A stored timestamp as an API date: ISO 8601 UTC values pass through
 * unchanged, other readable values are converted, and unreadable or missing
 * values become null.
 */
export function apiTimestamp(value: string | null | undefined): string | null {
	if (!value) return null;
	const date = parseDatabaseTimestamp(value);
	if (!date) return null;
	return API_ISO_UTC.test(value) ? value : date.toISOString();
}
