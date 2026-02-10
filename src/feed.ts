interface FeedMeta {
	feed_key: string;
	display_name: string;
	from_email: string | null;
	custom_title: string | null;
}

interface FeedItem {
	id: string;
	subject: string;
	html_content: string;
	from_name: string | null;
	from_email: string | null;
	received_at: string;
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

export function generateAtomFeed(
	feed: FeedMeta,
	items: FeedItem[],
	baseUrl: string,
): string {
	const feedUrl = `${baseUrl}/feed/${feed.feed_key}`;
	const title = feed.custom_title || feed.display_name;

	const entries = items
		.map(
			(item) => `  <entry>
    <title>${escapeXml(item.subject)}</title>
    <id>urn:uuid:${item.id}</id>
    <updated>${item.received_at}</updated>
    <published>${item.received_at}</published>
    <author>
      <name>${escapeXml(item.from_name || feed.display_name)}</name>
    </author>
    <content type="html">${wrapCDATA(item.html_content)}</content>
  </entry>`,
		)
		.join('\n');

	return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${escapeXml(title)}</title>
  <link href="${escapeXml(feedUrl)}" rel="self" type="application/atom+xml"/>
  <link href="${escapeXml(baseUrl)}" rel="alternate" type="text/html"/>
  <id>${escapeXml(feedUrl)}</id>
  <updated>${items[0]?.received_at || new Date().toISOString()}</updated>
  <generator>Pigeon Newsletter-to-RSS</generator>
  <author>
    <name>${escapeXml(feed.display_name)}</name>
    ${feed.from_email ? `<email>${escapeXml(feed.from_email)}</email>` : ''}
  </author>
${entries}
</feed>`;
}
