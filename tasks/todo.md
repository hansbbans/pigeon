# Pigeon — Task Tracker

## Phase 1: Foundation

- [x] Initialize Wrangler project with TypeScript
- [x] Install `postal-mime` dependency
- [x] Create `wrangler.toml` with D1 binding placeholder + env vars
- [x] Write `src/types.ts` (Env interface)
- [x] Write `src/index.ts` (fetch + email handlers)
- [x] Verify `wrangler dev` starts and `/health` works
- [x] Git init + first commit
- [ ] **Manual: Cloudflare setup** (see below)
- [ ] **Manual: Deploy + test email** (see below)

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
_Not started_

## Phase 3: RSS Serving
_Not started_
