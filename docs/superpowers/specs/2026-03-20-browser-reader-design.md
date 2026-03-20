# Browser Reader Design

Date: 2026-03-20

## Goal

Add a private browser-based reading experience to Pigeon so feeds can be read directly in a web browser, with a Settings area that includes operational status.

The first version should be small, coherent, and low-risk:

- private, password-protected
- read-only for feed management
- no database migration
- built with plain HTML, CSS, and JavaScript served by the Worker
- reuse existing API behavior wherever possible

## What This Solves

Today Pigeon is useful as a backend for feed readers, but it has no built-in browser reading interface. It also has no single operator page that shows the app's health and current state.

This feature adds:

- a browser UI for browsing feeds and reading articles
- a password-based login flow for the browser
- a Settings panel with status information

## Non-Goals For V1

The first version will not include:

- feed subscription management from the browser
- renaming feeds or editing categories
- routing rule management
- starring from the browser
- OPML import or export from the browser UI
- a frontend framework or build step
- exact heartbeat tracking for email handler runs or cron runs

## Recommended UX

### Entry Point

Add a private app route:

- `GET /app`

If the user is not authenticated in the browser app, show a simple password screen.

After login, show the main reader UI.

### Main Layout

Use a three-column layout on desktop:

1. Feed list
2. Article list
3. Article reader

Use a stacked or sliding layout on small screens so the app remains usable on mobile.

### Feed List

Show:

- feed title
- optional favicon
- unread count

Support:

- selecting a feed
- showing an "All items" view
- showing an "Unread" view

Feed order in V1 should be alphabetical by title on the client side. The reused subscription endpoint does not provide a dependable display order, so the browser UI should not depend on database row order.

### Article List

Show:

- article title
- short preview text
- feed title
- timestamp

Selecting an article loads its full content in the reader pane.

In V1, the browser app is a passive viewer. Opening an article does not mark it read, star it, or otherwise change server-side state.

### Reader Pane

Show:

- article title
- source/feed name
- timestamp
- full stored article content

Because stored content is raw newsletter or feed HTML, render the full article in an isolated container. The safest default is a sandboxed iframe using `srcdoc`, so newsletter styles do not break the surrounding app layout.

### Settings And Status

Add a Settings view or drawer inside the app.

The Settings area should include a Status section showing:

- configured `BASE_URL`
- current app origin
- health endpoint URL for the current app origin
- schema version
- total active feeds
- email feed count
- RSS feed count
- total items
- unread item count
- starred item count
- newest item timestamp
- newest email item timestamp
- newest RSS item timestamp
- most recent RSS fetch attempt timestamp
- count of RSS feeds with current fetch errors
- short list of failing RSS feeds with their last error

## Authentication Design

Reuse the existing password and token flow instead of inventing a separate browser auth system.

### Login Flow

The browser app submits the password to:

- `POST /accounts/ClientLogin`

The response already returns the token in the format this app understands.

The browser app stores that token in `sessionStorage`.

All authenticated browser requests send:

- `Authorization: GoogleLogin auth=pigeon/<token>`

The browser app should also provide:

- a logout action that clears `sessionStorage`
- automatic recovery on `401` responses by clearing the stored token and returning to the login screen

### Why This Approach

- reuses the existing auth path
- no new secret or cookie system
- no database change
- easy to invalidate by rotating `API_PASSWORD`

## Route Plan

### New Routes

- `GET /app`
  - serves the browser UI shell
- `GET /app/status`
  - returns private JSON status for the Settings page

Optional asset split if inline assets become too large:

- `GET /app.js`
- `GET /app.css`

### Existing Routes Reused

- `POST /accounts/ClientLogin`
- `GET /reader/api/0/subscription/list`
- `GET /reader/api/0/unread-count`
- `GET or POST /reader/api/0/stream/items/ids`
- `POST /reader/api/0/stream/items/contents`

### Routes Not Used In V1 UI

These existing write routes can remain in place for external clients, but the browser UI does not need to expose them in the first version:

- `POST /reader/api/0/edit-tag`
- `POST /reader/api/0/mark-all-as-read`
- `POST /feeds/subscribe`

## Data Design

No schema migration is required for the first version.

The app can build the reader and status views from existing data:

- `feeds`
- `items`
- `_meta`

### Reader Data

Feed list:

- `subscription/list`
- `unread-count`

Article list:

- `stream/items/ids`
- `stream/items/contents`

Status:

- aggregate queries against `feeds`, `items`, and `_meta`

### Status Caveats

The system does not currently store exact heartbeat records for:

- last successful cron run
- last successful email handler run

So V1 status should use the best existing signals instead:

- newest `last_fetched_at` for RSS fetch attempts
- newest email-backed item timestamp for email activity

If exact operator heartbeat is needed later, that should be a separate follow-up with explicit run tracking.

## Implementation Shape

### Server-Side

Add a new module to render the browser app shell:

- `src/browser-app.ts`

Responsibilities:

- return HTML for `/app`
- include app shell markup
- include inline or linked CSS and JS

Add a new module for status:

- `src/status.ts`

Responsibilities:

- authenticate requests using the existing auth helper
- run aggregate D1 queries
- return JSON for the Settings status view

Update:

- `src/index.ts`

Responsibilities:

- route `/app`
- route `/app/status`

### Client-Side

Keep the browser app simple and framework-free.

The client script should:

- render a login screen
- submit password to `ClientLogin`
- store the token in `sessionStorage`
- load subscriptions and unread counts
- sort feeds alphabetically by title in the browser
- load article ids for the selected view
- fetch article contents in chunks instead of pulling everything at once
- render the article list and article content
- load the status JSON for Settings

### Loading Rules

To keep the first version low-risk and responsive:

- fetch at most 50 item ids for the current view on initial load
- fetch full contents for the first 20 visible items
- fetch more item contents in chunks of 20 as the user scrolls or selects an unloaded item
- render list previews only from content that has already been loaded

This avoids loading a large number of full article bodies for the "All items" view up front.

## Security And Safety

### App Privacy

The browser app should be private. Both `/app` data loading and `/app/status` should require the existing auth token.

The initial HTML shell can be public or private. Recommended behavior:

- return the shell publicly
- require authentication before loading any feed or status data

This keeps the route simple while protecting all sensitive content.

### Content Isolation

Stored article HTML can include:

- remote images
- newsletter CSS
- layout-breaking markup

For V1, full article rendering should be isolated from the app shell. A sandboxed iframe is the safest default.

Required rules for V1:

- render article HTML only inside an iframe with a restrictive sandbox and no script permissions
- do not grant `allow-same-origin`
- render feed titles, timestamps, previews, and other app chrome with text insertion, not raw HTML insertion

V1 will not rewrite article HTML to remove remote images or tracking pixels. That is an accepted limitation for the first version and should be documented in implementation notes.

### Token Storage

Use `sessionStorage`, not `localStorage`, for the first version. It is simpler and reduces long-lived token persistence in the browser.

## Testing Plan

Add tests for:

- `/app` route shell response
- `/app/status` auth behavior
- `/app/status` aggregate output
- login flow helper behavior if extracted
- browser app rendering helpers if server-rendered pieces are split into functions

Keep current API tests in place and reuse them where possible.

Manual verification for the eventual implementation should include:

- login with valid password
- login rejection with bad password
- load feed list
- open a feed
- open an article
- verify article HTML is readable and does not break app layout
- open Settings and verify status numbers render
- test on desktop and mobile widths

## Risks

### No Frontend Stack Exists Today

This repo does not currently have a browser frontend setup. Adding React or another framework would create a much larger project change than this feature needs.

Plain HTML, CSS, and JavaScript is the correct first step.

### Existing Reader API Is Not Browser-Optimized

The current reader-compatible API is usable, but article list loading is two-step:

1. request item ids
2. request item contents

That is acceptable for V1 as long as the browser only loads item contents in small chunks. If performance becomes a problem later, add a dedicated browser endpoint rather than overloading the current compatibility surface.

### Status Is Operationally Useful But Not Perfect

The status page can report good operational signals from current data, but it cannot yet distinguish:

- cron ran but found nothing
- cron failed before updating any feed
- email arrived but failed before storage

That is acceptable for V1.

## Future Follow-Ups

After the first version is live, likely next improvements are:

- browser actions for mark read and star
- feed subscription management in Settings
- dedicated mobile navigation
- exact operator heartbeat tracking
- custom domain support for the browser app
- a cleaner browser-focused API for lists and article retrieval

## Proposed File Changes

- `src/index.ts`
- `src/browser-app.ts`
- `src/status.ts`
- new tests for app routes and status behavior

No database files need to change for V1.
