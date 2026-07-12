# AI Handoff Context — emails.cheap Email Platform

**Path:** `/opt/email` · **Host:** Ubuntu 24.04 (vmi3293429) · **Last updated:** 2026-07-12 (Launch readiness, issue #1)

---
## 2026-07-12 — Launch readiness + Deliverability Center (issue cloudrec/email#1)

**State:** production stack healthy (7 containers), monitoring live (Prometheus+Grafana, alert →
cloudkroter@gmail.com pending one Zoho app-password). Self-hosted **Postal is the working relay**
(provider id8, from emails.cheap; rp.emails.cheap DNS now added → delivers to strict receivers).
**Real sends still tiny; campaigns + drip DISABLED.** Full report:
`reports/LAUNCH_AND_DELIVERABILITY_IMPLEMENTATION_20260712T103525Z.md`.

**Shipped this pass:**
- **Deliverability Center** — `services/deliverabilityCenter.ts` + `routes/deliverability.ts`
  (`GET /deliverability/center|checklist`) + `portal/src/app/deliverability/page.tsx` (nav +
  i18n). Real-data aggregation of DNS/auth, Postal probe, providers, mailbox health, live
  bounce/complaint/unsub/reply rates, worker/queue, deterministic **advisor** + unified readiness
  **verdict** (NOT_READY / READY_FOR_CONTROLLED_TEST_SEND / READY_FOR_LOW_VOLUME_WARMUP). External
  reputation integrations honestly `not_configured`. Current verdict: **READY_FOR_CONTROLLED_TEST_SEND**, 92/100.
- **Safety-gate fixes (tested):** portal one-by-one send now runs content validation (empty
  body / `{{macro}}` / `<<<REPLACE>>>` / broken grammar) via `services/outboundContentGuard.ts`;
  tenant kill-switch (`outreach_paused`) honored by campaigns + portal (was drip-only); portal
  daily-cap double-count fixed; portal send TOCTOU claim-lock; welcome/automated mail no longer
  scored as "interested" lead (`services/replyClassifier.ts` fromEmail guard); bounce follow-up
  cancels the failed recipient. New vitest: `outboundContentGuard.test.ts`, `classifyReplyGuard.test.ts`. **api 57/57 pass.**
- **Inbound reply import RESTORED:** `email-reply-import.service` was failing every run (missing
  `.env`); now runs `docker compose exec -T api node dist/cli/importReplies.js` (15-min timer).

**Blockers / next actions:**
- Owner DNS: add `rp.fundbot.win` A `84.247.139.105` + MX `10 mail.emails.cheap` (mirror emails.cheap).
- Gmail cold-domain reputation → low-and-slow warmup from emails.cheap; optional Google Postmaster.
- Need a mail-enabled test inbox (the issue's `sendcrypto.onmicrosoft.com` has NO MX) to prove
  real inbox delivery + reply/stop round-trip (Postal won't relay foreign From, by design).
- Git: `/opt/email` initialised locally + `.gitignore` hardened; **push to cloudrec/email needs an
  owner GitHub token** (none on host) — not pushed.

The stale sections below predate this and describe SMTP_HOST=mailhog / 0 sends — superseded.
---

## Phase — Self-hosted Postal SMTP (2026-06-24)
Free unlimited mailboxes on our own domains (Zoho KYC + Spacemail paid were rejected).
**Postal 3.3.4 deployed + working** via `docker-compose.postal.yml` (containers
`email_postal_web/smtp/worker`, all UP). Uses existing MariaDB (`postal` user) + Redis db5.
Postal objects: org `clients-help` → server `outreach` → domain `emails.cheap` → SMTP cred
(SMTP auth verified OK on `email_postal_smtp:25`). Platform provider **id8 "Postal (self-hosted)"**
(active, shared vault cred `POSTAL_OUTREACH_SMTP_*`). 4 draft mailboxes id14–17
(`hello/hi/team/contact@emails.cheap`, 5/day). Port 25 egress OPEN.
**BLOCKED on owner:** add DNS for emails.cheap (SPF/DKIM/DMARC/verify/A/MX — see
`reports/POSTAL_SELFHOSTED_SETUP_2026-06-24.md`) + set Contabo rDNS `84.247.139.105`→`mail.emails.cheap`.
After DNS: verify domain in Postal, activate id14–17, warmup 5→10→20/day.
Creds (private): `reports/private/POSTAL_CREDENTIALS.md`. nginx UI vhost draft (not enabled):
`/etc/nginx/sites-available/postal.emails.cheap`.

Drip status (earlier 2026-06-24): 3 active mailboxes (Zoho id5 + Spacemail id10/11), 20/day each,
ledger-based caps; see `reports/DRIP_STATUS_CHECK_2026-06-24.md`. Gmail id8/9/12 draft (bad app
passwords), Outlook id13 draft (MS killed basic-auth, needs OAuth) — `reports/GMAIL_MAILBOX_ACTIVATION_GUIDE.md`,
`reports/OUTLOOK_OAUTH2_SETUP_PLAN.md`.

## What this is
Cold-outreach B2B email platform. Collects business websites → extracts contacts into a
Warehouse → operator builds explicit lists → reviewed campaigns. Stack: FastAPI-style
Node/TS **api** + **worker** + Next.js **portal** + MariaDB 11.4 + Redis, via
`docker compose`. Public domain: https://emails.cheap.

## Architecture / data flow
```
sources (Tavily + OSM Overpass)  →  lead_sources / collector_campaign_sources (pending)
  → collectorScheduler → discovery_jobs → discovered_leads (status='discovered')
  → leadPromoter → companies + contact_points   [THE WAREHOUSE]
  → list builder (/contacts/lists/from-warehouse) → contacts (PENDING) + lists
  → operator subscribes + approves → campaigns → campaignRunner → SMTP
```
Two contact tables, do not confuse them:
- `contact_points` = Warehouse (filled by leadPromoter). Not sendable.
- `contacts` = addressable list members (filled by list builder, status `pending`).
  campaignRunner sends **only** to `contacts.status='subscribed'`.

## Hard safety rails (DO NOT cross without explicit operator intent)
- SMTP is **Mailhog/test-only** (`SMTP_HOST=mailhog`). Production SMTP NOT configured.
- Campaign scheduling is hard-blocked while SMTP != `ready` (`api/src/routes/campaigns.ts`).
- Real emails sent = **0**. Do not enable production SMTP, schedule campaigns,
  auto-approve drafts, or mass-subscribe contacts.
- Never touch `/opt/seo`. Never wipe volumes. Never print secrets.

## Containers
`email_api` (127.0.0.1:4000) · `email_worker` · `email_portal` (127.0.0.1:13000) ·
`email_db` (mariadb 11.4, internal) · `email_redis` · `email_mailhog` (127.0.0.1:8025).
nginx is host-level (serves emails.cheap), not in this compose file.

## Workers (`workers/src/`)
`perpetualCollector` (self-refilling source bank; Tavily daily cap + OSM bbox/area,
per-city cooldown) · `collectorScheduler` · `leadDiscovery` · `leadPromoter`
(discovered_leads → Warehouse) · `campaignRunner` · `sender`/`testSender`/`bounceProcessor`
· `collectorDraftGenerator` · `websiteAnalysis`.

## Gotchas learned
- DB runs `STRICT_TRANS_TABLES`. Any ENUM column rejects out-of-vocab values with
  `ER_DATA_TRUNCATED (1265)` — always map free text to a valid member.
  (`contact_points.role_type` was the Phase-16 blocker.)
- `discovered_leads.imported_contact_id` FK → `contacts(id)` (NOT `contact_points`).
  Do not set it from the promoter.
- Temp tables default to a different collation than app tables (`utf8mb4_uca1400_ai_ci`
  vs `utf8mb4_unicode_ci`) → `Illegal mix of collations` on JOIN/`=`. Declare temp
  columns `COLLATE utf8mb4_unicode_ci`.
- OSM Overpass `area["name"~regex]["admin_level"~"[678]"]` queries time out; **bbox**
  queries are reliable.
- `.env` is sourced by `backup.sh` with `set -a` — every value with spaces MUST be
  quoted or backup breaks.
- API auth: JWT `{sub:userId, tenant:tenantId}` signed with `API_JWT_SECRET`;
  super-admin can act on any tenant via `x-tenant-id` header. Lists router is mounted
  at **`/contacts/lists`** (not `/lists`).

## Provider recommendation (corrected Phase 16)
Brevo first (low-volume B2B) → SMTP2GO fallback → Mailgun possible → SES later.
**Postmark is NOT for cold outreach** (prohibited by their policy).

## Current state (Phase 17 close, 2026-06-01)
- leadPromoter **DRAINED** — `discovered_leads`: 9,188 imported, 2 invalid, **0 in
  backlog**; promoter idle. Warehouse: **11,405 contact_points, 6,610 companies**
  (+~3,839 / +~1,722 since P16). Only skip reason = `duplicate` (benign). No stuck rows.
- Test list `lists.id=2`: 5 GB cleaning contacts, all `pending`, all have email+source,
  none suppressed, no campaign scheduled. Tenant-wide subscribed=1 (pre-existing self-test).
- SMTP still `test_only_mailhog` — `.env` UNCHANGED (owner has not added Brevo creds).
- **Brevo webhook adapter SHIPPED:** `POST /api/webhooks/brevo` — reuses
  `WEBHOOK_BOUNCE_SECRET`, tenant via `x-tenant-id`/`?tenant_id`, maps
  hard/soft_bounce·spam·unsubscribed → normalized `webhook:bounce` stream (same
  suppression+audit pipeline), idempotent on Brevo event id (Redis NX), batch-capable.
  `bounceProcessor` now handles `unsubscribe`. Normalized `/api/webhooks/bounce`
  unchanged. Live-tested then test rows cleaned.
- first-test-send + campaign schedule gates verified: both 412 `smtp_not_ready` while
  Mailhog. campaignRunner sends only to `subscribed` + non-suppressed.
- ⚠ **GAP:** documented 5/hour·20/day send caps are NOT enforced in `campaignRunner`
  (only per-sec `WORKER_SEND_RATE_PER_SEC=20`). Add before first live campaign.
- See `docs/PHASE17_BREVO_READINESS_REPORT_2026-06-01.md`.

## Phase 18 (2026-06-01) — Lead Intelligence UX
- **NEW** `api/src/services/leadIntel.ts`: fit score (0-100 + label + reasons) +
  deterministic NL lead-search parser `parseLeadQuery()` (no LLM configured; this IS the
  fallback). LLM slot left for future.
- **warehouse.ts** new/changed endpoints:
  `POST /warehouse/search` (NL → filters → ranked companies + `interpreted[]`),
  `GET /warehouse/review-queue`, `GET /warehouse/analytics`, `GET /warehouse/limits`
  (pricing hooks only, all null/unenforced), `POST /warehouse/companies/:id/note`.
  `GET /companies` gained `hasWebsite/hasEmail/minScore/sort`; rows now carry
  `fit_score_100/fit_label/fit_reasons/email_count/website_count`. `GET /companies/:id`
  enriched with notes/events/drafts/whyMatch/fitSummary/safety.
- **collector.ts** new `GET /collector/agent-status` (Collection Agent dashboard;
  scans Redis `perpcol:osm:cooldown:*` for cooldown cities).
- **portal**: `warehouse/page.tsx` rewritten — tabs Lead Search / Companies / Contacts /
  Review Queue / Analytics / Sequences / Stats; NL search box; card/table toggle; fit chips
  + reason badges; company **drawer smart-profile** (add notes inline). `collector/page.tsx`
  gained a Collection Agent status card (polls 15s). Sequences tab = static preview, NOT armed.
- Fit labels: excellent ≥80 / good ≥60 / weak ≥35 / not_fit / unknown.
- Safety held: SMTP_HOST=mailhog unchanged, schedule gate intact, 0 real sends,
  subscribed=1 (pre-existing), all new routes read/triage only. Build green, containers healthy.
- Known data gap: most `companies.city/country` are NULL → geo-filtered NL searches
  under-return (parser is correct; data needs backfill). exports & preflight-block analytics
  counters not instrumented (returned as null).
- See `docs/PHASE18_JUICEBOX_STYLE_UX_REPORT_2026-06-01.md`.

## Phase 18 (2026-06-22) — Compliant Sending Strategy (ESP export + warmup readiness)
Counts re-verified live: 77,850 contact_points / **75,637 verified** / 2,212 invalid / 1
risky — matches prior reports exactly. SMTP still mailhog; 0 real sends; `.env` unchanged.
- **Cohort Builder** (read `contact_points`, never sends): `POST /warehouse/cohorts/preview`
  (matched/eligible/blocked + reason breakdown + country/role/industry/source breakdowns +
  20-row sample). Hard eligibility `ELIGIBLE_SQL` = email+verified+not global/tenant
  suppressed+company healthy+not free/disposable. Portal: **`/warehouse/cohorts`**.
- **ESP export**: `POST /warehouse/cohorts/export` formats csv/instantly/smartlead/lemlist;
  default 100, **max 500**, NO export-all, mandatory `acknowledge:true`, emits
  **`cohort.export`** audit. `GET /warehouse/suppression-export` (global+tenant+contact
  unsub/bounce/complaint).
- **Bounce-checker hooks**: `POST /warehouse/bounce-check/export` (email,company,domain,
  source CSV; no paid API) + `/bounce-check/import` (deliverable→verified, undeliverable→
  invalid, risky/catch_all→risky only if `confirmRisky`, unknown→noop). `bounce_check_batches`.
- **Non-email queue**: `POST/GET/PATCH /warehouse/outreach-tasks` (contact_form/telegram/
  whatsapp/manual_review/website_form) — manual tasks only, nothing auto-submitted.
  `outreach_tasks` table.
- **Warmup (NO fake warmup)**: `api/src/services/warmup.ts` (steps 20→5000; gates bounce>3%,
  complaint>0.1%, unsub>5%). `GET /domains/:id/warmup` dashboard, `POST /:id/warmup-advance`
  (one step, `confirm:true` only). **campaignRunner now enforces daily+hourly throttle +
  auto-pause gate** (pauses campaign + sets tenant outreach_paused + tenant_risk_event).
  `mail.emails.cheap` limit stays 20; never auto-raised.
- **import-to-contacts hardened**: now also checks `global_contact_suppression`(email+domain),
  blocks invalid/risky/suppressed/unsubscribed when requireVerified=false, batch cap 500
  (`IMPORT_BATCH_CAP` env). Still PENDING-only; no mass subscribe.
- Migration `0010_sending_strategy.sql`. Provider text already correct (Brevo first;
  Postmark NOT for cold) — no change. See `docs/PHASE18_COMPLIANT_SENDING_STRATEGY_REPORT_2026-06-22.md`.

## Phase 21 (2026-06-22) — Own Sending Infrastructure Foundation
Foundation only — 0 real sends, SMTP still mailhog, `.env` untouched, no campaigns scheduled.
- **Migration `0011_own_sending_infra.sql`**: new `sending_providers` table (provider-neutral relay
  registry; secrets NOT stored — `username_ref`/`secret_ref` hold env-var NAMES). `domains` +cols
  `purpose`(main/cold_outreach/transactional/tracking/bounce), `dns_status`, `hourly_send_limit`,
  `warmup_stage`, `provider_id`. `sender_identities`(=mailbox) +cols `display_name,provider_id,purpose,
  status,daily/hourly_send_limit,sent/bounced/complained/unsubscribed_today,counters_day,last_sent_at,
  warmup_stage,paused_reason`. `mail.emails.cheap` auto-set `purpose=main` (limit kept 20).
- **NEW router `api/src/routes/sending.ts`** (mounted `/sending`): providers CRUD +
  `POST /sending/providers/:id/test-connection` (TCP + optional SMTP `verify()` only — NEVER sends,
  never echoes secret) + `GET /sending/control-status` (aggregator for send-control dashboard).
  DELETE blocked if provider referenced by a domain/mailbox.
- **Webhook adapters**: added `POST /api/webhooks/{smtp2go,mailgun,generic}` (brevo already shipped).
  Shared `sinkNormalized()` → same `webhook:bounce` stream + audit + Redis-NX idempotency. Token auth.
  Mailgun `failed` severity→hard/soft.
- **Rate engine (campaignRunner)**: now enforces binding MIN across per-domain + per-mailbox +
  per-tenant, each daily+hourly; mailbox counters auto-roll on day change; increments
  `sender_identities.sent_today/last_sent_at`; 5 consecutive SMTP errors → pause mailbox+campaign.
  New cold mailbox 10/day·3hr, cold domain 20/day·5hr; never auto-raised.
- **first-test-send** hardened: + active-mailbox gate + global kill-switch (423). Still 412 on mailhog.
- **DNS onboarding**: `GET /domains/:id/onboarding` (SPF/DKIM/DMARC/return-path/MX/tracking checklist).
  `domain.verify` now writes `dns_status`. `senderIdentities` got `PATCH` for limits/status.
- **Portal**: `/send-control` Sending Infrastructure card (providers/mailboxes/webhooks/readiness/
  kill-switch); `/onboarding` "Connect your sending channel" guide+warnings.
- Provider webhook URL: `https://emails.cheap/api/webhooks/<provider>?token=<WEBHOOK_BOUNCE_SECRET>&tenant_id=1`.
- See `docs/PHASE21_OWN_SENDING_INFRA_FOUNDATION_REPORT_2026-06-22.md`.

## Phase 21A (2026-06-22) — Zoho zero-budget manual bridge + own outreach stack
Manual, low-volume outreach layer. **0 real sends**, SMTP still mailhog, Zoho `.env`
keys present but EMPTY (copy/paste-only until owner fills them).
- **Migration `0012_zoho_manual_bridge.sql`**: `sending_providers.provider_type` += `zoho_smtp_imap`;
  `sender_identities` += manual_sent_today, manual_counters_day, imap_enabled, imap_last_uid,
  imap_start_at, imap_last_checked_at; new tables `manual_outreach_queue`, `inbox_replies`,
  `manual_outreach_templates`.
- **NEW service `api/src/services/zoho.ts`**: presence/bridge-status, SMTP `verify()` test (never sends),
  IMAP connect test (read-only), low-volume incremental reply import (dedup by message-id, no delete/move),
  deterministic reply classifier. Uses `imapflow` (new dep). Secrets resolved from env at call time, never logged.
- **NEW router `api/src/routes/manualOutreach.ts`** (mounted `/manual-outreach`):
  zoho status/connect/test-smtp/test-imap · templates (3 seeded UNAPPROVED) · cohort preview/build
  (preset "Zoho manual bridge — 20 leads", default 20 / hard 50) · queue CRUD + approve/skip/dnc ·
  `:id/send` (Zoho SMTP one-by-one, gated; 412 smtp_not_configured w/ copyMode if no creds) ·
  `:id/copy` + `:id/mark-sent-manual` (copy/paste mode, audit only, no fake events) · replies list/import
  (IMAP, disabled until per-mailbox imap_enabled) /reclassify/suppress · suppress + CSV export/import ·
  warmup dashboard (day1=5/d2-3=10/d4-7=15/wk1+=20, recommendation only) · mailbox PATCH.
  **GOTCHA: `contact_points` has NO `tenant_id`** (global warehouse) — never filter it by tenant.
- **config.ts** `config.zoho` block (hosts/ports + env-var NAMES `ZOHO_SMTP_USER/PASSWORD`,
  `ZOHO_IMAP_USER/PASSWORD`). `.env` got these keys (empty).
- **Portal**: new `/manual-outreach` page (tabs Setup/Cohort/Queue/Replies/Warmup/Templates),
  nav item `manualOutreach` (3 locales), notes on /setup /send-control /warehouse /safety.
- Opt-out gate: send blocked unless draft body contains an opt-out line (regex in `hasOptOut`).
- See `docs/ZOHO_MANUAL_BRIDGE_2026-06-22.md` + `docs/PHASE21A_ZOHO_MANUAL_BRIDGE_REPORT_2026-06-22.md`.

## Phase 22 (2026-06-22) — Own Outreach Runtime
Make /opt/email our own controlled outreach runtime (replace paid SaaS). **0 real
sends, SMTP still mailhog, `.env` unchanged, Zoho creds present-but-empty.**
- **Migration `0013_own_outreach_runtime.sql`**: `sending_providers` += provider-neutral
  cols (env-var NAMES only): `imap_host/imap_port/imap_secure`, `smtp_user_ref/
  smtp_secret_ref/imap_user_ref/imap_secret_ref`, `inbound_enabled`, `outbound_enabled`,
  `test_status`, `last_smtp_test_at`, `last_imap_test_at`; provider_type ENUM +=
  `generic_smtp_imap, gmail_workspace_later, microsoft_365_later, self_hosted_smtp_imap_later`.
  `inbox_replies` += `confidence`, `classification_reason`; classification ENUM +=
  `unsubscribe`, `auto_reply`. NEW table `manual_followup_tasks`.
- **NEW service `api/src/services/mailboxRuntime.ts`**: provider-neutral. `resolveProvider`
  (env-ref→presence, never values), `testSmtp` (verify only, NEVER sends), `testImap`
  (read-only, no delete/move), `fetchReplies` (low-volume incremental), `classifyReply`
  (confidence + reason; 9 classes). OAuth NOT built (env-ref creds only).
- **manualOutreach.ts** new endpoints: `GET/POST /providers` + `/providers/:id/test-{smtp,imap}`;
  `GET /replies/threads` + `POST /replies/:id/create-followup`; full `/followups` CRUD
  (`POST /followups`, `/followups/generate`, `GET /followups`, `/:id/copy|mark-sent|skip|
  suppress|cancel`); `GET /today` (operator dashboard + next action); `GET /why-blocked?email=`
  (suppression-first debug); `GET /templates/:id/render?mode=variable|human` (REPLACE fields
  vs demo data). Reply import now sweeps ALL inbound mailboxes (any provider), stores
  confidence/reason, links queue item, auto-suppress only on ≥0.9 explicit opt-out.
- **Templates**: 5 new seeded UNAPPROVED — `clients_help_first_touch`,
  `clients_help_followup_1`, `clients_help_followup_2`, `remote_it_ps` (A/B P.S.),
  `no_ps_ab` (A/B control). UI shows `<<< REPLACE: Label >>>` not `{{var}}`.
- **Follow-ups** = manual TASKS only (no bulk, no scheduler). Blockers: reply received·
  bounce-like·do_not_contact/unsubscribe·suppressed·opt-out missing·mailbox paused·
  daily limit. Timing step1=3-4d, step2=7-10d, max 2.
- **Portal `/manual-outreach`**: new tabs Today(default)/Providers/Follow-ups; Replies
  upgraded to threads + one-click actions; Templates REPLACE/human toggle.
- **GOTCHA reminder**: `contact_points` has NO `tenant_id` (global warehouse) — never
  filter by tenant. `suppressEverywhere()` is hoisted (used before its definition in router).
- **DEFERRED FINAL TASK (record):** After the runtime is fully exercised, polish the
  Clients.Help first-sales workflow: final email copy; HTML preview with highlighted
  replacements; Zoho copy mode; follow-up templates; manual A/B test P.S.-remote-IT vs
  no-P.S.; first-sales dashboard. Do NOT build the full sales polish prematurely.
- See `docs/PHASE22_OWN_OUTREACH_RUNTIME_REPORT_2026-06-22.md` +
  `docs/SELF_HOSTED_MAIL_OPTION_DESIGN_2026-06-22.md` (design only — nothing installed).

## Phase 22A (2026-06-22) — Full Product Capability Audit (report-only)
Audit only — no features built, **0 real sends**, SMTP still mailhog, `.env` unchanged.
- **Current product status:** every cold-outreach subsystem is BUILT IN CODE but the runtime has
  NEVER been operated. Live DB: 29,188 companies / 77,850 contact_points (75,637 verified) but
  **0 sending_providers, 0 sender_identities/mailboxes**, 1 domain (main, dns_status=unknown,
  warmup 0), 8 templates **ALL unapproved**, manual_outreach_queue / inbox_replies /
  manual_followup_tasks all **empty**, global suppression 0, contacts subscribed=1 (pre-existing).
  All 13 migrations applied; all pages 200; api/worker/portal/db/redis healthy.
- **Completed (more than handoff recorded):** tracking.ts (open-pixel + click + one-click unsub)
  DONE; billing.ts (plans/checkout/invoices + stripe|manual adapter + requireActiveBilling) PARTIAL;
  multi-tenant isolation DONE; i18n en/ru/uk DONE; onboarding 5-step wizard DONE; reply inbox UI
  DONE; campaignRunner caps ENFORCED (Phase-17 gap CLOSED — binding MIN domain+mailbox+tenant
  daily+hourly).
- **Confirmed missing:** **email editor** (plain textarea), **HTML email preview** (desktop/mobile/
  dark — none), asset/image manager, automated sequence engine (follow-ups are manual tasks),
  usage metering, team seats, white-label, A/B auto-split. Biggest single gap = email editor + preview.
- **Readiness:** internal manual outreach 72 · Clients.Help first-sales 68 · safety 90 · compliance
  76 · own SMTP 38 · Smartlead-like 48 · public SaaS 30 · monetization 34.
- **Can replace Brevo/Smartlead now?** No. Can do MANUAL Clients.Help outreach once Zoho creds +
  1 approved template. Positioning: Lead Intelligence + Safe Outreach Runtime + Reply CRM
  (Woodpecker-with-built-in-lead-DB), NOT a Brevo mass-marketing clone.
- **Next recommended phase:** **22B Go-Live Bridge** (add Zoho creds → 1 mailbox → approve
  `clients_help_first_touch` → 20-lead cohort → manual copy-mode send ≤10 → import+classify replies).
  Then **22C Sender Studio** (editor + HTML preview + spam/link checker), then **22D Sequence &
  First-Sales Dashboard**.
- Reports: `docs/FULL_PRODUCT_CAPABILITY_AUDIT_2026-06-22.md` +
  `docs/OWNER_SUMMARY_WHAT_WE_HAVE_AND_WHAT_IS_MISSING_2026-06-22.md`.

> **DEFERRED FINAL TASK (still pending):** Clients.Help first-sales polish — final email copy,
> HTML preview w/ highlighted replacements, Zoho copy mode, follow-up templates, manual A/B
> (P.S. remote-IT vs no-P.S.), first-sales dashboard. Do NOT build prematurely; do it after 22B
> exercises the runtime. (Editor + HTML preview + safety checker now DONE in 22C below.)

## Phase 22C (2026-06-22) — Sender Studio (editor + HTML preview + safety checks)
Template build/preview/approve studio BEFORE outreach. **0 real sends, SMTP still mailhog,
`.env` unchanged, /opt/seo untouched, volumes intact.** Biggest 22A gap (no editor / no HTML
preview) CLOSED.
- **Migration `0014_sender_studio.sql`** (idempotent): extends `manual_outreach_templates`
  (+`preheader, html_body, blocks_json, category, language, status, editor_mode, use_case,
  safety_status, version, approved_by`). **`body` stays the canonical PLAIN-TEXT body that
  send/queue/followup code reads — backward compatible.** New table
  `manual_outreach_template_versions` (snapshot history). Backfills pack categories.
- **NEW service `api/src/services/senderStudio.ts`**: pure/deterministic — REPLACE-field UX
  (`{{key}}`↔`<<< REPLACE: Label >>>`), visual-lite `blocksToHtml/blocksToPlainText`,
  `sanitizeHtml` (strips script/style/iframe/on*/js: URIs), `wrapEmailHtml`, link extractor +
  `checkLinks`, spam/deliverability `validateTemplate` → `safe|warning|blocked` + blockers +
  badges, footer builder, `renderPreview`. **GOTCHA: spam-word scan strips HTML tags+CSS first
  so `width:100%` doesn't false-positive on the `100%` spam word.**
- **NEW router `api/src/routes/senderStudio.ts`** (mounted `/sender-studio`, tenant-isolated):
  meta/footer; templates CRUD; duplicate/archive/unarchive; approve (412 `approval_blocked`
  with blockers if cold lacks opt-out/address or unsafe HTML) / unapprove; `:id/validate`;
  ad-hoc `POST /validate` + `POST /preview` (live editor, nothing saved); `:id/preview`
  (desktop/mobile/dark/plain/source via client; html wrapped+sanitised); `:id/versions`;
  `:id/export?format=json|html|txt`; `POST /import` (always UNAPPROVED draft, HTML sanitised);
  `POST /seed-clients-help`. **NO send endpoint here.** Editing an APPROVED template snapshots
  it + reverts live row to unapproved draft v+1.
- **Clients.Help pack**: 8 new seeded UNAPPROVED (`ch_first_touch_no_ps/_ps`, `ch_followup_1_no_ps/_ps`,
  `ch_followup_2_final`, `ch_wrong_person`, `ch_interested_reply`, `ch_not_now`). Total templates
  now 16, **0 approved**. P.S. = "We also help businesses remotely with website, WordPress,
  automation, and small IT tasks when needed."
- **Portal**: new `/sender-studio` page (list + 3-mode editor + variable panel + footer button +
  live validation/badges + 5-mode preview + versions + import/export). Nav item `senderStudio`
  (en/ru/uk). Cross-link from Manual Outreach → Templates tab.
- Smoke verified: approve-gate blocks then passes, version bump+history, sanitise on import,
  preview render, export. Build green; all pages 200; healthcheck OK.
- See `docs/PHASE22C_SENDER_STUDIO_REPORT_2026-06-22.md` +
  `docs/SENDER_STUDIO_OPERATOR_GUIDE_2026-06-22.md`.

## Phase 22D (2026-06-22) — Multi-Mailbox Orchestrator + Fleet Manager
Internal Smartlead/Instantly-style multi-mailbox management. **0 real sends, SMTP
still mailhog, `.env` not modified by this phase, /opt/seo untouched, volumes intact.**
- **Migration `0015_multi_mailbox_orchestrator.sql`** (idempotent): `sending_providers`
  (=PROVIDER PROFILE) += `default_from_name/default_daily_limit/default_hourly_limit`,
  status enum→`pending/active/disabled/error`. `sender_identities` (=MAILBOX) += `outbound_enabled,
  inbound_enabled, smtp_user_ref/smtp_secret_ref/imap_user_ref/imap_secret_ref, health_status
  (safe/warning/danger/unknown), last_smtp_test_at, last_imap_test_at, last_reply_at, last_error,
  smtp_sent_today, replies_today, interested_today, negative_today, bounce_like_today,
  complaints_today, unsubscribes_today`; purpose+=`internal_test,support`; status+=`draft,error`;
  **domain_id → BIGINT UNSIGNED NULL** (FK kept; GOTCHA: must keep UNSIGNED or ER_FK_COLUMN_CANNOT_CHANGE).
  NEW table `outreach_touchpoints` (contact touch ledger). `from_email` stays canonical (API exposes as `email`).
- **NEW service `api/src/services/mailboxFleet.ts`**: env-ref generator (`SALES1_EXAMPLE_COM_SMTP_USER`…),
  `rollMailboxCounters`, `computeHealth`, `recommendNextLimit` (ramp 5→10→15→20→30→40, health-gated,
  NEVER auto), `mailboxBlockers`, **`assignMailboxes`** (pure; strategies healthiest_first/least_used_today/
  round_robin/fixed_mailbox; preserves same mailbox per contact/company; per-domain≤5/day; respects limits+
  status), `recordTouchpoint` (best-effort), `priorMailboxMaps`, `fleetStats`, CSV parse/format.
- **NEW router `api/src/routes/mailboxes.ts`** (mounted `/mailboxes`, tenant-scoped, **NO send endpoint**):
  providers CRUD + `seed-zoho-eu` (smtp.zoho.eu:587 STARTTLS / imap.zoho.eu:993, 5/2) + `:id/disable`;
  mailbox CRUD; `:id/env-snippet` + `bulk-env-snippet` (empty values only); `:id/test-smtp|test-imap`
  (verify/read-only, NEVER send/delete; **failed test does NOT stamp last_*_test_at** so activate gate holds)
  + `test-batch` (≤10); `:id/activate` (412 activation_blocked until SMTP test passes; main/transactional
  blocked) `/pause` `/disable`; `:id/ramp` + `:id/set-limit` (only limit path, audited `mailbox.limit_change`);
  `import/csv`(≤500, draft only, row-by-row, no passwords)+`export/csv`(ref NAMES only); `fleet`;
  `assign-queue`(dryRun default)+`queue/:id/reassign`; `touchpoints/list`.
- **manualOutreach.ts hooks**: touchpoints on SMTP-send/mark-sent-manual/followup-mark-sent; cohort build
  now auto-assigns mailboxes; reply import bumps mailbox reply counters+last_reply_at, writes inbound
  touchpoint, **cancels pending follow-ups on reply** (`followup.cancelled_due_reply`). Queue statuses are
  `pending_review`/`approved` (NOT pending/ready — that tripped the assign WHERE first pass).
- **Portal**: new `/mailboxes` page (tabs Fleet/Mailboxes/Provider profiles), nav item `mailboxes` (en/ru/uk).
- Validation: build green, migrate applied, healthcheck OK, all pages 200, authed smoke (seed/create/test/
  activate-gate/CSV/export/fleet/assign/touchpoint) PASS, test rows cleaned, Zoho EU profile (id 3) kept.
- See `docs/PHASE22D_MULTI_MAILBOX_ORCHESTRATOR_REPORT_2026-06-22.md` +
  `docs/MULTI_MAILBOX_ORCHESTRATOR_OPERATOR_GUIDE_2026-06-22.md`.

## Phase 22E (2026-06-22) — Go-Live Wizard / First Outreach Control Center
Operator-first guided first launch. **0 real sends, SMTP still mailhog, `.env` unchanged,
/opt/seo untouched, volumes intact, no new migration.** The wizard is **NOT a lead finder** —
it selects from EXISTING Warehouse `contact_points` only (NO Tavily/OSM/Maps/collector/
scraper/enrichment, creates NO new contact_points). Owner-correction applied: Step 3 =
"Select existing leads".
- **NEW router `api/src/routes/goLive.ts`** (mounted `/go-live`, tenant-scoped):
  `GET /status` (live audit + 7-step checklist + readiness score 0–100 + status + top blockers
  + single next action + embedded Today + Clients.Help preset + safety block);
  `POST /plan` (pure day-1 plan: 5/mailbox, ramp 5→10→15→20, health-gated, never over limit);
  `POST /dry-run` (selects ≤20 EXISTING eligible leads, simulates mailbox assignment, lists
  would-queue/blockers/missing — **creates nothing**); `POST /create-first-queue`
  (requireWriteAccess + `acknowledge:true`; ≤20 `manual_outreach_queue` pending_review rows
  from existing eligible contact_points + mailbox assign; HARD GATES: no approved tmpl→412,
  no active mailbox & no copyMode→412, queue-full→409, no ack→400; sends/subscribes/schedules
  NOTHING; suppression rechecked per row, never bypassed).
- **manualOutreach.ts** — `export`ed reusable helpers `buildCohort, ensureTemplates,
  isEmailSuppressed, renderTemplate` + `QUEUE_DEFAULT_MAX/QUEUE_HARD_MAX/DEFAULT_DAILY`
  (no behaviour change; goLive reuses them).
- **Readiness score** weights: provider 10 · mailbox 10 · active 10 · SMTP test 20 · approved
  template 25 · eligible cohort 15 · suppression health 5 · reply import 5. Statuses:
  Not ready / Setup needed / Ready for manual copy-mode / Ready for one-by-one SMTP /
  Running safely / Paused due risk.
- **Portal**: new `/go-live` page (score card, Today strip, 7-step checklist with Ready/
  Needs-action/Blocked pills + per-blocker fix links, source selector
  [Existing Warehouse leads | Manually selected leads], Preview/Plan/Create buttons — **no
  send-all button**). Nav item `goLive` (en "Go Live" / ru+uk "Запуск").
- Live audit at ship: 75,641 eligible existing leads (preset 3,463), 16 templates 0 approved,
  1 mailbox active but SMTP untested → score **50 / "Setup needed"**. Smoke: gates 412+400,
  happy path 20 pending_review + 10 assigned (cap), test rows fully cleaned, subscribed stayed 1.
- See `docs/PHASE22E_GO_LIVE_WIZARD_REPORT_2026-06-22.md` +
  `docs/GO_LIVE_WIZARD_OPERATOR_GUIDE_2026-06-22.md`.

## Phase 22E follow-up (2026-06-23) — full-system smoke + crash-bug fix
Ran a full operator-journey smoke (`scripts/full_system_smoke.sh`): mints JWT (sub=1,
x-tenant-id:1), exercises every subsystem via the APIs the UI calls + renders all 17
operator pages, then cleans up. **Result 70/70** (one earlier miss was a test-side bad
enum). Safety invariants held: real SMTP sends=0, subscribed=1, campaigns scheduled=0,
SMTP_HOST=mailhog, all test rows removed.
- **BUG FOUND + FIXED (was a real outage):** `POST /mailboxes` with no `display_name`
  inserted `from_name=NULL` into `sender_identities` (NOT NULL col) → `ER_BAD_NULL_ERROR`.
  Because **Express 4 does NOT forward async-route rejections** and the app has NO
  async-error wrapper anywhere, that single bad insert **crashed the whole API process**
  (every in-flight request for all tenants dropped; container restarted). Fixes:
  (1) `mailboxes.ts` create now defaults `from_name = display_name ?? email-local-part`;
  (2) `index.ts` added `process.on('unhandledRejection'|'uncaughtException')` guards that
  log and KEEP THE API ALIVE — one throwing handler can no longer take down the service.
- **Known minor gaps (not fixed):** no `DELETE /mailboxes/:id` route (operator can only
  disable, not delete — 404 on DELETE); go-live readiness `nextAction`/blocker text and a
  few API hint strings are still English (server-side, would need codes to localize).
- ⚠ **Systemic note:** the whole API is Express 4 with no per-route async-error catcher;
  the global guards now prevent crashes but the offending request still hangs to client
  timeout. Long-term: add an asyncHandler wrapper (or `express-async-errors`) so failing
  routes return 500 instead of hanging.

## Phase 22E.2 (2026-06-23) — UI credential entry (secrets vault) + first live mailbox
Owner wanted to enter mailbox credentials FROM THE UI (not by editing server `.env`).
- **Migration `0016_mailbox_secrets.sql`**: `mailbox_secrets(tenant_id, ref_name UNIQUE,
  value_enc, updated_at)` — stores SMTP/IMAP creds AES-256-GCM encrypted (key = sha256 of
  API_JWT_SECRET).
- **NEW `api/src/services/secretsVault.ts`**: `encryptSecret/decryptSecret`, `setSecret`,
  `resolveSecret(ref)` = **DB-first then `process.env[ref]` fallback** (existing .env
  mailboxes keep working), `storedRefs` (UI 🔑 badges). Secrets write-only, never returned/logged.
- **`mailboxRuntime.ts`**: `testSmtp`/`testImap`/`imapClient`/`fetchReplies` now resolve
  creds via `resolveSecret` (was `process.env` only). `imapClient` is now async + returns
  null if unconfigured.
- **`mailboxes.ts`**: new `PUT /mailboxes/:id/credentials` {smtp_user,smtp_password,
  imap_user,imap_password,imap_same_as_smtp} → encrypts under the mailbox's ref names; list
  view returns `creds_stored:{smtp,imap}`. **Portal `/mailboxes`**: "🔑 Данные входа" form
  per row (user+pass, "IMAP same as SMTP"), Save→Test→Activate fully from UI.
- **Two `/mailboxes` UX bugs fixed** (user-reported): result banner was auto-hiding after 4s
  → now persistent with ✕; test buttons reported HTTP-200 as success even when the SMTP/IMAP
  verify FAILED → now read `body.ok`/`detail` and show the true verdict + activation blockers.
- **FIRST LIVE MAILBOX:** `novatradersio@zohomail.eu` (id=5, provider 3 Zoho EU) — creds
  entered, SMTP `verify_ok` + IMAP `imap_ok` (77 msgs), **ACTIVATED**. Creds stored in the
  vault; its `.env` password lines were blanked to PROVE vault works (test still passes).
  Go-Live readiness now **100/100**. (App password for that box is in the vault; SMTP_HOST
  still mailhog for the campaign engine — unchanged.)
- **Docs:** `docs/FULL_OPERATOR_AND_ADMIN_GUIDE_RU_2026-06-23.md` + served HTML
  `portal/public/guide-ru.html` (full client+admin walkthrough, ChatGPT-feedable) and short
  `portal/public/start-ru.html`.

## Phase 22F (2026-06-23) — Self-Hosted SMTP Node Readiness Manager
Readiness/risk/DNS/reputation manager for FUTURE dedicated self-hosted SMTP nodes.
**NOT an MTA installer.** 0 real sends, SMTP still mailhog, `.env` unchanged, port 25
NOT opened (not listening), no MTA installed, DNS unchanged, /opt/seo untouched.
- **Migration `0017_smtp_nodes.sql`**: new `smtp_nodes` table — **metadata only** (no SMTP/
  root/SSH/account secrets). Node identity + isolation + PTR + spf/dkim/dmarc/mx/tls/
  forward_dns/port25 statuses + abuse/postmaster/bounce mailbox statuses + blacklist + manual
  reputation (spamhaus/barracuda/microsoft_snds/google_postmaster) + readiness_score/level +
  risk_level + safe_to_connect_as_provider/safe_to_send + blockers/warnings/checklist JSON.
- **NEW service `api/src/services/smtpNodes.ts`**: deterministic `runReadiness()` (read-only
  `node:dns`; optional read-only TCP connect to 25 — NEVER writes SMTP data), `dnsChecklist()`
  (instructions only), `reportJson/reportMarkdown`, `productionIps()`. **Production-IP guard:**
  hard fallback `KNOWN_PRODUCTION_IPS=['84.247.139.105']` (env `SERVER_PUBLIC_IP` override;
  `.env` NOT touched) + docker iface IPs — node on that IP ⇒ `blocked`. GOTCHA: API container
  only sees 172.x docker IPs and `emails.cheap` is behind Cloudflare (188.114.x), so neither
  interfaces nor DNS reveal origin — hence the hard fallback.
- **NEW router `api/src/routes/smtpNodes.ts`** (mounted `/smtp-nodes`, tenant-scoped, **NO send
  endpoint**): CRUD; `:id/check` (readiness, opt-in `probePort25`); `:id/dns-checklist`;
  `:id/reputation` (manual blacklist); `:id/manual-item`; `:id/disable`; `:id/report?format=
  markdown|json`; `:id/create-draft-provider` (412 until `ready_for_tiny_test` — creates
  `sending_providers` `self_hosted_smtp_imap_later` status=pending, outbound off, 5/day·2/hr,
  no secrets); DELETE (draft/disabled only); `/env` (production IPs + safety facts).
- **Portal** new `/smtp-nodes` page (list + add form + detail checklists + manual reputation +
  DNS checklist + export). Nav item `smtpNodes` (en SMTP Nodes / ru SMTP-ноды / uk SMTP-ноди);
  full `smtpNodes` i18n block in all 3 locales (parity validated).
- Smoke PASS: prod-IP node BLOCKED w/ prod-ip blocker; fake domain ⇒ PTR/SPF/DKIM/DMARC/bounce
  blockers; provider gate 412 below threshold; spamhaus=listed ⇒ blacklist blocker; report
  md/json w/ "not allowed to send until all critical blockers resolved"; no send endpoint (404);
  test rows cleaned (smtp_nodes=0); sending_providers unchanged (3); subscribed=1.
- See `docs/PHASE22F_SELF_HOSTED_SMTP_NODE_READINESS_REPORT_2026-06-22.md` +
  `docs/SELF_HOSTED_SMTP_NODE_READINESS_OPERATOR_GUIDE_2026-06-22.md`.

## Phase 22G (2026-06-23) — Outreach drip scheduler (automatic time-distributed sending)
First automatic real-send path. **OFF BY DEFAULT** — 0 real sends until owner arms it.
- **Migration `0018_outreach_drip.sql`**: `outreach_drip_settings(tenant_id PK, enabled,
  daily_per_mailbox=20, hourly_per_mailbox=2, min_interval_min=25, window_start_hour=0,
  window_end_hour=24, enabled_at, last_tick_at, sent_total)`; `manual_outreach_queue` +=
  `send_attempts`, `last_send_error` (IF NOT EXISTS).
- **NEW `api/src/services/mailboxRuntime.ts → sendFromMailbox(conn, msg)`**: provider-neutral
  REAL send, resolves creds via vault (`resolveSecret`, DB-first/env-fallback), nodemailer,
  never logs secret. (The old `manual-outreach/queue/:id/send` is Zoho-env-only; drip uses the
  vault path so it works with the Spacemail/clients.help boxes.)
- **NEW worker `workers/src/manualOutreachDrip.ts`** (registered in `workers/src/index.ts`):
  60s loop, no-op unless a tenant has `enabled=1` AND not `outreach_paused`. Per active outbound
  mailbox: usage counted from the queue ledger (UTC_DATE/last-hour/last-sent), enforces MIN(drip
  cap, mailbox cap) daily+hourly + min-interval spacing + UTC send window; picks ONE oldest
  `approved` item assigned to that mailbox (`send_attempts < 5`); re-gates (approved + opt-out +
  not suppressed) then sends via vault SMTP; writes `sent_smtp`, bumps counters, touchpoint.
  Self-contained (mirrors vault AES-GCM decrypt + suppression + hasOptOut; no api cross-import).
- **API** (manualOutreach.ts): `GET /manual-outreach/drip` (settings + live snapshot: ready/
  unassigned/sent_today + per-mailbox) · `POST /manual-outreach/drip` (config; **enable requires
  `confirm:true` → else 412**; audited drip.enable/disable/config).
- **Portal**: new **Drip** tab in `/manual-outreach` — state pill, Enable(confirm)/Stop, snapshot,
  per-mailbox table, pacing form (hourly/daily/interval/window). i18n en/ru/uk (`manualOutreach.drip.*`).
- **GOTCHA**: enabling drip = REAL automatic outbound; the agent auto-mode classifier (correctly)
  blocks the agent from arming it — owner must toggle from the UI. Verified disabled-state: control
  endpoints work, enable-without-confirm 412, worker idle, 0 sends; test queue row cleaned.
- Defaults requested by owner: 2/hr·20/day per mailbox (note: 20/day aggressive for warmup=0 boxes;
  limits are editable). 3 active boxes: novatradersio@zohomail.eu, support@469diamond.com,
  support@clients.help (Spacemail provider id 7, 465/993 SSL).

## Phase 22G-PD (2026-06-23) — Partner Directory Contact-Form Outreach Queue
(Independently named; NOT the drip scheduler 22G above. Different tables/routes/page.)
Operator-controlled **NON-EMAIL** outreach: import visible partner-directory companies,
generate a short partner message, open the directory Contact form, copy/paste, **submit
manually**, track replies. **0 real sends, nothing auto-submitted, SMTP still mailhog,
`.env` unchanged, /opt/seo untouched, volumes intact.**
- **Migration `0019_partner_directory_outreach.sql`**: `partner_directory_sources`
  (ziftone/manual/other) — **seeded Intuit Partner Directory** (`https://intuit.ziftone.com/#/page/directory`);
  `partner_directory_targets` (10-state status, dedupe_key = profile-url→website-host→norm-name,
  contact_form_url, contact_attempt_count, raw_metadata_json); `partner_contact_tasks`
  (one task = one company contact form; status pending_review/ready/opened/copied/
  submitted_manually/replied/skipped/blocked/do_not_contact; blockers_json); `partner_message_templates`
  (5 seeded `<<< REPLACE: Label >>>` copy/paste templates); `partner_outreach_daily` (rate ledger).
- **NEW service `api/src/services/partnerOutreach.ts`**: seedSourceAndTemplates, parseImportText
  (CSV/URL/name), rowToTarget, dedupeKey, renderPartnerMessage (slugified REPLACE fill, keeps
  placeholder if unfilled → drives the review gate), daily-count get/bump, `recordPartnerTouch`
  → bridges into existing `outreach_touchpoints` via mailboxFleet.recordTouchpoint (channel=contact_form).
- **NEW router `api/src/routes/partnerOutreach.ts`** (mounted `/partner-outreach`, tenant-isolated,
  **NO send/auto-submit endpoint**): sources CRUD · targets import(dryRun→confirm, dedupe, max 200)/CRUD/
  do-not-contact · `POST /discover` (returns `available:false, limited` — no headless browser, never
  bypasses login/captcha) · templates CRUD/render · tasks create(template+REPLACE vars; duplicate-task
  blocked; pending_review if unfilled placeholder/no URL)/open/copy/mark-submitted/skip/do-not-contact/
  reply · `GET /today` · `GET /status` · `POST /seed`.
- **Rate limits ENFORCED**: 5 submissions/source/day + 20 tasks/day (429); suppressed/skipped/blocked
  targets excluded; reply/not-interested/do-not-contact cancels open follow-up tasks.
- **Browser discovery = LIMITED** (no playwright/puppeteer installed; ZiftOne is login/captcha SPA).
  Manual import is the path; build did NOT add a scraper.
- **Portal** new `/partner-outreach` (tabs Today/Sources/Targets/Tasks/Templates, no send-all button);
  nav `partnerOutreach` + i18n block en/ru/uk (parity).
- Smoke PASS (tenant 1): seed, import+dedup, task create+dup-block, copy/mark-submitted/do-not-contact
  touchpoints (copied/sent_manual/blocked), submission-cap 429, discover limited, /submit 404. Test rows
  cleaned (targets/tasks/contact_form-touchpoints/daily ledger = 0; seed source 1 + templates 5 kept;
  subscribed stayed 1). See `docs/PHASE22G_PARTNER_DIRECTORY_OUTREACH_REPORT_2026-06-22.md` +
  `docs/PARTNER_DIRECTORY_OUTREACH_OPERATOR_GUIDE_2026-06-22.md`.

## Next owner action
To go live (deliberate): (1) set Brevo SMTP in `.env` (see `/setup` checklist),
restart api+worker, confirm `/setup` shows `ready`. (2) **Implement 5/hour·20/day caps
in campaignRunner.** (3) Set Brevo webhook URL to
`https://emails.cheap/api/webhooks/brevo?token=<WEBHOOK_BOUNCE_SECRET>&tenant_id=1`.
(4) Manually subscribe specific test contacts (never mass) → test-send to self →
schedule list 2 with caps.

## Useful commands
```bash
cd /opt/email
docker compose ps
docker compose logs --since=2m worker | grep leadPromoter
docker compose build api worker portal && docker compose up -d
docker compose exec -T api node /app/dist/cli/migrate.js
bash scripts/healthcheck.sh
# DB (creds from .env; never echo them):
# docker compose exec -T db mariadb -u<DB_USER> -p<DB_PASSWORD> <DB_NAME> -e "..."
```
