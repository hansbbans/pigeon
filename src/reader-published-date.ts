// Self-contained: the browser reading tools inline this function via toString(),
// so it must not reference imports or other module-level names.
export function normalizePublishedDate(value: unknown, now: Date = new Date()): string | null {
	if (typeof value !== 'string' || value.length > 200 || !/\b(19|20)\d\d\b/.test(value)) return null;
	const time = Date.parse(value.trim());
	if (!Number.isFinite(time)) return null;
	if (time < Date.UTC(1990, 0, 1) || time > now.getTime() + 86_400_000) return null;
	return new Date(time).toISOString();
}
