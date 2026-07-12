# Phase 22G — Partner Directory Contact-Form Outreach Queue (Report, 2026-06-22)

> Note: a prior "Phase 22G" (outreach drip scheduler) already exists in the handoff.
> This is a separate, independently-named workstream (Partner Directory Outreach).
> No conflict — different tables, routes, and pages.

## Goal
Add an operator-controlled, **non-email** outreach channel so the owner can import
visible partner-directory companies, generate a short partner message, open/copy into
the directory's own Contact form, **submit it manually**, and track replies/suppression.
**Nothing is sent or submitted automatically.**

## PART 1 — Live audit (what was reused)
- **Touch ledger** `outreach_touchpoints` (0015) already supports `channel='contact_form'`,
  `direction` in/out, `touch_type` first_touch/reply/manual_note, `status`
  copied/sent_manual/replied/blocked → **reused directly** via `recordTouchpoint()`
  in `mailboxFleet.ts`. New service bridges through `recordPartnerTouch()`.
- **Suppression** patterns (`suppression.ts`, `manualOutreach.isEmailSuppressed`) exist but
  are **email-keyed**; partner targets have no email, so suppression here is
  target-status-based (`do_not_contact`/`skipped`/`blocked`).
- **Generic** `outreach_tasks` (0010, channel includes contact_form) is minimal/company-level;
  built a **dedicated** partner queue instead per spec (richer status model, dedupe, rate limit).
- **Go-Live wizard / Manual Outreach / Sender Studio** untouched; this is a parallel channel.
- Router/portal/i18n conventions copied from `smtpNodes` (auth middleware, AppShell `pageKey`,
  `useT`, locale parity en/ru/uk).
- **No headless browser** is installed → browser-assisted discovery is **LIMITED** (manual import only).

## PART 2–6 — Data model + seeds (migration `0019_partner_directory_outreach.sql`)
- `partner_directory_sources` — directory registry (ziftone/manual/other; active/disabled/needs_review).
  **Seeded:** *Intuit Partner Directory* → `https://intuit.ziftone.com/#/page/directory`, platform `ziftone`, status `active`.
- `partner_directory_targets` — saved companies; full status enum
  (new/selected/queued/contacted/replied/interested/not_interested/do_not_contact/skipped/blocked),
  `contact_button_present`, `contact_form_url`, `contact_attempt_count`, `raw_metadata_json`,
  unique `dedupe_key` (profile URL → website host → normalized name). No secrets, no hidden data.
- `partner_contact_tasks` — one task = one company contact form; channel `contact_form` only;
  status pending_review/ready/opened/copied/submitted_manually/replied/skipped/blocked/do_not_contact;
  `message_subject/message_body`, `blockers_json`, `assigned_to`, `due_at`, `submitted_at`.
- `partner_message_templates` — 5 seeded copy/paste templates (PART 6), `<<< REPLACE: Label >>>`
  fields shown literally: partnership intro, lead-capture offer, remote-IT P.S. version,
  wrong-person/referral, manual follow-up.
- `partner_outreach_daily` — per-day rate-limit ledger (submissions per source + tasks per day).

## PART 4 — Safe discovery / import
- **Manual import** (CSV / URLs / pasted card data): dry-run preview first, explicit
  `confirm:true` to persist, dedupe on save, **max 200 rows**, stores visible fields only.
- **Browser discovery:** `POST /partner-outreach/discover` returns
  `{available:false, limited:true, reason:'browser_discovery_unavailable'}` with guidance.
  No login/captcha bypass, no hidden-API calls — intentionally not built.

## PART 5/7/8 — Queue, UI, ledger integration
- Router `api/src/routes/partnerOutreach.ts` (mounted `/partner-outreach`, tenant-isolated,
  **no send endpoint**): sources CRUD · targets import/CRUD/do-not-contact · `discover` (limited)
  · templates CRUD/render · tasks create/open/copy/mark-submitted/skip/do-not-contact/reply ·
  `today` dashboard · `status` · `seed`.
- **Touch ledger:** copy → `copied`, mark-submitted → `sent_manual`, reply/interested → inbound
  `replied`, do-not-contact/not-interested → `manual_note`/`blocked`; follow-up tasks are
  cancelled on reply/not-interested/do-not-contact; suppression rechecked before each submit.
- **Portal page** `/partner-outreach`: tabs Today/Sources/Targets/Tasks/Templates; import box;
  target multi-select → task creation with REPLACE-field inputs; per-task open/copy/mark-submitted/
  reply/skip/do-not-contact; **no send-all button**. Nav item `partnerOutreach` + full i18n block
  (en/ru/uk, parity validated). Banner: "no automatic form submission".

## PART 9 — Safety / rate limits (enforced)
- Max 5 submissions/source/day (429 `daily_submission_limit`), max 20 tasks/day
  (429 `daily_task_limit`), max 50 discovery/run (n/a — discovery disabled), max 200 import rows.
- Duplicate company task blocked; suppressed/skipped/blocked targets excluded; warnings surfaced.

## PART 11 — Validation (all green)
- `docker compose build api worker portal` → green; `migrate.js` → `applied 0019`; `healthcheck.sh` → OK.
- Pages 200: `/api/health`, `/partner-outreach`, `/go-live`, `/mailboxes`, `/manual-outreach`,
  `/sender-studio`, `/safety`.
- Authed smoke (tenant 1): seed (1 source + 5 templates) ✓ · dry-run import (3) ✓ ·
  confirm import created 3 ✓ · re-import dedup (created 0, dup 1) ✓ · create 3 tasks ✓ ·
  duplicate-task blocked (`task_exists`) ✓ · render fills `<<< REPLACE >>>` cleanly ✓ ·
  copy → `copied` touch ✓ · mark-submitted → target `contacted` attempts=1 + `sent_manual` touch
  + submissions ledger=1 ✓ · do-not-contact → target `do_not_contact` + `blocked` touch ✓ ·
  submission cap → 429 ✓ · discover → limited ✓ · `tasks/:id/submit` → 404 (no auto-submit) ✓.
- **Test rows cleaned:** partner_directory_targets=0, partner_contact_tasks=0, contact_form
  touchpoints=0, partner_outreach_daily=0. Seed source (1) + templates (5) kept.

## PART 12 — Safety confirmations
- ✅ No real emails sent (0). ✅ No contact forms submitted automatically.
- ✅ No captcha/login bypass. ✅ No mass submit. ✅ No proxies/evasion. ✅ No hidden/private API abuse.
- ✅ No campaign scheduled (scheduled=0). ✅ No mass subscribe (subscribed=1, pre-existing).
- ✅ No secrets exposed/stored. ✅ `.env` unchanged (`SMTP_HOST=mailhog`). ✅ `/opt/seo` untouched.
- ✅ Volumes not wiped.

## Files
- `db/migrations/0019_partner_directory_outreach.sql`
- `api/src/services/partnerOutreach.ts`, `api/src/routes/partnerOutreach.ts` (+ mount in `index.ts`)
- `portal/src/app/partner-outreach/page.tsx`, nav in `AppShell.tsx`, i18n en/ru/uk
- `docs/PARTNER_DIRECTORY_OUTREACH_OPERATOR_GUIDE_2026-06-22.md`

## Next owner action
Open `/partner-outreach` → **Seed** (loads the Intuit/ZiftOne source + 5 templates) → in your
own logged-in directory session, copy visible listings → **Targets → Import** (dry-run, confirm)
→ pick a template, fill REPLACE fields → **Create tasks** → per task: open form, copy, submit by
hand, **mark submitted** → track replies. Stay under 5 submissions/source/day.
