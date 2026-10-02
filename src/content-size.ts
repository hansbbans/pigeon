/** Truncate stored content by UTF-8 bytes without splitting a code point. */
export function truncateUtf8(value: string, maxBytes: number): string {
	const encoded = new TextEncoder().encode(value);
	if (encoded.byteLength <= maxBytes) return value;
	let end = maxBytes;
	while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1;
	return new TextDecoder().decode(encoded.subarray(0, end));
}
// Together with the 900KB body budget, these bounds leave space in a 1MB row.
export const MAX_TEXT_METADATA_BYTES = 16_000;
export const MAX_IDENTIFIER_BYTES = 8_000;

export function assertBoundedIdentifier(value: string, field: string): void {
	if (new Blob([value]).size > MAX_IDENTIFIER_BYTES) {
		throw new Error(`${field} exceeds the stored identifier limit`);
	}
}

export function boundedStoredUrl(value: string | null): string | null {
	return value && new Blob([value]).size <= MAX_IDENTIFIER_BYTES ? value : null;
}
