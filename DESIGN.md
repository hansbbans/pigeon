# Pigeon design system

Pigeon should feel like part of iOS everywhere except the page, and like a well-set book on the page. Chrome is stock SwiftUI with system materials and text styles. Reading (article text, story titles, the Front Page) is set in Bookerly with a generous line and a short measure. Hard rules: it must not look like Mail (see Principle), and every text colour reaches 4.5:1 on its background in every reader theme.

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
| `reader-body` | Bookerly 18 / 400 / 1.55 (28) | Article body; paragraphs 1.08em apart |
| `reader-title` | Bookerly 25 / 700 / 30 | Article title |
| `reader-h2` / `reader-h3` | Bookerly 26 / 22, 700, leading 1.16 | Article headings (1.45em / 1.24em) |
| `story-title` | Bookerly 17 / 700 / 22, relative to `.body` | List story titles, two lines at most |
| `masthead` / `front-lead` / `front-dek` | Bookerly Italic 38 / Bold 27 / Regular 16 | Front Page |
| `kicker` | SF 11 / 700, uppercase, tracking 0.8 | Kickers and datelines (`.caption2`) |
| `large-title` … `caption` | iOS text styles unchanged (34, 20, 17, 17, 15, 13, 12) | All chrome |
| `code` | system monospace 15 / 22 | `pre` in articles |

Always use Dynamic Type (`Font.custom(_:size:relativeTo:)` for Bookerly); the reader's `textScale` multiplies on top. Body text never goes below 16pt, is never justified, and never uses light weights.

## Spacing and radius (target)
- Spacing: 2, 4, 8, 12, 16 (iOS layout margin), 20 (reader margin on iPhone), 24, 32.
- Radius: 4 favicons, 8 thumbnails and code, 12 Front Page images and inset cells, 16 floating material panels, pill for capsules. Use continuous corners.
- Layout: `reader-measure` 640 (about 66 characters), minimum tap target 44, row thumbnail 72×54.
- Depth comes from system materials (`.bar`, `.regularMaterial`), never custom shadows.

## Components (target)
- **ReaderArticle**: header (feed in `tint`, `reader-title`, `subheadline` meta) and Bookerly body. Lives in `ArticleReaderHeaderView.swift` and `StructuredHTMLView` / `StructuredHTMLJavaScript.swift`.
- **ArticleRow**: serif `story-title` first, one `caption` meta line, optional 72×54 thumbnail; read state is a change of weight and colour, not a dot. Lives in `ArticleRowView.swift`.
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
- Selection wash: iOS uses opacity 0.1 (0.16 in the sidebar) in every mode vs `tint-soft` 0.10 light and 0.18 dark.
- Radii and kickers: article images use 10 (`ArticleBodyView.swift`, `RemoteArticleImageView.swift`), the boundary pull panel 14 (target 16), and only Front Page thumbnails use continuous corners. Feed kickers use `.tracking(0.9)` and the dateline `.caption2.weight(.semibold)` vs `kicker` 700 with tracking 0.8.
- Swipe actions remain on the Classic list; the design discourages swipe-first triage but the swipes stay.

## Principle

Design rule (from `CLAUDE.md`): the reader must not look like Mail. No sender/subject/preview rows, no swipe-to-triage as the main interaction, no unread dots as the organizing idea. Lean editorial or magazine. Before proposing a redesign, ask what Hans dislikes about the current screen.

The editorial direction is clearest in the iOS Front Page layout and the Bookerly reader. The Classic iOS list (title first, one meta line, no preview, swipe actions) and the web article list (title plus a two-line preview) are closer to an inbox. Treat those as legacy, not as patterns to copy.

## iOS (PigeonReader, SwiftUI)

**Tokens.** `Resources/Assets.xcassets` has an `AccentColor` set (`#0063d1` / `#409cff`, the design's `tint`), wired through `ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME` in `project.yml`. `Core/PigeonPalette.swift` holds the design colours SwiftUI lacks: `labelSecondary` (`.pigeonSecondary`, `#6c6c70` / `#98989f`, used instead of `.secondary`), `keep` (`.pigeonKeep`), `danger` (`.pigeonDanger`), `positive` (`kicker-6`), the fixed `SwipeFill` colours and the sepia and dark-gray grounds. `PigeonPaletteTests` pins the 4.5:1 floor. Otherwise UI uses system semantics (`.primary`, `.bar`, `.systemBackground`). Named colors are:
- Reader background, `readerBackground` in `Features/Reader/ArticleReaderView.swift`: `PigeonPalette.sepiaBackground` (`#f6ecd1`), `darkGrayBackground` (`#1c1c1e`), otherwise `.systemBackground`. In Sepia the bottom controls bar and the compact back bar use the page colour; in every other theme they use `.bar`.
- Kicker palette, `FrontPageKickerPalette` (`Features/Reader/FrontPageLayout.swift` picks the index by FNV-1a hash of `feedKey`; the colors are in `Features/Reader/FrontPageView.swift`): 8 light/dark pairs, `0xB3261E/0xFF8A80`, `0x1F6F6A/0x6FD6CC`, `0x3A5BA0/0x9DB6FF`, `0x8A5A00/0xF2C14E`, `0x6A57C9/0xBCAEFF`, `0x2E7D32/0x8BD48F`, `0xA2386B/0xF59AC4`, `0x5D4037/0xD7B8A8`.
- Selection: `Color.accentColor.opacity(0.1)` for article rows, Front Page stories and Read It Later rows; `0.16` for sidebar rows (`ReaderNavigationRowView.swift`, `ReaderFolderNavigationRowView.swift`). Same opacity in light and dark.
- Article HTML CSS, inline in `Core/StructuredHTMLJavaScript.swift` (~lines 316-390): body `#202124`, headings `#151515`, links `#075f9a`, `pre`/table header `#eef1f3`, `hr` and table borders `#aeb7bd` (sepia `#b9a57c`), image placeholder borders `#b7c0c6`. There are per-theme overrides on `body[data-theme="light|dark|dark-gray|sepia"]`, for example sepia text `#433a2c` and links `#735c17`, dark-gray background `#1c1c1e` and links `#64d2ff`, plus a `prefers-color-scheme: dark` fallback.

**Themes.** `ReaderTheme` in `Core/ReaderTypographySettings.swift` has `system`, `light`, `darkGray` ("Dark Gray"), `dark` ("Black") and `sepia`. `ReaderThemeColorSchemePlacement` (`Core/ReaderTypography.swift`) applies the scheme as a window-level `preferredColorScheme` only in compact readers. In the iPad split view it is environment-only, so the sidebar and list do not get tinted.

**Typography.** Bookerly (Regular/Bold/Italic/BoldItalic) lives in `Resources/Fonts/` and is registered under `UIAppFonts` in `ios/PigeonReader/project.yml`. `ReaderTypography` (`Core/ReaderTypography.swift`):
- `storyTitle` is Bookerly-Bold 17 (`relativeTo: .body`).
- `articleTitle` is Bookerly-Bold 25 and `articleBody` is Bookerly-Regular 18, both multiplied by `textScale`.
- Front Page masthead is Bookerly-Italic 38, lead headline Bookerly-Bold 27, deck Bookerly-Regular 16.
- In the HTML, headings and body use `Bookerly, "Iowan Old Style", Georgia, serif` with heading line-height 1.16. Captions and UI chrome use the system font. Code uses `ui-monospace, SFMono-Regular, Menlo`.
- Classic list rows (`ArticleRowView.swift`) use `storyTitle` for titles and `.caption` for metadata.

**Reading preferences.** `ReaderTypographySettings`:
- textScale 0.85–1.35 (default 1.0)
- lineHeight 1.25–1.85 (default 1.55)
- horizontalMargin 8–56 (default 20)
- columnWidth 480–920 (default 640; a saved width is kept)
- `ReaderTimelineDensity`: title-only / compact / comfortable / image-rich
- `ReaderHomeLayout`: classic / front-page
- `ReaderMarkReadBehavior`

They persist under `pigeon.reader.*` UserDefaults keys. The HTML gets them through `--pigeon-text-scale` and `--pigeon-line-height`.

**Spacing and radii.** There are no spacing constants; values are inline. The Front Page uses horizontal padding 16, grid spacing 22 and a column gap of 18. Common corner radii are 8, 16, 10 and 12; Front Page thumbnails use 12 with continuous corners.

**Layout and components.**
- `FrontPageView` / `FrontPageLayout` (iPhone only; see `usesFrontPage` in `ArticleListView.swift`):
  - newspaper masthead with `FrontPageRule` hairlines (2pt / 0.5pt) and an uppercase dateline (`.caption2`, tracking 0.8)
  - pages of 13 stories: 1 lead plus a 2-column `LazyVGrid`, which drops to 1 column at accessibility sizes
  - colored feed kicker, a 240-char deck, and an `isEditorialImage` aspect filter of 0.6–2.4
- Other: `ArticleReaderHeaderView`, `ArticleBodyView`, `StructuredHTMLView`, `ReaderReadingSettingsView`, `ScoreBadge`, `PaywallLabel`, `ReadingLengthLabel`, `ReaderMotion`. All are under `Features/Reader/`.
- Classic list swipe actions (`ArticleListView.swift`) use `PigeonPalette.SwipeFill`: tint (read), keep (star) and teal `kicker-2` (Read It Later).

## Web (Worker `/app`)

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

The dark table above leaves out `--scrim` and `--shadow`, which are also redefined for dark. `--radius: 8px` is light-only and inherited. The article iframe has its own set, `--frame-page`, `--frame-text`, `--frame-link` (`#0063d1` / `#409cff`), `--frame-border`, `--frame-pre`, `--frame-quote` and `--frame-muted`, in `browser-app-client.ts` (~line 335). It forces newsletter backgrounds transparent in dark mode.

**Themes.**
- App theme: `data-theme` on `<html>`, light or dark. It is stored in `pigeon.browser.theme` and falls back to `prefers-color-scheme`. `browser-app.ts` sets the `theme-color` meta to `#f5f5f6` / `#19191b`.
- Article theme: `app`, `light`, `dark`, `sepia` or `system`, mapped by `frameTheme()` in `src/browser-reading-preferences.ts`. Only sepia paints its own colors (`#433a2c` on `#f6ecd1`, links `#735c17`, the same as iOS) in `frameCSS()` there.

**Typography.**
- UI: `--font` = `-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', 'Helvetica Neue', sans-serif`, at `14px/1.45`.
- Serif stack `'New York', 'Iowan Old Style', Charter, Georgia, …` is used only for `.saved-title` and `.transcript-segment`.
- Reader title: `clamp(1.5rem, 2.3vw, 2rem)`, weight 700.
- List titles: `.article-title` 0.92rem/600, with a 2-line `.article-preview`.
- Iframe default: `16px/1.7` system sans.

**Reading preferences** (`pigeon.browser.reading.v1`, schema 2):
- font: `system`, `serif` (Georgia, Charter) or `sans`
- fontSize 14–28 (default 18)
- lineHeight 1.2–2.2 (default 1.65)
- width 480–960 (default 640)
- margins 0–64 (default 24)
- density: comfortable or compact
- imagePolicy: load, ask or proxy

**Layout.** `.reader-grid` has three columns: sidebar `minmax(14rem, var(--sidebar-column-width: 224px))`, stream `minmax(18rem, var(--stream-column-width: 340px))`, and reader `1fr`. Resizers write widths to `pigeon.browser.column-widths`. The sidebar collapses through `.is-sidebar-collapsed`. `.reader-copy` is capped at `var(--reader-measure, 640px)` with padding `var(--reader-gutter, 24px)`. The list mode is `preview` or `titles` (`pigeon.browser.article-list-mode`).

**Breakpoints.** There is one breakpoint, `@media (max-width: 760px)`, which shows a single pane at a time via `data-mobile-pane="sidebar|stream|reader"`. Other media queries are `(hover: hover)` and `(prefers-reduced-motion: reduce)`.

**Shape.** Buttons are outlined, with a 1px `--border`, 7px radius and 120ms transitions. Cards use 8px radii. Radii otherwise range from 4px to 14px, plus 999px pills.

## Extension

`extension/static/options.css` is a separate 16-line stylesheet for the options page with its own tokens: `--fg`, `--muted`, `--bg`, `--field`, `--border`, `--accent` (`#2f5d50` / `#7fb8a4`, green, not the app blue) and `--error`. It switches theme with `prefers-color-scheme: dark`, not `data-theme`.

## When changing UI

- Web: use the existing `--*` vars in `browser-app-styles.ts`. Add any new token to both `:root` and `html[data-theme="dark"]`. Check light, dark and the ≤760px single-pane layout.
- iOS reader: change fonts through `ReaderTypography` (Bookerly, scaled by `textScale`). Check all five `ReaderTheme` values, because article HTML colors are per-theme CSS in `StructuredHTMLJavaScript.swift`, separate from the SwiftUI background.
- New list or home surfaces should grow from the Front Page vocabulary (masthead, rules, kickers, decks, lead + grid), not from Classic rows. Follow the principle above.
- Check Dynamic Type at accessibility sizes (Front Page collapses to one column) and reduced motion (`ReaderMotion`, `prefers-reduced-motion`).
