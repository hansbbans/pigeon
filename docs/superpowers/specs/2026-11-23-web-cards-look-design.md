# Web Cards look: library + page (part 4)

Date: 2026-11-23. Status: approved (Hans picked option B, "yeah do B"). Part 4 of `2026-11-22-folder-cards-design.md`; its structure rules (Today, Last 7 Days, one section per feed, Older, "N more") apply unchanged.

Mockup: `docs/superpowers/mockups/2026-11-23-web-cards-look.html`, option B.

## Intent

The web app gets the Cards look iOS has, as a second look beside the current one (Reeder). Cards on the web keeps the quiet library sidebar; everything right of it is one page of cards. Same card language as iOS Cards: white tiles on the grouped grey, a 3px top bar in the folder's kicker colour, serif headlines, uppercase kicker headers, "N more".

## Goals

1. **The switch.** One setting, Cards or Reeder, stored per browser (`pigeon.browser.look`, default `reeder`, so nobody's web app changes until they choose). It is a toolbar icon in the list header and a choice in Settings. Switching keeps the open view and story.
2. **Layout in Cards (wider than 760px).** Two areas: the sidebar (unchanged, resizable, collapsible) and the page, which takes the stream and reader columns. The page shows either the cards or the open story, never both:
   - Clicking a story opens it across the page area (the reader with its 640px measure, centred) with a back button labelled with the list ("‹ Newsletters"). Back returns to the cards at the same scroll position. Escape goes back too.
   - j/k and the arrow keys step through the stories in card order while a story is open, as they do in the list.
   - The stream-column resizer is hidden in Cards.
3. **Home.** In Cards the sidebar gains a "Home" row at its top. Home is the tile page: one tile per enabled view (For You, Starred, Read It Later, Today, Last 7 Days; Unread and All items get none, as on iOS), then a tile per folder (name and 3px bar in the folder's kicker colour, the folder's feeds as favicons and names, four at most). Clicking a tile opens that view or folder. Cards opens on Home when the page loads.
4. **Folders** are cards built from `buildFolderSections` (the same sections and limits as the Reeder sections): a full-width Today card whose stories flow two columns when the page is wide enough, then Last 7 Days and the feed cards in a grid (three across on a wide page, two on a medium one, one at ≤760px), then "Older" as a full-width label over the older feed cards. Today and Last 7 Days stories carry their feed name as a coloured kicker; a feed card's header has the favicon and name and opens the feed. "N more" opens the card in place for the page session, as now.
5. **Single feeds** are day cards: Today, Yesterday and Earlier (five until "N more" for Today and Yesterday), the iOS `FeedDaySections` rule.
6. **Smart views** (For You, All items, Unread, Today, Last 7 Days, Starred, Recently read) are the Front Page: a masthead (view name in the reading face, italic, with a kicker-type dateline), a lead story (hero image when there is one, headline, two-line deck) and a grid of the rest (three across, feed kicker in its colour, headline, image when there is one). Read It Later keeps its own cards, unchanged.
7. **Colours.** Folder colours come from the iOS palette (`FrontPageKickerPalette`, `kicker-1`…`kicker-8`, light and dark values), assigned from a hash of the folder id and moved to the next free colour so folders do not share one (the `ReaderHomeTiles.colorIndices` rule). A feed's kicker colour is a hash of its stream id. Feeds out of any folder use their own colour as the bar.
8. **Kept:** read state by weight and colour (read headlines in `--muted`); selection is `--accent-soft`; context menu (mark above/below from the copy used), search (results are a flat list of story cards, not sections), the Show filter, refresh, mark all read, keyboard shortcuts, offline mode, reading-log impressions and opens.

## Non-goals

- Reeder is unchanged.
- No iOS change, no API change, no Worker route change.
- No library tiles (All Feeds) on the web: the sidebar is the library.

## Anti-goals

- Anything that reads as Mail: sender/subject/preview rows, unread dots, swipe triage.
- Unread counts on tiles or card headers (the sidebar keeps its counts).
- Custom shadows; colours outside the tokens below.

## Constraints

- **Tokens.** New vars in both `:root` and `html[data-theme="dark"]`: `--grouped` (`#f2f2f7` / `#141416`), `--tile` (`#ffffff` / `#1f1f21`), `--kicker-1`…`--kicker-8` (iOS light / dark values). Text on tiles keeps 4.5:1 in both themes.
- **Reading log** (live until about 2026-12-16): card stories keep impressions and opens. Metadata: `row: "card"` for folder and feed cards (with `section` as today), `row: "front-page"` for Front Page stories.
- **One rendered story list.** Cards reuse `renderArticles()`' rows (`renderedArticleCards`, `data-item-id`, `is-active`, `is-read`), so selection, keys, impressions, context menus and the folder anchor keep working; only the containers and styles differ.
- **Narrow windows (≤760px)** keep the single-pane switch (`data-mobile-pane`): sidebar, page, story.
- Checks: `npm run check`; `npm run visual:check` (light, dark, 375/768/1280); new tests through `test/helpers/browser-app-client-harness`.
- `DESIGN.md` Web section gains the look, tokens and layout, in the same PR.

## Delivery

Two PRs, one outcome each:
1. **4a: Cards layout, Home, folder and feed cards, the switch** (goals 1-5, 7, 8). Smart views in Cards show the story cards as one full-width card until 4b.
2. **4b: Front Page** for smart views (goal 6).

## Decided

- Option B, library + page (Hans).
- Claude's calls: default look Reeder on the web; Home only in Cards, and Cards opens on it; the story opens over the page rather than beside it; search is flat; no library tiles on the web; Front Page in its own PR.
