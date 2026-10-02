import PostalMime from 'postal-mime';
import type { Env } from './types';
import { resolveFeedKey, resolveFeedDisplayName } from './normalize';
import { applyRoutingRules } from './routing-rules';
import { getFaviconForEmail } from './favicon';
import { extractOriginalUrlFromEmail } from './original-url';
import { ensureDatabaseSchema } from './migrations';

const MAX_CONTENT_SIZE = 900_000; // 900KB — stay under D1's 1MB row limit

function truncateUtf8(value: string, maxBytes: number): string {
	const encoded = new TextEncoder().encode(value);
	if (encoded.byteLength <= maxBytes) return value;
	let end = maxBytes;
	// Do not keep part of a multibyte code point at the truncation boundary.
	while (end > 0 && (encoded[end] & 0xc0) === 0x80) end -= 1;
	return new TextDecoder().decode(encoded.subarray(0, end));
}

function deriveSiteUrlFromOriginalUrl(originalUrl: string | null): string | null {
	if (!originalUrl) {
		return null;
	}

	try {
		const url = new URL(originalUrl);
		return `${url.origin}/`;
	} catch {
		return null;
	}
}

/**
 * Detect forwarded emails and extract the original sender.
 * Handles Gmail auto-forwards where DMARC rewrites the From header.
 */
function unwrapForward(
	parsed: { from?: { address?: string; name?: string }; subject?: string; headers?: { key: string; value: string }[]; text?: string },
	fromAddress: string,
	trustedForwarder: string | undefined,
): { fromAddress: string; fromName: string | undefined; subject: string } | null {
	if (!trustedForwarder) return null;
	if (fromAddress !== trustedForwarder.toLowerCase()) return null;

	const getHeader = (name: string): string | undefined =>
		parsed.headers?.find((h) => h.key.toLowerCase() === name)?.value;

	let originalAddress: string | undefined;
	let originalName: string | undefined;

	// 1. X-Google-Original-From: "Name <email>" or just "email"
	const xOriginalFrom = getHeader('x-google-original-from');
	if (xOriginalFrom) {
		const match = xOriginalFrom.match(/<([^>]+)>/);
		if (match) {
			originalAddress = match[1].toLowerCase();
			const namepart = xOriginalFrom.slice(0, xOriginalFrom.indexOf('<')).trim().replace(/^"|"$/g, '');
			if (namepart) originalName = namepart;
		} else {
			originalAddress = xOriginalFrom.trim().toLowerCase();
		}
	}

	// 2. X-Original-Sender header (some forwarding services)
	if (!originalAddress) {
		const xOriginalSender = getHeader('x-original-sender');
		if (xOriginalSender) {
			originalAddress = xOriginalSender.trim().toLowerCase();
		}
	}

	// 3. Parse forwarded message block from text body
	if (!originalAddress && parsed.text) {
		const fwdIdx = parsed.text.indexOf('---------- Forwarded message ---------');
		if (fwdIdx !== -1) {
			const block = parsed.text.slice(fwdIdx, fwdIdx + 500);
			const fromMatch = block.match(/From:\s*(?:(.*?)\s*<([^>]+)>|(.+))$/m);
			if (fromMatch) {
				originalAddress = (fromMatch[2] || fromMatch[3]).trim().toLowerCase();
				const bodyName = fromMatch[1]?.trim().replace(/^"|"$/g, '');
				if (bodyName && !originalName) originalName = bodyName;
			}
		}
	}

	if (!originalAddress) return null;

	// Strip "Fwd: " prefix from subject
	const subject = (parsed.subject || '(no subject)').replace(/^Fwd:\s*/i, '');

	console.log(`Forward unwrapped | forwarder=${trustedForwarder} original_sender=${originalAddress}`);

	return { fromAddress: originalAddress, fromName: originalName, subject };
}

export async function handleIncomingEmail(
	message: ForwardableEmailMessage,
	env: Env,
): Promise<void> {
	try {
		await ensureDatabaseSchema(env);

		// 1. Read raw email
		const rawEmail = await new Response(message.raw).arrayBuffer();
		const size = rawEmail.byteLength;

		// 2. Parse with postal-mime
		const parser = new PostalMime();
		const parsed = await parser.parse(rawEmail);

		// 3. Extract fields
		let fromAddress =
			parsed.from?.address?.toLowerCase() || message.from.toLowerCase();
		let fromName = parsed.from?.name || undefined;
		let subject = parsed.subject || '(no subject)';
		const replyToAddress = parsed.replyTo?.[0]?.address?.toLowerCase();

		// 3b. Unwrap forwarded emails (recover original sender)
		const forwarded = unwrapForward(parsed, fromAddress, env.TRUSTED_FORWARDER);
		if (forwarded) {
			fromAddress = forwarded.fromAddress;
			fromName = forwarded.fromName;
			subject = forwarded.subject;
		}

		// Parse date safely
		const parsedDate = parsed.date ? new Date(parsed.date) : null;
		const receivedAt =
			parsedDate && !isNaN(parsedDate.getTime())
				? parsedDate.toISOString()
				: new Date().toISOString();

		const messageId = parsed.messageId || crypto.randomUUID();

		// 4. Resolve feed key and display name
		let feedKey = resolveFeedKey(parsed.headers, fromAddress, replyToAddress);
		let displayName = resolveFeedDisplayName(
			parsed.headers,
			fromName,
			fromAddress,
		);

		// 4b. Check routing rules for feed key override
		const routingOverride = await applyRoutingRules(env.DB, feedKey, {
			subject,
			fromName,
			fromAddress,
		});
		if (routingOverride) {
			console.log(`Routing rule matched | ${feedKey} → ${routingOverride.feedKey} subject="${subject}"`);
			feedKey = routingOverride.feedKey;
			if (routingOverride.displayName) {
				displayName = routingOverride.displayName;
			}
		}

		// 5. Content with size check
		const originalHtmlContent = parsed.html || '';
		let htmlContent = originalHtmlContent;
		const originalTextContent = parsed.text || '';
		let textContent = originalTextContent;
		const sourceContentSize = new Blob([htmlContent, textContent]).size;

		if (sourceContentSize > MAX_CONTENT_SIZE) {
			console.warn(
				`Content too large (${sourceContentSize} bytes), limiting stored body | feed_key=${feedKey} subject="${subject}"`,
			);
			if (textContent) htmlContent = '';
		}

		// html_content is NOT NULL in schema — always store something
		// Plain text is stored in both fields for existing reader compatibility,
		// so give each copy half the total row-content budget.
		if (!htmlContent) textContent = truncateUtf8(textContent, MAX_CONTENT_SIZE / 2);
		const storedHtml = truncateUtf8(htmlContent || textContent || '(empty)', MAX_CONTENT_SIZE);
		textContent = truncateUtf8(textContent, MAX_CONTENT_SIZE - new Blob([storedHtml]).size);
		const contentSize = new Blob([storedHtml, textContent]).size;
		const originalUrl = extractOriginalUrlFromEmail({
			subject,
			htmlContent: originalHtmlContent || storedHtml,
			textContent: originalTextContent,
		});
		const siteUrl = deriveSiteUrlFromOriginalUrl(originalUrl);

		// 6. D1 batch: upsert feed + insert item
		const id = crypto.randomUUID();
		const now = new Date().toISOString();
		const iconUrl = getFaviconForEmail(fromAddress);

		await env.DB.batch([
				env.DB.prepare(
					`INSERT INTO feeds (feed_key, display_name, from_email, icon_url, site_url, first_seen_at, last_item_at, item_count)
					 VALUES (?, ?, ?, ?, ?, ?, ?, 0)
					 ON CONFLICT(feed_key) DO UPDATE SET
				   display_name = CASE
				     WHEN excluded.display_name NOT LIKE '%@%' AND feeds.display_name LIKE '%@%'
				       THEN excluded.display_name
				     ELSE feeds.display_name
				   END,
				   icon_url = COALESCE(feeds.icon_url, excluded.icon_url),
				   site_url = COALESCE(feeds.site_url, excluded.site_url)`,
				).bind(feedKey, displayName, fromAddress, iconUrl, siteUrl, now, receivedAt),

			env.DB.prepare(
				`INSERT INTO items (
					id, feed_key, from_name, from_email, subject,
					html_content, text_content, original_url, message_id, received_at, content_size
				 )
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(message_id) DO UPDATE SET
				   original_url = COALESCE(items.original_url, excluded.original_url)`,
			).bind(
				id,
				feedKey,
				fromName || null,
				fromAddress,
				subject,
				storedHtml,
				textContent || null,
				originalUrl,
				messageId,
				receivedAt,
				contentSize,
			),
			env.DB.prepare(
				`UPDATE feeds
				 SET item_count = (SELECT COUNT(*) FROM items WHERE feed_key = ?),
				     last_item_at = (SELECT MAX(received_at) FROM items WHERE feed_key = ?)
				 WHERE feed_key = ?`,
			).bind(feedKey, feedKey, feedKey),
		]);

		console.log(
			`Email stored | feed_key=${feedKey} subject="${subject}" size=${size} content_size=${contentSize} message_id=${messageId}`,
		);
	} catch (error) {
		console.error('Email processing failed', {
			from: message.from,
			to: message.to,
			error: error instanceof Error ? error.message : String(error),
		});
		// Don't rethrow — prevents Cloudflare retry loops
	}
}
