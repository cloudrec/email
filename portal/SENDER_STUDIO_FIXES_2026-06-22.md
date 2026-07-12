# Sender Studio — Export 401 + Editor Mode Body Loss (fixes)

Date: 2026-06-22
File: `/opt/email/portal/src/app/sender-studio/page.tsx`

## Bug 1 — Export "unauthorized"
**Symptom:** `GET /api/sender-studio/templates/1/export?format=txt|html` → `{"error":"unauthorized"}` even when logged in.

**Cause:** export buttons were plain `<a href="/api/...export">` (direct browser
navigation). The API `authMiddleware` (`/opt/email/api/src/middleware/auth.ts:37`)
requires an `Authorization: Bearer <jwt>` header — a browser link sends only cookies,
no header → 401. (API itself is correct; verified 401 no-token / 401 bad-token at :4000.)

**Fix:** replaced the 3 `<a>` with buttons calling `downloadExport(fmt)` — `fetch()`
with `Authorization: Bearer <token>` (same token the rest of the page uses), then
download via Blob + `URL.createObjectURL`. No server/auth change (kept strict).

## Bug 2 — Body "disappears" when switching editor mode
**Symptom:** plain→html hides the text; →visual_lite empties the body.

**Cause (by design, bad UX):** each mode stores content in a DIFFERENT field —
`plain → body`, `html → html_body`, `visual_lite → blocks_json`. Switching modes
didn't migrate content, so the text was still saved but not shown in the new mode's
editor. (In html mode it was actually still visible in the smaller "Plain fallback"
textarea — just confusing.)

**Fix:** mode `<select>` now calls `changeEditorMode()` which SEEDS the target field
from existing content when it is empty (never overwrites):
- → html: `html_body = plainToHtml(body)`
- → plain: `body = htmlToPlain(html_body)`
- → visual_lite: one `{type:'paragraph', text}` block from body/html
Added small `plainToHtml` / `htmlToPlain` helpers.

## Extras
- Added i18n key `senderStudio.msgExportFailed` (en/ru/uk) for export error toast.
  Locales still full parity: 2252 strings each.

## Status
`docker compose build portal` clean, deployed, container healthy.
Authed download not E2E-tested here (needs a real session JWT) but uses the exact
Bearer-token path the page's working `api()` calls already use.
