# Cloudflare Setup Guide

## Prerequisites
- A domain name you control
- Cloudflare account (free tier)
- Node.js 18+ installed locally
- `wrangler` CLI (`npm install -g wrangler`)

## Step 1: Add Domain to Cloudflare

1. Log into Cloudflare Dashboard
2. Add Site → enter your domain
3. Select Free plan
4. Cloudflare provides two nameservers
5. Go to your domain registrar, update nameservers to Cloudflare's
6. Wait for propagation (usually 5-30 minutes)
7. Cloudflare shows domain as "Active"

## Step 2: Configure Email Routing

1. In Cloudflare Dashboard → your domain → Email → Email Routing
2. Enable Email Routing
3. Cloudflare will add the required MX and TXT records automatically:
   - MX: `route1.mx.cloudflare.net` (priority 69)
   - MX: `route2.mx.cloudflare.net` (priority 12)
   - MX: `route3.mx.cloudflare.net` (priority 37)
   - TXT: SPF record for Cloudflare
4. Under "Routing Rules" → Create a catch-all rule or a specific address rule:
   - **Option A (recommended):** Custom address `rss@yourdomain.com` → Route to Worker
   - **Option B:** Catch-all → Route to Worker
5. The Worker must be deployed first before you can select it as a destination

## Step 3: Create Wrangler Project

```bash
# Create project
wrangler init pigeon --type=javascript
cd pigeon

# Or with TypeScript (recommended)
wrangler init pigeon
# Select "Yes" for TypeScript

# Install dependencies
npm install postal-mime

# Create D1 database
wrangler d1 create pigeon-db
# Copy the database_id from the output into wrangler.toml
```

## Step 4: Configure wrangler.toml

```toml
name = "pigeon"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[[d1_databases]]
binding = "DB"
database_name = "pigeon-db"
database_id = "paste-your-id-here"

[vars]
BASE_URL = "https://feeds.yourdomain.com"
ITEMS_PER_FEED = "50"
```

## Step 5: Set Up Custom Domain for Worker

1. Cloudflare Dashboard → Workers & Pages → your worker → Settings → Triggers
2. Add Custom Domain: `feeds.yourdomain.com`
3. Cloudflare auto-provisions TLS and DNS

This means your feed URLs will be `https://feeds.yourdomain.com/feed/:feed_key`

## Step 6: Link Email Routing to Worker

1. Deploy the Worker first: `wrangler deploy`
2. Go back to Email → Email Routing → Routing Rules
3. Edit the rule for `rss@yourdomain.com`
4. Destination: "Send to Worker" → select `pigeon`
5. Save

## Step 7: Local Development

```bash
# Start local dev server (HTTP routes)
wrangler dev --local

# D1 works locally with --local flag
# Email events can be tested via Miniflare or by sending real emails after deploy
```

## Gotcha: Email Testing Locally

Cloudflare Email Routing events **cannot** be triggered locally via `wrangler dev`. You have two options:

1. **Deploy and test with real emails** — fastest for integration testing
2. **Unit test the parsing logic** — extract the email handler into a pure function that takes raw email bytes, test with saved `.eml` files locally

Recommendation: Do both. Use saved `.eml` files for rapid iteration, deploy and send real emails for integration verification.

## DNS Records Summary

After setup, your domain should have:

| Type | Name | Content | Purpose |
|------|------|---------|---------|
| MX | @ | route1.mx.cloudflare.net | Email routing |
| MX | @ | route2.mx.cloudflare.net | Email routing |
| MX | @ | route3.mx.cloudflare.net | Email routing |
| TXT | @ | v=spf1 include:_spf.mx.cloudflare.net ~all | SPF for email routing |
| CNAME | feeds | pigeon.yoursubdomain.workers.dev | Worker custom domain |
