# Phase 0 — Current System Audit

**Project:** `/opt/email` — B2B + Affiliate Outreach Engine upgrade
**Date:** 2026-07-23
**Mode:** Read-only audit. Nothing changed. No implementation started (per TZ §3).

> Headline: `/opt/email` is a mature, working outreach platform. A large share of the
> TZ's requirements **already exist** and should be reused, not rebuilt. The genuinely
> new work is the two-mode split (OWN_PRODUCT_B2B vs AFFILIATE), the affiliate offer
> registry + compliance, and affiliate click/conversion/revenue attribution.

---

## 1. Repository & directory structure

```
/opt/email/
├── api/            Node/TypeScript API (Express), built to dist/
├── workers/        background worker (lead discovery, collector, verifier)
├── portal/         admin/portal frontend
├── db/migrations/  SQL migrations (0001–0021)
├── scripts/        *.mjs send/ops scripts (warmup, audit outreach, unsuppress…)
├── nginx/          vhost config
├── postal/         Postal mail server config (submodule stack)
├── monitoring/     Prometheus + Grafana + alerts
├── docs/, reports/, imports/, data/, logs/, backups/, mautic/
```

Top-level docs: `README.md`, `CHANGELOG.md`, `ROADMAP.md`, `AI_HANDOFF_CONTEXT.md`,
`LAUNCH_STAGE3_REPORT.md`, plus this TZ.

## 2. Application stack & versions

| Service | Image | State |
|---|---|---|
| email_api | email-platform-api (Node **v22.23.1**, Express/TS) | Up, healthy |
| email_worker | email-platform-worker | Up, healthy |
| email_db | **mariadb:11.4** | Up, healthy |
| email_redis | redis:7.4-alpine | Up, healthy |
| email_portal | email-platform-portal | Up, healthy |
| email_prometheus | prom/prometheus:v3.0.1 | Up, healthy |
| email_grafana | grafana/grafana:11.4.0 | Up, healthy |
| Postal (separate stack) | ghcr.io/postalserver/postal:3.3.4 | Up (SMTP/worker/web) |

## 3. Services, timers, cron jobs

No systemd units for the app (Docker Compose managed). Cron (`crontab -l`) drives sends —
**7 entries touch /opt/email**:

| Schedule | Job | Purpose |
|---|---|---|
| 0 10 * * * | warmup_send.mjs | daily warmup, emails.cheap |
| 0 11 * * * | warmup_send_pilot.mjs | daily warmup, 5 brand domains |
| 0 11 * * * | clearorchard_pilot_send.mjs | pilot |
| 0 13 * * * | **audit_daily_send.sh** | audit-outreach batch (25/day) |
| 5 * * * * | postal_unsuppress_reputation.mjs | clears reputation-only Postal holds hourly |
| 0 8,20 * * * | warmup_monitor.sh | warmup health |
| 0 3 * * * | make backup | daily encrypted DB+config backup |

## 4. Database (MariaDB `email_platform`) — 79 tables

Largest / most relevant:

| Table | Rows | Role |
|---|---|---|
| contact_points | 173,493 | emails/phones per company (**contacts**) |
| discovered_leads | 167,189 | raw discovered leads |
| companies | 60,478 | company records (country, industry, category) |
| email_domain_mx | 73,122 | cached MX verdict (sendable?) |
| outreach_touchpoints | 5,855 | **per-contact send history / dedup** |
| audit_log | 3,102 | **audit trail** |
| manual_outreach_queue | 1,794 | send queue |
| global_contact_suppression | 421 | **global suppression** |
| suppressions | 366 | per-tenant suppression |
| inbox_replies | 89 | **reply ingestion + classification** |
| outreach_drafts / _versions | 70 / 67 | **reply/message drafts, versioned** |
| outreach_approval_events | 76 | **approval workflow events** |
| manual_outreach_templates / _versions | 27 / 14 | **templates, versioned + structured** |
| sender_identities | 37 | **mailboxes** |
| sending_providers | 4 | provider config (Postal etc.) |
| company_product_fit | 9,935 | **company→product match scoring** |
| platform_settings | 3 | key/value settings |

## 5. Mailbox inventory & limits

- **37 mailboxes** (36 active) across **9 domains**.
- `sender_identities` **already has** `daily_send_limit` (default 10) and
  `hourly_send_limit` (default 3) columns.
- **Gap:** the live send scripts (`warmup_send*.mjs`, `audit_outreach_send.mjs`) do **not**
  read those per-mailbox columns. They enforce volume with their own ramp arrays / a hard
  `--cap`. So the "current limit" is script-enforced, not schema-enforced.
- **TZ requires 20/day, 2/hour per mailbox.** Current per-mailbox reality: audit outreach
  caps 25/batch across 4 clients.help mailboxes (~6 each), warmup pilot adds ~25 each →
  ~31/mailbox/day on those four. **This exceeds the TZ's 20/day figure** and must be
  reconciled before any new campaign volume is added (owner decision — §Blockers).

## 6. Sending, retry, bounce, reply, unsubscribe logic

- **Sending:** cron copies a script into the api container and runs it; it selects
  candidates (SQL), checks suppression + touchpoints + Postal suppression list + MX cache,
  sends via Postal SMTP, writes an `outreach_touchpoints` row.
- **Retry:** none at the app layer for cold sends (single attempt); Postal handles its own
  transient retries. A touchpoint is written at accept time, so **no duplicate on rerun**.
- **Bounce:** `postal_unsuppress_reputation.mjs` (hourly) distinguishes reputation holds
  from genuine bad addresses; `syncPostalBounces()` in warmup suppresses invalid addresses.
- **Reply:** `inbox_replies` populated by a reply importer (IMAP), classified by rule into
  interested / auto_reply / bounce_like / wrong_person / unsubscribe / not_interested /
  unknown. Alerts on interested/unknown via a monitored inbox.
- **Unsubscribe:** one-click `List-Unsubscribe` + `/u/m/` link on each send; feeds
  `global_contact_suppression` / `suppressions`.

## 7. Dashboards / admin / API

- **33 API route files**, including directly reusable ones: `campaigns.js`, `contacts.js`,
  `sending.js`, `deliverability.js`, `manualOutreach.js`, `outreachDrafts.js`,
  `mailboxes.js`, `senderIdentities.js`, `adminSafety.js`, `productProfiles.js`,
  `partnerOutreach.js`, `senderStudio.js`, `goLive.js`, `domains.js`.
- Portal frontend (`email_portal`) + Grafana dashboards + Prometheus alerts already exist.
- Separate audit product dashboard at **audit.clients.help** (the prospect-audit system).

## 8. Secrets, auth, DNS

- **Secrets:** mailbox credentials in encrypted `mailbox_secrets` (AES-GCM), resolved at
  runtime via `secretsVault`/`resolveSecret`. Platform secrets in `.env` (git-ignored).
  No credentials in Git.
- **SPF/DKIM/DMARC:** repaired 2026-07-17. `emails.cheap` = `v=spf1 a mx
  include:spf.emails.cheap ~all` (PASS on the envelope `rp.emails.cheap`); `clients.help`
  clean; DKIM per-domain via Postal selectors; DMARC `p=none` with rua.

## 9. Known errors (last 7 days)

- ~1,202 worker log lines match error/level:50 — **dominated by expected Overpass mirror
  timeouts** in the perpetual collector (handled by mirror rotation), not send failures.
  No send-path fatal pattern observed. (Full triage deferred to Phase 1.)

## 10. Disk & backups

- Disk: `/` 72% used, **55G free**. `/opt/email` tree = 392M (data lives in Docker volumes
  + DB).
- **Backups:** daily **encrypted** archives `backups/backup-YYYYMMDDTHHMMSSZ.tar.gz.gpg`
  (latest 2026-07-23). `make backup` cron at 03:00.
- **Not yet present:** the TZ's suggested `/opt/backups/email-outreach/<UTC>/` snapshot —
  to be created **before** Phase 1 implementation (§2.1).

## 11. Security risks / gaps observed

- Per-mailbox limit columns exist but are **not enforced** by senders → limits live only in
  scripts (fragile; a new script could exceed them). TZ wants enforced 20/2.
- No `campaign_mode` concept → own-product and (future) affiliate traffic are not separated.
- No affiliate offer registry, compliance snapshot, or click/conversion/revenue tracking.
- Reply classes are coarser than the TZ's set (no MEETING_REQUEST / REQUEST_DETAILS /
  REFERRAL / LEGAL_OR_PRIVACY split).
- Touchpoints carry no `campaign`/`mode` tag → cross-campaign analytics are coarse.

## 12. Missing tests

No automated test suite covering the TZ's 20 required invariants (suppression-before-queue,
dedup-on-restart, complaint-pauses-campaign, affiliate-offer-gating, etc.). Send scripts are
verified manually. A test harness is net-new work.

## 13. Components that WILL be modified vs REUSED

**Reuse as-is (already provide the TZ function):**
`global_contact_suppression` + `suppressions` (→ global suppression), `contact_points` +
`companies` (→ contacts + sources), `manual_outreach_templates` + `_versions` (→ structured
templates), `outreach_drafts` + `_versions` (→ reply drafts, no auto-send), `outreach_approval_events`
(→ approval workflow), `audit_log`, `inbox_replies` (→ reply ingestion), `sender_identities` +
`mailbox_secrets` (→ mailboxes/secrets), `sending_providers`, `company_product_fit` (→ relevance scoring).

**Extend (additive migrations):**
`sender_identities` (enforce daily/hourly limits), campaigns table/route (add `campaign_mode`
+ lifecycle states), `inbox_replies` (richer reply classes), `outreach_touchpoints` (add
campaign/mode tag).

**Net-new (build):**
`affiliate_offers`, `affiliate_offer_terms_versions`, `compliance_snapshots`, `click_events`,
`conversion_events`, `revenue_events`, `campaign_experiments`; affiliate compliance gate;
conversion/postback ingestion; the 20 automated tests; docs.

---

## 14. Recommended staged plan (for owner approval before Phase 1)

The TZ is a multi-week build with mandatory human approval at each gate. Proposed order,
each a reviewable increment (no sending without approval, per §20/§26):

1. **Backup** to `/opt/backups/email-outreach/<UTC>/` (schema+data+config+cron+nginx),
   checksummed and verified — the §2.1 precondition.
2. **Additive migrations only:** `campaigns.campaign_mode` + lifecycle, `affiliate_offers`
   (+ terms versions), `compliance_snapshots`, `click/conversion/revenue_events`, campaign
   tag on touchpoints. Every migration with a rollback.
3. **Global suppression hardening** (double-check before queue AND before send — mostly
   present; formalize + test).
4. **Enforce per-mailbox 20/day, 2/hour** in a shared send guard (reconcile with current
   ramp — owner decision on the warmup/audit overlap).
5. **Affiliate offer registry + compliance gate** (block send unless offer APPROVED +
   cold_email_allowed + geo allowed + disclosure present + terms fresh).
6. **Reply classes + escalation** (richer set; complaint→pause, legal→escalate).
7. **Conversion/revenue attribution** (own-product pipeline + affiliate postback, idempotent).
8. **3 draft experiments** (A: website audit; B: Security Check / Clients.Help; C: one
   legitimate B2B SaaS affiliate — only if its program's written terms allow cold email).
9. **Test harness** (the 20 invariants) + **docs** (7 files) + final reports.

---

## 15. Blockers / owner decisions needed before implementation

1. **Limit reconciliation.** TZ mandates 20/day + 2/hour per mailbox. Current warmup+audit
   overlap puts ~31/day on 4 clients.help mailboxes. Confirm: enforce 20/2 (which forces
   the audit campaign to shrink or move to dedicated mailboxes), or set a different owner-approved
   number? **Nothing proceeds on volume until this is set.**
2. **Affiliate track go/no-go for now.** TZ §26 prefers proving own-product B2B first. Do we
   build the affiliate registry now (schema + gate, no live offer), or defer affiliate until
   own-product is proven and only scaffold the tables?
3. **Scope/pace.** This is large. Confirm the staged order above, and that each phase stops
   for approval before the next (especially anything that sends).
4. **Existing audit campaign.** The live 25/day audit outreach — keep running as-is during
   the build, or fold it into the new campaign-mode model first?

**No implementation has started. Awaiting owner direction on §15 before Phase 1.**
