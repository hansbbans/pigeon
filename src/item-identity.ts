const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GOOGLE_ITEM_PREFIX = 'tag:google.com,2005:reader/item/';
const HEX_ITEM_ID_REGEX = /^[0-9a-fA-F]{16}$/;
const GOOGLE_ITEM_SUFFIX_REGEX = /^[0-9a-fA-F]{16}$/;
const NUMERIC_ITEM_ID_REGEX = /^\d+$/;

function parsePositiveSafeInteger(value: string, radix: 10 | 16): number | null {
	const parsed = Number.parseInt(value, radix);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function parseGoogleReaderItemRowid(itemId: string): number | null {
	if (itemId.startsWith(GOOGLE_ITEM_PREFIX)) {
		const suffix = itemId.slice(GOOGLE_ITEM_PREFIX.length);
		return GOOGLE_ITEM_SUFFIX_REGEX.test(suffix) ? parsePositiveSafeInteger(suffix, 16) : null;
	}
	if (HEX_ITEM_ID_REGEX.test(itemId)) {
		return parsePositiveSafeInteger(itemId, 16);
	}
	if (NUMERIC_ITEM_ID_REGEX.test(itemId)) {
		return parsePositiveSafeInteger(itemId, 10);
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
