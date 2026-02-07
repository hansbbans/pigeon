# Deployment

## First Deploy

```bash
# 1. Login to Cloudflare
wrangler login

# 2. Create D1 database
wrangler d1 create pigeon-db
# Copy the database_id to wrangler.toml

# 3. Initialize schema on remote D1
wrangler d1 execute pigeon-db --file=./04-storage/SCHEMA.sql

# 4. Deploy Worker
wrangler deploy

# 5. Set up custom domain (in Cloudflare Dashboard)
# Workers & Pages → pigeon → Settings → Triggers → Add Custom Domain
# Enter: feeds.yourdomain.com

# 6. Configure Email Routing (in Cloudflare Dashboard)
# Email → Email Routing → Create rule
# Address: rss@yourdomain.com → Send to Worker → pigeon
```

## Subsequent Deploys

```bash
wrangler deploy
```

That's it. Wrangler handles the rest. Zero-downtime deployment.

## Environment Variables

Set secrets via wrangler (for Phase 5 auth):
```bash
wrangler secret put FEED_AUTH_TOKEN
# Enter your token when prompted
```

Non-secret vars go in `wrangler.toml` under `[vars]`.

## Monitoring

### Live Logs
```bash
wrangler tail
# Shows real-time logs from production Worker
# Filter: wrangler tail --format=json | jq 'select(.logs[].message | contains("error"))'
```

### D1 Query (Production)
```bash
# Check recent items
wrangler d1 execute pigeon-db --command "SELECT feed_key, subject, received_at FROM items ORDER BY received_at DESC LIMIT 10"

# Check feed list
wrangler d1 execute pigeon-db --command "SELECT feed_key, display_name, item_count FROM feeds ORDER BY last_item_at DESC"

# Check for errors (if you log them to a table)
wrangler d1 execute pigeon-db --command "SELECT * FROM error_log ORDER BY created_at DESC LIMIT 10"
```

### Health Check
Hit `https://feeds.yourdomain.com/health` — should return 200 "ok".

For automated monitoring, use an external uptime checker (UptimeRobot free tier) pointed at the health endpoint.

## Rollback

```bash
# List recent deployments
wrangler deployments list

# Rollback to previous version
wrangler rollback
```

## Staging Environment

Not needed for MVP. If desired later:
```toml
# wrangler.toml
[env.staging]
name = "pigeon-staging"
vars = { BASE_URL = "https://staging-feeds.yourdomain.com" }

[[env.staging.d1_databases]]
binding = "DB"
database_name = "pigeon-db-staging"
database_id = "staging-id-here"
```

Deploy staging: `wrangler deploy --env staging`
