# Pigeon design system

What exists today, with file references. Every value below is grep-able in the code. Paths are relative to the repo root; `ios/…/PigeonReader/` means `ios/PigeonReader/PigeonReader/`.

## Principle

Design rule (from `CLAUDE.md`): the reader must not look like Mail. No sender/subject/preview rows, no swipe-to-triage as the main interaction, no unread dots as the organizing idea. Lean editorial or magazine. Before proposing a redesign, ask what Hans dislikes about the current screen.

The editorial direction is clearest in the iOS Front Page layout and the Bookerly reader. The Classic iOS list and the web article list still use source + title + preview rows and swipe actions. Treat those as legacy, not as patterns to copy.

## iOS (PigeonReader, SwiftUI)

**Tokens.** No color theme type and no colorsets: `Resources/Assets.xcassets` holds only `AppIcon`. UI uses system semantics (`.primary`, `.secondary`, `.bar`, `Color.accentColor`, `.systemBackground`). Named colors are:
- Reader background, `readerBackground` in `Features/Reader/ArticleReaderView.swift`: sepia `Color(red: 0.965, green: 0.925, blue: 0.82)`, dark gray `28/255, 28/255, 30/255`, otherwise `.systemBackground`.
- Kicker palette, `FrontPageKickerPalette` (`Core/FrontPageLayout.swift` picks the index by FNV-1a hash of `feedKey`; the colors are in `Features/Reader/FrontPageView.swift`): 8 light/dark pairs, `0xB3261E/0xFF8A80`, `0x1F6F6A/0x6FD6CC`, `0x3A5BA0/0x9DB6FF`, `0x8A5A00/0xF2C14E`, `0x6A57C9/0xBCAEFF`, `0x2E7D32/0x8BD48F`, `0xA2386B/0xF59AC4`, `0x5D4037/0xD7B8A8`.
- Selection: `Color.accentColor.opacity(0.1)` for rows and stories, `0.16` for folder rows (`ReaderFolderNavigationRowView.swift`).
- Article HTML CSS, inline in `Core/StructuredHTMLJavaScript.swift` (~lines 316-390): body `#202124`, headings `#151515`, links `#075f9a`, `pre`/table header `#eef1f3`, borders `#b7c0c6`. There are per-theme overrides on `body[data-theme="light|dark|dark-gray|sepia"]`, for example sepia text `#433a2c` and links `#735c17`, dark-gray background `#1c1c1e` and links `#64d2ff`, plus a `prefers-color-scheme: dark` fallback.

**Themes.** `ReaderTheme` in `Core/ReaderTypographySettings.swift` has `system`, `light`, `darkGray` ("Dark Gray"), `dark` ("Black") and `sepia`. `ReaderThemeColorSchemePlacement` (`Core/ReaderTypography.swift`) applies the scheme as a window-level `preferredColorScheme` only in compact readers. In the iPad split view it is environment-only, so the sidebar and list do not get tinted.

**Typography.** Bookerly (Regular/Bold/Italic/BoldItalic) lives in `Resources/Fonts/` and is registered under `UIAppFonts` in `ios/PigeonReader/project.yml`. `ReaderTypography` (`Core/ReaderTypography.swift`):
- `storyTitle` is Bookerly-Bold 17 (`relativeTo: .body`).
- `articleTitle` is Bookerly-Bold 25 and `articleBody` is Bookerly-Regular 18, both multiplied by `textScale`.
- Front Page masthead is Bookerly-Italic 38, lead headline Bookerly-Bold 27, deck Bookerly-Regular 16.
- In the HTML, headings and body use `Bookerly, "Iowan Old Style", Georgia, serif` with heading line-height 1.16. Captions and UI chrome use the system font. Code uses `ui-monospace, SFMono-Regular, Menlo`.
- Classic list rows (`ArticleRowView.swift`) use the system `.body.weight(.semibold)` for titles and `.caption` for metadata.

**Reading preferences.** `ReaderTypographySettings`:
- textScale 0.85–1.35 (default 1.0)
- lineHeight 1.25–1.85 (default 1.55)
- horizontalMargin 8–56 (default 20)
- columnWidth 480–920 (default 720)
- `ReaderTimelineDensity`: title-only / compact / comfortable / image-rich
- `ReaderHomeLayout`: classic / front-page
- `ReaderMarkReadBehavior`

They persist under `pigeon.reader.*` UserDefaults keys. The HTML gets them through `--pigeon-text-scale` and `--pigeon-line-height`.

**Spacing and radii.** There are no spacing constants; values are inline. The Front Page uses horizontal padding 18, grid spacing 22 and a column gap of 18. Common corner radii are 8 (7 uses), 16 (4), 10 and 12, plus 3 on Front Page thumbnails.

**Layout and components.**
- `FrontPageView` / `FrontPageLayout` (iPhone only; see `usesFrontPage` in `ArticleListView.swift`):
  - newspaper masthead with `FrontPageRule` hairlines (2pt / 0.5pt) and an uppercase dateline (`.caption2`, tracking 0.8)
  - pages of 13 stories: 1 lead plus a 2-column `LazyVGrid`, which drops to 1 column at accessibility sizes
  - colored feed kicker, a 240-char deck, and an `isEditorialImage` aspect filter of 0.6–2.4
- Other: `ArticleReaderHeaderView`, `ArticleBodyView`, `StructuredHTMLView`, `ReaderReadingSettingsView`, `ScoreBadge`, `PaywallLabel`, `ReadingLengthLabel`, `ReaderMotion`. All are under `Features/Reader/`.
- Classic list swipe actions (`ArticleListView.swift`) are tinted `.blue` (read), `.orange` (star) and `.green` (Read It Later).

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
| `--accent` / `--accent-soft` | `#3466b0` / `rgba(52, 102, 176, 0.12)` | `#8fb3e8` / `rgba(143, 179, 232, 0.16)` |
| `--star` / `--danger` | `#e3a008` / `#c4382b` | `#f0b429` / `#ff8a7a` |

The dark table above leaves out `--scrim` and `--shadow`, which are also redefined for dark. `--radius: 8px` is light-only and inherited. The article iframe has its own set, `--frame-page`, `--frame-text`, `--frame-link` (`#3466b0` / `#8fb3e8`), `--frame-border`, `--frame-pre`, `--frame-quote` and `--frame-muted`, in `browser-app-client.ts` (~line 335). It forces newsletter backgrounds transparent in dark mode.

**Themes.**
- App theme: `data-theme` on `<html>`, light or dark. It is stored in `pigeon.browser.theme` and falls back to `prefers-color-scheme`. `browser-app.ts` sets the `theme-color` meta to `#f5f5f6` / `#19191b`.
- Article theme: `app`, `light`, `dark`, `sepia` or `system`, mapped by `frameTheme()` in `src/browser-reading-preferences.ts`. Only sepia paints its own colors (`#40362c` on `#f4ecd8`, links `#765b2d`) in `frameCSS()` there.

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
- width 480–960 (default 720)
- margins 0–64 (default 24)
- density: comfortable or compact
- imagePolicy: load, ask or proxy

**Layout.** `.reader-grid` has three columns: sidebar `minmax(14rem, var(--sidebar-column-width: 224px))`, stream `minmax(18rem, var(--stream-column-width: 340px))`, and reader `1fr`. Resizers write widths to `pigeon.browser.column-widths`. The sidebar collapses through `.is-sidebar-collapsed`. `.reader-copy` is capped at `var(--reader-measure, 720px)` with padding `var(--reader-gutter, 24px)`. The list mode is `preview` or `titles` (`pigeon.browser.article-list-mode`).

**Breakpoints.** There is one breakpoint, `@media (max-width: 760px)`, which shows a single pane at a time via `data-mobile-pane="sidebar|stream|reader"`. Other media queries are `(hover: hover)` and `(prefers-reduced-motion: reduce)`.

**Shape.** Buttons are outlined, with a 1px `--border`, 7px radius and 120ms transitions. Cards use 8px radii. Radii otherwise range from 4px to 14px, plus 999px pills.

## Extension

`extension/static/options.css` is a separate 16-line stylesheet for the options page with its own tokens: `--fg`, `--muted`, `--bg`, `--field`, `--border`, `--accent` (`#2f5d50` / `#7fb8a4`, green, not the app blue) and `--error`. It switches theme with `prefers-color-scheme: dark`, not `data-theme`.

## When changing UI

- Web: use the existing `--*` vars in `browser-app-styles.ts`. Add any new token to both `:root` and `html[data-theme="dark"]`. Check light, dark and the ≤760px single-pane layout.
- iOS reader: change fonts through `ReaderTypography` (Bookerly, scaled by `textScale`). Check all five `ReaderTheme` values, because article HTML colors are per-theme CSS in `StructuredHTMLJavaScript.swift`, separate from the SwiftUI background.
- New list or home surfaces should grow from the Front Page vocabulary (masthead, rules, kickers, decks, lead + grid), not from Classic rows. Follow the principle above.
- Check Dynamic Type at accessibility sizes (Front Page collapses to one column) and reduced motion (`ReaderMotion`, `prefers-reduced-motion`).
