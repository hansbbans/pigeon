# Pigeon

Pigeon is a Cloudflare Worker that turns incoming newsletter emails and external RSS feeds into reader-friendly Atom feeds.

This file is the current practical guide for how the app works and how to ship updates. It reflects the intended production setup for the next Cloudflare deploy.

## Target Production Setup

- Public app URL: `https://pigeon.hanscho.com`
- Health check: `https://pigeon.hanscho.com/health`
- Feed list: `https://pigeon.hanscho.com/feeds`
- OPML export: `https://pigeon.hanscho.com/feeds/opml`
- Incoming newsletter address: `rss@hanscho.com`
- Worker name: `pigeon`
- D1 database: `pigeon-db`
- Cron schedule: every hour (`0 * * * *`)

Important: `BASE_URL` must always match the real public URL of the app. For production, that should be the custom domain above. If this value points somewhere else, the app still runs, but it generates broken feed links.

## How The App Works

Pigeon is one Worker with three jobs:

1. Receive newsletter emails.
2. Store newsletters and RSS items in D1.
3. Serve those stored items back out as Atom feeds and a Google Reader style API.

### 1. Email Ingestion

Cloudflare Email Routing sends mail for `rss@hanscho.com` into the Worker's `email()` handler.

The email handler:

- parses the raw email with `postal-mime`
- detects forwarded mail from the trusted forwarder
- figures out which feed the message belongs to
- applies any feed routing overrides
- stores the feed and item in D1

Main files:

- `src/email-handler.ts`
- `src/normalize.ts`
- `src/routing-rules.ts`

### 2. RSS Subscription And Refresh

Pigeon also supports normal RSS and Atom feeds.

Those feeds can be added through:

- `POST /feeds/subscribe`
- the Google Reader compatible quick-add endpoints used by Reeder and similar apps

Subscribed RSS feeds are stored in the same `feeds` table as email-based feeds, but marked as `source_type = 'rss'`.

Every hour, the Worker's `scheduled()` handler:

- finds RSS feeds that are due for refresh
- fetches them with conditional requests when possible
- parses the response
- deduplicates items
- updates feed metadata like counts, fetch timestamps, and last item time

Main files:

- `src/subscribe.ts`
- `src/rss-fetcher.ts`
- `src/rss-parser.ts`
- `src/cron-handler.ts`

### 3. Feed Serving

The `fetch()` handler serves multiple kinds of output:

- `/health` returns `ok`
- `/feeds` returns a JSON list of feeds
- `/feeds/opml` returns an OPML export
- `/feed/:feed_key` returns an Atom feed
- `/accounts/ClientLogin` and `/reader/api/0/*` provide a Google Reader style API
- `/api/greader.php/*` supports FreshRSS and Reeder style paths

Feed endpoints are public. The subscription and Google Reader style management endpoints use `API_PASSWORD`.

Main files:

- `src/index.ts`
- `src/feed.ts`
- `src/opml.ts`
- `src/greader.ts`
- `src/api-auth.ts`

### 4. Reader clients

Pigeon includes two authenticated Reader clients backed by the Google Reader style API:

- `/app` is the browser Reader. It supports Today, unread filtering, folders, feeds, keyboard navigation, article triage, and Mark All Read for a selected feed or folder.
- `ios/PigeonReader` is the native iOS Reader. It supports the same navigation hierarchy, long-press multi-folder feed organization, leading-edge swipe back to the feed, boundary-swipe article navigation, configurable external-keyboard next/previous shortcuts, bounded folder/feed/Today loading with Load More, unread counts, bulk Mark Above/Below triage, and direct Readwise saves.

The native client stores the optional Readwise access token in the iOS Keychain. It only sends the exact validated article URL to Readwise and treats HTTP 200 and 201 as successful saves.

The browser client and native client both use the authenticated `/reader/api/0/*` endpoints; the browser Mark All Read action uses `/reader/api/0/mark-all-as-read`.

Native local checks, from `ios/PigeonReader`, are:

```bash
xcodegen generate
xcodebuild test -project PigeonReader.xcodeproj -scheme PigeonReader -destination 'platform=iOS Simulator,name=iPhone 17 Pro' CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO
xcodebuild build -project PigeonReader.xcodeproj -scheme PigeonReader -configuration Release -destination 'platform=iOS Simulator,name=iPhone 17 Pro' CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO
```

### 5. Database

The app stores feed metadata in `feeds` and content items in `items`.

Current schema version: `12`

Schema files:

- `04-storage/SCHEMA.sql`
- `04-storage/SCHEMA-V2.sql`
- `04-storage/SCHEMA-V3.sql`
- `04-storage/SCHEMA-V4.sql`
- `04-storage/SCHEMA-V5.sql`
- `src/migrations.ts` (the existing-database upgrade path)

Version `2` added RSS subscription support. Version `3` added feed icons. Version `4` added per-item original URLs so reader apps can open source posts. Version `5` added `feeds.site_url` so feed homepages stay separate from feed URLs.

Current deployments automatically apply pending migration work on the first database-backed request after a deployment. The legacy `SCHEMA-V2.sql` through `SCHEMA-V5.sql` commands below are recovery-only for databases that missed prior upgrades, not the normal current path.

## Runtime Settings

Current required runtime values:

- `API_PASSWORD` as a Cloudflare secret
- `BASE_URL`
- `ITEMS_PER_FEED`
- `TRUSTED_FORWARDER`

These are defined in:

- `wrangler.toml`
- Cloudflare Worker settings in the dashboard

If you change a variable in the dashboard, commit the same change in `wrangler.toml` so the repo stays aligned with production.

## Deploying Code Updates

This is the normal update flow when you change the app.

### 1. Make the code change

Edit the code in this repo and keep `wrangler.toml` aligned with the intended production setup.

### 2. Run local checks

From the repo root:

```bash
npm test
npm exec tsc --noEmit
```

### 3. Log into Cloudflare if needed

If Wrangler is not authenticated in your shell:

```bash
npx wrangler login
```

If you are deploying from a non-interactive environment, use a `CLOUDFLARE_API_TOKEN` instead.

### 4. Check whether the remote database needs a migration

Inspect the remote schema:

```bash
npx wrangler d1 execute pigeon-db --remote --command "SELECT value FROM _meta WHERE key = 'schema_version';"
npx wrangler d1 execute pigeon-db --remote --command "SELECT name FROM pragma_table_info('feeds') ORDER BY cid;"
```

For an existing database that missed a prior automatic upgrade:

- if `source_type` is missing, run `04-storage/SCHEMA-V2.sql`
- if `icon_url` is missing, run `04-storage/SCHEMA-V3.sql`
- if `original_url` is missing from `items`, run `04-storage/SCHEMA-V4.sql`
- if `site_url` is missing from `feeds`, run `04-storage/SCHEMA-V5.sql`

Commands:

```bash
npx wrangler d1 execute pigeon-db --remote --file=./04-storage/SCHEMA-V2.sql
npx wrangler d1 execute pigeon-db --remote --file=./04-storage/SCHEMA-V3.sql
npx wrangler d1 execute pigeon-db --remote --file=./04-storage/SCHEMA-V4.sql
npx wrangler d1 execute pigeon-db --remote --file=./04-storage/SCHEMA-V5.sql
```

Do not run `SCHEMA.sql` on top of an older live database unless you are initializing a brand-new database.

### 5. Deploy the Worker

```bash
npx wrangler deploy
```

That updates the existing `pigeon` Worker.

For the first deploy that attaches `pigeon.hanscho.com`, keep these Cloudflare-side checks in mind:

1. `wrangler.toml` already declares the custom domain route.
2. The `pigeon.hanscho.com` hostname must not already have a conflicting DNS record in Cloudflare. Cloudflare's custom-domain flow refuses hostnames with an existing CNAME record.
3. Email Routing for `rss@hanscho.com` stays separate from the HTTP custom domain and does not need to change unless the Worker binding itself was never connected.

### 6. Verify production immediately after deploy

Check the public endpoints:

```bash
curl https://pigeon.hanscho.com/health
curl https://pigeon.hanscho.com/feeds
```

Watch logs if needed:

```bash
npx wrangler tail pigeon
```

If the deploy touched email handling, send a real test email to `rss@hanscho.com`.

If the deploy touched RSS fetching, wait for the next hourly cron or trigger the logic manually by testing the relevant code path before relying on production.

## Deploying Setting Changes Only

If the code is already live and you only need to change runtime values such as `BASE_URL`:

1. Update the value in the Cloudflare dashboard.
2. Confirm the live output changed.
3. Mirror the same change in `wrangler.toml`.
4. Commit that repo change.

If you are changing the public hostname itself, commit the `wrangler.toml` route change and deploy the Worker. A dashboard-only variable edit is not enough for the first custom-domain attachment.

## Common Gotchas

- `BASE_URL` drift breaks feed links even when the Worker itself is healthy.
- Email routing is configured in the Cloudflare dashboard, not just in `wrangler.toml`.
- The Worker can be healthy on `workers.dev` even if your custom domain is missing or misconfigured.
- Custom domain creation can fail if `pigeon.hanscho.com` already has a conflicting DNS record in Cloudflare.
- Direct deploys from this repo require Wrangler auth in the current shell.
- D1 rows have size limits, so large message bodies may be trimmed before storage.

## Useful Files

- `wrangler.toml`: Worker name, D1 binding, vars, cron
- `src/index.ts`: request routing, email entrypoint, cron entrypoint
- `src/email-handler.ts`: newsletter ingestion
- `src/subscribe.ts`: external RSS subscription endpoint
- `src/rss-fetcher.ts`: hourly RSS refresh logic
- `src/greader.ts`: reader-compatible API
- `src/browser-app.ts`: authenticated browser Reader shell and client
- `ios/PigeonReader/project.yml`: authoritative native iOS project definition
- `ios/PigeonReader/PigeonReader/`: native Reader app
- `04-storage/SCHEMA.sql`: current schema
- `09-deployment/DEPLOYMENT.md`: older deployment notes

## Canonical Public URL

After the custom domain deploy succeeds, the correct public base URL is:

`https://pigeon.hanscho.com`
