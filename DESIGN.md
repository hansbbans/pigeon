# Pigeon design system

Pigeon should feel like part of iOS everywhere except the page, and like a well-set book on the page. Chrome is SwiftUI with system materials and text styles, in two looks the reader switches between (see **iOS**): Cards, whose Home is a tile grid and whose lists are cards and the Front Page, and Reeder, a quiet hairline list in the web app's manner with no Home. Reading (article text, story titles, the Front Page) is set in the reading typeface, Geist Serif by default, Bookerly, or the sans Allo (Settings → Typeface), with a generous line and a short measure. Hard rules: it must not look like Mail (see Principle), and every text colour reaches 4.5:1 on its background in every reader theme.

The first half of this file is the target system from Claude Design. The second half, from **Principle** on, is what the code does today, with file references. Where they disagree, see **Drift**. Paths are relative to the repo root; `ios/…/PigeonReader/` means `ios/PigeonReader/PigeonReader/`.

## Source
- Claude Design: [Pigeon](https://claude.ai/artifact/7zYobhZqf2TbFHWbqe1w5d) (Design System), synced 2026-11-09 from `main@f5ce68e`. Its README holds the full usage rules; this file is the in-repo copy of the decisions.
- Code: `Core/StructuredHTMLJavaScript.swift` (reader colours), `Core/ReaderTypography.swift` and `Core/ReaderTypographySettings.swift` (type and reader settings), `Features/Reader/FrontPageView.swift` (kickers), `src/browser-app-styles.ts` (web).

## Color (target)
Four themes, matching `ReaderTheme`: Light, Black (`dark`), Dark Gray and Sepia. System follows the device between Light and Black.

| Token | Light | Black | Dark Gray | Sepia | Use |
|---|---|---|---|---|---|
| `bg` | `#ffffff` | `#000000` | `#1c1c1e` | `#f6ecd1` | Page and list background |
| `bg-grouped` | `#f2f2f7` | `#1c1c1e` | `#2c2c2e` | `#ede2c9` | Settings, sheets, iPad sidebar |
| `bg-inset` | `#eef1f3` | `#252c31` | `#2c2c2e` | `#ede2c9` | Code, table headers, image placeholders |
| `separator` | `#c6c6c8` | `#38383a` | `#48484a` | `#d9c9a3` | Row hairlines (decorative only) |
| `library-ground` | `#f5f5f6` | `#1c1c1e` | `#1c1c1e` | `#f5f5f6` | The Reeder library column (iOS; the web's `--sidebar`) |
| `library-selection` | `#e3e3e7` | `#3a3a3c` | `#3a3a3c` | `#e3e3e7` | Selected library row; its count is `label`, not `label-secondary` |
| `rule` | `#aeb7bd` | `#63717a` | `#636366` | `#b9a57c` | Article `hr`, table borders, masthead rules |
| `text-heading` | `#151515` | `#fafafa` | `#ffffff` | `#2f281e` | Article title and headings |
| `text-body` | `#202124` | `#ececec` | `#f2f2f7` | `#433a2c` | Article body |
| `text-quote` / `quote-rule` | `#4c5660` / `#9aa6af` | `#c3ccd2` / `#71808b` | `#d1d1d6` / `#8e8e93` | `#62533d` / `#a58b62` | Blockquote text and bar |
| `text-caption` | `#5e6971` | `#b7c1c8` | `#aeaeb2` | `#6b5d45` | Figure captions |
| `link` | `#075f9a` | `#75c7ff` | `#64d2ff` | `#735c17` | Inline links |
| `label` | `#000000` | `#ffffff` | `#ffffff` | `#2f281e` | Interface text |
| `label-secondary` | `#6c6c70` | `#98989f` | `#aeaeb2` | `#6b5d45` | Metadata (opaque; replaces `.secondary`) |
| `tint` / `focus-ring` | `#0063d1` | `#409cff` | `#409cff` | `#7a5c12` | Tappable things, 2px focus ring |
| `on-tint` | `#ffffff` | `#000000` | `#000000` | `#ffffff` | Text on a filled tint |
| `tint-soft` | `rgba(0,99,209,.10)` | `rgba(64,156,255,.18)` | same as Black | `rgba(122,92,18,.12)` | Selection wash |
| `danger` | `#d70015` | `#ff6961` | `#ff6961` | `#a3271b` | Errors, always with a word |
| `keep` | `#a05a00` | `#ffb340` | `#ffb340` | `#8a5a00` | Kept/starred, paywall label |

- `kicker-1`…`kicker-8` are the existing `FrontPageKickerPalette` pairs unchanged: the light value is used for Light and Sepia, the dark value for Black and Dark Gray. `kicker-6` (`#2e7d32`) reads 4.36:1 on Sepia, which is flagged.
- Brand colours from the app icon, for the icon, onboarding and marketing only: `brand-paper` `#fbf2e6`, `brand-slate` `#2d363e`, `brand-blue` `#597a9d` (fills only, 4:1 on paper).

## Typography (target)
| Style | Font / size / weight / line height | Use |
|---|---|---|
| `reader-body` | Reading face 18 / 400 / 1.55 (28) | Article body; paragraphs 1.08em apart |
| `reader-title` | Reading face 25 / 30; Bookerly 700, Geist Serif 400 | Article title |
| `reader-h2` / `reader-h3` | Reading face 26 / 22, leading 1.16; Bookerly 700, Geist Serif 400 | Article headings (1.45em / 1.24em) |
| `story-title` | Reading face 17 / 22, relative to `.body`; Bookerly 700, Geist Serif 400 | Story titles in Cards (folder cards, tiles), two lines at most |
| `list-title` / `list-meta` | SF `.body` semibold (read: regular, `label-secondary`) / SF `.footnote` | Reeder list rows, whatever the reading face |
| `section-label` | SF `.caption` semibold, uppercase, tracking 0.8, `label-secondary` | Reeder list sections and library groups |
| `masthead` / `front-lead` / `front-dek` | Reading face 38 italic / 27 title / 16 regular (Geist Serif: all Regular) | Front Page |
| `kicker` | SF 11 / 700, uppercase, tracking 0.8 | Kickers and datelines (`.caption2`) |
| `large-title` … `caption` | iOS text styles unchanged (34, 20, 17, 17, 15, 13, 12) | All chrome |
| `code` | system monospace 15 / 22 | `pre` in articles |

Always use Dynamic Type (`Font.custom(_:size:relativeTo:)` through `ReaderTypography`); the reader's `textScale` multiplies on top. Body text never goes below 16pt, is never justified, and never uses light weights.

## Spacing and radius (target)
- Spacing: 2, 4, 8, 12, 16 (iOS layout margin), 20 (reader margin on iPhone), 24, 32.
- Radius: 4 favicons, 8 thumbnails and code, 12 Front Page images and inset cells, 16 floating material panels, pill for capsules. Use continuous corners.
- Layout: `reader-measure` 640 (about 66 characters), minimum tap target 44, row thumbnail 72×54.
- Depth comes from system materials (`.bar`, `.regularMaterial`), never custom shadows.

## Components (target)
- **ReaderArticle**: header (feed in `tint`, `reader-title`, `subheadline` meta) and a body in the reading typeface. Lives in `ArticleReaderHeaderView.swift` and `StructuredHTMLView` / `StructuredHTMLJavaScript.swift`.
- **ArticleRow** (Reeder): sans `list-title` first, one `list-meta` line (feed in mixed lists, time, length), optional 72×54 thumbnail; read state is a change of weight and colour, not a dot. A story already read when its list first shows it is compact: one line, no thumbnail. Lives in `ArticleRowView.swift`.
- **FrontPage**: masthead between 2pt and 0.5pt rules, lead story plus grid, kicker colours by feed key. Lives in `FrontPageView.swift` and `FrontPageLayout.swift`.
- **ReadingSettings**: a sheet with theme swatches, text size, line spacing, margins and remote images. Lives in `ReaderReadingSettingsView.swift`.

## Do / Don't
- Do use SF Symbols, outline for actions and `.fill` only for an on state. Do keep toolbars icon-only, with accessibility labels.
- Do keep copy quiet, in Title Case for settings values ("Ask Before Loading") and sentence case for explanations. No emoji.
- Don't restyle controls Apple already ships, add shadows, colour headings, or use colour alone to carry meaning.
- Don't use raw `.red`, `.orange` or `.secondary` for text; use `danger`, `keep` and `label-secondary`.

## Drift
Where the code on `main` still differs from the design. hansbbans/pigeon#177 (web) and hansbbans/pigeon#178 (iOS) closed the original list: tint (iOS and web), sepia page colours (iOS and web), column width 640, and on iOS opaque secondary text, `keep` and `danger`, Bookerly list titles, Front Page radius and padding, sepia rules and table borders, and swipe fills.
- Sepia chrome: the design gives Sepia its own `bg-grouped`, `separator` and `rule`. The code paints Sepia only in the reader (page, bottom controls, compact back bar, article CSS). Settings, sheets and lists stay on system greys.
- `kicker-6` (`#2e7d32`) reads 4.36:1 on Sepia, under the 4.5:1 rule. Not changed.
- Image placeholders (`.pigeon-image-failure`, `.pigeon-image-blocked`) keep the `#b7c0c6` border (`#636366` in Dark Gray); the design does not specify one. Not changed.
- Figure captions: `figcaption` is `#66727b` (`StructuredHTMLJavaScript.swift`) vs `text-caption` `#5e6971`, and there is no Sepia override, so Sepia captions are 4.19:1 instead of `#6b5d45`.
- Web `keep` and `danger`: `--star` `#e3a008` / `#f0b429` (about 2.3:1 on white) and `--danger` `#c4382b` / `#ff8a7a` in `src/browser-app-styles.ts` vs `keep` `#a05a00` / `#ffb340` and `danger` `#d70015` / `#ff6961`.
- Web Sepia sets only text, background and link (`frameCSS()` in `src/browser-reading-preferences.ts`); headings, quotes, rules and captions get no Sepia colours.
- Selection wash: iOS uses opacity 0.1 in every mode vs `tint-soft` 0.10 light and 0.18 dark.
- Reeder in Sepia: `library-ground` and `library-selection` have no Sepia values; the library stays on its light greys.
- The Claude Design artifact predates the two looks: it has no Reeder list, `list-title`, `section-label` or library tokens.
- Radii and kickers: article images use 10 (`ArticleBodyView.swift`, `RemoteArticleImageView.swift`), the boundary pull panel 14 (target 16), and only Front Page thumbnails use continuous corners. Feed kickers use `.tracking(0.9)` and the dateline `.caption2.weight(.semibold)` vs `kicker` 700 with tracking 0.8.
- Swipe actions remain on the Reeder list; the design discourages swipe-first triage but the swipes stay.

## Principle

Design rule (from `CLAUDE.md`): the reader must not look like Mail. No sender/subject/preview rows, no swipe-to-triage as the main interaction, no unread dots as the organizing idea. Lean editorial or magazine. Before proposing a redesign, ask what Hans dislikes about the current screen.

The editorial direction is clearest in the iOS Front Page layout, the Cards look and the Bookerly reader. The Reeder look (iOS list and web app) is the quiet alternative: hairlines, small grey labels, sans titles, and the folder structure (Today, Last 7 Days, one section per feed) rather than one stream, so it reads as a reader's contents page, not an inbox.

## iOS (PigeonReader, SwiftUI)

**Tokens.** `Resources/Assets.xcassets` has an `AccentColor` set (`#0063d1` / `#409cff`, the design's `tint`), wired through `ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME` in `project.yml`. `Core/PigeonPalette.swift` holds the design colours SwiftUI lacks: `labelSecondary` (`.pigeonSecondary`, `#6c6c70` / `#98989f`, used instead of `.secondary`), `keep` (`.pigeonKeep`), `danger` (`.pigeonDanger`), `positive` (`kicker-6`), the fixed `SwipeFill` colours and the sepia and dark-gray grounds. `PigeonPaletteTests` pins the 4.5:1 floor. Otherwise UI uses system semantics (`.primary`, `.bar`, `.systemBackground`). Named colors are:
- Reader background, `readerBackground` in `Features/Reader/ArticleReaderView.swift`: `PigeonPalette.sepiaBackground` (`#f6ecd1`), `darkGrayBackground` (`#1c1c1e`), otherwise `.systemBackground`. In Sepia the bottom controls bar and the compact back bar use the page colour; in every other theme they use `.bar`.
- Kicker palette, `FrontPageKickerPalette` (`Features/Reader/FrontPageLayout.swift` picks the index by FNV-1a hash of `feedKey`; the colors are in `Features/Reader/FrontPageView.swift`): 8 light/dark pairs, `0xB3261E/0xFF8A80`, `0x1F6F6A/0x6FD6CC`, `0x3A5BA0/0x9DB6FF`, `0x8A5A00/0xF2C14E`, `0x6A57C9/0xBCAEFF`, `0x2E7D32/0x8BD48F`, `0xA2386B/0xF59AC4`, `0x5D4037/0xD7B8A8`.
- Selection: `Color.accentColor.opacity(0.1)` for article rows, Front Page stories and Read It Later rows. Library rows use `PigeonPalette.librarySelection`, a rounded neutral fill drawn behind the row's content (`ReaderLibrarySelection` in `ReaderNavigationLabelView.swift`; `listRowBackground` lays any non-colour view over a white cell). The library column is `PigeonPalette.libraryGround`.
- Article HTML CSS, inline in `Core/StructuredHTMLJavaScript.swift` (~lines 316-390): body `#202124`, headings `#151515`, links `#075f9a`, `pre`/table header `#eef1f3`, `hr` and table borders `#aeb7bd` (sepia `#b9a57c`), image placeholder borders `#b7c0c6`. There are per-theme overrides on `body[data-theme="light|dark|dark-gray|sepia"]`, for example sepia text `#433a2c` and links `#735c17`, dark-gray background `#1c1c1e` and links `#64d2ff`, plus a `prefers-color-scheme: dark` fallback.

**Themes.** `ReaderTheme` in `Core/ReaderTypographySettings.swift` has `system`, `light`, `darkGray` ("Dark Gray"), `dark` ("Black") and `sepia`. `ReaderThemeColorSchemePlacement` (`Core/ReaderTypography.swift`) applies the scheme as a window-level `preferredColorScheme` only in compact readers. In the iPad split view it is environment-only, so the sidebar and list do not get tinted.

**Typography.** The reading typeface is `ReaderTypeface`: Geist Serif (default), Bookerly, or Allo. It is stored in `pigeon.reader.typography.typeface`, chosen in Settings and in the reader's Reading controls, and passed down as the `readerTypeface` environment value from `RootView`. All three live in `Resources/Fonts/` and are registered under `UIAppFonts` in `ios/PigeonReader/project.yml`. Geist Serif (Vercel, SIL OFL 1.1, `GeistSerif-OFL.txt` alongside) ships only Regular, and SwiftUI does not synthesize bold or italic for a custom font, so in Geist Serif every title, headline and the masthead is Regular. Allo (Josh Puckett, SIL OFL 1.1, `Allo-OFL.txt` alongside; vendored by `npm run vendor:allo`) ships as static OTFs: titles in SemiBold, italics in Oblique, `strong` in Bold. `ReaderTypography` (`Core/ReaderTypography.swift`) picks the face per role (`title`, `body`, `italic`):
- `storyTitle` is the title face at 17 (`relativeTo: .body`).
- `articleTitle` is the title face at 25 and `articleBody` the regular face at 18, both multiplied by `textScale`.
- Front Page masthead is the italic face at 38, lead headline the title face at 27, deck the regular face at 16 (52, 34 and 18 in the wide spread).
- In the HTML, the body uses `"Geist Serif", "Iowan Old Style", Georgia, serif`, Bookerly when `body[data-typeface="bookerly"]`, or Allo when `body[data-typeface="allo"]`. Headings inherit it with line-height 1.16, and are weight 400 in Geist Serif and 600 in Allo to match the SwiftUI title. WebKit synthesizes bold and italic for `strong` and `em` in Geist Serif; Bookerly and Allo use their own bold and italic faces. WebKit's content process cannot see `UIAppFonts` fonts, and it blocks fonts fetched from a custom scheme on the article's https page as mixed content. So `ReaderWebFonts` passes the chosen typeface's bytes to `__pigeonInstallFonts`, which adds them with the `FontFace` API before the first render (about 7 ms for Bookerly's four faces in the simulator). Captions and UI chrome use the system font. Code uses `ui-monospace, SFMono-Regular, Menlo`.
- Reeder list rows (`ArticleRowView.swift`) use `ReaderTypography.listTitle` (`.body` semibold; read rows `listReadTitle`, `.body` regular in `label-secondary`) and `listMeta` (`.footnote`), the system sans whatever the reading face. Section and library labels use `sectionLabel` (`.caption` semibold, uppercase, tracking 0.8).
- Folder cards set an unread headline in `storyTitle`, `.primary`; a read one in the regular face at 17, `label-secondary`. The meta line is `.caption`.

**Reading preferences.** `ReaderTypographySettings`:
- textScale 0.85–1.35 (default 1.0)
- lineHeight 1.25–1.85 (default 1.55)
- horizontalMargin 8–56 (default 20)
- columnWidth 480–920 (default 640; a saved width is kept)
- `ReaderTimelineDensity`: title-only / compact / comfortable / image-rich
- `ReaderLook`: cards (default) / reeder, under `pigeon.reader.look.v1`. A stored `pigeon.reader.home-layout.v1` is migrated once (classic → reeder, front-page → cards) and kept, written in step with the look, so an older build keeps its layout
- `ReaderMarkReadBehavior`

They persist under `pigeon.reader.*` UserDefaults keys. The HTML gets them through `--pigeon-text-scale` and `--pigeon-line-height`.

**Spacing and radii.** There are no spacing constants; values are inline. The Front Page uses horizontal padding 16, grid spacing 22 and a column gap of 18; a spread uses padding 28 and a column gap of 28. Common corner radii are 8, 16, 10 and 12; Front Page thumbnails use 12 with continuous corners.

**Layout and components.**
- The look (Settings → Look, the list's Display menu, or the Reeder library's More menu) is Cards or Reeder. Reeder is the list: three-column split view on iPad, rows with density options, and no Home: the library list is the root, and a regular window always has a list open beside it (`ReaderCompactArticlePresentation.columnWithoutHome`, applied in `ReaderShellView`). The split view launches with all three columns (`columnVisibility` starts at `.all`): an iPad in landscape tiles library, list and story; in portrait the three do not fit, so the list and story fill the window and the library slides over from the sidebar button (tap the story column to close it). Folders and feeds in Reeder are sectioned lists with no sort menu (below); smart views are flat lists with every sort. Cards is the editorial look: For You, Today and the other views are the Front Page, a folder or feed is folder cards, and All Feeds is tiles (`usesCardsLook`, `usesFolderCards`, `usesFrontPage` in `ArticleListView.swift`). Cards has no density options and, for folders and feeds, no sort menu: the cards are the order.
- `FrontPageView` / `FrontPageLayout` (For You and the other views in Cards):
  - newspaper masthead with `FrontPageRule` hairlines (2pt / 0.5pt) and an uppercase dateline (`.caption2`, tracking 0.8)
  - pages of 13 stories: 1 lead plus a 2-column `LazyVGrid`, which drops to 1 column at accessibility sizes and in a column narrower than 330pt (`FrontPageLayout.gridColumnCount`)
  - the page is capped at 640pt and centred, so an iPhone in landscape does not stretch the lead image
  - from 760pt wide (an iPad Pro 11-inch in portrait; not an iPad mini in portrait, 744) the page is a spread (`FrontPageLayout.usesSpread`): the lead image takes 58% of the page beside its headline (title face 34) and deck (18, six lines), the grid goes three across with a 28pt gap, the masthead is 52, padding is 28, and the page is capped at 1080pt. Spread images load at 1200×800 (lead) and 640×480 (columns). Accessibility sizes and short windows (a phone in landscape, however wide) keep the stacked page, and a lead without an image keeps stacked typography
  - Cards are pages, not a column: a regular-width window in Cards navigates the way a phone does, Home then the page then the article, each across the whole window (`ReaderCompactArticlePresentation.navigationSizeClass`, applied in `ReaderShellView`). Reeder keeps the three-column split view
  - colored feed kicker, a 240-char deck, and an `isEditorialImage` aspect filter of 0.6–2.4
- `FolderCardsView` / `FolderSections` (a folder or feed in Cards):
  - a folder is a full-width Today card (stories since local midnight, five until "N more"), a full-width Last 7 Days card (the six local days before today, five until "N more"), then one card per feed with stories this week (three until "N more"), newest feed first; feeds with nothing this week follow under an "Older" header. A story can sit in Today and in its feed's card; the reading log counts it once, at the card that showed it first (`row` metadata: `card-today`, `card-last-7-days`, `card-feed`, `card-day`)
  - a single feed is day cards: Today and Yesterday (five until "N more") and Earlier
  - each card is a Home tile (`ReaderTiles.swift`: `readerTileBackground(barColor:)`, the same shape, background and 3pt top bar), in the folder's `kicker` colour; a feed out of any folder uses its own kicker colour, a view none. The header is `.footnote` bold, uppercase, tracking 0.8, in that colour, with the feed's favicon under Load Normally; a feed card's header opens the feed. Today and Last 7 Days stories name their feed in the colored kicker
  - read stories are told apart by weight and colour, not dots. Selection is the 0.1 accent wash
  - feed cards go one column on a phone and at accessibility sizes, and up to three across from 600pt (`FolderCardsLayout.feedColumnCount`), in a page capped at 960pt and centred
- `ReaderLibraryTilesView` / `ReaderLibraryTiles` (All Feeds in Cards): every view as a tile (Unread too), then each folder's tile with its feeds as smaller tiles under it (favicon, name and newest headline in the reading face at 15, the folder's colour bar), then a "Feeds" group for feeds in no folder. The Unread filter hides read folders and feeds; colours never move with it. Context menus and the editor match the library list (`ReaderLibraryItemMenus.swift`). Reeder has no All Feeds: the library list is its root
- `ReaderHomeView` / `ReaderHomeTilesView` / `ReaderHomeTiles` (Home on iPhone and iPad; decided in the Nov 2026 home redesign, not yet in the Claude Design artifact):
  - no large title; the toolbar's leading item is a dateline in kicker type ("Wed, Nov 11 · 8 new"), the only number on the screen
  - equal view tiles in navigation order: For You, Starred, Read It Later, Today and Last 7 Days when all are enabled. A phone puts three in a row (five go three then two; four become two rows of two); from 600pt every view sits on one row (`ReaderHomeTiles.viewColumnCount`). Unread never gets a tile
  - Last 7 Days (`ReaderSection.lastSevenDays`, ⌘6, `calendar.badge.clock`) is a smart view like Today: the reading list from local midnight six days before today to the next midnight, today included, newest first, Read It Later left out. Its title carries its unread count as Today's does; it is the Front Page in Cards and the list in Reeder, and can be turned off in Settings → Views
  - a 2-column grid of folder tiles: 3pt bar and name in the folder's `kicker` colour (`FrontPageKickerPalette`, starting from the folder id hash and moved to the next free colour so folders do not share one), the newest cached story title in `story-title` (four lines at most; the first feed names until a story is cached), up to four feed favicons. No featured story and no unread counts; a list shows its count in its title once opened
  - Home exists only in Cards. "All Feeds" swaps it for the library tiles; their leading Home button swaps back
  - a regular-width window in Cards shows the tiles across the window (Cards navigates like a phone). From 600pt wide the views sit on one row and folders go three or four across (`ReaderHomeTiles.folderColumnCount`), in a grid capped at 960pt and centred. Reeder's split view columns are 240-320pt (ideal 280) for the library and 300-400pt (ideal 340) for the list, set in `ReaderShellView`, so the reading column on an iPad mini in portrait is at least as wide as an iPhone's
  - tiles are `secondarySystemGroupedBackground` on `systemGroupedBackground`, radius 12 continuous, one column at accessibility sizes
  - motion: favicons and headlines fade in and crossfade, the dateline count rolls (`numericText`), tiles press to 0.97, content fades under the toolbar (`scrollEdgeEffectStyle(.soft)`); all of it is off or reduced with Reduce Motion
- Other: `ArticleReaderHeaderView`, `ArticleBodyView`, `StructuredHTMLView`, `ReaderReadingSettingsView`, `ScoreBadge`, `PaywallLabel`, `ReadingLengthLabel`, `ReaderMotion`. All are under `Features/Reader/`.
- Reeder folders and feeds (the Hairline look, mockup option A in `docs/superpowers/mockups/2026-11-23-ios-reeder-look.html`; spec `docs/superpowers/specs/2026-11-23-ios-reeder-look-design.md`) draw the cards' `FolderSections` as a plain `List`: Today (5, then "N more"), Last 7 Days (5), one section per feed by newest story (3), and Older; a feed is Today, Yesterday and Earlier. Each section sits under `ArticleSectionLabel` (`section-label`, the feed's favicon at 14pt under Load Normally, and a chevron when the label opens the feed); "N more" (`ArticleSectionMoreButton`, `list-meta` in `tint`) expands the section in place. Hairlines run edge to edge; labels have none. A story shown twice (Today and its feed) keeps its plain id and scroll anchor at its first copy, and only the tapped copy is highlighted.
- Read rows: `ReaderFullRowMemory` (the web's `fullRowIdsByList`) remembers, per list context and app session, which stories a list drew in full. A read story not among them is compact; one read in place keeps its height.
- The Reeder library (`ReaderSidebarView`) is a plain `List` on `library-ground`: `section-label` group labels as rows (Views, Folders, Feeds), grey symbols for views, favicons for feeds, no folder icon, a leading `label-secondary` disclosure triangle, grey tabular counts hidden at zero, no separators or chevrons (`navigationLinkIndicatorVisibility(.hidden)`; the links stay for the native push and ⌘1–⌘6), 44pt rows. Its toolbar is ＋ and ⋯ (Filter, Look, Settings).
- Reeder list swipe actions (`ArticleListView.swift`) use `PigeonPalette.SwipeFill`: tint (read), keep (star) and teal `kicker-2` (Read It Later).

## Web (Worker `/`)

**Files.**
- `src/browser-app-styles.ts`: `renderBrowserAppStyles()` holds all app CSS, plus Tabler icon masks as `--icon-*` vars.
- `src/browser-app.ts`: HTML shell and behavior.
- `src/browser-app-client.ts`: CSS for the article iframe document.
- `src/browser-reading-preferences.ts`: `window.PigeonReading`.

The header comment of `browser-app-styles.ts` describes the direction as quiet, Reeder-style: three hairline-separated columns, icon-only toolbars, one muted accent and a graphite dark mode.

**Tokens** (`:root` and `html[data-theme="dark"]`, light → dark):

| Var | Light | Dark |
|---|---|---|
| `--page` / `--surface` / `--frame` | `#ffffff` | `#1f1f21` |
| `--sidebar` | `#f5f5f6` | `#19191b` |
| `--list` | `#ffffff` | `#1c1c1e` |
| `--surface-raised` | `#ffffff` | `#2a2a2d` |
| `--hover` / `--selected` / `--sidebar-selected` | `#f0f0f2` / `#ebebee` / `#e3e3e7` | `#262629` / `#2c2c2f` / `#2e2e31` |
| `--border` / `--hairline` | `#e4e4e7` / `#efeff1` | `#2e2e31` / `#262628` |
| `--text` / `--text-secondary` / `--muted` | `#1c1c1e` / `#48484a` / `#6e6e73` | `#e8e8ea` / `#b4b4b9` / `#8e8e94` |
| `--accent` / `--accent-soft` | `#0063d1` / `rgba(0, 99, 209, 0.10)` | `#409cff` / `rgba(64, 156, 255, 0.18)` |
| `--star` / `--danger` | `#e3a008` / `#c4382b` | `#f0b429` / `#ff8a7a` |
| `--grouped` / `--tile` (Cards) | `#f2f2f7` / `#ffffff` | `#141416` / `#1f1f21` |
| `--kicker-1` … `--kicker-4` (Cards) | `#b3261e` / `#1f6f6a` / `#3a5ba0` / `#8a5a00` | `#ff8a80` / `#6fd6cc` / `#9db6ff` / `#f2c14e` |
| `--kicker-5` … `--kicker-8` (Cards) | `#6a57c9` / `#2e7d32` / `#a2386b` / `#5d4037` | `#bcaeff` / `#8bd48f` / `#f59ac4` / `#d7b8a8` |

The dark table above leaves out `--scrim` and `--shadow`, which are also redefined for dark. `--radius: 8px` is light-only and inherited. The article iframe has its own set, `--frame-page`, `--frame-text`, `--frame-link` (`#0063d1` / `#409cff`), `--frame-border`, `--frame-pre`, `--frame-quote` and `--frame-muted`, in `browser-app-client.ts` (~line 335). It forces newsletter backgrounds transparent in dark mode.

**Article list read state.** Read rows are compact (`is-compact`): source and time over a one-line, truncated title in `--muted` at regular weight, with no preview or image (the image is not even loaded). Unread rows keep the bold title, two-line preview and image, so read and unread differ by shape, not only by grey. A loaded row never changes height within a list: the open row is always full, and a row the list has already shown in full this page session (the reader just read it, or another device marked it read) stays full with title and preview in `--muted`, title weight unchanged so it cannot rewrap. That also keeps each list's saved scroll position valid when the reader comes back to it. A list not shown before in this session (another view, search, filter or sort) and every list after a reload show read rows compact. Read It Later rows keep their own treatment. Impressions of compact rows carry `metadata.row = "compact"`. Rule: `renderArticles()` in `src/browser-app.ts` (`fullRowIdsByList`).

**Smart views.** All items, Unread, Today, Last 7 Days, Recently read, Starred, Read It Later and For You, in that order. Today is the local day (local midnight to the next); Last 7 Days is the local day and the six before it, counted in calendar days so a daylight-saving week stays 7 days (`getLocalDayRangeBounds` in `src/browser-app-client.ts`). Both show a sidebar count of unread stories in their window from `/api/v1/browser/articles/count?since&before`, because the server does not know the browser's time zone. Last 7 Days always loads through `/api/v1/browser/articles` with `since`/`before`; Today pages the reading list and filters by day unless a search, filter or sort is on. The sidebar icon is `--icon-week`; the summary line reads "Received in the last 7 days". The reading log names the list `last-7-days`.

**Folder sections.** A folder's stream column is sections, not one stream: **Today**, then **Last 7 Days** (yesterday and the five days before it, so not today's stories), then **one section per feed** ordered by its newest story (ties by feed title), and feeds whose newest loaded story is older than that week after an **Older** label. Today and Last 7 Days show 5 stories, feed sections 3; the rest sit behind a "N more" link (`--accent`, 0.8rem, no underline until hover) that opens the section in place for the rest of the page session. A story from Today or Last 7 Days also appears in its feed's section. Rows in Today and Last 7 Days keep the feed name in the meta line; rows in a feed section leave it out. Section labels reuse the quiet uppercase `.article-feed-header` (0.7rem, 600, `--muted`, hairline above): Today and Last 7 Days in `--text-secondary`, Older with extra space above it, feed labels with the favicon and clickable to open that feed. No boxes or cards: hairlines only. Folders load newest first and have no Sort control (the sections are the order); the Show filter stays, and under Unread every section holds only unread stories. j/k, impressions and the selection follow each story's first appearance; both copies of the open story are highlighted. Impressions carry `metadata.section` (`today`, `last-7-days` or `feed`). When a page lands or a section opens, the first row on screen stays where it was. Rule: `buildFolderSections()` in `src/browser-app-client.ts`, rendered by `renderArticles()` in `src/browser-app.ts`.

**Cards look.** The web app has two looks, Reeder (default) and Cards, the same pair as iOS. The look is stored in `pigeon.browser.look` and set as `data-look` on `.reader-grid`; it switches from the `cards` icon button in the stream header (`aria-pressed`) or Settings → Look. Spec: `docs/superpowers/specs/2026-11-23-web-cards-look-design.md`, mockup option B in `docs/superpowers/mockups/2026-11-23-web-cards-look.html`.
- Layout (wider than 760px): the sidebar, then one page area. The stream and reader panels share `grid-area: page`; the one not shown is `visibility: hidden`, so the cards keep their scroll position under an open story. The stream resizer is hidden and a sidebar toggle sits at the start of the stream header. `data-page` on the grid is `home`, `cards`, `front-page` or `list`. At 760px and below the single-pane behaviour is unchanged.
- Opening a story shows the reader in the page; its back button is named for the list ("‹ Newsletters", title "Back to Newsletters", `--accent`), and Escape does the same (after closing an image zoom). Switching to Cards on a wide window shows the cards, with the open story still selected. Going back restores the cards' scroll position and focuses the story's card. The first story is still selected in the hidden reader, but auto-mark-read and reading time count only while the reader is on screen, and impressions are only sampled while the cards are. The `--accent-soft` selection wash marks only a story opened in this visit to the list (a click, j/k, a notification), never the one picked when the list arrives; j or k with nothing opened yet steps to the first story drawn (a Front Page's lead). Reeder draws its selection as before.
- Home: Cards opens on Home (a Home row tops the sidebar, Cards only). Home has the italic serif heading "Home", a small uppercase dateline in `--muted` ("Mon, Nov 23 · 12 new"), view tiles (For You, Starred, Read It Later, Today, Last 7 Days) and one tile per folder with its colour bar and up to four feeds.
- Folders render the folder sections as cards on `--grouped`: `.cards-card` tiles (`--tile`, 12px radius, a 3px top bar in the folder's colour) in a `repeat(auto-fill, minmax(16rem, 1fr))` grid capped at 960px; Today spans the full width in two text columns; Older is a full-width label. A feed shows day cards (Today, Yesterday, Earlier, 5 each until "N more"; `buildFeedDaySections()`), newest first with no Sort control. Search results are one full-width flat card. Read It Later keeps its own list (`data-page="list"`).
- Front Page: the smart views (All items, Unread, Today, Last 7 Days, Recently read, Starred, For You) without a search, on the plain page (`--list`), in `#articles-list.is-front-page` capped at 960px. The masthead is the view's name in the reading face, italic (2.4rem; 3.25rem in a spread; 2rem at ≤760px), between a 2px `--text` rule and a 1px `--border` rule, over an uppercase dateline (weekday, month, day, and "· N new" where the view has an unread count), closed by another 2px rule; it replaces the stream heading, which stays for assistive technology only, and the article count is hidden. Stories come in pages of 13 (`buildFrontPagePages()`): a lead, then a grid, with a 2px rule between pages and a 1px rule under the lead. The lead is the first story with a picture among the page's first four, else the first story; the others keep the list's order, and keys, impressions and positions follow the drawn order. Lead: picture (3:2), kicker, headline (1.75rem), a deck of about 240 characters from the preview (`frontPageDeck()`, three lines) and the meta line. Grid stories: picture (4:3) when they have one, kicker, headline (1.15rem), meta. Headlines are the reading face at weight 400, read ones in `--muted`, decks in `--text-secondary`; pictures have a 12px radius and follow the image policy as list rows do (none under Ask, the reading proxy under Proxy), and a picture that loads as a logo or banner is dropped (`isEditorialImage()`: at least 320px wide for a lead, 140 for a grid story, aspect 0.6–2.4). The layout follows the list's own width (a container query): from 760px it is a spread, the lead's picture taking 58% beside its headline (2.1rem) and deck (six lines), and the grid three across; below that the lead stacks and the grid is two across; at ≤760px the grid is one column.
- Story rows in cards: a kicker (the feed name, uppercase, in one of `--kicker-1..8`), a serif title (1.04rem, 500 unread / 400 read) and one meta line (time · reading length). No preview, no image, no compact rows. Feed-section and day-card rows leave the kicker out.
- Colours match iOS: a feed's kicker is 64-bit FNV-1a of its stream id mod 8 (`kickerColorIndex()`); folders take their hash colour or the next free one (`assignFolderColorIndices()`), and a feed card's bar uses its folder's colour. Both in `src/browser-app-client.ts`.
- Reading log: impressions of Front Page stories carry `metadata.row = "front-page"` and their drawn position; impressions of card rows carry `metadata.row = "card"`, plus `metadata.section`: a folder's `today`, `last-7-days` or `feed`, and `day` for every one of a feed's day cards (so a feed's Today is not counted as a folder's).

**Themes.**
- App theme: `data-theme` on `<html>`, light or dark. It is stored in `pigeon.browser.theme` and falls back to `prefers-color-scheme`. `browser-app.ts` sets the `theme-color` meta to `#f5f5f6` / `#19191b`.
- Article theme: `app`, `light`, `dark`, `sepia` or `system`, mapped by `frameTheme()` in `src/browser-reading-preferences.ts`. Only sepia paints its own colors (`#433a2c` on `#f6ecd1`, links `#735c17`, the same as iOS) in `frameCSS()` there.

**Typography.**
- UI: `--font` = `-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', 'Helvetica Neue', sans-serif`, at `14px/1.45`.
- Reading typeface: `--reading-font`, set from the reading preference by `fontStack()` in `src/browser-reading-preferences.ts`. It styles the reader title, `.saved-title`, `.transcript-segment` and the article iframe body. The default is Geist Serif (`'Geist Serif', 'New York', 'Iowan Old Style', Georgia, serif`); `allo` is `Allo, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`. The empty-reader placeholder stays in `--font`.
- Geist Serif (Vercel, SIL OFL 1.1, `docs/licenses/GeistSerif-OFL.txt`) ships one weight. `scripts/vendor-geist-serif.mjs` pins it by tag and SHA-256 into `src/browser-font-geist-serif.ts`, and the Worker serves it at `/app/fonts/geist-serif-<version>.woff2` (immutable). Its `@font-face` declares weight 400 only, so browsers synthesize bold and italic. A weight range would claim a real bold and render `<strong>` at Regular. The frame loads the font only when Geist Serif is chosen.
- Allo (Josh Puckett, SIL OFL 1.1, `docs/licenses/Allo-OFL.txt`): `scripts/vendor-allo.mjs` pins the Friendly variable upright (weight 100-900, roundness fixed at 50) and the Regular oblique into `src/browser-font-allo.ts`, served at `/app/fonts/allo-<version>.woff2` and `/app/fonts/allo-oblique-<version>.woff2`. The upright declares `font-weight:100 900` (a real variable font, so bold is drawn); the oblique declares 400 only, so bold italic is synthesized. The frame loads them only when Allo is chosen.
- Reader title: `clamp(1.5rem, 2.3vw, 2rem)`, weight 700 (synthesized bold in Geist Serif).
- List titles: `.article-title` 0.92rem/600, with a 2-line `.article-preview`.
- Iframe default: `16px/1.7` system sans.

**Reading preferences** (`pigeon.browser.reading.v1`, schema 3):
- font: `geist` (Geist Serif, default), `allo`, `system`, `serif` (Georgia, Charter) or `sans`. Records older than schema 3 saved `system` as the old default, so they read as `geist`.
- fontSize 14–28 (default 18)
- lineHeight 1.2–2.2 (default 1.65)
- width 480–960 (default 640)
- margins 0–64 (default 24)
- density: comfortable or compact
- imagePolicy: load, ask or proxy

**Layout.** `.reader-grid` has three columns: sidebar `minmax(14rem, var(--sidebar-column-width: 224px))`, stream `minmax(18rem, var(--stream-column-width: 340px))`, and reader `1fr`. Resizers write widths to `pigeon.browser.column-widths`. The sidebar collapses through `.is-sidebar-collapsed`. `.reader-copy` is capped at `var(--reader-measure, 640px)` with padding `var(--reader-gutter, 24px)`. The list mode is `preview` or `titles` (`pigeon.browser.article-list-mode`). The Cards look replaces the stream and reader columns with one page area (see Cards look).

**Breakpoints.** There is one breakpoint, `@media (max-width: 760px)`, which shows a single pane at a time via `data-mobile-pane="sidebar|stream|reader"`. Other media queries are `(hover: hover)` and `(prefers-reduced-motion: reduce)`.

**Shape.** Buttons are outlined, with a 1px `--border`, 7px radius and 120ms transitions. Cards use 8px radii. Radii otherwise range from 4px to 14px, plus 999px pills.

## Extension

`extension/static/options.css` is a separate 16-line stylesheet for the options page with its own tokens: `--fg`, `--muted`, `--bg`, `--field`, `--border`, `--accent` (`#2f5d50` / `#7fb8a4`, green, not the app blue) and `--error`. It switches theme with `prefers-color-scheme: dark`, not `data-theme`.

## When changing UI

- Web: use the existing `--*` vars in `browser-app-styles.ts`. Add any new token to both `:root` and `html[data-theme="dark"]`. Check light, dark and the ≤760px single-pane layout.
- iOS reader: change fonts through `ReaderTypography` and the `readerTypeface` environment value (never a hard-coded font name), scaled by `textScale`. Check both typefaces. Check all five `ReaderTheme` values, because article HTML colors are per-theme CSS in `StructuredHTMLJavaScript.swift`, separate from the SwiftUI background.
- New surfaces come in both looks. In Cards they grow from the Front Page vocabulary (masthead, rules, kickers, decks, lead + grid) or the home tiles (kicker colours, reading-typeface headlines, no counts); in Reeder from the hairline list (section labels, sans titles, one meta line, quiet grey library). Follow the principle above.
- Check Dynamic Type at accessibility sizes (Front Page collapses to one column) and reduced motion (`ReaderMotion`, `prefers-reduced-motion`).
