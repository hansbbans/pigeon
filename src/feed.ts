import { createPreviewText } from './preview-text';
import { createRenderedContent } from './rendered-content';
import { createCanonicalItemUuid, hasStoredItemId } from './item-identity';
import type { FeedVariant } from './feed-urls';

interface FeedMeta {
	feed_key: string;
	display_name: string;
	from_email: string | null;
	custom_title: string | null;
}

interface FeedItem {
	id: string | null;
	message_id?: string | null;
	subject: string;
	html_content: string;
	text_content?: string | null;
	from_name: string | null;
	from_email: string | null;
	received_at: string;
}

interface PreparedFeedItem extends FeedItem {
	canonicalId: string;
	hasStoredId: boolean;
}

function escapeXml(str: string): string {
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

function wrapCDATA(html: string): string {
	const safe = html.replace(/]]>/g, ']]]]><![CDATA[>');
	return `<![CDATA[${safe}]]>`;
}

export async function generateAtomFeed(
	feed: FeedMeta,
	items: FeedItem[],
	baseUrl: string,
	options?: {
		variant?: FeedVariant;
		feedUrl?: string;
		hubUrl?: string | null;
	},
): Promise<string> {
	const variant = options?.variant || 'full';
	const feedUrl = options?.feedUrl || `${baseUrl}/feed/${feed.feed_key}`;
	const titleBase = feed.custom_title || feed.display_name;
	const title = variant === 'light' ? `${titleBase} (Light)` : titleBase;
	const preparedItems = await prepareFeedItems(feed.feed_key, items);

	const entries = preparedItems
		.map((item) => {
			const summary = createPreviewText({
				textContent: item.text_content,
				htmlContent: item.html_content,
			});
			const renderedContent = createRenderedContent({
				htmlContent: item.html_content,
				textContent: item.text_content,
			});

			return `  <entry>
    <title>${escapeXml(item.subject)}</title>
    <id>urn:uuid:${item.canonicalId}</id>
    <updated>${item.received_at}</updated>
    <published>${item.received_at}</published>
    <author>
      <name>${escapeXml(item.from_name || feed.display_name)}</name>
    </author>
    ${summary ? `<summary type="text">${escapeXml(summary)}</summary>` : ''}
    <content type="html">${wrapCDATA(renderedContent)}</content>
  </entry>`;
		})
		.join('\n');

	return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${escapeXml(title)}</title>
  <link href="${escapeXml(feedUrl)}" rel="self" type="application/atom+xml"/>
  ${options?.hubUrl ? `<link href="${escapeXml(options.hubUrl)}" rel="hub"/>` : ''}
  <link href="${escapeXml(baseUrl)}" rel="alternate" type="text/html"/>
  <id>${escapeXml(feedUrl)}</id>
  <updated>${preparedItems[0]?.received_at || new Date().toISOString()}</updated>
  <generator>Pigeon Newsletter-to-RSS</generator>
  <author>
    <name>${escapeXml(feed.display_name)}</name>
    ${feed.from_email ? `<email>${escapeXml(feed.from_email)}</email>` : ''}
  </author>
${entries}
</feed>`;
}

async function prepareFeedItems(feedKey: string, items: FeedItem[]): Promise<PreparedFeedItem[]> {
	const resolved = await Promise.all(
		items.map(async (item) => ({
			...item,
			canonicalId: await createCanonicalItemUuid({
				feedKey,
				id: item.id,
				messageId: item.message_id,
				subject: item.subject,
				htmlContent: item.html_content,
				textContent: item.text_content,
				fromName: item.from_name,
				fromEmail: item.from_email,
				receivedAt: item.received_at,
			}),
			hasStoredId: hasStoredItemId(item.id),
		})),
	);

	const deduped = new Map<
		string,
		{
			firstIndex: number;
			item: PreparedFeedItem;
		}
	>();

	for (const [index, item] of resolved.entries()) {
		const existing = deduped.get(item.canonicalId);
		if (!existing) {
			deduped.set(item.canonicalId, { firstIndex: index, item });
			continue;
		}

		if (item.hasStoredId && !existing.item.hasStoredId) {
			existing.item = item;
		}
	}

	return [...deduped.values()]
		.sort((left, right) => left.firstIndex - right.firstIndex)
		.map(({ item }) => item);
}
