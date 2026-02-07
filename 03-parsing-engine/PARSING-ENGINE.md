# Parsing Engine

## Overview

The parsing engine sits between email ingestion and storage. Its job is to extract clean, structured data from raw parsed emails. In the default mode, it preserves the full HTML. The custom rules engine (Phase 4) can override this per-sender.

## Pipeline

```
Raw parsed email (from postal-mime)
    │
    ├── 1. Feed key resolution
    │     (sender normalization + header inspection)
    │
    ├── 2. Content extraction
    │     (HTML selection, fallback to text)
    │
    ├── 3. Content cleaning (optional, rule-based)
    │     (strip tracking pixels, remove wrapper divs)
    │
    ├── 4. Metadata extraction
    │     (subject, date, message-id, author name)
    │
    └── 5. Structured output → D1 insert
```

## Default Behavior (No Custom Rules)

1. **Feed key:** Use `List-Id` header if present, then `Reply-To` if different from `From`, then `From` address
2. **Content:** Use `html` field as-is from postal-mime
3. **Title:** Use `subject` field
4. **Date:** Use `date` field, fallback to current time
5. **Author:** Use `from.name`, fallback to `from.address`

## Content Cleaning (Phase 5 Enhancement)

Optional cleaning steps that can be toggled globally or per-feed:

```typescript
function cleanHtml(html: string, options: CleanOptions): string {
  let cleaned = html;
  
  if (options.stripTrackingPixels) {
    // Remove 1x1 images with tracking URLs
    cleaned = cleaned.replace(
      /<img[^>]*(?:width=["']1["'][^>]*height=["']1["']|height=["']1["'][^>]*width=["']1["'])[^>]*\/?>/gi,
      ''
    );
  }
  
  if (options.stripHiddenElements) {
    // Remove display:none elements (common for preheader text)
    cleaned = cleaned.replace(
      /<[^>]*style=["'][^"']*display\s*:\s*none[^"']*["'][^>]*>.*?<\/[^>]+>/gis,
      ''
    );
  }
  
  return cleaned;
}
```

**Note:** Regex-based HTML cleaning is fragile. For Phase 4 custom rules, use a proper HTML parser if available in Workers (e.g., `htmlparser2` or `linkedom`).
