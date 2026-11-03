/** Optional reading-length fields shared by the sync and GReader payloads. */
export interface ReadingLengthColumns {
	word_count?: number | null;
	media_kind?: string | null;
	duration_seconds?: number | null;
}

export interface ReadingLengthFields {
	wordCount?: number;
	mediaKind?: 'text' | 'video';
	durationSeconds?: number;
}

/** Omits null values so older clients and fixtures see no new keys. */
export function readingLengthFields(row: ReadingLengthColumns): ReadingLengthFields {
	const fields: ReadingLengthFields = {};
	if (typeof row.word_count === 'number') fields.wordCount = row.word_count;
	if (row.media_kind === 'text' || row.media_kind === 'video') fields.mediaKind = row.media_kind;
	if (typeof row.duration_seconds === 'number') fields.durationSeconds = row.duration_seconds;
	return fields;
}
