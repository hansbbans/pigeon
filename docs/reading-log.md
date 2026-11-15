# Reading log

Started November 2026. The recommendation ranker is being redesigned, and there
was too little reading data to judge a new one against. The reading log records
what the reader was shown and what he did with it, so the next ranker can be
compared with real behaviour. Plan: collect for about a month, then revisit
(`npm run reading-log:report` says whether there is enough).

## What is recorded

| Signal | Where | Clients |
|---|---|---|
| Impression: a card was at least half visible in a list for one continuous second, or was picked sooner. Once per card per list session. Carries the list (`view`), the 0-based `position` as displayed, a `session_id`, and for For You the ranker's `score`. | `reading_log` | web, iOS |
| Open: the reader chose an article. | `engagement_events` `explicit_open` | web, iOS |
| Reading time, exact to a tenth of a second, sent in 15 second chunks plus the remainder when reading stops. | `engagement_events` `active_reading` | web, iOS |
| Scroll depth, once per quarter of the article. | `engagement_events` `scroll_depth` | web, iOS |
| Link out of an article, host only. | `engagement_events` `outbound_link` | web, iOS |
| Star, read, unread, mark all read, more like this, not interested. | `engagement_events` | all clients |

`view` is one of `for-you`, `unread`, `today`, `starred`, `saved`, `all`,
`recent`, `feed`, `folder`, `search`. For `feed`, `folder` and a search inside
one, `metadata_json.stream` names the feed or folder.

A list session is one showing of one list: changing view, search, filter or
sort starts a new one, and so does coming back to the page after half an
hour away. A card seen in two sessions is two impressions.

## Rules that keep the data honest

- Only an article the reader chose counts as opened. The web app selects the
  first article of a list by itself; that logs nothing. Stepping through
  articles with the keyboard counts as an open after three seconds on one.
- Reading time counts only while the article is on screen and the page or app
  is in the foreground. On the web it also stops after two minutes without a
  scroll, key press or click, so a tab left open does not look like a long
  read. A video is the exception: it is watched without input, so it counts
  for as long as its player is on screen.
- The article the reader opened stays "the opened article" while another one
  is showing, so switching lists and coming back keeps counting.
- A hidden page or backgrounded app logs no impressions.
- Logging never reaches the UI: sends are fire-and-forget and a failure is
  dropped. Nothing is queued offline.
- No IP address, user agent or device identifier is stored. `reading_log`
  keeps the two Pigeon apps apart as `pigeon_web` and `pigeon_ios`;
  `engagement_events` can only say `pigeon` for both.

The web app sent no open, reading-time, scroll or link events before this. The
live ranker reads `engagement_events`, so reading on the web now counts toward
recommendations the same way reading on iOS does.

## API

`POST /api/v1/reading-log` with `{ "events": [...] }`, 1 to 200 events, same
authentication as the rest of `/api/v1`. Each event: `itemId` and `type`
(`impression`) are required; `view` is required for impressions; `id`,
`position`, `value`, `sessionId`, `occurredAt` and a small `metadata` object
are optional. Idempotent per `id`. Events for items that no longer exist are
skipped and counted in `skipped`. Validation lives in `src/reading-log.ts`;
`event_type` has no CHECK constraint, so a new kind of event needs no schema
change.

## Reading the data

`npm run reading-log:report` (add `-- --days 7`) prints whether each app is
still logging, weekly totals, shown versus opened per list, and whether higher
For You positions are opened more. It only reads.

An open is credited to the impression it came from: the latest impression of
that article from an hour before the open to ten seconds after it. So an
article opened from Unread and later shown in For You counts for Unread only.
Opens with no impression on record (Reeder, or a build without logging) are
counted separately.

`reading_log` has no foreign keys, so the history survives a deleted article.
Nothing prunes it yet: at a few hundred impressions a day it grows by roughly
2 MB a month against the 500 MB D1 cap. Add pruning before leaving it on for
more than a year.
