/** Truncate stored content by UTF-8 bytes without splitting a code point. */
export function truncateUtf8(value: string, maxBytes: number): string {
	const encoded = new TextEncoder().encode(value);
	if (encoded.byteLength <= maxBytes) return value;
	let end = maxBytes;
	while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1;
	return new TextDecoder().decode(encoded.subarray(0, end));
}
