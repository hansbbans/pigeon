/** Older RSS imports stored their byline in from_email. Email senders are not bylines. */
export const ARTICLE_AUTHOR_SQL = `COALESCE(NULLIF(i.from_name, ''), CASE WHEN f.source_type = 'rss' THEN i.from_email END)`;

export function articleAuthor(item: { from_name: string | null; from_email: string | null }, sourceType?: string): string | null {
	return item.from_name || (sourceType === 'rss' ? item.from_email : null);
}
