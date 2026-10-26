# Pigeon — Task Tracker

## Phase 1: Foundation

- [x] Initialize Wrangler project with TypeScript
- [x] Install `postal-mime` dependency
- [x] Create `wrangler.toml` with D1 binding placeholder + env vars
- [x] Write `src/types.ts` (Env interface)
- [x] Write `src/index.ts` (fetch + email handlers)
- [x] Verify `wrangler dev` starts and `/health` works
- [x] Git init + first commit
- [x] **Manual: Cloudflare setup** (see below)
- [x] **Manual: Deploy + test email** (see below)

### Manual Cloudflare Steps (you do these)

1. **Create Cloudflare account** (if needed) and add your domain — change nameservers at registrar
2. **Wait for DNS propagation** (~5-30 min, until CF shows domain as "Active")
3. **Enable Email Routing** — CF dashboard → Email → Email Routing
4. **Create D1 database:**
   ```bash
   npx wrangler d1 create pigeon-db
   ```
   Then paste the `database_id` into `wrangler.toml`
5. **Update `BASE_URL`** in `wrangler.toml` to your actual domain (e.g. `https://feeds.yourdomain.com`)
6. **Deploy:**
   ```bash
   npm run deploy
   ```
7. **Link email routing to Worker** — CF dashboard → Email Routing → route `rss@yourdomain.com` to the `pigeon` worker
8. **Test** — send an email to `rss@yourdomain.com`, then:
   ```bash
   npm run tail
   ```
   You should see the log line: `Email received | from=... to=... size=... bytes`

## Phase 2: Parse + Store
_Complete_

## Phase 3: RSS Serving
_Complete_

## Phase 4: Google Reader API (Reeder Classic)

- [x] Add `is_read` and `is_starred` columns to items table (schema migration)
- [x] Add `idx_items_unread` index
- [x] Add `API_PASSWORD` to Env interface
- [x] Create `src/greader.ts` — Google Reader API handler
  - [x] Auth: ClientLogin, token generation, auth validation
  - [x] GET /reader/api/0/token
  - [x] GET /reader/api/0/user-info
  - [x] GET /reader/api/0/tag/list
  - [x] GET /reader/api/0/subscription/list
  - [x] GET /reader/api/0/unread-count
  - [x] GET /reader/api/0/stream/items/ids
  - [x] POST /reader/api/0/stream/items/contents
  - [x] POST /reader/api/0/edit-tag
  - [x] POST /reader/api/0/mark-all-as-read
  - [x] ID conversion utilities (parseItemId, toGoogleItemId, isoToUnix)
- [x] Update `src/index.ts` with greader routes
- [x] Update `wrangler.toml` with dev API_PASSWORD
- [x] Update SCHEMA.sql with new columns + index
- [x] `npx tsc --noEmit` — clean
- [ ] **Manual: Run schema migration on remote D1**
- [ ] **Manual: `wrangler secret put API_PASSWORD`**
- [ ] **Manual: Deploy + test with curl**
- [ ] **Manual: Add to Reeder Classic as FreshRSS**

### Deploy Steps

1. Run schema migration:
   ```bash
   wrangler d1 execute pigeon-db --remote --command "ALTER TABLE items ADD COLUMN is_read INTEGER DEFAULT 0;"
   wrangler d1 execute pigeon-db --remote --command "ALTER TABLE items ADD COLUMN is_starred INTEGER DEFAULT 0;"
   wrangler d1 execute pigeon-db --remote --command "CREATE INDEX idx_items_unread ON items(is_read, feed_key);"
   ```
2. Set production password:
   ```bash
   wrangler secret put API_PASSWORD
   ```
3. Deploy:
   ```bash
   npm run deploy
   ```
4. Test:
   ```bash
   curl -X POST 'https://pigeon.hans-cho.workers.dev/accounts/ClientLogin' -d 'Email=pigeon&Passwd=YOUR_PASSWORD'
   ```
5. Add to Reeder Classic as FreshRSS → URL: `https://pigeon.hans-cho.workers.dev`, username: `pigeon`, password: YOUR_PASSWORD

## Folder mark-as-read feed badges — September 13, 2026

- [x] Inspect released main and preserve the unrelated primary checkout.
- [x] Reproduce stale child-feed badges in native and iPad UI tests.
- [x] Fix folder read propagation and add a failing-before/passing-after regression.
- [x] Verify native tests, folder UI behavior, and clean Release build (496 native tests and two iPad UI tests passed).

Release, tester availability, and simulator cleanup are tracked in the associated PR, Actions runs, and task verification record.

## iOS: Front Page layout (switchable with Classic)

Goal: add the "Front Page" newspaper layout (direction A) for the iPhone story list, with a one-tap switch back to the current list ("Classic") so both can be lived with side by side. Classic stays exactly as it is today.

### Design
- New `ReaderHomeLayout` enum (`classic`, `frontPage`) persisted in `ReaderTypographySettings` next to `timelineDensity` (key `pigeon.reader.home-layout.v1`, default `classic`).
- Switch lives in two places:
  - Toolbar `Display` menu (`ArticleListToolbar.swift:59`): a "Layout" picker above Timeline density, so flipping takes two taps from any list.
  - Settings → Reading: a "Layout" picker next to "Timeline".
- Timeline density applies to Classic only; the density picker is hidden while Front Page is active.
- Swap point: `ArticleListView.swift:130`. Only the `List { ForEach … ArticleRowView }` branch changes. Empty, search, error and loading states, `.refreshable`, pagination (`loadMoreControls`), thumbnail prefetch and `model.select(article:)` are all reused unchanged.
- Front Page applies on compact width (iPhone) only. iPad regular width keeps Classic for now.
- Reader screen, sidebar and settings are untouched in this pass.

### Front Page view (`Features/Reader/FrontPageView.swift`)
- Masthead: the collection title in an italic serif (Bookerly, falling back to New York), the date, and an "N unread" line.
- Lead story: the first story of each page, in the collection's existing order (For You is already ranked by score). Changed from "best story with a thumbnail": picking by read state or image would reshuffle the page after reading, and checking HTML for images on every render is too slow. Shown as a full-width image, a coloured small-caps sender kicker, a large serif headline and a 2-line deck taken from `text`.
- Below that, a two-column headline grid: kicker plus serif headline, with a small thumbnail when one exists.
- The page lays out in "pages" of about 13 stories each (1 lead plus a grid of 12), separated by a rule. Pagination keeps using the existing load-more trigger at the bottom.
- Read stories fade to about 50% but stay in place. No unread dots and no swipe actions.
- The long-press context menu has the same actions as Classic: read/unread, star, mark above/below.
- Sender kicker colour is a stable hue hashed from `feedKey`, from a small fixed palette tuned for contrast in light and dark.
- Accessibility: each story is one element labelled with sender, headline and read state. Dynamic Type is supported, and the grid collapses to one column at accessibility sizes.

### Steps
- [x] 1. Add `ReaderHomeLayout` and its persisted property, with unit tests for the default, round-trip and unknown raw value.
- [x] 2. Add the Layout picker to the Display menu and to Settings → Reading; hide density while on Front Page.
- [x] 3. Build `FrontPageView`: masthead, lead story, grid, read fade, context menu.
- [x] 4. Add a pure, unit-tested `FrontPageLayout` helper that picks the lead story and chunks pages, plus kicker colour hashing.
- [x] 5. Wire the swap in `ArticleListView` with compact width plus `frontPage`.
- [x] 6. Highlight the selected Front Page story with `Color.accentColor.opacity(0.1)`. Scroll restoration is explicitly out of scope; Front Page does not use `ReaderListViewportController`.
- [x] 7. Add UI tests: toggle the layout from the Display menu, open a story from Front Page, toggle back, and confirm Classic is unchanged.
- [ ] 8. Verify in the simulator: both layouts with real feeds, plus For You, Today, an empty feed, search, a dark theme, the largest Dynamic Type size, and flipping the layout 5+ times rapidly.

### Out of scope (later, if Front Page wins)
- A tab bar or NavigationStack restructure, the reader pill, the Aa sheet, design tokens.
- Front Page on iPad.

### Review
Merged to `main` in PR #137 (`b46ae87`) on 2026-10-25. Not yet on TestFlight.
- New: `FrontPageLayout.swift` (page chunking, deck text, image filter, stable kicker colour hash) and `FrontPageView.swift`. The setting is `ReaderHomeLayout` in `ReaderTypographySettings`. Pickers are in Display menu → Layout and in Settings → Reading → Layout.
- Classic is unchanged. Front Page reuses the list's selection, context-menu actions, pull to refresh, automatic and manual load-more, the "new stories" button and thumbnail prefetch.
- Images use the shared thumbnail pipeline, so they load only under the "Load Normally" image policy. Logos, spacers and banner-shaped images are skipped.
- Verified:
  - Debug build with zero first-party warnings (CI gate script).
  - New unit tests pass (layout, deck, image filter, palette, setting persistence).
  - The new UI test (switch to Front Page → open story → back → switch to Classic) passed 3 of 3 runs.
  - Full suite, 797 unit tests plus the UI tests: 5 failures under load (a bulk-undo timing test, a hitch performance test, three Personalization UI tests that lost the app). All 5 pass when re-run in isolation.
  - Simulator screenshots checked in light, dark, XXXL and AX5 text sizes. The AX5 dateline wrapping was fixed.
- Not verified: real account feeds, Today, an empty feed, search on Front Page, rapid repeated layout flips, iPad (where Front Page is intentionally off).
- Follow-up in the same PR: the bulk read/undo timing test flaked because undo took ~1.9s against a 2s budget. Pending-status overlay matching now uses a direct alias lookup, and `ReaderArticleIdentity.matches` compares ids without building Sets. Undo now takes ~1.3s and bulk read ~0.89s. The remaining cost is about 1,800 per-article SQLite upserts in `persistCollections`.
