import PostalMime from 'postal-mime';
import type { Env } from './types';
import { resolveFeedKey, resolveFeedDisplayName } from './normalize';
import { applyRoutingRules } from './routing-rules';
import { getFaviconForEmail } from './favicon';

const MAX_CONTENT_SIZE = 900_000; // 900KB — stay under D1's 1MB row limit

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
		let htmlContent = parsed.html || '';
		const textContent = parsed.text || '';
		const contentSize = new Blob([htmlContent || textContent]).size;

		if (contentSize > MAX_CONTENT_SIZE) {
			console.warn(
				`Content too large (${contentSize} bytes), falling back to text | feed_key=${feedKey} subject="${subject}"`,
			);
			htmlContent = '';
		}

		// html_content is NOT NULL in schema — always store something
		const storedHtml = htmlContent || textContent || '(empty)';

		// 6. D1 batch: upsert feed + insert item
		const id = crypto.randomUUID();
		const now = new Date().toISOString();
	const iconUrl = getFaviconForEmail(fromAddress);

		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO feeds (feed_key, display_name, from_email, icon_url, first_seen_at, last_item_at, item_count)
				 VALUES (?, ?, ?, ?, ?, ?, 1)
				 ON CONFLICT(feed_key) DO UPDATE SET
				   last_item_at = excluded.last_item_at,
				   item_count = item_count + 1,
				   display_name = CASE
				     WHEN excluded.display_name NOT LIKE '%@%' AND feeds.display_name LIKE '%@%'
				       THEN excluded.display_name
				     ELSE feeds.display_name
			   END,
			   icon_url = COALESCE(feeds.icon_url, excluded.icon_url)`,
			).bind(feedKey, displayName, fromAddress, iconUrl, now, receivedAt),

			env.DB.prepare(
				`INSERT OR IGNORE INTO items (id, feed_key, from_name, from_email, subject, html_content, text_content, message_id, received_at, content_size)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).bind(
				id,
				feedKey,
				fromName || null,
				fromAddress,
				subject,
				storedHtml,
				textContent || null,
				messageId,
				receivedAt,
				contentSize,
			),
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
