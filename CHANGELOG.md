# Changelog

All notable changes to Pigeon are documented in this file.

## Unreleased

### Added

- iOS: a look switch in the top bar of Home, All Feeds, the library and every list: one tap between Cards and Reeder (a list icon in Cards, a grid icon in Reeder).

## [0.1.16.0] - 2026-11-23

### Added

- Two looks, Cards and Reeder, with the same structure on iOS and the web. A folder reads as its sources: Today (five stories, then "N more"), Last 7 Days, then one section per feed ordered by its newest story, and an "Older" group. A story from today also sits in its feed's section.
- Last 7 Days, a new view beside Today on iOS and the web: every feed's stories from the last seven local days, newest first, with its own unread count. On iOS it has a Home tile, a Settings → Views toggle and ⌘6.
- iOS: the Cards look (Settings → Look, or the list's Display menu) replaces the Front Page and Classic layouts: Front Page becomes Cards and Classic becomes Reeder. In Cards a folder is a column of cards in the folder's colour, a feed is day cards, All Feeds is tiles, and the smart views are the Front Page; iPhone and iPad navigate Home → folder → story with swipe-back.
- Web: a Cards look, switched from the stream header or Settings → Look. It opens on a Home page of tiles; folders show their sections as cards, a feed shows Today, Yesterday and Earlier cards, and each story is a coloured feed name, a serif headline and one meta line. A story opens over the cards, and Back or Escape returns to them. Reeder stays the default.
- Web: in the Cards look, All items, Unread, Today, Last 7 Days, Recently read, Starred and For You are a Front Page: the view's name as a masthead, a lead story with its picture and a few lines of the story, then the rest three across on a wide window. Pictures follow the image setting, and logos and banners are left out.

### Changed

- Web: a folder is one list in sections (Today, Last 7 Days, one per feed, Older) instead of one stream, and has no Sort menu; the Show filter stays.
- iOS: the Reeder look no longer looks like stock iOS. The library is a quiet grey column with small labels, grey counts and no chevrons, and it is where Reeder opens: there are no Home tiles in Reeder (they stay in Cards), and an iPad opens with a list beside the library. A folder is one list in sections, Today, Last 7 Days and then one per feed, as on the web; a feed is Today, Yesterday and Earlier. Story titles are sans serif with one grey line under them, and a story already read when its list opens takes a single line.
- A feed's own `Cache-Control: max-age` now holds its next poll back by five hours at most, instead of a day, so a feed that overstates its freshness still shows new stories the same day.
- iOS: after a cold launch the list you were on shows its saved stories straight away, while the rest of the offline library loads behind it. Marking a story read or starring it in that moment no longer leaves the library half loaded until the next refresh.
- iOS: feed icons in the sidebar, on Home and above By Feed sections are decoded once at icon size and reused, and story pictures and icons are kept on disk between launches (up to 150 MB).
- iOS: the reader prepares the web view for the next story ahead of time, so opening a story does less work at the moment of the tap. Each story still reads in its own private web view.
- iOS: syncing a page of new stories reads the list of unsent changes once, not once per story.
- iOS: marking a story read or starring it changes the screen at once, also while a sync is writing to the offline library. If the change cannot be saved, the story goes back to how it was.

### Fixed

- A routine feed poll no longer records a feed change for every client to sync. The Worker rewrote the feed's site and source URL on each successful poll, which logged a change even when nothing differed; it now writes them only when they change.
- Web: opening the reader no longer waits for the status page's counts. The sign-in check ran the full status query, which reads every article, before the first list could load; it now only checks the token.
- iOS: in a story list's More menu, Sort, Display and Read actions stay open when you expand them. A background sync or refresh rebuilt the menu and collapsed the submenu before you could pick anything. Refresh in that menu is no longer greyed out during a sync; tapping it joins the sync already running.

## [0.1.15.0] - 2026-11-21

### Added

- Allo, Josh Puckett's open-source sans (SIL OFL 1.1), is a new reading typeface on the web and iOS: Settings → Reading → Typeface on the web, Settings → Typeface or the reader's Reading controls on iOS. Titles are SemiBold on iOS, with real bold and oblique faces in articles. Geist Serif stays the default.

### Changed

- iOS: on iPad, the Front Page layout fills the window instead of sitting in the middle of three columns. From an iPad Pro 11-inch upwards it is a magazine spread, with the lead picture beside its headline and three stories across underneath, and a story opens across the whole screen with a back button to the page, as on iPhone. The Classic layout keeps the sidebar, list and article side by side.
- Feeds refresh on a five-minute schedule instead of hourly, and each feed is polled by how recently it published (every 30 minutes to every four hours), so active feeds show new stories sooner. Web push considers a browser at most every 15 minutes.

### Fixed

- iOS: rebuilding the offline library no longer replays the server's whole change history. The app lists unread, starred, saved and recently read articles in a few requests, newest unread first, and resumes where it stopped if it is interrupted. Article text downloads in the background afterwards, and an article opened before its text arrives fetches it first. Pull-to-refresh, in a list, the sidebar or Home, no longer waits for a rebuild, which could leave it spinning without end. The Worker adds `GET /api/v1/library` and `POST /api/v1/library/articles` for this; older app builds are unaffected.
- iOS: the article sanitizer no longer passes through a tag or comment that is cut off at the end of a story, or everything after a stray `<` followed by an unmatched quote. A cut-off tag is dropped and a stray `<` is shown as text.

## [0.1.14.0] - 2026-11-17

### Changed

- The web reader now lives at the site root, `https://pigeon.hanscho.com`, instead of `/app`. Old `/app` links and bookmarks still work; in a browser tab the address changes to the root. Home Screen installs keep working, offline reload works at the new address, and existing push notification subscriptions are untouched.
- The web reader uses Geist Serif, Vercel's open-source serif, as its reading typeface: article titles, article text, saved-story titles and transcripts. Choose System, Serif or Sans serif instead under Settings → Reading → Typeface. If you never picked a typeface, you get Geist Serif.
- The iOS app uses Geist Serif, Vercel's open-source serif, as its reading typeface: story titles, the Front Page, article titles and text, and transcripts. Choose Bookerly again under Settings → Typeface or in the reader's Reading controls. Geist Serif has a single weight, so titles are set in Regular; bold text inside articles is still bold. On iOS this also fixes article text, which had never actually loaded Bookerly and showed Iowan Old Style.

## [0.1.13.0] - 2026-11-17

### Added

- Folders open grouped by feed, in the iOS app and the web reader. Feeds are listed alphabetically, each under a small label with its name, newest story first within each feed. "Newest" and "Oldest" are still in the sort menu for the mixed-by-date view, and changing the sort in a folder does not change other views. On iOS the Front Page layout keeps its normal pages in feed order (each story already names its feed); the labels appear in the Classic list.

### Changed

- In the web reader, read articles are compact: source and time over a one-line grey title, with no summary or picture, so unread articles stand out by shape and not only by a lighter grey. A list never shrinks a row it has already shown you in full, so nothing moves while you read; those rows only turn grey. Read rows are compact again in a list you have not opened yet or after a reload.

## [0.1.12.0] - 2026-11-15

### Added

- Pigeon keeps a private reading log, in the web reader and the iOS app. It records which articles each list showed you, which ones you opened, how long you read them, how far you scrolled and which links you followed out. It is stored only in your own Pigeon database and nothing in the app looks different. Its purpose is to measure whether For You puts the articles you actually read near the top, before the ranking is changed. `npm run reading-log:report` summarises it; `docs/reading-log.md` describes what is recorded.

### Fixed

- Sharing a link to Pigeon from Safari, Messages and other apps now saves it to Read It Later. The share extension used to keep only `URL` objects, so a string or attributed-text share (what those apps actually send) was dropped; a failed save no longer claims “Saved, will sync”.

## [0.1.11.0] - 2026-11-11

### Changed

- The iPhone home screen is a grid of tiles instead of a list with unread counts. Each view (For You, Today, Read It Later) is a tile, and each folder is a tile in its own colour showing its newest headline and the icons of its feeds. The large "Pigeon" title is gone; the date and how many stories arrived today sit in the toolbar. Unread no longer appears on the home screen. "All Feeds" opens the full list of folders and feeds with their counts, and a list still shows its count in its title. iPad keeps the list.

## [0.1.10.0] - 2026-11-10

### Changed

- iPhone and iPad follow the new Pigeon design system. Buttons, links and selections use one blue tint (darker in light mode, brighter in dark mode). Secondary text, the Starred and Paywall labels and error messages use solid colours that stay readable (4.5:1 or better) instead of faint system grey, orange and red. Story titles in the list are set in Bookerly like the reader. Front Page pictures have rounder corners and slightly wider margins. In the Sepia theme the reader's bottom controls and back bar match the page, and dividers and table borders are warm instead of grey. Swipe actions use the tint, amber and teal.
- The default reading column is narrower (640 points instead of 720, about 66 characters per line) on iOS and in the web reader. A width you already chose is kept.
- The web reader uses the same blue as the app, and its Sepia article theme now matches the iOS one.

### Fixed

- Feeds that declare a character set other than UTF-8 no longer turn accented letters into garbage; text that is valid UTF-8 wins over a wrong declaration.
- A feed that temporarily redirected no longer has its address replaced by the redirect target, and a feed that lists the same entry twice no longer rewrites it back and forth.
- Character references such as `&#8217;` and `&#038;` in feed and article titles and bylines show as the character, and feed discovery no longer cuts links like `/?feed=rss2&#038;cat=3` short.
- Newsletters whose List-Id has no letters or digits no longer land in a feed with an empty name, encoded List-Id names are decoded, and a forwarded email whose subject was only "Fwd:" no longer breaks iOS sync.
- Mark all as read touches only unread stories, so it is faster on large feeds.
- In the web reader, turning on the offline library works (the app page was never saved for offline use), a server error while restoring your session no longer signs you out, and your reading position is restored even when the article text loads after the article opens.
- The browser extension backs off while Pigeon is unreachable, no longer sends a save twice, keeps retrying after a failed attempt, and shows sign-out and settings errors instead of hiding them.
- The web reader's page can be revalidated instead of downloaded in full on every load. Its ETag was a strong one, which Cloudflare removes from Worker responses, so the browser never had anything to revalidate with; it is now a weak ETag, and the service worker (offline saving, notifications) revalidates too instead of always fetching a fresh copy.
- In the web reader, Today in the sidebar now shows how many unread articles arrived today (your local day), like All and Unread. It used to show no number.
- Substack paid-only posts sent to a free subscriber with no preview at all (the email body is empty) now carry the Paywall label. Previously only teasers that stopped partway at Substack's paywall block were labeled.

## [0.1.9.0] - 2026-11-04

### Added

- YouTube transcripts on iPhone and iPad. Under the player of any YouTube video (saved or from a feed), Get Transcript fetches the captions and chapters from YouTube on the phone itself, shows them at once and stores them in Pigeon so other devices load them directly. The transcript follows the video: the playing line is highlighted and kept in view (it waits 4 seconds after you scroll it), tapping a line or chapter jumps the video there, and chapters appear as headings. If YouTube doesn't answer within 25 seconds or has no captions, a message and Try Again replace the spinner.
- Read It Later on iPhone and iPad. Long-press a link in an article and choose Read It Later (or tap it and pick Read It Later); a toast confirms and you stay in the article. The share sheet saves pages from Safari, Messages, YouTube and other apps straight to Read It Later, and offers Add as Feed first for feed and channel links. Saved pages are cleaned up in the background with Defuddle; opening one that isn't ready shows it preparing, and a page that can't be extracted after three tries offers Open Original and Try Again. Read It Later sits below Starred with an unread count, and filters Unread/Archive, Text/Video and length, sorted by saved time or length. Finishing a saved article archives it; videos play in the in-app player. Saves made offline are kept and sent when Pigeon reconnects. Saved items never appear in Today, Unread, folders or For You.
- Articles and videos longer than 10 minutes show their length ("12 min read", "1 hr 5 min video") on list rows, the Front Page and the article header, on iOS and web. Settings → Reading → Show reading time turns it off. Text length is estimated from the article; for a feed that sends only a teaser, opening it in reader mode records the full article's length. YouTube durations are fetched hourly. The Worker moves to schema v16.
- Newsletters that arrive as a paywalled teaser (Substack, beehiiv, and Ghost paid posts sent to a free subscriber) carry a Paywall label beside the title in the iOS list, Front Page, and article header, and in the web reader. Full copies sent to paying subscribers are not labeled.
- Read It Later in the web reader. Right-click a link inside an article and choose Read It Later (Shift+right-click keeps the browser's own menu); the article stays put and a toast confirms the save. The Read It Later section below Starred lists saved links with a thumbnail, title, source, length and when you saved them, with Unread/Archive, All/Text/Video and length filters and newest, oldest, shortest and longest sorts (remembered on this device). Opening a link saved without its text fetches and cleans the page, then stores it; if that fails, Open original and Try again are offered. Reaching the end of a saved article archives it. Archive, Remove, Open original and Copy link sit in the article toolbar, and YouTube links play in the built-in player. Saved items stay out of All, Today, folders, unread counts, notifications and feed settings.
- In the web reader, right-click a story in the list to mark everything above it (or below it) as read without opening it. It follows the list's current feed, search, filter and sort, includes stories not loaded yet, and offers Undo. With the keyboard, focus a story and press Shift+F10, then use the arrow keys and Enter.

### Changed

- iOS no longer saves to Readwise Reader: Share to Reader, the Readwise token setting and the stored token are gone, replaced by Read It Later. The sign-in session moves to the app group's keychain so the share extension can use it.
- In an Unread list (the Unread view, or a feed or folder filtered to Unread), a story you open or mark read stays in place, dimmed, instead of vanishing. The list re-filters when you refresh, switch feeds, change the filter or sort, or mark everything read; on iOS also after 15 minutes away. Same for stories marked unread under the Read filter. iOS and web.
- The web reader has a quieter design: three hairline-separated columns, icon toolbars instead of rows of word buttons, a short source-and-time line on each story, and a neutral graphite dark mode in place of the navy one. Dark mode follows the system until you pick one. Sort, filters, titles-only and bulk mark-read live in the list's ⋯ menu; More like this, Not interested, View and Readwise live in the article's ⋯ menu. The sidebar can be hidden, and narrow windows show one column at a time. Articles now match the app theme by default (Settings → Appearance and shortcuts → Article theme); before, the article stayed light in dark mode because Light was the only default. A Light article theme saved under that old default switches to Match app once. Settings → Reading → Appearance chooses System, Light or Dark for the app.
- The iPhone and iPad sidebar's folder arrow is smaller and lighter, so folder names lead the row.
- The web reader no longer has a Save to Readwise option; Read It Later replaces it. The Worker's Readwise endpoints stay for the iOS build on TestFlight.

### Fixed

- Offline sync no longer stalls on a run of long newsletters. The server caps each sync page by article size as well as count, because a page of long issues could exceed the Worker's CPU limit and fail every time, leaving an iPad on months-old cached stories. After a failed page shrinks its request, the app grows the page size back instead of finishing a full rebuild three changes at a time.
- A feed whose cached stories are left over from a failed sync says "Sync failed · updated …" instead of "Cached", and Settings → Offline Library shows the last sync error.

## [0.1.8.0] - 2026-10-26

### Added

- A newspaper-style Front Page home layout for iPhone: a masthead, a lead story with an image and summary, then a two-column headline grid. Classic stays the default; switch in the list's More → Display → Layout or in Settings → Reading → Layout.

### Changed

- Marking many stories read and undoing it match stories by identity, so large bulk actions finish faster.
- Opening a folder or feed is much faster. The app asks the server once for the page of story identifiers, reuses every story body it already has when the server confirms the body is unchanged, and downloads any new or changed bodies in a single request instead of five sequential ones. Read and starred state arrives with the identifiers, so an unchanged page needs one small round trip.
- The server answers story-content requests with one batched database round trip instead of four sequential queries, sends each body once to Pigeon's own apps, and uses index-only plans for Today, per-feed unread lists, and unread counts.
- The web app loads a first visit to a feed or folder with a single request, refreshes cached views without re-downloading unchanged bodies, and serves the app shell with cache validation headers.

### For contributors

- Database schema v15 adds `items.content_version` (bumped whenever a story body changes or is pruned) and replaces `idx_items_unread_feed` with a covering `(feed_key, received_at DESC)` unread index. Deploy the Worker so the migration runs before relying on the new iOS build.
- `stream/items/ids` item references now carry `timestampUsec`, `read`, `starred`, and `contentVersion`; `stream/items/contents` and `stream/contents` items carry `contentVersion` and omit `summary` when the request sends `X-Pigeon-Client`. Third-party Google Reader clients see the previous shapes.

## [0.1.7.0] - 2026-10-07

### Fixed

- Large cached folders, feeds, and Today open promptly while preserving pagination, saved article text, and unread counts.
- Searching saved stories stops processing article bodies when enough matches are found, and moving between stories stays responsive in filtered lists.
- Marking many stories read and undoing the action avoid repeated list updates while keeping reading position and saved changes consistent.
- Image-rich stories avoid repeated image discovery during scrolling, and list image permissions reset correctly when display settings change.

### For contributors

- Local Worker image processing uses the patched Sharp library that resolves the librsvg security advisory.

## [0.1.6.0] - 2026-10-05

### Changed

- For You shows every qualifying story scoring above 50, instead of filling a fixed list of 30.

### Fixed

- Recommendation pages stay complete and consistently ordered through read changes and service restarts; failed refreshes preserve the previous readable list.
- Sidebar counts survive refreshes and reopening the app, rejected stories stay removed, and saved article text remains available when the server has removed its copy.
- Resetting preferences clears older queued feedback while preserving newer feedback and unrelated reading actions.
- Topic matching recognizes dotted A.I. without matching email addresses and avoids severe slowdowns on long text and malformed markup.

### For contributors

- Reader image and cached-startup interface checks handle scrolling and already-completed loading reliably.
- Deployment documentation covers the recommendation helper's bounded persistent snapshots and deployment order.

## [0.1.5.0] - 2026-09-27

### Added

- The native Reader now exposes an Unread smart view with the global unread count, including existing saved view preferences.

## [Unreleased]

### Added

- Choose up to 20 monitored topics in Settings to prioritize matching For You stories across publishers, with a Recommended sort that preserves their ranking.
- New feed subscriptions immediately show up to three newest stories without importing the older backlog on later refreshes.
- Follow public YouTube channels by URL or look up handles such as `mkbhd` in Add Feed. Broader channel-name search is available when a YouTube API key is configured.
- Watch YouTube entries inside the iOS and browser readers, with playback controls, fullscreen, and an Open in YouTube fallback.

### Fixed

- Reader collection entry and lifecycle refreshes now revalidate cached articles automatically while retaining cached content during offline or failed refreshes. Shared article identities keep bodies and status updates consistent across lists, queued edits survive held responses, and warm synchronization preserves unrelated pagination and the open article.
- Daily database maintenance now advances through small indexed batches instead of rescanning the full article library every hour. Starred and unread views also use targeted indexes, preventing routine Pigeon traffic from exhausting the D1 daily read allowance.
- Sidebar folders can be renamed and deleted. The folder list updates immediately, and deleting the open folder no longer leaves a ghost collection.
- Feed notifications now treat a subscription's stream ID (`feed/7`) and feed slug as the same feed, so enabling a feed in Settings actually alerts after background refresh.
- Fresh Worker instances now honor the stored database schema version, reject unsupported newer versions safely, and use an atomic indexed one-time sync backfill, preventing repeated full-library scans from exhausting D1 reads.
- Offline library caches now detect incomplete syncs, rebuild automatically, and keep unread counts aligned with authoritative server navigation snapshots.

## [0.1.3.0] - 2026-08-23

### Fixed

- Reader mode now follows a feed across For You `feed_key` and stream `feed/{rowid}` identities, so choosing Reader View or Website in one list applies in the other.
- iPad Feed Content and Reader View now remount when the story or reading mode changes, so the next article no longer opens already scrolled.
- Searching no longer leaves a stale unread or unstarred row after you mark the story read or starred. The same update applies to library-wide hits that are not in the open list.

## [0.1.2.0] - 2026-08-20

### Fixed

 - The top error banner now clears when you switch feeds or leave a failed search, so a stale load or search failure no longer covers the next list.
 - Not Interested from Today or a feed now drops the story from an already-loaded For You list.
 - Mark Above / Below as Read during search follows the visible hit list instead of the unfiltered collection cache.
 - Mark All as Read during search now marks the visible hits, not every story in the open collection.
 - Mark Older Than during search now marks the visible hits, not every older story in the open collection.
 - Mark Above and Mark Below as Read now follow the visible Unread/Read/All list, so hidden unread stories stay unread when the Read filter is on.
- Searching a list now respects Unread, Read, and All, so a read story no longer appears while Unread is selected.
- After 60% Read marks a story again after you mark it unread. Scrolling a story that is already read no longer consumes that trigger.
- Mark All as Read now marks the visible Unread/Read/All list, not hidden unread neighbors behind the Read filter.
- Mark Older Than now marks the visible Unread/Read/All list, not hidden unread neighbors behind the Read filter.
- The Reading text-size slider now scales the article title and plain fallback body, not only HTML Feed Content / Reader View.
- Opening an article no longer jumps back to the feed list when a library refresh, unread membership update, or stale snapshot apply runs in the background.
- Freeing space from older read articles, or an incremental sync that prunes those bodies, no longer blanks the newsletter you are currently reading.
- Ordinary reading pans no longer count as back-to-feed; only the leading-edge swipe leaves the article.
- Swiping from the leading edge of an iPhone article returns to the feed again. The gesture is recognized on the reader itself, not only the back button.

## [0.1.1.0] - 2026-08-18

### Changed

- Large cached libraries now reuse each article while rebuilding folders and feeds at launch, making the first article list available much faster without changing its order or freshness.

## [0.1.0.0] - 2026-08-17

### Added

- iPad readers can move to the next or previous visible article with configurable hardware-keyboard shortcuts, using J and K by default.

### Fixed

- The iPad app no longer reports Offline for server-side failures while the device is connected, and successful refreshes clear stale connectivity state.
- Large folders, feeds, and Today load one bounded page at a time with an explicit Load More action instead of downloading the entire collection at once.
- Folder pagination is restored safely after relaunch, and an older page request can no longer overwrite a newer refresh.

## [0.0.2.0] - 2026-08-17

### Fixed

- Keep the article you are reading open when a refresh updates its server identifier.
- Keep iPhone and iPad library status accurate when the server is reachable, recover stale offline banners after a successful refresh, and preserve cached and queued reading when connectivity genuinely drops.

## [0.0.1.0] - 2026-08-16

### Fixed

- Newsletter feeds that use nested layout tables now display as a clean reading column, while genuine data tables retain readable borders and horizontal scrolling.
