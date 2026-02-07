# postal-mime Usage Guide

## Installation

```bash
npm install postal-mime
```

## Basic Usage in Workers

```typescript
import PostalMime from 'postal-mime';

// In email handler
const rawEmail = await new Response(message.raw).arrayBuffer();
const parser = new PostalMime();
const email = await parser.parse(rawEmail);
```

## Parsed Email Object Shape

```typescript
interface ParsedEmail {
  // Sender
  from: { address: string; name: string } | null;
  
  // Recipients
  to: Array<{ address: string; name: string }>;
  cc: Array<{ address: string; name: string }>;
  bcc: Array<{ address: string; name: string }>;
  replyTo: Array<{ address: string; name: string }>;
  
  // Content
  subject: string;
  html: string;          // HTML body (empty string if none)
  text: string;          // Plain text body (empty string if none)
  
  // Metadata
  date: string;          // ISO date string
  messageId: string;     // Message-ID header value
  
  // Headers (all of them)
  headers: Array<{ key: string; value: string }>;
  
  // Attachments
  attachments: Array<{
    filename: string;
    mimeType: string;
    disposition: 'attachment' | 'inline';
    content: ArrayBuffer;
    contentId?: string;   // For CID inline images
  }>;
}
```

## Accessing Headers

```typescript
// postal-mime returns headers as an array of {key, value} objects
// Keys are lowercase

function getHeader(parsed: ParsedEmail, name: string): string | undefined {
  return parsed.headers.find(h => h.key === name.toLowerCase())?.value;
}

// Examples
const listId = getHeader(parsed, 'list-id');
const xMailer = getHeader(parsed, 'x-mailer');
const receivedSPF = getHeader(parsed, 'received-spf');
```

## Gotchas

### 1. `html` can be empty
Some emails are plain-text only. Always fallback:
```typescript
const content = parsed.html || `<pre>${escapeHtml(parsed.text)}</pre>`;
```

### 2. `from` can be null
Malformed emails might not have a parseable From header:
```typescript
const fromAddress = parsed.from?.address || message.from; // fallback to EmailMessage.from
```

### 3. Date parsing
`parsed.date` is a string, not a Date object. It's usually ISO format but can vary:
```typescript
const dateObj = new Date(parsed.date);
const isoDate = isNaN(dateObj.getTime()) 
  ? new Date().toISOString() 
  : dateObj.toISOString();
```

### 4. Large emails
`postal-mime` loads the entire email into memory. With Workers' 128MB limit, this is fine for typical newsletters (50-500KB). The raw stream must be fully consumed before parsing.

### 5. Inline images (CID)
`postal-mime` puts inline images in the `attachments` array with `disposition: 'inline'` and a `contentId`. The HTML references them as `src="cid:contentId"`. These won't render in RSS unless you:
- Convert them to data URIs (bloats content)
- Upload to R2 and rewrite URLs (complex)
- Ignore them (recommended for MVP — most newsletters use hosted URLs)

## Testing Locally

You can test postal-mime parsing with a simple Node.js script (it works in Node too):

```typescript
// test-parse.ts
import PostalMime from 'postal-mime';
import { readFileSync } from 'fs';

const raw = readFileSync('./test-emails/sample.eml');
const parser = new PostalMime();
const email = await parser.parse(raw.buffer);

console.log('From:', email.from);
console.log('Subject:', email.subject);
console.log('HTML length:', email.html.length);
console.log('Headers:', email.headers.map(h => `${h.key}: ${h.value.substring(0, 50)}`));
```

Run with: `npx tsx test-parse.ts`
