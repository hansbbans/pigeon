interface FeedInfo {
	feed_key: string;
	display_name: string;
	custom_title: string | null;
	category: string | null;
}

function escapeXml(str: string): string {
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

function feedOutline(f: FeedInfo, baseUrl: string, indent: string): string {
	const title = escapeXml(f.custom_title || f.display_name);
	const url = escapeXml(`${baseUrl}/feed/${f.feed_key}`);
	return `${indent}<outline type="rss" text="${title}" title="${title}" xmlUrl="${url}"/>`;
}

export function generateOpml(feeds: FeedInfo[], baseUrl: string): string {
	// Group by category
	const grouped = new Map<string, FeedInfo[]>();
	const uncategorized: FeedInfo[] = [];

	for (const f of feeds) {
		if (f.category) {
			const list = grouped.get(f.category);
			if (list) {
				list.push(f);
			} else {
				grouped.set(f.category, [f]);
			}
		} else {
			uncategorized.push(f);
		}
	}

	const lines: string[] = [];

	// Uncategorized feeds at root level
	for (const f of uncategorized) {
		lines.push(feedOutline(f, baseUrl, '    '));
	}

	// Categorized feeds in folder outlines
	for (const [category, categoryFeeds] of grouped) {
		const catTitle = escapeXml(category);
		lines.push(`    <outline text="${catTitle}" title="${catTitle}">`);
		for (const f of categoryFeeds) {
			lines.push(feedOutline(f, baseUrl, '      '));
		}
		lines.push('    </outline>');
	}

	return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>Pigeon Newsletter Feeds</title>
    <dateCreated>${new Date().toISOString()}</dateCreated>
  </head>
  <body>
${lines.join('\n')}
  </body>
</opml>`;
}
