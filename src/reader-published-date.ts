// Self-contained: the browser reading tools inline this function via toString(),
// so it must not reference imports or other module-level names.
// Accepts only explicit date formats and reads dates without a zone as UTC,
// matching iOS ReaderPublishedDate. Loose text ("Updated 2025") is rejected.
export function normalizePublishedDate(value: unknown, now: Date = new Date()): string | null {
	if (typeof value !== 'string' || value.length > 200) return null;
	const text = value.trim();
	const monthIndex = (name: string): number => {
		const lower = name.toLowerCase();
		const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
		return months.findIndex((month) => lower.length >= 3 && month.startsWith(lower));
	};
	const zoneMinutes = (zone: string | undefined): number => {
		if (!zone || /^(z|gmt|utc)$/i.test(zone)) return 0;
		const digits = zone.slice(1).replace(':', '');
		return (zone[0] === '-' ? -1 : 1) * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
	};
	let parts: { year: number; month: number; day: number; hour: number; minute: number; second: number; ms: number; zone?: string } | null = null;
	let match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/i.exec(text);
	if (match) {
		parts = { year: +match[1], month: +match[2] - 1, day: +match[3], hour: +(match[4] ?? 0), minute: +(match[5] ?? 0), second: +(match[6] ?? 0), ms: Math.round(Number('0.' + (match[7] ?? '0')) * 1000), zone: match[8] };
	} else if ((match = /^(?:[A-Za-z]{3,9},?\s+)?(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?\s*(GMT|UTC|Z|[+-]\d{4})?)?$/i.exec(text))) {
		parts = { year: +match[3], month: monthIndex(match[2]), day: +match[1], hour: +(match[4] ?? 0), minute: +(match[5] ?? 0), second: +(match[6] ?? 0), ms: 0, zone: match[7] };
	} else if ((match = /^(?:[A-Za-z]{3,9},?\s+)?([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/i.exec(text))) {
		parts = { year: +match[3], month: monthIndex(match[1]), day: +match[2], hour: 0, minute: 0, second: 0, ms: 0 };
	}
	if (!parts || parts.month < 0 || parts.hour > 23 || parts.minute > 59 || parts.second > 59) return null;
	const calendar = new Date(Date.UTC(parts.year, parts.month, parts.day));
	if (calendar.getUTCMonth() !== parts.month || calendar.getUTCDate() !== parts.day) return null;
	const time = Date.UTC(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second, parts.ms) - zoneMinutes(parts.zone) * 60_000;
	if (time < Date.UTC(1990, 0, 1) || time > now.getTime() + 86_400_000) return null;
	return new Date(time).toISOString();
}
