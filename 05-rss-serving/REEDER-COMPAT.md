# Reeder Classic Compatibility

## Reeder Classic Behavior

### Feed Discovery
- Reeder accepts direct feed URLs
- Supports both RSS 2.0 and Atom 1.0
- Auto-detects feed format from Content-Type and XML structure
- Supports OPML import for bulk subscription

### Polling
- Default poll interval: ~15-30 minutes (user configurable)
- Sends `If-None-Match` and `If-Modified-Since` headers for conditional GET
- Respects `Cache-Control` headers
- Handles 304 Not Modified correctly

### Content Rendering
- Renders full HTML content from `<content:encoded>` (RSS) or `<content type="html">` (Atom)
- Loads external images (newsletter images will display)
- Supports CSS in HTML content
- Does NOT execute JavaScript
- Has a built-in "Reader" mode that strips HTML for cleaner reading

### What Works Well
- Atom `<content type="html">` with CDATA-wrapped HTML
- Absolute image URLs (standard in newsletters)
- UTF-8 content
- `<published>` dates for sort order
- Unique `<id>` per entry (we use `urn:uuid:`)

### Known Quirks
- Reeder deduplicates by `<id>` — if you change the id scheme, old items may re-appear
- Very long content may be truncated in the list view (full content visible when opened)
- Inline CSS `<style>` blocks are applied — some newsletter styles may look off
- Feed title comes from `<title>` — keep it descriptive

## Recommended Atom Structure for Reeder

```xml
<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Newsletter Name</title>
  <link href="https://feeds.domain.com/feed/key" rel="self" type="application/atom+xml"/>
  <id>https://feeds.domain.com/feed/key</id>
  <updated>2024-01-15T12:00:00Z</updated>
  
  <entry>
    <title>Issue Subject Line</title>
    <id>urn:uuid:unique-id-here</id>
    <updated>2024-01-15T12:00:00Z</updated>
    <published>2024-01-15T12:00:00Z</published>
    <author><name>Author Name</name></author>
    <content type="html"><![CDATA[
      <html>Full newsletter HTML here</html>
    ]]></content>
  </entry>
</feed>
```

## OPML Import

Reeder supports OPML import. Generate at `/feeds/opml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>Pigeon Feeds</title>
    <dateCreated>2024-01-15T12:00:00Z</dateCreated>
  </head>
  <body>
    <outline text="Newsletters" title="Newsletters">
      <outline type="rss"
        text="Morning Brew"
        title="Morning Brew"
        xmlUrl="https://feeds.domain.com/feed/mb.morningbrew.com"
        htmlUrl="https://feeds.domain.com"/>
      <!-- more outlines -->
    </outline>
  </body>
</opml>
```

Reeder imports this as a folder of subscriptions. One-click setup for all 30 newsletters.

## Testing with Reeder

1. Deploy Pigeon
2. Send a test email to `rss@yourdomain.com`
3. Wait for it to process (~seconds)
4. In Reeder: Add subscription → paste `https://feeds.yourdomain.com/feed/<feed_key>`
5. Reeder should show the feed with the test item
6. Verify: images load, HTML renders, title and date are correct
