# Email Ingestion

## How Cloudflare Email Workers Receive Mail

When an email arrives at your domain, Cloudflare Email Routing invokes your Worker's `email()` export with an `EmailMessage` object.

```typescript
export default {
  async email(message: EmailMessage, env: Env, ctx: ExecutionContext) {
    // message.from — sender address (string)
    // message.to — recipient address (string)
    // message.headers — Headers object (email headers)
    // message.raw — ReadableStream of the raw RFC 5322 email
    // message.rawSize — size in bytes
  }
};
```

## Processing Pipeline

```typescript
import PostalMime from 'postal-mime';

async function handleIncomingEmail(message: EmailMessage, env: Env) {
  // 1. Read the raw email stream into an ArrayBuffer
  const rawEmail = await new Response(message.raw).arrayBuffer();
  
  // 2. Parse with postal-mime
  const parser = new PostalMime();
  const parsed = await parser.parse(rawEmail);
  
  // 3. Extract fields
  const fromAddress = parsed.from?.address?.toLowerCase() || message.from;
  const fromName = parsed.from?.name || fromAddress;
  const subject = parsed.subject || '(no subject)';
  const htmlContent = parsed.html || parsed.text || '';
  const receivedAt = parsed.date || new Date().toISOString();
  const messageId = parsed.messageId || crypto.randomUUID();
  
  // 4. Generate feed key from sender
  const feedKey = normalizeFeedKey(fromAddress);
  
  // 5. Write to D1
  await env.DB.prepare(`
    INSERT INTO items (id, feed_key, from_name, from_email, subject, html_content, message_id, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    crypto.randomUUID(),
    feedKey,
    fromName,
    fromAddress,
    subject,
    htmlContent,
    messageId,
    receivedAt
  ).run();
}
```

## Sender Normalization

The feed key determines which RSS feed an email ends up in. Normalization strategy:

```typescript
function normalizeFeedKey(email: string): string {
  // Lowercase
  let key = email.toLowerCase().trim();
  
  // Remove common ESP subaddress patterns
  // e.g., bounce+letters.substack.com → letters.substack.com
  // This is sender-side, not recipient-side plus addressing
  
  // Replace special chars with hyphens for URL safety
  key = key.replace(/[^a-z0-9.-]/g, '-');
  
  // Remove leading/trailing hyphens
  key = key.replace(/^-+|-+$/g, '');
  
  return key;
}
```

**Examples:**
| Raw From Address | Feed Key |
|-----------------|----------|
| `newsletters@morningbrew.com` | `newsletters-morningbrew.com` |
| `hello@tldrnewsletter.com` | `hello-tldrnewsletter.com` |
| `noreply@substack.com` | `noreply-substack.com` ← Problem! |

**Substack special case:** Many Substack newsletters send from a generic `@substack.com` address but include the real newsletter name in headers. Check `List-Id` or `X-Mailer` headers for better identification:

```typescript
function getFeedKeyWithHeaders(parsed: ParsedEmail, fallbackFrom: string): string {
  // Check List-Id header first (most reliable for mailing lists)
  const listId = parsed.headers?.find(h => h.key === 'list-id')?.value;
  if (listId) {
    // List-Id format: "Newsletter Name <list-id.substack.com>"
    const match = listId.match(/<([^>]+)>/);
    if (match) return normalizeFeedKey(match[1]);
  }
  
  // Check Reply-To (often the real sender for ESP-sent mail)
  const replyTo = parsed.replyTo?.[0]?.address;
  if (replyTo && replyTo !== fallbackFrom) {
    return normalizeFeedKey(replyTo);
  }
  
  // Fallback to From address
  return normalizeFeedKey(fallbackFrom);
}
```

## Error Handling

```typescript
async function handleIncomingEmail(message: EmailMessage, env: Env) {
  try {
    // ... parsing and storage logic ...
  } catch (error) {
    // Log error with context
    console.error('Email processing failed', {
      from: message.from,
      to: message.to,
      size: message.rawSize,
      error: error instanceof Error ? error.message : String(error),
    });
    
    // Optionally store the raw email for debugging
    // Don't rethrow — Cloudflare will retry on throws, which may cause duplicates
  }
}
```

## Duplicate Detection

Newsletters sometimes get sent multiple times, or Cloudflare may retry delivery. Use `Message-ID` header for deduplication:

```sql
-- Add UNIQUE constraint on message_id
CREATE UNIQUE INDEX idx_items_message_id ON items(message_id);
```

```typescript
// Use INSERT OR IGNORE to silently skip duplicates
await env.DB.prepare(`
  INSERT OR IGNORE INTO items (...)
  VALUES (...)
`).bind(...).run();
```

## Size Limits

D1 rows have a 1MB limit. Most newsletter HTML is 50-200KB, but some (especially image-heavy ones) can be larger.

Strategy:
1. Check `htmlContent.length` before writing
2. If > 900KB, try stripping tracking pixels and style blocks
3. If still > 900KB, store the text version instead
4. Log a warning for manual review
