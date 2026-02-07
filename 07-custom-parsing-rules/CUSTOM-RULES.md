# Custom Parsing Rules Engine

## Purpose

Override the default "store full HTML" behavior on a per-feed basis. Use cases:
- Extract only the main content (strip header, footer, ads)
- Remove tracking pixels and analytics
- Extract a specific section from a multi-section newsletter
- Strip inline styles for cleaner rendering
- Transform content (e.g., unwrap link shorteners)

## Rule Types

### 1. `css_selector` — Extract content matching a CSS selector
```json
{
  "rule_type": "css_selector",
  "rule_config": {
    "selector": ".main-content",
    "action": "extract",
    "multiple": false
  }
}
```
- `extract`: Keep only the matched element(s)
- `multiple: true`: Concatenate all matches

### 2. `css_remove` — Remove elements matching a selector
```json
{
  "rule_type": "css_remove",
  "rule_config": {
    "selector": ".tracking-pixel, .footer-ads, .unsubscribe-block"
  }
}
```

### 3. `regex_replace` — Pattern-based text replacement
```json
{
  "rule_type": "regex_replace",
  "rule_config": {
    "pattern": "<img[^>]*width=[\"']1[\"'][^>]*/?>",
    "replacement": "",
    "flags": "gi"
  }
}
```

### 4. `strip_attributes` — Remove specific HTML attributes
```json
{
  "rule_type": "strip_attributes",
  "rule_config": {
    "attributes": ["onclick", "onload", "data-track", "data-analytics"]
  }
}
```

### 5. `strip_styles` — Remove all inline styles
```json
{
  "rule_type": "strip_styles",
  "rule_config": {
    "remove_style_tags": true,
    "remove_inline_styles": true
  }
}
```

## Rule Execution Pipeline

```typescript
async function applyRules(htmlContent: string, feedKey: string, env: Env): Promise<string> {
  // Get active rules for this feed, ordered by priority
  const { results: rules } = await env.DB.prepare(
    'SELECT rule_type, rule_config FROM parsing_rules WHERE feed_key = ? AND is_active = 1 ORDER BY priority DESC'
  ).bind(feedKey).all<ParsingRule>();
  
  if (!rules.length) return htmlContent; // No rules, return as-is
  
  let content = htmlContent;
  
  for (const rule of rules) {
    const config = JSON.parse(rule.rule_config);
    
    switch (rule.rule_type) {
      case 'css_selector':
        content = applyCssSelector(content, config);
        break;
      case 'css_remove':
        content = applyCssRemove(content, config);
        break;
      case 'regex_replace':
        content = applyRegexReplace(content, config);
        break;
      case 'strip_attributes':
        content = applyStripAttributes(content, config);
        break;
      case 'strip_styles':
        content = applyStripStyles(content, config);
        break;
    }
  }
  
  return content;
}
```

## HTML Parsing in Workers

For CSS selector-based rules, we need an HTML parser that runs in Workers. Options:

| Library | Workers Compatible | Size | CSS Selectors |
|---------|-------------------|------|---------------|
| `linkedom` | ✅ | ~50KB | ✅ Full DOM API |
| `htmlparser2` + `css-select` | ✅ | ~30KB | ✅ |
| `cheerio` | ❌ (uses Node APIs) | — | — |
| Regex | ✅ | 0 | ❌ Fragile |

**Recommendation:** Use `linkedom` — it provides a full DOM API (`querySelector`, `remove()`, `innerHTML`) that makes rule implementation straightforward.

```typescript
import { parseHTML } from 'linkedom';

function applyCssSelector(html: string, config: { selector: string; multiple: boolean }): string {
  const { document } = parseHTML(html);
  
  if (config.multiple) {
    const elements = document.querySelectorAll(config.selector);
    return Array.from(elements).map(el => el.outerHTML).join('\n');
  }
  
  const element = document.querySelector(config.selector);
  return element ? element.outerHTML : html; // Fallback to full HTML if selector doesn't match
}

function applyCssRemove(html: string, config: { selector: string }): string {
  const { document } = parseHTML(html);
  document.querySelectorAll(config.selector).forEach(el => el.remove());
  return document.toString();
}
```

## Rule Management

### Adding Rules via D1 (CLI/wrangler)
```bash
wrangler d1 execute pigeon-db --command "INSERT INTO parsing_rules (id, feed_key, rule_type, rule_config, priority) VALUES ('rule-1', 'mb.morningbrew.com', 'css_remove', '{\"selector\": \".tracking-pixel, .footer\"}', 10)"
```

### Future: Rule Testing Endpoint
```
POST /api/feeds/:key/rules/test
Body: { "rule_type": "css_selector", "rule_config": { "selector": ".main-content" } }
Response: { "original_size": 150000, "result_size": 45000, "preview": "<div class='main-content'>..." }
```

This would apply the rule to the most recent item and return a before/after comparison.

## Example Rules for Common Newsletters

### Morning Brew — Strip footer
```json
{
  "feed_key": "mb.morningbrew.com",
  "rule_type": "css_remove",
  "rule_config": { "selector": ".footer-section, .share-section, .referral-section" }
}
```

### Substack — Extract post content
```json
{
  "feed_key": "stratechery.substack.com",
  "rule_type": "css_selector",
  "rule_config": { "selector": ".post-content, .body", "multiple": false }
}
```

### Generic — Strip tracking pixels
```json
{
  "feed_key": "*",
  "rule_type": "regex_replace",
  "rule_config": {
    "pattern": "<img[^>]*(?:width=[\"']1[\"'][^>]*height=[\"']1[\"']|height=[\"']1[\"'][^>]*width=[\"']1[\"'])[^>]*/?>",
    "replacement": "",
    "flags": "gi"
  }
}
```

**Note:** `feed_key: "*"` for global rules — the rule engine should check for wildcard rules that apply to all feeds.
