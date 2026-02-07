# Email Format Reference

## MIME Structure of Newsletter Emails

Most newsletter emails use one of these structures:

### Simple HTML (most common)
```
Content-Type: text/html; charset=UTF-8
Content-Transfer-Encoding: quoted-printable

<html>...</html>
```

### Multipart/Alternative (HTML + plain text fallback)
```
Content-Type: multipart/alternative; boundary="----=_Part_123"

------=_Part_123
Content-Type: text/plain; charset=UTF-8

Plain text version...

------=_Part_123
Content-Type: text/html; charset=UTF-8

<html>...</html>
------=_Part_123--
```

### Multipart/Mixed (HTML + attachments)
```
Content-Type: multipart/mixed; boundary="----=_Part_456"

------=_Part_456
Content-Type: multipart/alternative; boundary="----=_Part_789"

  (text/plain + text/html as above)

------=_Part_456
Content-Type: image/png
Content-Disposition: attachment; filename="logo.png"

(base64 encoded image)
------=_Part_456--
```

### Multipart/Related (HTML with inline images via CID)
```
Content-Type: multipart/related; boundary="----=_Part_ABC"

------=_Part_ABC
Content-Type: text/html; charset=UTF-8

<html><img src="cid:image001"></html>

------=_Part_ABC
Content-Type: image/jpeg
Content-ID: <image001>

(base64 encoded image)
------=_Part_ABC--
```

**Note on CID images:** These are inline images referenced by Content-ID. They won't display in RSS because the image data isn't hosted anywhere. Most modern newsletters use absolute URLs instead. CID images are rare but may need handling in Phase 4 (custom rules).

## Content-Transfer-Encoding

| Encoding | Description | postal-mime handles? |
|----------|-------------|---------------------|
| 7bit | ASCII only | ✅ |
| 8bit | 8-bit characters | ✅ |
| quoted-printable | `=XX` hex encoding | ✅ |
| base64 | Base64 encoded | ✅ |

`postal-mime` decodes all of these transparently. You always get the decoded output.

## Key Headers for Newsletter Processing

| Header | Example | Use |
|--------|---------|-----|
| `From` | `Morning Brew <newsletters@morningbrew.com>` | Sender identification, feed key |
| `Subject` | `☕ Daily Digest - Jan 15` | RSS item title |
| `Date` | `Mon, 15 Jan 2024 07:00:00 -0500` | RSS item pubDate |
| `Message-ID` | `<abc123@morningbrew.com>` | Deduplication |
| `List-Id` | `<morningbrew.list-id.com>` | Better feed key for ESPs |
| `List-Unsubscribe` | `<mailto:unsub@...>` | Useful metadata |
| `Reply-To` | `reply@newsletter.com` | Sometimes better sender identity |
| `X-Mailer` | `Substack` | ESP identification |

## Common ESP Patterns

### Substack
- From: Often `@substack.com` generic address
- List-Id: Contains newsletter slug
- Reply-To: Usually the author's email
- HTML: Clean, well-structured, absolute image URLs
- **Feed key strategy:** Use List-Id

### Mailchimp / Mandrill
- From: Custom sender domain
- List-Id: Contains list identifier
- HTML: Table-heavy layout, lots of tracking pixels
- `X-Mailer: Mailchimp` or `X-MC-User`
- **Feed key strategy:** From address works well

### ConvertKit
- From: Custom sender domain
- HTML: Relatively clean
- **Feed key strategy:** From address

### Beehiiv
- From: Custom sender or `@beehiiv.com`
- Similar pattern to Substack
- **Feed key strategy:** List-Id or From

### Ghost
- From: Custom domain
- HTML: Clean, minimal wrapper
- **Feed key strategy:** From address

## Tracking Pixels

Almost all newsletter ESPs inject 1x1 tracking pixel images. These are typically:
```html
<img src="https://tracking.esp.com/open/abc123" width="1" height="1" style="display:none">
```

These are harmless in RSS (Reeder won't load them unless images are enabled, and even then it's just a tiny invisible request). Stripping them is optional but recommended for cleanliness in Phase 4.

## Character Encoding

Most modern newsletters use UTF-8. `postal-mime` handles charset detection and conversion. Edge cases:
- ISO-8859-1 (older newsletters) — postal-mime handles
- Windows-1252 — postal-mime handles
- Missing charset declaration — postal-mime assumes UTF-8, usually correct
