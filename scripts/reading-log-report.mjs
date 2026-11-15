#!/usr/bin/env node
// Summarises the reading log: is logging alive, and what was shown versus read.
//
//   npm run reading-log:report                      # production D1, last 30 days
//   npm run reading-log:report -- --days 7
//   npm run reading-log:report -- --local [--persist-to <dir>]
//
// Read-only. See docs/reading-log.md for what each number means.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/**
 * The report's queries, for everything logged after `since` (an ISO 8601 UTC
 * timestamp; stored timestamps have the same shape, so they compare as text).
 *
 * An open is credited to the impression it came from: the latest impression
 * of that article from an hour before the open to ten seconds after it (a card
 * can be picked before its one second on screen is up). An open with no such
 * impression (another client, or from before logging began) is credited to no
 * list. An article counts as read once its reading time adds up to 15 seconds.
 */
export function reportQueries(since) {
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(since)) throw new Error('since must be an ISO 8601 UTC timestamp');
	const attributed = `WITH opens AS (
	     SELECT o.item_id, (
	       SELECT r.id FROM reading_log r
	       WHERE r.event_type = 'impression' AND r.item_id = o.item_id
	         AND r.occurred_at >= strftime('%Y-%m-%dT%H:%M:%fZ', o.occurred_at, '-60 minutes')
	         AND r.occurred_at <= strftime('%Y-%m-%dT%H:%M:%fZ', o.occurred_at, '+10 seconds')
	       ORDER BY r.occurred_at DESC LIMIT 1
	     ) AS impression_id
	     FROM engagement_events o WHERE o.event_type = 'explicit_open' AND o.occurred_at > '${since}'
	   ), reads AS (
	     SELECT item_id FROM engagement_events
	     WHERE event_type = 'active_reading' AND occurred_at > '${since}'
	     GROUP BY item_id HAVING SUM(duration_seconds) >= 15
	   ), shown AS (
	     SELECT id, item_id, view, position FROM reading_log WHERE event_type = 'impression' AND occurred_at > '${since}'
	   )`;
	return {
		impressionsByClient: `SELECT client_family AS client, COUNT(*) AS impressions, MAX(occurred_at) AS latest
		   FROM reading_log WHERE event_type = 'impression' AND occurred_at > '${since}'
		   GROUP BY client_family ORDER BY client_family`,
		engagementByKind: `SELECT client_family AS client, event_type AS kind, COUNT(*) AS events, MAX(occurred_at) AS latest
		   FROM engagement_events
		   WHERE occurred_at > '${since}'
		     AND event_type IN ('explicit_open', 'active_reading', 'scroll_depth', 'outbound_link', 'star', 'more_like_this', 'not_interested')
		   GROUP BY client_family, event_type ORDER BY client_family, events DESC`,
		byWeek: `SELECT week,
		        SUM(kind = 'impression') AS impressions,
		        COUNT(DISTINCT CASE WHEN kind = 'impression' THEN item_id END) AS items_shown,
		        COUNT(DISTINCT CASE WHEN kind = 'explicit_open' THEN item_id END) AS items_opened,
		        ROUND(SUM(CASE WHEN kind = 'active_reading' THEN seconds ELSE 0 END) / 60.0, 1) AS minutes_read,
		        COUNT(DISTINCT substr(at, 1, 10)) AS active_days
		   FROM (
		     SELECT strftime('%Y-%W', occurred_at) AS week, 'impression' AS kind, item_id, 0 AS seconds, occurred_at AS at
		     FROM reading_log WHERE event_type = 'impression' AND occurred_at > '${since}'
		     UNION ALL
		     SELECT strftime('%Y-%W', occurred_at), event_type, item_id, COALESCE(duration_seconds, 0), occurred_at
		     FROM engagement_events WHERE event_type IN ('explicit_open', 'active_reading') AND occurred_at > '${since}'
		   ) GROUP BY week ORDER BY week`,
		byView: `${attributed}
		   SELECT shown.view,
		          COUNT(DISTINCT shown.item_id) AS items_shown,
		          COUNT(DISTINCT opens.item_id) AS opened_from_here,
		          COUNT(DISTINCT reads.item_id) AS of_those_read_15s,
		          ROUND(100.0 * COUNT(DISTINCT opens.item_id) / COUNT(DISTINCT shown.item_id), 1) AS open_pct
		   FROM shown
		   LEFT JOIN opens ON opens.impression_id = shown.id
		   LEFT JOIN reads ON reads.item_id = opens.item_id
		   GROUP BY shown.view ORDER BY items_shown DESC, shown.view`,
		forYouByPosition: `${attributed}
		   SELECT CASE WHEN shown.position < 5 THEN '1-5' WHEN shown.position < 10 THEN '6-10'
		               WHEN shown.position < 20 THEN '11-20' ELSE '21+' END AS position,
		          COUNT(DISTINCT shown.id) AS times_shown,
		          COUNT(DISTINCT CASE WHEN opens.item_id IS NOT NULL THEN shown.id END) AS opened_from_here,
		          COUNT(DISTINCT CASE WHEN reads.item_id IS NOT NULL THEN shown.id END) AS of_those_read_15s
		   FROM shown
		   LEFT JOIN opens ON opens.impression_id = shown.id
		   LEFT JOIN reads ON reads.item_id = opens.item_id
		   WHERE shown.view = 'for-you'
		   GROUP BY 1 ORDER BY MIN(shown.position)`,
		totals: `${attributed}
		   SELECT (SELECT COUNT(DISTINCT item_id) FROM shown) AS items_shown,
		          (SELECT COUNT(DISTINCT item_id) FROM opens) AS items_opened,
		          (SELECT COUNT(DISTINCT item_id) FROM opens WHERE impression_id IS NULL) AS opened_without_impression,
		          (SELECT COUNT(*) FROM reads) AS items_read_15s`,
	};
}

function main() {
	const { values: args } = parseArgs({
		options: {
			days: { type: 'string', default: '30' },
			local: { type: 'boolean', default: false },
			'persist-to': { type: 'string' },
		},
	});
	const days = Number(args.days);
	if (!Number.isInteger(days) || days < 1 || days > 3650) {
		console.error('--days must be a whole number of days');
		process.exit(2);
	}
	const queries = reportQueries(new Date(Date.now() - days * 86_400_000).toISOString());

	const query = (sql) => {
		const location = args.local ? ['--local', ...(args['persist-to'] ? ['--persist-to', args['persist-to']] : [])] : ['--remote'];
		const output = execFileSync(
			resolve('node_modules/.bin/wrangler'),
			['d1', 'execute', 'pigeon-db', ...location, '--config', 'wrangler.toml', '--json', '--command', sql],
			{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
		);
		return JSON.parse(output)[0].results;
	};
	const table = (title, rows) => {
		console.log(`\n${title}`);
		if (rows.length === 0) {
			console.log('  (nothing logged)');
			return;
		}
		const columns = Object.keys(rows[0]);
		const text = (value) => (value === null || value === undefined ? '' : String(value));
		const widths = columns.map((column) => Math.max(column.length, ...rows.map((row) => text(row[column]).length)));
		const line = (cells) => '  ' + cells.map((cell, index) => text(cell).padEnd(widths[index])).join('  ');
		console.log(line(columns));
		for (const row of rows) console.log(line(columns.map((column) => row[column])));
	};

	console.log(`Reading log, last ${days} days (${args.local ? 'local' : 'production'} database)`);
	table('Is each app logging? Impressions (pigeon_web is the browser, pigeon_ios the iPhone and iPad app)', query(queries.impressionsByClient));
	table('Reading events (the two Pigeon apps are not told apart here)', query(queries.engagementByKind));
	table('By week', query(queries.byWeek));
	table('Shown versus opened, by the list the open came from', query(queries.byView));
	table('For You: are higher positions opened more?', query(queries.forYouByPosition));
	const [totals] = query(queries.totals);
	console.log(`\nTotals: ${totals.items_shown} articles shown, ${totals.items_opened} opened, ${totals.items_read_15s} read for 15 seconds or more.`);
	if (totals.opened_without_impression > 0) {
		console.log(`${totals.opened_without_impression} opened articles had no impression on record (another client, or a build without logging).`);
	}
	console.log('A ranking comparison needs a few hundred articles shown and at least 50 read; below that, keep logging.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
