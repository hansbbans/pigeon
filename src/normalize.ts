import { decodeWords, type Email } from 'postal-mime';

/** Extract the machine-readable portion from a List-Id header. */
function extractListId(headers: Email['headers']): string | null {
	const header = headers.find((h) => h.key === 'list-id')?.value;
	if (!header) return null;

	// List-Id format: "Human Name <machine-id.domain.com>"
	const match = header.match(/<([^>]+)>/);
	return match ? match[1] : null;
}

/** Normalize an input string into a URL-safe feed key. */
export function normalizeFeedKey(input: string): string {
	return input
		.toLowerCase()
		.trim()
		.replace(/@/g, '-at-')
		.replace(/[^a-z0-9.-]/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
}

/**
 * Resolve the feed key for an email using priority:
 * 1. List-Id header (most reliable for mailing lists)
 * 2. Reply-To if different from From (real sender behind ESP)
 * 3. From address
 */
export function resolveFeedKey(
	headers: Email['headers'],
	fromAddress: string,
	replyToAddress: string | undefined,
): string {
	// A List-Id made only of non-ASCII characters normalizes to an empty key; fall through to the sender.
	const listId = extractListId(headers);
	const listKey = listId ? normalizeFeedKey(listId) : '';
	if (listKey) return listKey;

	if (replyToAddress && replyToAddress !== fromAddress) {
		const replyToKey = normalizeFeedKey(replyToAddress);
		if (replyToKey) return replyToKey;
	}

	return normalizeFeedKey(fromAddress);
}

/**
 * Resolve a human-readable display name for the feed.
 * Tries List-Id human portion first, then From name, then From address.
 */
export function resolveFeedDisplayName(
	headers: Email['headers'],
	fromName: string | undefined,
	fromAddress: string,
): string {
	const listIdHeader = headers.find((h) => h.key === 'list-id')?.value;
	if (listIdHeader) {
		// The phrase may be an RFC 2047 encoded word (`=?utf-8?Q?Caf=C3=A9_Weekly?=`).
		const humanName = decodeWords(unquotePhrase(listIdHeader.replace(/<[^>]+>/, '').trim())).trim();
		if (humanName) return humanName;
	}

	return fromName || humanizeEmail(fromAddress);
}

/** Unwrap an RFC 5322 quoted-string phrase, e.g. `"Morning Brew"` → `Morning Brew`. */
function unquotePhrase(value: string): string {
	const quoted = value.match(/^"((?:[^"\\]|\\.)*)"$/);
	return quoted ? quoted[1].replace(/\\(.)/g, '$1').trim() : value;
}

const GENERIC_LOCAL_PARTS = new Set([
	'newsletters',
	'newsletter',
	'noreply',
	'no-reply',
	'hello',
	'info',
	'mail',
	'mailer',
	'updates',
	'news',
	'contact',
	'team',
	'support',
]);

/** Title-case a string, splitting on `-_.+` and camelCase boundaries. */
function titleCase(input: string): string {
	return input
		.replace(/([a-z])([A-Z])/g, '$1 $2') // camelCase → camel Case
		.split(/[-_.+\s]+/)
		.filter(Boolean)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
		.join(' ');
}

/**
 * Derive a human-readable name from an email address.
 * - Newsletter platforms → title-cased local part
 * - Generic local parts (noreply, newsletters) → domain name
 * - Otherwise → title-cased local part
 */
export function humanizeEmail(email: string): string {
	const [localPart, domain] = email.split('@');
	if (!domain) return email;

	const domainBase = domain.replace(/^mail\./, '').split('.')[0];

	if (GENERIC_LOCAL_PARTS.has(localPart.toLowerCase())) {
		return titleCase(domainBase);
	}

	return titleCase(localPart);
}
