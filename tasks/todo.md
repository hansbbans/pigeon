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
