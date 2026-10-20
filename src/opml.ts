import { stripInvalidXmlCharacters } from './xml';

interface FeedInfo {
	feed_key: string;
	display_name: string;
	custom_title: string | null;
	/** Legacy primary folder; exported even when it has no feed_tags row. */
	category: string | null;
	/** Every feed_tags label for the feed. */
	folders?: string[];
	site_url?: string | null;
}

function escapeXml(str: string): string {
	return stripInvalidXmlCharacters(str)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

function feedTitle(f: FeedInfo): string {
	return f.custom_title || f.display_name;
}

function compareTitles(a: string, b: string): number {
	return a.localeCompare(b, undefined, { sensitivity: 'accent' }) || a.localeCompare(b);
}

function feedOutline(f: FeedInfo, baseUrl: string, indent: string): string {
	const title = escapeXml(feedTitle(f));
	const url = escapeXml(`${baseUrl}/feed/${f.feed_key}`);
	// htmlUrl is the website; never substitute the XML source URL.
	const htmlUrlAttribute = f.site_url ? ` htmlUrl="${escapeXml(f.site_url)}"` : '';
	return `${indent}<outline type="rss" text="${title}" title="${title}" xmlUrl="${url}"${htmlUrlAttribute}/>`;
}

export function generateOpml(feeds: FeedInfo[], baseUrl: string): string {
	const sortedFeeds = [...feeds].sort((a, b) => compareTitles(feedTitle(a), feedTitle(b)));
	// A feed appears once under each of its folders.
	const grouped = new Map<string, FeedInfo[]>();
	const uncategorized: FeedInfo[] = [];

	for (const f of sortedFeeds) {
		const folders = new Set([...(f.folders ?? []), f.category].filter((folder): folder is string => Boolean(folder)));
		if (folders.size === 0) {
			uncategorized.push(f);
		}
		for (const folder of folders) {
			const list = grouped.get(folder);
			if (list) {
				list.push(f);
			} else {
				grouped.set(folder, [f]);
			}
		}
	}

	const lines: string[] = [];

	// Uncategorized feeds at root level
	for (const f of uncategorized) {
		lines.push(feedOutline(f, baseUrl, '    '));
	}

	// Categorized feeds in folder outlines
	for (const [category, categoryFeeds] of [...grouped].sort(([a], [b]) => compareTitles(a, b))) {
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
