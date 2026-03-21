# Browser Reader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a private browser-based reader at `/app` with a login screen, read-only feed browsing, article viewing, and a Settings status panel backed by the existing Worker and D1 data.

**Architecture:** Keep the Worker as a single deployable service. Add one HTML app shell route and one private status JSON route, then reuse the existing Google Reader compatible API for subscriptions, unread counts, item ids, and item contents. Use plain HTML, CSS, and JavaScript served directly by the Worker, with raw article HTML rendered only inside a locked-down sandboxed iframe.

**Tech Stack:** Cloudflare Workers, TypeScript, D1, existing GReader-compatible endpoints, Node test runner via `tsx --test`

---

## File Map

- Create: `src/browser-app.ts`
  - Serves the browser app shell and any inline CSS/JS helpers.
- Create: `src/browser-app-client.ts`
  - Holds pure browser-reader helper logic that can be tested without a DOM harness.
- Create: `src/status.ts`
  - Authenticates `/app/status` and returns aggregate JSON status.
- Create: `test/browser-app.test.ts`
  - Covers `/app` and `/app/status` route behavior plus status aggregation.
- Create: `test/browser-app-client.test.ts`
  - Covers auth parsing, feed sorting, paging, chunking, and preview selection logic.
- Modify: `src/index.ts`
  - Adds `/app` and `/app/status` routes.
- Modify: `docs/superpowers/specs/2026-03-20-browser-reader-design.md`
  - Only if implementation forces a small spec clarification.

Keep the existing untracked `README.md` untouched during this work.

### Task 1: Add App Routes And Route Tests

**Files:**
- Create: `test/browser-app.test.ts`
- Create: `src/browser-app.ts`
- Create: `src/status.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Write the failing route tests**

Add tests covering:

- `GET /app` returns `200`
- `GET /app` returns `Content-Type: text/html`
- the HTML contains an app root marker such as `id="app"`
- `GET /app/status` returns `401` without auth

- [ ] **Step 2: Run the targeted tests and verify they fail**

Run:

```bash
npm test -- test/browser-app.test.ts
```

Expected:

- route tests fail because `/app` and `/app/status` do not exist yet

- [ ] **Step 3: Implement the minimal routes**

Add:

- `renderBrowserAppHtml(baseUrl: string): string` in `src/browser-app.ts`
- `handleStatusRequest(request: Request, env: Env): Promise<Response>` in `src/status.ts`
- route wiring in `src/index.ts`

Minimal behavior for this step:

- `/app` serves HTML shell
- `/app/status` enforces existing auth and returns placeholder JSON

- [ ] **Step 4: Run the targeted tests and verify they pass**

Run:

```bash
npm test -- test/browser-app.test.ts
```

Expected:

- all route tests pass

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/browser-app.ts src/status.ts test/browser-app.test.ts
git commit -m "feat: add browser app routes"
```

### Task 2: Add Status Aggregation

**Files:**
- Modify: `test/browser-app.test.ts`
- Modify: `src/status.ts`

- [ ] **Step 1: Write failing status tests**

Add tests for authenticated `GET /app/status` using a fake D1 layer. Cover:

- configured `BASE_URL`
- current origin derived from request URL
- schema version
- active feed counts
- email feed count and RSS feed count
- total items, unread items, starred items
- newest timestamps
- RSS fetch attempt timestamp
- failing RSS feed count
- failing feed summaries

- [ ] **Step 2: Run the targeted tests and verify they fail**

Run:

```bash
npm test -- test/browser-app.test.ts
```

Expected:

- status tests fail because the placeholder response is incomplete

- [ ] **Step 3: Implement the aggregation queries**

In `src/status.ts`, build the response from `_meta`, `feeds`, and `items` using focused queries. Return JSON shaped for the browser app rather than mirroring raw SQL rows.

- [ ] **Step 4: Run the targeted tests and verify they pass**

Run:

```bash
npm test -- test/browser-app.test.ts
```

Expected:

- all status tests pass

- [ ] **Step 5: Commit**

```bash
git add src/status.ts test/browser-app.test.ts
git commit -m "feat: add browser app status endpoint"
```

### Task 3: Build The Browser App Shell

**Files:**
- Modify: `test/browser-app.test.ts`
- Create: `test/browser-app-client.test.ts`
- Modify: `src/browser-app.ts`
- Create: `src/browser-app-client.ts`

- [ ] **Step 1: Write failing shell tests**

Add tests that assert the HTML shell includes:

- login form marker
- logout button marker
- feeds panel marker
- articles panel marker
- reader panel marker
- settings/status panel marker
- a client config payload containing `baseUrl`

Add pure helper tests covering:

- parsing a successful `ClientLogin` response into the auth token
- rejecting malformed `ClientLogin` responses
- clearing auth state on logout
- returning to login state when a `401` is encountered

- [ ] **Step 2: Run the targeted tests and verify they fail**

Run:

```bash
npm test -- test/browser-app.test.ts
```

Expected:

- shell tests fail because the HTML shell is still skeletal

- [ ] **Step 3: Implement the HTML/CSS/JS shell**

In `src/browser-app.ts`:

- render the login screen
- include the main three-pane layout
- include a Settings drawer or panel
- include inline CSS sized for desktop and mobile
- include client-side JavaScript that:
  - logs in via `POST /accounts/ClientLogin`
  - stores the token in `sessionStorage`
  - logs out by clearing `sessionStorage`
  - resets to login on `401`

Keep all app chrome rendered as plain text content. Do not render article HTML in the app shell.

In `src/browser-app-client.ts`:

- add pure helpers for auth token parsing and auth-state transitions so the privacy-critical flow is testable without a browser harness

- [ ] **Step 4: Run the targeted tests and verify they pass**

Run:

```bash
npm test -- test/browser-app.test.ts
```

Expected:

- all shell tests pass

- [ ] **Step 5: Commit**

```bash
git add src/browser-app.ts src/browser-app-client.ts test/browser-app.test.ts test/browser-app-client.test.ts
git commit -m "feat: add browser reader shell"
```

### Task 4: Wire Feed Loading, Article Loading, And Reader Isolation

**Files:**
- Modify: `src/browser-app.ts`
- Modify: `src/browser-app-client.ts`
- Modify: `test/browser-app.test.ts`
- Modify: `test/browser-app-client.test.ts`

- [ ] **Step 1: Write failing behavior tests for browser reader helpers**

Add pure helper tests covering:

- sorting subscriptions alphabetically by title
- building the `All items`, `Unread`, and single-feed views
- limiting initial id fetches to 50
- selecting content loads in chunks of 20
- not duplicating already loaded content ids
- rendering list previews only from content that has already been loaded

Keep one light shell-contract test in `test/browser-app.test.ts` for:

- script references the reused API routes
- iframe rendering uses `srcdoc`
- iframe uses `sandbox=""`

- [ ] **Step 2: Run the targeted tests and verify they fail**

Run:

```bash
npm test -- test/browser-app.test.ts
```

Expected:

- helper and shell-contract tests fail because the reader logic does not exist yet

- [ ] **Step 3: Implement the browser reader logic**

In `src/browser-app.ts`, add client-side behavior that:

- loads subscriptions and unread counts after login
- sorts feeds alphabetically by title
- supports `All items`, `Unread`, and individual feed views
- fetches at most 50 ids initially for the active view
- fetches item contents in chunks of 20
- uses loaded contents to render article previews
- loads full article content into a sandboxed iframe with `sandbox=""`
- loads status JSON for the Settings view

In `src/browser-app-client.ts`, add pure helpers that the inline script calls for:

- auth parsing and invalidation
- feed sorting
- view selection
- incremental id paging
- content chunk selection
- preview extraction from loaded items

V1 remains read-only:

- do not call mark-read or star routes
- do not expose feed-management actions

- [ ] **Step 4: Run the targeted tests and verify they pass**

Run:

```bash
npm test -- test/browser-app.test.ts test/browser-app-client.test.ts
```

Expected:

- all browser app helper and shell-contract tests pass

- [ ] **Step 5: Run the full suite**

Run:

```bash
npm test
npm exec tsc --noEmit
```

Expected:

- tests pass
- typecheck passes

- [ ] **Step 6: Commit**

```bash
git add src/browser-app.ts src/browser-app-client.ts test/browser-app.test.ts test/browser-app-client.test.ts
git commit -m "feat: add browser reader experience"
```

### Task 5: Final Verification And Cleanup

**Files:**
- Modify: `docs/superpowers/specs/2026-03-20-browser-reader-design.md` only if implementation exposed a mismatch

- [ ] **Step 1: Re-read the spec and confirm the implementation matches it**

Checklist:

- private login
- read-only browser UI
- settings status panel
- no schema migration
- no frontend framework
- iframe isolation rules

- [ ] **Step 2: Run final verification**

Run:

```bash
npm test
npm exec tsc --noEmit
```

If practical, also run:

```bash
npx wrangler dev
```

Then manually check:

- `/app`
- login flow
- bad password rejection
- logout
- forced `401` recovery back to login if practical
- feeds list
- article list
- article reader
- settings status panel
- desktop width layout
- narrow mobile-sized viewport layout

- [ ] **Step 3: Commit any final spec or polish changes**

```bash
git add src/index.ts src/browser-app.ts src/status.ts test/browser-app.test.ts docs/superpowers/specs/2026-03-20-browser-reader-design.md
git commit -m "chore: finalize browser reader implementation"
```
