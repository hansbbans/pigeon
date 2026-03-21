# Browser Reader Reference Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the existing `/app` browser reader so it feels much closer to the approved Feedbin-like reference while keeping the current read-only behavior, auth flow, and data loading intact.

**Architecture:** Keep the Worker and browser reader architecture exactly as it is today. Confine the redesign to the existing shell, CSS, and client-side rendering logic in the browser reader, with only light helper additions where needed for stream-card presentation. Preserve the iframe-isolated article body and existing route/data contracts.

**Tech Stack:** Cloudflare Workers, TypeScript, inline HTML/CSS/JS, existing browser-reader runtime helpers, Node test runner via `tsx --test`

---

## File Map

- Modify: `src/browser-app.ts`
  - Rework the app shell markup, CSS, toolbar chrome, sidebar structure, stream-card rendering, reader framing, and responsive layout.
- Modify: `src/browser-app-client.ts`
  - Add only lightweight presentation helpers if needed for the redesign, such as selecting a card hero image from already-loaded article HTML.
- Modify: `test/browser-app.test.ts`
  - Update shell contract tests for the new chrome, layout markers, toolbar markers, and preserved iframe isolation.
- Modify: `test/browser-app-client.test.ts`
  - Add helper tests and runtime harness assertions for stream cards, hero-image fallback behavior, presentational toolbar controls, and redesign-specific UI state.

Keep the existing untracked `.superpowers/` directory and `README.md` untouched during this work.

### Task 1: Update Shell Contract Tests For The New Product Chrome

**Files:**
- Modify: `test/browser-app.test.ts`
- Modify: `src/browser-app.ts`

- [ ] **Step 1: Write the failing shell contract assertions**

In `test/browser-app.test.ts`, extend `GET /app returns an HTML shell` so it checks for concrete redesign markers:

- browser-style top bar marker such as `id="reader-window-bar"`
- app toolbar marker such as `id="reader-toolbar"`
- explicit sidebar section markers for real views and feeds
- updated desktop three-pane column definition closer to the reference proportions
- mobile media-query markers for the redesigned stacked layout
- preserved iframe `sandbox=""` and `srcdoc`
- a non-working control marker such as `data-presentational-control="true"` for future toolbar buttons

- [ ] **Step 2: Run the shell test and verify it fails**

Run:

```bash
npx tsx --test test/browser-app.test.ts
```

Expected:

- the `/app` shell test fails because the current browser reader does not include the new chrome markers or layout contract

- [ ] **Step 3: Implement the redesigned outer shell**

In `src/browser-app.ts`:

- replace the current warm “paper” framing with cooler product-like shell styling
- add a browser-style top bar above the reader app
- tighten the main pane seams and reduce oversized outer padding
- update the desktop grid proportions so the left rail is narrower, the stream is stronger, and the reader pane is wider
- add explicit markup hooks for:
  - real views section
  - real feeds section
  - reader toolbar
  - presentational future-action controls
- keep login, settings, and iframe isolation behavior unchanged

- [ ] **Step 4: Run the shell test and verify it passes**

Run:

```bash
npx tsx --test test/browser-app.test.ts
```

Expected:

- the `/app` contract test passes with the new shell markers in place

- [ ] **Step 5: Commit**

```bash
git add src/browser-app.ts test/browser-app.test.ts
git commit -m "feat: redesign browser reader chrome"
```

### Task 2: Restyle The Sidebar And Stream Into Feedbin-Like Navigation And Cards

**Files:**
- Modify: `src/browser-app.ts`
- Modify: `src/browser-app-client.ts`
- Modify: `test/browser-app-client.test.ts`

- [ ] **Step 1: Add failing helper and runtime tests for stream-card presentation**

In `test/browser-app-client.test.ts`, add tests covering:

- a helper that selects a usable hero image URL from already-loaded article HTML, returning `null` when none exists
- article cards rendering a hero image only when the currently loaded item content includes one
- article cards falling back to a text-first layout when no image is available
- feed list rendering that still uses only real views and feeds, with counts intact

Use the runtime harness rather than shell string matching for the card assertions.

- [ ] **Step 2: Run the browser client tests and verify they fail**

Run:

```bash
npx tsx --test test/browser-app-client.test.ts
```

Expected:

- the new helper and runtime assertions fail because the stream still renders as simple stacked buttons

- [ ] **Step 3: Implement the sidebar and stream redesign**

In `src/browser-app.ts` and `src/browser-app-client.ts`:

- restyle the left sidebar so real global views and real feeds are visually separated and easier to scan
- keep the sidebar honest to today’s functionality; do not invent reference-like fake sections
- turn article rows into stream cards with:
  - stronger title hierarchy
  - quieter source and timestamp metadata
  - clearer selected-state treatment
- add optional hero-image support using already-loaded article data only
- keep the selected article’s blue highlight stronger than the rest of the interface

If a helper is needed, keep it small and focused in `src/browser-app-client.ts`.

- [ ] **Step 4: Run the browser client tests and verify they pass**

Run:

```bash
npx tsx --test test/browser-app-client.test.ts
```

Expected:

- the new helper and runtime assertions pass

- [ ] **Step 5: Commit**

```bash
git add src/browser-app.ts src/browser-app-client.ts test/browser-app-client.test.ts
git commit -m "feat: redesign browser reader stream cards"
```

### Task 3: Polish The Reading Pane And Add Honest Reference-Like Toolbar Chrome

**Files:**
- Modify: `src/browser-app.ts`
- Modify: `test/browser-app.test.ts`
- Modify: `test/browser-app-client.test.ts`

- [ ] **Step 1: Add failing tests for reader-pane polish and optional presentational controls**

Add tests that check:

- the reader pane includes a dedicated toolbar row marker
- presentational future-action buttons are clearly marked as non-working, for example with `data-presentational-control="true"` and disabled or non-primary treatment
- the reader pane still keeps full article HTML inside the iframe only
- the runtime harness still shows the active article title and metadata outside the iframe while the iframe holds the full body

- [ ] **Step 2: Run the affected tests and verify they fail**

Run:

```bash
npx tsx --test test/browser-app.test.ts test/browser-app-client.test.ts
```

Expected:

- the new reader-pane assertions fail because the current pane is still styled like a utility panel rather than the approved reference-led reader

- [ ] **Step 3: Implement the reader-pane redesign**

In `src/browser-app.ts`:

- add a lighter reader toolbar row closer to the reference
- improve reader title size, metadata spacing, and the relationship between app chrome and article body
- make the iframe feel like part of a calmer reading surface rather than a generic embedded box
- add a short implementation note comment near the toolbar controls listing:
  - which controls are visual-only today
  - the recommended next follow-up actions from the spec

Do not add working behavior for unsupported actions in this task.

- [ ] **Step 4: Run the affected tests and verify they pass**

Run:

```bash
npx tsx --test test/browser-app.test.ts test/browser-app-client.test.ts
```

Expected:

- the reader-pane and toolbar assertions pass

- [ ] **Step 5: Commit**

```bash
git add src/browser-app.ts test/browser-app.test.ts test/browser-app-client.test.ts
git commit -m "feat: polish browser reader pane"
```

### Task 4: Finish The Responsive Pass And Verify The Redesign End To End

**Files:**
- Modify: `src/browser-app.ts`
- Modify: `test/browser-app.test.ts`

- [ ] **Step 1: Add a failing shell test for the responsive redesign contract**

In `test/browser-app.test.ts`, add assertions for the new responsive contract, such as:

- the redesign’s mobile media-query breakpoint is present
- the mobile layout collapses the three-pane grid into a stacked layout
- the settings panel remains usable in the redesigned shell

- [ ] **Step 2: Run the shell test and verify it fails**

Run:

```bash
npx tsx --test test/browser-app.test.ts
```

Expected:

- the responsive shell assertions fail because the current CSS does not yet match the redesigned contract

- [ ] **Step 3: Implement the responsive redesign**

In `src/browser-app.ts`:

- refine the mobile breakpoint and stacked layout so the app still feels related to the desktop design
- simplify toolbar density on narrow screens
- keep the reader pane readable on mobile
- ensure the settings panel still opens cleanly in the redesigned shell

- [ ] **Step 4: Run the shell test and verify it passes**

Run:

```bash
npx tsx --test test/browser-app.test.ts
```

Expected:

- the responsive shell assertions pass

- [ ] **Step 5: Run the full verification set**

Run:

```bash
npm test
npm exec tsc --noEmit
```

Then run a real browser pass:

1. Start the Worker locally with remote bindings and the existing auth flow:

```bash
npx wrangler dev --remote
```

2. Open the local `/app` URL in a browser and verify:

- login still works
- desktop three-pane layout feels substantially closer to the approved reference
- real views and feeds still load in the sidebar
- article stream cards and selection state look correct
- reader pane title, metadata, and article body framing feel more polished
- settings still opens and shows status

3. Repeat the `/app` check at a narrow mobile width and verify:

- layout stacks cleanly
- chrome remains usable
- article reading still feels readable

- [ ] **Step 6: Commit**

```bash
git add src/browser-app.ts test/browser-app.test.ts
git commit -m "feat: finish browser reader reference redesign"
```
