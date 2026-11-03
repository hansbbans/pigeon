# Read It Later, Step 1: Defuddle Everywhere — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Mozilla Readability with kepano's Defuddle as Pigeon's reader-mode extractor on web and iOS. Keep Readability as a fallback. Return Defuddle's metadata (word count, author, published date, site, image) from both extractors so later steps can store it.

**Architecture:**
- Defuddle's single-file UMD browser bundle is vendored once, as an exact copy:
  - into the iOS app as `Resources/Defuddle.js`;
  - into the Worker as a TypeScript string served at `/app/defuddle.js`.
- **Web:** the existing `__PIGEON_READING_TOOLS__.extract` wrapper, which uses inert template parsing and resource markers, calls Defuddle first and falls back to Readability. The web app loads `/app/defuddle.js` lazily the first time reader mode extracts.
- **iOS:** `ReaderViewExtractor` evaluates Defuddle in its offscreen WKWebView and falls back to Readability.
- **No extraction runs on the Worker.**

**Tech Stack:** TypeScript (Worker, `tsx --test`), vanilla browser JS emitted from TS, Swift / WKWebView / Swift Testing, Defuddle 0.19.6 (MIT), linkedom (dev-only DOM for Node tests).

**Spec:** `docs/superpowers/specs/2026-11-03-read-it-later-design.md` (section "Defuddle", delivery step 1)

## Global Constraints

**Defuddle and Readability**
- Pin Defuddle at exactly `0.19.6` (or later; it includes the Markdown XSS fix). Pin with no caret.
- Use Defuddle's core bundle `dist/index.js`, not `index.full.js`, and HTML output only (no `markdown` option).
- Keep the MIT notice: `ios/PigeonReader/PigeonReader/Resources/DEFUDDLE-NOTICE.md`, next to the existing `READABILITY-NOTICE.md`.
- Call `parse()`, never `parseAsync()`. Reader extraction must make no network requests.
- Readability stays as the fallback in this release. It is used when Defuddle throws, returns no content, or returns under 80 characters of text.

**Limits and data**
- Existing limits stay: 5,000,000-byte source cap and 10,000-element cap.
- `published` is normalized to ISO 8601 UTC (`YYYY-MM-DDTHH:MM:SS.sssZ`) or `null`.
  - Relative strings such as "An hour ago" become `null`.
  - So do dates more than 1 day in the future, and dates before 1990.
- No new Worker CPU work. `/app/defuddle.js` is a static string response.

**Workflow**
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Worker checks: `npm run check`.
- iOS fast loop:
  `xcodebuild test -project ios/PigeonReader/PigeonReader.xcodeproj -scheme PigeonReader -destination 'platform=iOS Simulator,name=Pigeon Claude' -parallel-testing-enabled NO CODE_SIGNING_ALLOWED=NO -only-testing:PigeonReaderTests`
  Boot `Pigeon Claude` first. Run `xcodegen generate` in `ios/PigeonReader` after adding files.
- Ship as two PRs: Tasks 1–3 (web, which doesn't touch the Mac), then Task 4 (iOS). Task 1's vendored iOS file goes in the first PR. It is a resource the app doesn't load yet, but its path is under `ios/`, so that PR runs the iOS job once.

## Review Focus

1. **Defuddle throws or returns an empty or near-empty article** (script-rendered pages, paywalls). Expect the Readability result, or the existing "Reader extraction unavailable" message, never a blank reader. Tested in Task 2 (web) and Task 4 (iOS).
2. **Footnote links** (`href="#fn:1"`). They must stay in-page fragments and must not resolve to `https://site/page#fn:1`, which would navigate away. Tested in Task 2 and Task 4.
3. **Relative or garbage `published` values** ("An hour ago", "Updated", a year-3000 date) become `null`. Tested in Task 2 (JS) and Task 4 (Swift).
4. **Very large pages** (10,001 elements, or 5 MB plus 1 byte) fail fast with the existing errors before Defuddle runs. Tested in Task 2.
5. **First reader-mode use offline, or `/app/defuddle.js` failing to load.** Reader mode falls back to Readability, which is inline, instead of failing. Tested in Task 3.

---

### Task 1: Vendor Defuddle

**Files:**
- Modify: `package.json` (add `defuddle: "0.19.6"` and `linkedom` to devDependencies; add script `"vendor:defuddle": "node scripts/vendor-defuddle.mjs"`)
- Create: `scripts/vendor-defuddle.mjs`
- Create (generated): `src/browser-defuddle-source.ts`, `ios/PigeonReader/PigeonReader/Resources/Defuddle.js`
- Create: `ios/PigeonReader/PigeonReader/Resources/DEFUDDLE-NOTICE.md`
- Test: `test/browser-defuddle.test.ts`

**Interfaces:**
- Produces:
  - `src/browser-defuddle-source.ts` exports `DEFUDDLE_SOURCE: string` (the exact bytes of `node_modules/defuddle/dist/index.js`) and `DEFUDDLE_VERSION: '0.19.6'`.
  - The iOS resource `Defuddle.js` holds the same bytes. Evaluated in a page, it defines global `Defuddle`.

- [ ] **Step 1: Check feasibility (throwaway, outside the repo)**
  In `/tmp/pigeon-defuddle-spike`, `npm i defuddle@0.19.6 linkedom`. Then, in Node:
  1. Parse a 1,000-word article with linkedom.
  2. Copy its `<html>` into `document.implementation.createHTMLDocument('')`, which matches the existing web/iOS flow. That document has `defaultView === null` in browsers.
  3. Run `new Defuddle(doc, { url }).parse()`.

  Record whether it throws without a `defaultView` or `getComputedStyle`. If it throws, the wrapper in Tasks 2 and 4 must parse into a document that has a `defaultView`: for example, on web a detached same-origin `about:blank` iframe's document, and on iOS the shell page's own `document` with the source swapped into a `<template>`. Note the outcome in the Task 2 commit message. Delete the spike directory.
- [ ] **Step 2: Write the failing test** `test/browser-defuddle.test.ts`:
  - `'vendored Defuddle matches the pinned npm bundle on web and iOS'`:
    - `DEFUDDLE_SOURCE === readFileSync(require.resolve('defuddle/dist/index.js'))`
    - the iOS `Defuddle.js` equals the same bytes
    - `DEFUDDLE_VERSION === require('defuddle/package.json').version === '0.19.6'`
  - `'Defuddle notice carries the MIT license'`: `DEFUDDLE-NOTICE.md` matches `/MIT/` and `/Steph Ango/` and mentions `0.19.6`.
- [ ] **Step 3: Run** `npx tsx --test test/browser-defuddle.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 4: Implement `scripts/vendor-defuddle.mjs`.** It reads `defuddle/dist/index.js` and `defuddle/package.json`, then writes:
  - the iOS file, byte for byte;
  - `src/browser-defuddle-source.ts` with a header comment (source, version, MIT, "generated by scripts/vendor-defuddle.mjs; do not edit") and the two exports, with the source embedded via `JSON.stringify`.

  Write `DEFUDDLE-NOTICE.md` modeled on `READABILITY-NOTICE.md`, with the full MIT license text. Run `npm run vendor:defuddle`.
- [ ] **Step 5: Run** the test again. Expected: PASS. Run `npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `chore: vendor Defuddle 0.19.6 for web and iOS`.

### Task 2: Web reading tools, Defuddle first with Readability fallback

**Files:**
- Modify: `src/browser-readability.ts` (`installBrowserReadingTools`, `renderBrowserReadabilityScript`)
- Create: `src/reader-published-date.ts`
- Test: `test/browser-readability.test.ts` (extend); `test/reader-published-date.test.ts`; fixtures `test/fixtures/reader/{essay-footnotes,code-post,substack-post,thin-script-page}.html`

**Interfaces:**
- Consumes: global `Defuddle` (Task 1), present on `root` when loaded.
- Produces:
  - `normalizePublishedDate(value: unknown, now?: Date): string | null`, exported from `src/reader-published-date.ts`. It is pure and has no DOM. It is also inlined into the emitted reading-tools script via `.toString()`, as `installBrowserReadingTools` already is.
  - `root.__PIGEON_READING_TOOLS__.extract(html, url)` now returns:
    ```ts
    { title: string|null, byline: string|null, excerpt: string|null, content: string, url: string,
      wordCount: number|null, published: string|null, image: string|null, site: string|null,
      extractor: 'defuddle' | 'readability' }
    ```
    `content` is still passed through `client.sanitizeArticleHtml`. Existing callers keep working, since they only read `content` and `url`.
  - `root.__PIGEON_READING_TOOLS__.hasDefuddle(): boolean`.

- [ ] **Step 1: Write the failing tests** for `normalizePublishedDate`, with `now = new Date('2026-11-03T12:00:00Z')`:
  - `'2026-10-01'` → `'2026-10-01T00:00:00.000Z'`
  - `'2026-10-01T09:30:00-04:00'` → `'2026-10-01T13:30:00.000Z'`
  - `'Tue, 14 Oct 2025 08:00:00 GMT'` → `'2025-10-14T08:00:00.000Z'`
  - `'An hour ago'`, `'Updated'`, `''`, `null`, `42`, `'3000-01-01'`, `'1989-12-31'` → `null`
  - `'2026-11-04T11:00:00Z'` (23 hours ahead) → kept; `'2026-11-05T00:00:00Z'` → `null`
- [ ] **Step 2: Write the failing extraction tests** in `test/browser-readability.test.ts`.

  Setup: run the emitted reading-tools script (`renderBrowserReadabilityScript()`) plus `DEFUDDLE_SOURCE` plus `renderBrowserAppClientScript()` inside a linkedom `window`, with `fetch` stubbed to throw.

  Tests:
  - `'extract prefers Defuddle and returns metadata'` (fixture `essay-footnotes.html`):
    - `extractor === 'defuddle'`
    - `wordCount > 300`
    - `published === '2025-04-02T00:00:00.000Z'`
    - `site === 'Example Essays'`
    - `byline === 'Ada Reader'`
  - `'footnote links stay in-page'`: the content contains `href="#fn:1"`, and no `href` matches `/^https?:.*#fn:/`. Elements with `id="fn:1"` and `id="fnref:1"` survive sanitizing.
  - `'code language survives'` (`code-post.html`): the content contains `data-lang="python"` or `class="language-python"`.
  - `'falls back to Readability when Defuddle is absent'`: delete `window.Defuddle`; expect `extractor === 'readability'` and non-empty content.
  - `'falls back to Readability when Defuddle throws or returns thin text'`: stub `window.Defuddle` with a class whose `parse()` throws, and then with one that returns `{content:'<p>hi</p>'}`; both give `extractor === 'readability'`.
  - `'size and element caps run before Defuddle'`: a 5,000,001-byte source throws `/too large/`; 10,001 `<p>` elements throw `/too many elements/`; the Defuddle stub's `parse` is never called.
  - `'no network during extraction'`: the `fetch` stub was never called.

  If linkedom lacks `template.content`, switch the test DOM to `happy-dom`; production code is unchanged.
- [ ] **Step 3: Run** `npx tsx --test test/browser-readability.test.ts test/reader-published-date.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement.**
  - **Signatures:** `installBrowserReadingTools(root, Reader)` keeps its signature and reads `root.Defuddle` at call time, so lazy loading (Task 3) works.
  - **Unchanged order:** cap checks, inert `template` parse, `clean(…, false)`, and the parsed document with `<base>` all stay as they are.
  - **Then:**
    1. Try `new root.Defuddle(parsed, { url: base }).parse()`.
    2. Accept the result if `content` is present and its text is at least 80 characters. Otherwise, or on a throw, run the existing Readability path.
    3. Map the fields:
       - Defuddle: `author` → `byline`, `description` → `excerpt`, `published` → `normalizePublishedDate`, `site` → `site`, `image` → `safeURL(image, base)`, `wordCount` → `wordCount`.
       - Readability: `wordCount` comes from a whitespace token count of `textContent`; `published` comes from `publishedTime`, normalized.
  - **Sanitizer allowlist in `clean()`:**
    - Add `data-lang` to `attributes`.
    - For `a[href]` whose raw value starts with `#`, keep the fragment as-is instead of resolving it against `base`.
    - Apply the same fragment rule in `client.sanitizeArticleHtml` (`src/browser-app-client.ts`) if it rewrites hrefs. Check, and pin it with the footnote test.
  - **Readability hooks:** keep the existing no-op overrides of `_fixLazyImages` and `_unwrapNoscriptImages`. Defuddle's equivalents are harmless here, because media already carries opaque markers.
  - **Emit `normalizePublishedDate`** into the script by adding `normalizePublishedDate.toString()` to the IIFE.
- [ ] **Step 5: Run** the tests. Expected: PASS. Run `npm run check`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(web): extract reader view with Defuddle, fall back to Readability`.

### Task 3: Serve and lazily load Defuddle in the web app

**Files:**
- Modify: `src/index.ts` (route `GET /app/defuddle.js`), `src/browser-app.ts` (`prepareReadingFrame`, around line 2758)
- Test: `test/browser-app.test.ts` (extend)

**Interfaces:**
- Consumes: `DEFUDDLE_SOURCE` and `DEFUDDLE_VERSION` (Task 1); `__PIGEON_READING_TOOLS__.hasDefuddle()` (Task 2).
- Produces: `GET /app/defuddle.js?v=<DEFUDDLE_VERSION>`:
  - `200`, `Content-Type: text/javascript; charset=utf-8`, `Cache-Control: public, max-age=31536000, immutable`, no auth.
  - The body is `DEFUDDLE_SOURCE`.

- [ ] **Step 1: Write the failing tests:**
  - `'serves vendored Defuddle with immutable caching'`: the response body equals `DEFUDDLE_SOURCE` and has the headers above.
  - `'app shell does not inline Defuddle'`: the `/app` HTML does not contain a distinctive substring of `DEFUDDLE_SOURCE`, and does contain `/app/defuddle.js?v=0.19.6` inside the reading code.
  - `'reader mode loads Defuddle once and falls back when it fails'`: run the client loader helper (below) with a fake `document.createElement('script')` that triggers `onerror`. Expect it to resolve `false` without throwing, and a second call not to inject a second script.
- [ ] **Step 2: Run** `npx tsx --test test/browser-app.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Route:** in `src/index.ts`, next to the `/app/sw.js` route.
  - **Loader:** in `browser-app.ts`, add `ensureDefuddle(): Promise<boolean>`. It injects `<script src="/app/defuddle.js?v=…">` once, caches the promise, resolves `true` on load and `false` on error or after a 10-second timeout.
  - **Call site:** in `prepareReadingFrame`, `await ensureDefuddle()` before calling `extract`. Extraction then runs with or without Defuddle; Task 2 handles the fallback.
  - **Service worker:** if it precaches `/app` assets, leave `defuddle.js` out of the precache. HTTP caching is enough.
- [ ] **Step 4: Run** the tests. Expected: PASS. Run `npm run check`. Expected: PASS.
- [ ] **Step 5: Verify manually.** Run `npm run dev:main` and open `/app`. Switch an RSS item to Reader mode:
  - the network panel shows one `defuddle.js` request;
  - the article renders;
  - a footnote link scrolls within the frame.

  Repeat on 5 different articles, then block `defuddle.js` in devtools and confirm Readability still renders.
- [ ] **Step 6: Commit** `feat(web): serve Defuddle at /app/defuddle.js and load it on first reader extraction`. Open PR 1 (Tasks 1–3), following the repo's shipping rules.

### Task 4: iOS extractor, Defuddle first with Readability fallback

**Files:**
- Modify: `ios/PigeonReader/project.yml` (add `PigeonReader/Resources/Defuddle.js` under `resources`, next to `Readability.js`)
- Modify: `ios/PigeonReader/PigeonReader/Core/ReaderViewExtractor.swift` (`extract(html:title:baseURL:)`, `extractionScript`, new `defuddleSource()`)
- Modify: `ios/PigeonReader/PigeonReader/Core/ReaderViewDocument.swift`
- Modify: `ios/PigeonReader/PigeonReader/Core/StructuredHTMLJavaScript.swift` (allowlist `data-lang`; keep `#fragment` hrefs)
- Create: `ios/PigeonReader/PigeonReader/Core/ReaderPublishedDate.swift`
- Test: `PigeonReaderTests/Core/ReaderViewExtractorTests.swift`, `ReaderViewDocumentTests.swift`, new `ReaderPublishedDateTests.swift`; fixtures copied from `test/fixtures/reader/` into the test bundle

**Interfaces:**
- Consumes: the `Defuddle.js` resource (Task 1); the same fixtures as Task 2.
- Produces: `ReaderViewDocument` gains:
  - `wordCount: Int?`
  - `publishedAt: Date?`
  - `siteName: String?`
  - `extractor: ReaderViewExtractorKind` (`enum ReaderViewExtractorKind: String, Sendable { case defuddle, readability }`)

  All have defaults, so existing initializers compile unchanged. `init(payload:)` reads the keys `wordCount`, `published`, `site` and `extractor`.
- Produces: `enum ReaderPublishedDate { static func normalize(_ value: String?, now: Date = .now) -> Date? }`, with the same rules as the web `normalizePublishedDate`.

- [ ] **Step 1: Write the failing tests.**
  - `ReaderPublishedDateTests`: the same cases and expected instants as Task 2, Step 1.
  - `ReaderViewExtractorTests`:
    - `defuddleIsPreferredAndReturnsMetadata` (`essay-footnotes.html`): `extractor == .defuddle`, `wordCount > 300`, `siteName == "Example Essays"`, `byline == "Ada Reader"`, `publishedAt` is 2025-04-02 UTC.
    - `footnoteLinksStayInPage`: `contentHTML` contains `href="#fn:1"`.
    - `fallsBackToReadabilityWhenDefuddleReturnsThinContent` (`thin-script-page.html`): `extractor == .readability`, or `ReaderViewError.extractionFailed` if both fail.
    - `fallsBackWhenDefuddleResourceMissing`: inject a `defuddleSourceProvider` that returns `nil`; expect `extractor == .readability`.
- [ ] **Step 2: Run** `xcodegen generate`, then the iOS fast loop with `-only-testing:PigeonReaderTests/ReaderViewExtractorTests -only-testing:PigeonReaderTests/ReaderPublishedDateTests`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Init:** add `defuddleSourceProvider: @MainActor () -> String? = ReaderViewExtractor.bundledDefuddleSource` to `init`, for testability.
  - **Script loading:** evaluate the Defuddle source, then `window.__PigeonDefuddle = Defuddle;`. If the provider returns `nil` or evaluation throws, skip that step.
  - **`extractionScript`:** after `__pigeonPrepareSource`:
    1. Try `new window.__PigeonDefuddle(working, { url: baseURL }).parse()`, with the same 80-character text threshold and try/catch as web.
    2. Otherwise run the existing Readability path, then its existing `article/main` fallback.
    3. Add `wordCount`, `published` (raw string), `site` and `extractor` to the returned object.

    Use the Task 1 spike outcome if `working` needs a `defaultView`.
  - **Swift side:** normalize `published` with `ReaderPublishedDate.normalize` when building `ReaderViewDocument`.
  - **`StructuredHTMLJavaScript`:** keep `#…` hrefs untouched and add `data-lang` to `allowedAttributes`.
- [ ] **Step 4: Run** the same tests. Expected: PASS. Then run the full `PigeonReaderTests`. Expected: PASS.
- [ ] **Step 5: Verify manually** on the `Pigeon Claude` simulator. Open 5 RSS articles in Reader view:
  - text renders;
  - footnote links scroll within the article;
  - nothing new appears in `log stream --predicate 'process == "PigeonReader"' --level error` during extraction.
- [ ] **Step 6: Commit** `feat(ios): extract reader view with Defuddle, fall back to Readability`. Open PR 2, following the repo's shipping rules.

---

## Not in this plan (later plans)

- **Storing metadata** (`word_count`, `published_at`, …) and reading-length labels: plan 2, schema v16.
- **Reader polish:** footnote popovers, code copy button, a title/author/date/site header block. Defuddle's standardized markup from this plan is what they build on. A short follow-up plan after plan 3.
- **YouTube via Defuddle's extractor** (`media_kind`, duration, transcript): plans 3 and 5. iOS reader mode stays disabled for YouTube URLs, as today.
