# PROJECT STATE — /opt/email

_Last updated: 2026-07-27_

## CURRENT STATE
Mature outreach platform, extended with a two-mode (OWN_PRODUCT_B2B + AFFILIATE) engine.
Own-product audit outreach runs live (25/day). Affiliate track is built and tested but
dormant and fail-closed — no affiliate email can send until an offer is approved.

## WORKING COMPONENTS
- Warmup senders (main + 5-brand pilot), daily crons, self-regulating ramp.
- Audit outreach campaign: `audit_daily_send.sh` cron 13:00, 25/day worst-first, from
  clients.help; queue built by prospect-audit → export → Postal with full safety rails.
- Deliverability: SPF/DKIM/DMARC clean; hourly Postal reputation-hold cleaner.
- Affiliate engine (new): `affiliate_offers` registry API, compliance gate (fail-closed),
  postback ingestion (idempotent), 7 new tables, 3 DRAFT experiments.
- Reply ingestion + finer classifier (TZ §11 classes + escalation map/actions).
- Message quality gate (TZ §9) + affiliate compliance gate (TZ §10), both fail-closed.
- Admin UI (TZ §17, COMPLETE — all 6 sections): portal pages /affiliate-offers, /revenue,
  /replies, /engine-safety, contact detail panel on /contacts, read-only engine badges on
  /campaigns. Read-only revenue + engine-safety + contact-detail endpoints.
- Silent health/reply monitor (pings owner only on a genuine reply or real breakage).
- Campaign send-worker (TZ §18): `dist/cli/campaignSendWorker.js`, DRY-RUN by default (sends
  nothing, writes nothing). Live only when armed by owner (CAMPAIGN_SEND_LIVE=1 + campaign
  ACTIVE + CAMPAIGN_SEND_CONFIRM=uuid), capped, quality+compliance gated, idempotent via
  campaign_send_log (migration 0024). NOT on any cron.
- Tests: 129 passed + 7 skipped (DB integration, run via `npm run test:integration`). TZ §21 20/20.

## LIMITS
- Send volume: kept as-is per owner (audit 25/day; warmup ramp). Per-mailbox schema fields
  (daily_send_limit=10, hourly=3) exist but are NOT code-enforced.
- Affiliate: 0 approved offers → 0 affiliate sends possible.

## KNOWN RISKS
- 20/day-2/hour not enforced in code (owner deferred).
- TZ implemented + tested: §9,§10,§11,§17(all 6 sections),§21(20/20 tests),§23(7 docs),§24.
  §21 #13/#14/#15 tested at the decision level via the pure `campaignSendGate` contract; a
  LIVE campaign-send worker that calls it is intentionally NOT built (owner-gated = real send).
- Audit outreach hits some role addresses (info@/support@) that route into helpdesks.

## PENDING APPROVALS
- Register + approve a real B2B SaaS affiliate offer (cold-email-permitting terms) before
  any affiliate send.
- Any affiliate test send (EXP-C) — owner approval required.

## NEXT SAFE TASK
TZ is fully implemented and tested, including the campaign send-worker (dry-run default).
To go live on a real campaign: register+approve an offer (affiliate) or set the campaign
to lifecycle_state='ACTIVE', then run the worker armed (CAMPAIGN_SEND_LIVE=1 +
CAMPAIGN_SEND_CONFIRM=uuid) with a small CAMPAIGN_SEND_MAX — owner-driven only. Consider a
first supervised live send of 1–5 messages before any scale-up.

## LAST VERIFIED COMMANDS
```
# system health
cd /opt/email && curl -s http://127.0.0.1:4000/health        # {"status":"ok","db":"ok","redis":"ok"}
# tests
cd /opt/email/api && API_JWT_SECRET=… SESSION_SECRET=… DB_HOST=localhost DB_USER=x DB_PASSWORD=x DB_NAME=x node_modules/.bin/vitest run   # 109 passed, 7 skipped
# engine routes mounted (all authed → 401 unauthenticated)
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4000/affiliate/offers            # 401
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4000/affiliate/revenue/summary   # 401
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4000/engine/safety               # 401
# backup verify
sha256sum -c /opt/backups/email-outreach/20260725T075113Z/SHA256SUMS
```
