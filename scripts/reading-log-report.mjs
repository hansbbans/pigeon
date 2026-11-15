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
import { parseArgs } from 'node:util';

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
const since = `datetime('now', '-${days} days')`;

function query(sql) {
	const location = args.local ? ['--local', ...(args['persist-to'] ? ['--persist-to', args['persist-to']] : [])] : ['--remote'];
	const output = execFileSync(
		resolve('node_modules/.bin/wrangler'),
		['d1', 'execute', 'pigeon-db', ...location, '--config', 'wrangler.toml', '--json', '--command', sql],
		{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
	);
	return JSON.parse(output)[0].results;
}

function table(title, rows) {
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
}

// An item counts as read once its reported reading time adds up to 15 seconds.
const READS = `SELECT item_id, SUM(duration_seconds) AS seconds FROM engagement_events
	WHERE event_type = 'active_reading' AND occurred_at > ${since} GROUP BY item_id HAVING SUM(duration_seconds) >= 15`;
const OPENS = `SELECT DISTINCT item_id FROM engagement_events WHERE event_type = 'explicit_open' AND occurred_at > ${since}`;
const SHOWN = `SELECT item_id, view, MIN(position) AS position, MIN(occurred_at) AS first_shown FROM reading_log
	WHERE event_type = 'impression' AND occurred_at > ${since} GROUP BY item_id, view`;

console.log(`Reading log, last ${days} days (${args.local ? 'local' : 'production'} database)`);

table('Is logging alive? Events by client', query(
	`SELECT client_family AS client, kind, COUNT(*) AS events, MAX(occurred_at) AS latest FROM (
	   SELECT client_family, 'impression' AS kind, occurred_at FROM reading_log WHERE event_type = 'impression' AND occurred_at > ${since}
	   UNION ALL
	   SELECT client_family, event_type, occurred_at FROM engagement_events
	   WHERE occurred_at > ${since} AND event_type IN ('explicit_open', 'active_reading', 'scroll_depth', 'outbound_link', 'star', 'more_like_this', 'not_interested')
	 ) GROUP BY client_family, kind ORDER BY client_family, events DESC`,
));

table('By week', query(
	`SELECT week,
	        SUM(kind = 'impression') AS impressions,
	        COUNT(DISTINCT CASE WHEN kind = 'impression' THEN item_id END) AS items_shown,
	        COUNT(DISTINCT CASE WHEN kind = 'explicit_open' THEN item_id END) AS items_opened,
	        ROUND(SUM(CASE WHEN kind = 'active_reading' THEN seconds ELSE 0 END) / 60.0, 1) AS minutes_read,
	        COUNT(DISTINCT substr(at, 1, 10)) AS active_days
	 FROM (
	   SELECT strftime('%Y-%W', occurred_at) AS week, 'impression' AS kind, item_id, 0 AS seconds, occurred_at AS at
	   FROM reading_log WHERE event_type = 'impression' AND occurred_at > ${since}
	   UNION ALL
	   SELECT strftime('%Y-%W', occurred_at), event_type, item_id, COALESCE(duration_seconds, 0), occurred_at
	   FROM engagement_events WHERE event_type IN ('explicit_open', 'active_reading') AND occurred_at > ${since}
	 ) GROUP BY week ORDER BY week`,
));

table('Shown versus read, by list', query(
	`SELECT shown.view,
	        COUNT(*) AS items_shown,
	        COUNT(opens.item_id) AS opened,
	        COUNT(reads.item_id) AS read_15s,
	        ROUND(100.0 * COUNT(opens.item_id) / COUNT(*), 1) AS open_pct
	 FROM (${SHOWN}) shown
	 LEFT JOIN (${OPENS}) opens ON opens.item_id = shown.item_id
	 LEFT JOIN (${READS}) reads ON reads.item_id = shown.item_id
	 GROUP BY shown.view ORDER BY items_shown DESC`,
));

table('For You: does a higher position get read more?', query(
	`SELECT CASE WHEN shown.position < 5 THEN '1-5' WHEN shown.position < 10 THEN '6-10'
	             WHEN shown.position < 20 THEN '11-20' ELSE '21+' END AS position,
	        COUNT(*) AS items_shown,
	        COUNT(opens.item_id) AS opened,
	        COUNT(reads.item_id) AS read_15s
	 FROM (${SHOWN}) shown
	 LEFT JOIN (${OPENS}) opens ON opens.item_id = shown.item_id
	 LEFT JOIN (${READS}) reads ON reads.item_id = shown.item_id
	 WHERE shown.view = 'for-you'
	 GROUP BY 1 ORDER BY MIN(shown.position)`,
));

const [totals] = query(
	`SELECT (SELECT COUNT(*) FROM (${SHOWN})) AS shown_items,
	        (SELECT COUNT(*) FROM (${OPENS})) AS opened_items,
	        (SELECT COUNT(*) FROM (${READS})) AS read_items`,
);
console.log(`\nTotals: ${totals.shown_items} items shown, ${totals.opened_items} opened, ${totals.read_items} read for 15 seconds or more.`);
console.log('A ranking comparison needs a few hundred shown items and at least 50 reads; below that, keep logging.');
