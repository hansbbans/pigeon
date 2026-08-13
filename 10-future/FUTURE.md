# Future Roadmap

## Delivered Reader surfaces

The authenticated browser Reader at `/app` and the native iOS Reader now provide the core navigation and triage surface: Today, folders, feeds, unread counts, article reading, keyboard navigation, bulk read actions, and browser Mark All Read for a selected feed or folder. The native client also supports direct Readwise saves with Keychain-backed token storage.

## Phase 6: Reader surface follow-ups
- Reader list-view and visual-design refinements
- Feed list with enable/disable toggles
- Item browser with HTML preview
- Custom rule editor with live preview
- Feed title customization
- **Build with:** Claude Code + frontend-design skill

## Phase 7: Smart Content Processing
- Readability extraction mode (Mozilla Readability port for Workers)
- Auto-detect and strip common newsletter boilerplate (footers, share buttons, referral blocks)
- Image proxy via R2 (for newsletters that expire image URLs)
- Link shortener unwrapping

## Phase 8: Notifications & Webhooks
- Webhook on new item (POST to URL with feed_key, subject, link)
- Integration with Slack, Discord, Telegram
- Daily digest email (ironic but useful for aggregation)

## Phase 9: Multi-User
- Auth system (Cloudflare Access or simple API keys)
- Per-user email addresses (`user1-rss@domain.com`)
- Isolated feeds per user
- Shared rule templates

## Phase 10: Search
- Full-text search across all stored newsletters
- D1 FTS5 extension (if available) or external search service
- Search API endpoint
- Search UI in management interface

## Ideas Parking Lot
- Newsletter discovery: "Popular newsletters other Pigeon users subscribe to"
- AI summarization: Use Claude API to generate a 2-sentence summary per item
- Category/tag auto-assignment based on content
- Export to Notion (newsletter archive)
- Kindle delivery (convert HTML to MOBI, send via email)
- Analytics: open rates, read time estimates
- Newsletter recommendation engine
- Archive/bookmark specific issues
- Share individual items via public URL
