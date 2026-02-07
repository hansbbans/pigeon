# Edge Cases

## Known Problematic Patterns

### 1. Shared ESP Sender Addresses
**Problem:** Multiple newsletters from `noreply@substack.com` or `no-reply@mail.beehiiv.com`
**Solution:** List-Id header differentiation (see SENDER-NORMALIZATION.md)
**Severity:** High — affects Substack, Beehiiv, some Mailchimp setups

### 2. Sender Address Changes
**Problem:** Newsletter migrates ESPs, From address changes
**Example:** `news@newsletter.com` → `news@mail.newsletter.com`
**Solution:** Phase 4 — manual feed key aliasing in custom rules
**Severity:** Low — rare, but breaks feed continuity when it happens

### 3. HTML-Only Newsletters (No Plain Text)
**Problem:** Some senders don't include a text/plain alternative
**Solution:** Already handled — we prefer HTML and only fallback to text
**Severity:** None

### 4. Plain-Text-Only Newsletters
**Problem:** Some tech newsletters are plain text only
**Solution:** Wrap in `<pre>` tags for RSS content
**Severity:** Low — uncommon but exists (some developer newsletters)

### 5. Extremely Large HTML
**Problem:** Image-heavy newsletters with massive inline CSS can exceed D1's 1MB row limit
**Solution:** 
  1. Check size before insert
  2. Strip `<style>` blocks (often duplicated across sections)
  3. Strip HTML comments
  4. If still too large, store text version
  5. Log warning
**Severity:** Medium — rare but will cause silent failures if not handled

### 6. CID Inline Images
**Problem:** Images referenced as `src="cid:image001"` won't load in RSS
**Solution:** For MVP, ignore. Most modern newsletters use absolute URLs.
**Severity:** Low — mostly legacy senders

### 7. Duplicate Deliveries
**Problem:** ESP retries or Cloudflare retries deliver same email twice
**Solution:** UNIQUE index on `message_id`, use `INSERT OR IGNORE`
**Severity:** High if not handled — causes duplicate items in feed

### 8. Non-Newsletter Email
**Problem:** Spam or non-newsletter email sent to the RSS address
**Solution:** 
  - Phase 1: Accept everything, let it create feeds (harmless)
  - Phase 5: Add sender allowlist/blocklist
**Severity:** Low — the address isn't public, only newsletter subscriptions use it

### 9. Base64-Encoded HTML Body
**Problem:** Some ESPs base64-encode the HTML part
**Solution:** postal-mime handles this automatically
**Severity:** None

### 10. Character Encoding Issues
**Problem:** Non-UTF-8 content with incorrect charset declaration
**Solution:** postal-mime handles most cases. Edge case: mojibake in subject lines from older ESPs
**Severity:** Low

### 11. AMP HTML
**Problem:** Some newsletters include `text/x-amp-html` MIME part
**Solution:** Ignore — postal-mime extracts standard `text/html` which is always present alongside AMP
**Severity:** None

### 12. Newsletter with Identical Subjects
**Problem:** Some newsletters use the same subject every time (e.g., "Daily Digest")
**Solution:** Not a problem for RSS — items are differentiated by date and guid (message_id)
**Severity:** None
