# Testing Strategy

## Layers

### 1. Unit Tests — Parsing Logic
Test email parsing and feed key resolution with saved `.eml` files. No Workers runtime needed.

```typescript
// test/parsing.test.ts
import { describe, it, expect } from 'vitest';
import PostalMime from 'postal-mime';
import { resolveFeedKey, normalizeFeedKey } from '../src/parsing';
import { readFileSync } from 'fs';

describe('Feed Key Resolution', () => {
  it('uses List-Id when present', async () => {
    const raw = readFileSync('./test/fixtures/substack-with-list-id.eml');
    const parser = new PostalMime();
    const email = await parser.parse(raw.buffer);
    
    const key = resolveFeedKey(email, email.from.address);
    expect(key).toBe('stratechery.substack.com');
  });
  
  it('falls back to From address', async () => {
    const raw = readFileSync('./test/fixtures/simple-newsletter.eml');
    const parser = new PostalMime();
    const email = await parser.parse(raw.buffer);
    
    const key = resolveFeedKey(email, email.from.address);
    expect(key).toBe('hello-at-newsletter.com');
  });
});
```

### 2. Unit Tests — RSS Generation
Test that generated XML is valid and contains expected elements.

```typescript
describe('Atom Feed Generation', () => {
  it('generates valid Atom XML', () => {
    const feed = { feed_key: 'test', display_name: 'Test Feed', from_email: 'test@test.com' };
    const items = [{
      id: '123',
      subject: 'Test Subject',
      html_content: '<p>Hello & goodbye</p>',
      from_name: 'Test',
      received_at: '2024-01-15T12:00:00Z',
    }];
    
    const xml = generateAtomFeed(feed, items, 'https://feeds.example.com');
    
    expect(xml).toContain('<?xml version="1.0"');
    expect(xml).toContain('<title>Test Feed</title>');
    expect(xml).toContain('Test Subject');
    expect(xml).toContain('Hello &amp; goodbye'); // or CDATA wrapped
  });
  
  it('handles special characters in CDATA', () => {
    const items = [{
      html_content: '<p>Contains ]]> end marker</p>',
      // ...
    }];
    const xml = generateAtomFeed(feed, items, baseUrl);
    // Should not break XML parsing
    expect(() => new DOMParser().parseFromString(xml, 'text/xml')).not.toThrow();
  });
});
```

### 3. Integration Tests — D1 Operations
Test with local D1 via wrangler.

```bash
# Initialize local D1 with schema
wrangler d1 execute pigeon-db --local --file=./04-storage/SCHEMA.sql

# Run integration tests that use the local D1
vitest run --config vitest.integration.config.ts
```

### 4. End-to-End Tests — Full Pipeline

**Manual E2E test checklist:**

- [ ] Send email to `rss@yourdomain.com` from a personal account
- [ ] Check `wrangler tail` for processing logs
- [ ] Verify item appears in D1: `wrangler d1 execute pigeon-db --command "SELECT feed_key, subject FROM items ORDER BY created_at DESC LIMIT 1"`
- [ ] Hit the feed URL in browser, verify valid XML
- [ ] Subscribe in Reeder Classic, verify item appears
- [ ] Verify images load in Reeder
- [ ] Subscribe a second newsletter, verify separate feeds
- [ ] Send duplicate email, verify no duplicate item created
- [ ] Hit `/feeds` endpoint, verify JSON listing
- [ ] Import `/feeds/opml` in Reeder

## Test Email Fixtures

Save real newsletter emails as `.eml` files for offline testing. To get `.eml` files:

### Method 1: Forward to yourself, save as .eml
Most email clients (Apple Mail, Thunderbird) can "Save As" `.eml`.

### Method 2: Use `wrangler tail` to capture raw emails
Log the raw email bytes in the Worker during development:

```typescript
// TEMPORARY — for capturing test fixtures only
const rawBytes = await new Response(message.raw).arrayBuffer();
const base64 = btoa(String.fromCharCode(...new Uint8Array(rawBytes)));
console.log('RAW_EMAIL_BASE64:', base64);
```

Then decode from the logs to save as `.eml`.

### Method 3: Compose synthetic test emails
```
From: test@example.com
To: rss@yourdomain.com
Subject: Test Newsletter #1
Date: Mon, 15 Jan 2024 12:00:00 +0000
Message-ID: <test-001@example.com>
Content-Type: text/html; charset=UTF-8

<html><body><h1>Test Newsletter</h1><p>Content here</p></body></html>
```

Save as `test/fixtures/simple.eml`.

## Recommended Test Fixtures

| File | Purpose |
|------|---------|
| `simple.eml` | Basic HTML newsletter |
| `multipart-alternative.eml` | HTML + plain text |
| `substack-with-list-id.eml` | Substack with List-Id header |
| `mailchimp-tracking.eml` | Mailchimp with tracking pixels |
| `plain-text-only.eml` | No HTML part |
| `large-newsletter.eml` | >500KB HTML |
| `non-utf8.eml` | ISO-8859-1 encoding |
| `duplicate.eml` | Same Message-ID as another fixture |

## Test Framework

Use **Vitest** — it's fast, works with TypeScript, and the Workers community uses it:

```bash
npm install -D vitest
```

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
```
