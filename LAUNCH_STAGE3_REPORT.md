# Launch Stage 3 — Production Readiness Report
Date: 2026-07-12 · Branch: `launch-stage3` · Scope: `/opt/email` · No new features (launch engineering)

## What was done (per task, each a separate commit)

| Task | Result |
|---|---|
| **Before** | Backup `/opt/backups/email_launch_stage3_20260712T112413Z/` (DB dump + .env snapshot + source). Branch `launch-stage3`. Remote `cloudrec/email` not fetchable (empty/blocked) — local is authoritative. |
| **1 Sending engine** | Audited all 6 SMTP-send call sites → 2 engines. Fixed the real CONFLICTS. **Consolidation done:** the worker secret resolver (2 divergent copies, no allowlist, `insecure-dev-key` fallback → env-exfil risk) is now one hardened `workers/src/secretsVault.ts` (SECRETS_MASTER_KEY, boot-refuse, `ENV_REF_ALLOWED`). Verified: resolves real cred, blocks `API_JWT_SECRET`. |
| **2 Sender identity authority** | Authoritative = **`sender_identities`** (From, caps, counters); `sending_providers` = transport+creds; `domains` = DKIM. `smtp_nodes` = readiness telemetry only, **not a send path**. `sending_providers.default_*` limits are dead config (never read at send). Documented; no risky refactor. |
| **3 Warmup engine** | **DONE + live.** Auto ramp day 1=5,2=8,3=12,4=18,5=25,… (`warmup.ts WARMUP_RAMP`) + `workers/warmupScheduler.ts`: once/UTC-day per active mailbox, advance `warmup_stage` + set `daily_send_limit`; **auto-pause** when same-day bounce>3% or complaint>0.1%. Verified: mailboxes ramped, limits now warmup-safe. |
| **4 Deliverability Center** | **DONE.** Added live **Spamhaus + Barracuda DNSBL**, HELO/STARTTLS/banner from the Postal probe, daily/hourly limit totals. Google/Microsoft reputation + true inbox/spam placement honestly `not_configured` (no fabricated numbers). |
| **5 Inbox monitoring** | Audited: UID cursor correct (no loss/re-fetch), dedup correct, no loops. **Fixed:** missing migration for `inbox_replies.{failed_recipient,bounce_category,bounce_confidence,classification_source}` (schema drift → migration-built DB failed every import) — added idempotent `0020`; route `/replies/import` now cancels the bounced recipient's follow-ups (was CLI-only). |
| **6 Launch wizard** | **Done.** Added a one-press **Run launch check** on the go-live wizard → calls the full Deliverability Center checklist, renders the verdict + every check (pass/warn/fail) + **exact blocker codes** inline (never "unknown error"). Plus the standalone Deliverability Center `/deliverability`. |
| **7 Sender rotation** | **Consolidation done:** single authoritative per-mailbox cap/eligibility in `workers/src/mailboxCaps.ts`, shared by campaignRunner + drip (removes divergent copies; unset limit fail-safe blocks). Warmup's `daily_send_limit` is the one ceiling every path honors → no mailbox overloaded past its warmup limit. Selection = `mailboxFleet.assignMailboxes`. |
| **8 Template validation** | Canonical `outboundContentGuard.contentBlockers` now enforced on portal send AND campaigns (`gateChecks`: empty subject/body, `<<<REPLACE>>>`, broken grammar; `{{macros}}` kept — rendered per-recipient). Drip already validated. |
| **9 Reply pipeline** | Every reply → exactly one deterministic status (verified). **Fixed compliance gap:** a bare **STOP** reply (which templates instruct) had no keyword → `unknown` → never suppressed. Now `\bstop\b` → `unsubscribe` conf 0.97 → auto-suppress. |
| **10 Suppression engine** | **Fixed the real bypass:** `campaignRunner.recipientsFor` checked only `suppressions`, ignoring `global_contact_suppression` (email + domain) — a globally suppressed/complained/hard-bounced address (or suppressed domain) was mailable by a campaign. Now anti-joins global email + domain, matching drip/portal. |
| **11 Launch tests** | New `launchScenario.test.ts` (real functions, no mocks): content gate, warmup ramp, reply classification every branch, STOP→suppress, hard-bounce parse+suppress. **api 64/64 pass** (58→64). |
| **12 Documentation** | `docs/operations/PRODUCTION_LAUNCH.md` (launch/warmup/mailbox/SMTP/DNS/campaign/replies/stop/recover) + this report. |

## Files changed
- **api:** `services/deliverabilityCenter.ts` (DNSBL/HELO/TLS/limits/reputation), `services/warmup.ts`
  (ramp), `services/replyClassifier.ts` (STOP), `routes/manualOutreach.ts` (bounce follow-up cancel).
- **workers:** `warmupScheduler.ts` (new), `index.ts` (wire loop), `campaignRunner.ts` (global
  suppression + content gate).
- **db:** `migrations/0020_inbox_replies_bounce_columns.sql` (new, idempotent).
- **portal:** `app/deliverability/page.tsx` (blacklist/TLS/limits cards), `locales/{en,ru,uk}.json`.
- **tests:** `__tests__/launchScenario.test.ts` (new), `__tests__/classifyReplyGuard.test.ts` (STOP).
- **docs:** `docs/operations/PRODUCTION_LAUNCH.md`, `LAUNCH_STAGE3_REPORT.md`.

## Tests
- api typecheck + workers typecheck: **clean (exit 0)**.
- api vitest: **64/64 pass** (5 files: outboundContentGuard, classifyReply, classifyReplyGuard,
  bounceParser, launchScenario).
- Migration `make migrate`: 0020 applied idempotently, `schema_migrations` 19→20 (no-op on live).
- All 7 containers `(healthy)` after redeploy; warmup scheduler live (0 errors); worker heartbeat fresh.
- i18n parity: en/ru/uk **2274/2274/2274**.

## Screenshots
Headless environment — no screenshots. Live evidence (Deliverability Center `GET /api/deliverability/center`):
```
verdict = READY_FOR_CONTROLLED_TEST_SEND, score 92/100
checklist = domain_verified:pass spf_dkim_dmarc:pass return_path:fail(fundbot) ptr:pass
            smtp_verified:pass imap_verified:pass active_mailbox:pass worker:pass
            bounce_ok:pass complaint_ok:pass suppression:pass campaigns_disabled:pass
blacklist = spamhaus:clean barracuda:clean   postal = reachable, banner ok, HELO mail.emails.cheap
warmup = mailboxes ramped to conservative daily limits (auto scheduler live)
```

## Remaining blockers
**Owner (DNS):** add `rp.fundbot.win` A `84.247.139.105` + MX `10 mail.emails.cheap` (mirror emails.cheap) — the only failing checklist item.
**Reputation (time):** Gmail cold-domain 550 block on emails.cheap → the now-automated warmup must run ~1–2 weeks at low volume; optionally register Google Postmaster Tools + Microsoft SNDS (dashboard shows `not_configured` until then).
**Test coverage:** a mail-enabled external inbox is needed to prove real inbox delivery + the reply/STOP round-trip end-to-end (the issue's `sendcrypto.onmicrosoft.com` has no MX).
**Consolidation:** worker `resolveSecret` now single hardened module with the allowlist (env-exfil closed); per-mailbox cap/eligibility now single `mailboxCaps.ts`. Remaining (non-blocking, documented): per-window COUNT source stays per-path by design (campaign_events / queue-ledger / counters — each correct for its context; the LIMIT is unified); `bounceProcessor` writes tenant `suppressions` only (all 3 send paths check `suppressions`, so still blocked in-tenant). None allow an unsafe send.
**Git push:** committed on `launch-stage3` (6 task commits + docs); **push to cloudrec/email needs an owner token** (none on host; sandbox blocks git push).

## SUCCESS CRITERIA — Can this platform safely send real campaigns tomorrow?

**Partially — YES for controlled warmup, NO for full-volume campaigns.**

- **YES, safely tomorrow:** from **emails.cheap**, low-volume **warmup** sends (5/day/mailbox, auto-ramping)
  with every safety gate enforced — approved template, content validation, suppression (now consistent
  across all paths incl. campaigns + STOP compliance), per-mailbox caps, kill-switch, auto-pause on breach,
  reply/bounce monitoring. The pipeline is production-safe.
- **NOT YET for real campaign volume**, because inbox delivery is currently reputation-blocked:
  1. Gmail 550 low-reputation on emails.cheap → needs ~1–2 weeks of automated warmup first.
  2. `rp.fundbot.win` DNS missing → fundbot.win can't deliver to strict receivers (owner fix).
  3. No verified real-inbox delivery yet (need a mail-enabled test recipient).

**Exact launch checklist to reach full-send readiness:** (1) add `rp.fundbot.win` DNS; (2) enable 1–2
emails.cheap mailboxes and let warmup ramp, watching Deliverability Center bounce/complaint daily;
(3) confirm inbox delivery to a real test inbox once reputation warms; (4) when Deliverability Center
verdict = `READY_FOR_LOW_VOLUME_WARMUP` with zero blockers, start the first small approved-list campaign
within the warmup cap; (5) scale volume only as reputation holds.
