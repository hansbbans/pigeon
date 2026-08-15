const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GOOGLE_ITEM_PREFIX = 'tag:google.com,2005:reader/item/';

export function parseGoogleReaderItemRowid(itemId: string): number | null {
	if (itemId.startsWith(GOOGLE_ITEM_PREFIX)) {
		const parsed = Number.parseInt(itemId.slice(GOOGLE_ITEM_PREFIX.length), 16);
		return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
	}
	if (/^[0-9a-fA-F]{16}$/.test(itemId)) {
		const parsed = Number.parseInt(itemId, 16);
		return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
	}
	if (/^\d+$/.test(itemId)) {
		const parsed = Number.parseInt(itemId, 10);
		return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
	}
	return null;
}

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
