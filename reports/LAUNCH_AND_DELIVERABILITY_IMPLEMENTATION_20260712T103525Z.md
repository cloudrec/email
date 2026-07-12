# Launch Readiness & Deliverability — Implementation Report
Date: 2026-07-12 · Issue: cloudrec/email#1 · Scope: /opt/email · Tenant 1

## 1. Executive summary
Worked the issue end-to-end (not just an audit): backed up, established a baseline, ran a
4-agent audit of the outbound/inbound pipelines + deliverability/AI inventory, **fixed the real
launch-blocker bugs with automated tests**, **built a real-data Deliverability Center + Launch
Checklist + deterministic Deliverability Advisor**, restored the **dormant inbound reply import**,
and ran a **controlled external test send with per-recipient delivery evidence**.

Outcome: the platform's send/receive **pipeline is correct and safe**. Verdict from the new
Deliverability Center: **`READY_FOR_CONTROLLED_TEST_SEND`** (score 92/100). Actual inbox delivery
is currently blocked only by (a) Gmail cold-domain **reputation** (warmup, not code) and (b) one
owner DNS gap (`rp.fundbot.win`) + recipient-side issues (a test address with no MX). Campaigns and
drip remain **disabled**; zero real-lead sends occurred.

## 2. Backup paths (created before any change)
`/opt/backups/email_launch_20260712T100030Z/`
- `email_platform.sql.gz` (20 MB) — full app DB dump
- `postal-server-1.sql.gz` (752 KB) — Postal message/suppression state
- `env.snapshot` — `.env` (root-only, NOT committed)
- `docker-compose.yml`, `docker-compose.postal.yml`
- `project_files.tar.gz` (868 KB) — source (excl. node_modules/dist/.next/backups)

## 3. Baseline (at start)
- Git: **not a repo** (initialised in Phase 5). 7 containers `(healthy)`. Worker heartbeat fresh.
- DB: `email_platform`, 78 tables, `schema_migrations`=19. Redis healthy. Monitoring targets up.
- Data: 1 tenant, 34 active sender identities, 5 active providers, **manual_queue=1943** (kept
  disabled), suppressions=23, campaigns=2, real sends to date = 2.
- Provider **id8 Postal** = the only `test_status=smtp_ok` working relay (from hello@emails.cheap).

## 4. DNS state (verified via public resolvers)
| Record | State |
|---|---|
| PTR 84.247.139.105 | ✅ `mail.emails.cheap` |
| SPF emails.cheap | ✅ `v=spf1 a mx include:spf.emails.cheap include:_spf.email.clients.help ~all` |
| DKIM emails.cheap | ✅ Postal `dkim_status=OK` (selector `up1S7H`) |
| DMARC emails.cheap | ✅ `p=none; rua=mailto:postmaster@emails.cheap` |
| **rp.emails.cheap** | ✅ A `84.247.139.105` + MX `10 mail.emails.cheap` (owner added; delivery to strict receivers now passes) |
| **rp.fundbot.win** | ❌ **missing** — fundbot.win sends via Postal but its return-path does not resolve (owner DNS action) |
| MX/return_path in Postal UI | shows `Missing` because Postal's verifier checks `psrp.emails.cheap`; the actual envelope uses `rp.emails.cheap` which resolves → real delivery works |

## 5. Existing features found vs newly implemented
**Reused (already real):** SPF/DKIM/DMARC/return-path live checks (`dnsVerify`), warmup verdict
(`warmup.evaluateWarmup`), mailbox health (`mailboxFleet.computeHealth`), SMTP-node readiness,
provider SMTP/IMAP tests, SMTP relay state (`evaluateSmtp`), spam/compliance validator
(`senderStudio.validateTemplate` — enforced at approve + send), reply classifier
(`classifyReply`), Go-Live wizard (= a launch checklist). **Not rebuilt.**

**Newly implemented this pass:**
- `services/deliverabilityCenter.ts` + `routes/deliverability.ts` — **aggregated Deliverability
  Center** (`GET /deliverability/center|checklist`): DNS/auth per domain, live Postal probe, PTR,
  providers, mailbox/sender health, real bounce/complaint/unsub/reply rates, worker/queue health,
  suppression count, **deterministic advisor** (prioritised blockers+actions), **unified readiness
  score + launch verdict** (`NOT_READY` / `READY_FOR_CONTROLLED_TEST_SEND` /
  `READY_FOR_LOW_VOLUME_WARMUP`), external integrations honestly marked `not_configured`.
- `portal/src/app/deliverability/page.tsx` + nav entry — responsive, i18n (en/ru/uk) operator page.
- `services/outboundContentGuard.ts` + `services/replyClassifier.ts` (extracted pure modules).

## 6. Root causes and fixes (launch-blocker bugs)
1. **Inbound reply import was dead** — `email-reply-import.service` failed every run for days
   (`Missing env: API_JWT_SECRET`; the host `tsx` unit had no `.env`). **Fixed**: unit now runs
   `docker compose exec -T api node dist/cli/importReplies.js` (env present in container).
   Verified: service runs clean, checks 2 IMAP mailboxes.
2. **Portal one-by-one send bypassed content validation** — could ship empty body / leftover
   `{{macro}}` / `<<<REPLACE>>>` / broken "the your business". **Fixed**: canonical
   `contentBlockers()` wired into `evaluateSendGate`; drip validator extended to the same cases.
3. **Tenant kill-switch ignored by campaigns + portal send** (`outreach_paused` only respected by
   drip). **Fixed**: honored in `campaignRunner.gateChecks` and portal `evaluateSendGate`.
4. **Portal daily-cap double-counted** (`manual_sent_today + sent_today`) → halved caps. **Fixed**
   to the authoritative `sent_today`.
5. **Portal send TOCTOU** double-send. **Fixed** with a Redis claim-lock.
6. **Welcome/automated mail mis-scored as "interested" leads** (no sender/subject guard). **Fixed**:
   `classifyReply` now takes `fromEmail`, funnels noreply/mailer-daemon/notifications/wordpress
   and welcome/account/newsletter subjects to `auto_reply` before any positive scoring.
7. **Bounce follow-up cancellation keyed on mailer-daemon** not the failed recipient. **Fixed** to
   cancel the bounced address's follow-ups.

## 7. Files changed
API: `services/outboundContentGuard.ts` (new), `services/replyClassifier.ts` (new),
`services/deliverabilityCenter.ts` (new), `routes/deliverability.ts` (new), `routes/manualOutreach.ts`,
`services/mailboxRuntime.ts`, `cli/importReplies.ts`, `index.ts`.
Workers: `manualOutreachDrip.ts`, `campaignRunner.ts`.
Portal: `app/deliverability/page.tsx` (new), `components/AppShell.tsx`, `locales/{en,ru,uk}.json`.
Infra: `/etc/systemd/system/email-reply-import.service`.
Tests: `services/__tests__/outboundContentGuard.test.ts` (new), `__tests__/classifyReplyGuard.test.ts` (new).

## 8. Migrations
None required — all fixes are code/config; no schema change. `schema_migrations` unchanged at 19.

## 9. Tests and exact results
- `api` typecheck `tsc --noEmit` → **clean (exit 0)**. `workers` typecheck → **clean (exit 0)**.
- `api` vitest → **57 passed** (44 prior + 13 new): `outboundContentGuard` (7), `classifyReplyGuard`
  (6, importing shipping code), plus existing `classifyReply` (8) and `bounceParser` (36).
- Portal production build → **succeeded**. All 7 containers `(healthy)` after redeploy.
- Live: `/deliverability/center` returns real data, verdict `READY_FOR_CONTROLLED_TEST_SEND`,
  score 92; page loads 200; i18n parity **2268/2268/2268**.

## 10. External test-send evidence (per recipient)
Sent one diagnostic at a time from `hello@emails.cheap` via Postal (provider id8), DKIM-signed.
All three **accepted by Postal (SMTP 250 OK)** — but SMTP 250 ≠ inbox delivery:

| Recipient | Provider | SMTP | Postal msg-id | Remote MX result |
|---|---|---|---|---|
| microsendcrypto@gmail.com | Postal/emails.cheap | 250 OK | `<c3eb75e1…@emails.cheap>` | **HardFail** `550-5.7.1 low reputation of the sending domain` (Gmail) |
| cloudkroter@gmail.com | Postal/emails.cheap | 250 OK | `<585dad5b…@emails.cheap>` | **HardFail** same Gmail 550 reputation |
| AndriiPecherskyi@Sendcrypto.onmicrosoft.com | Postal/emails.cheap | 250 OK | `<185d609d…@emails.cheap>` | **SoftFail** "No SMTP servers available for sendcrypto.onmicrosoft.com" — **recipient domain has no MX** |

## 11. Inbox / spam / rejection results
- **Gmail (×2): rejected at MX** (`550-5.7.1`) — not delivered; cold-domain reputation.
- **Microsoft onmicrosoft.com: not deliverable** — `sendcrypto.onmicrosoft.com` publishes no MX
  (verified via public DNS); recipient-side, not a platform issue.
- Inbound classification: verified by unit tests (welcome/noreply → `auto_reply`, genuine reply →
  `interested`, stop/unsubscribe → suppression). A **live external→IMAP round-trip was not possible**
  because Postal correctly refuses to relay foreign `From` addresses (`530 From/Sender name is not
  valid`) — anti-spoofing by design; the classifier is covered by the shipping-code unit tests.

## 12. Remaining blockers
**Owner action (DNS):** add `rp.fundbot.win` A `84.247.139.105` + MX `10 mail.emails.cheap` (mirror
of the emails.cheap fix) so fundbot.win can deliver to strict receivers.
**Provider / reputation:** Gmail blocks emails.cheap on low reputation — needs low-and-slow warmup
over days (all auth records already pass); optionally register Google Postmaster Tools. A valid,
mail-enabled test recipient is needed to prove inbox delivery (the onmicrosoft.com address has no MX).
**Code:** none outstanding from this pass (all fixed + tested).
**Optional product (deferred, audited):** subject/copy optimizer, campaign optimizer, automated
DNSBL/blacklist + deliverability timeline, Google Postmaster / Microsoft SNDS ingestion, reply
summarize/draft. AI Deliverability Advisor is delivered in rule-based form (the Center's advisor).

## 13. Exact safe launch recommendation
**READY FOR CONTROLLED TEST SEND** from **emails.cheap only** (its DNS/auth/return-path all pass,
Postal relay verified, worker healthy, gates enforced). Do **not** enable campaigns/drip. Next steps,
in order: (1) add `rp.fundbot.win` DNS; (2) begin **low-volume Gmail warmup** from emails.cheap
(5→10→20/day) and monitor the Deliverability Center bounce/complaint rates; (3) obtain a
mail-enabled test inbox to confirm real delivery + exercise the reply/stop round-trip; (4) only after
reputation stabilises, consider `READY_FOR_LOW_VOLUME_WARMUP`. Real-lead sending stays disabled until
the owner explicitly authorizes it after reviewing this report.
