const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function hasStoredItemId(id: string | null): boolean {
	return id !== null && UUID_REGEX.test(id);
}

export async function createCanonicalItemUuid(params: {
	feedKey: string;
	id: string | null;
	messageId?: string | null;
	subject: string;
	htmlContent: string;
	textContent?: string | null;
	fromName: string | null;
	fromEmail: string | null;
	receivedAt: string;
}): Promise<string> {
	if (hasStoredItemId(params.id)) {
		return params.id!;
	}

	// Derive a deterministic UUID from available identifiers
	const source = [
		params.messageId || '',
		params.feedKey,
		params.subject,
		params.receivedAt,
		params.fromEmail || '',
	].join('\x00');

	const data = new TextEncoder().encode(source);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const bytes = new Uint8Array(hashBuffer).slice(0, 16);

	// Format as UUID v8 (custom/experimental)
	bytes[6] = (bytes[6] & 0x0f) | 0x80;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;

	const hex = Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
