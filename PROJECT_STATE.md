# PROJECT STATE — /opt/email

_Last updated: 2026-07-25_

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
- Reply ingestion + rule classifier; silent health/reply monitor (pings owner only on a
  genuine reply or real deliverability breakage).
- Tests: 73/73 green.

## LIMITS
- Send volume: kept as-is per owner (audit 25/day; warmup ramp). Per-mailbox schema fields
  (daily_send_limit=10, hourly=3) exist but are NOT code-enforced.
- Affiliate: 0 approved offers → 0 affiliate sends possible.

## KNOWN RISKS
- 20/day-2/hour not enforced in code (owner deferred).
- Reply classes coarser than TZ §11; no admin UI yet (API-only); ~8 of 20 TZ tests and
  6 of 7 docs pending.
- Audit outreach hits some role addresses (info@/support@) that route into helpdesks.

## PENDING APPROVALS
- Register + approve a real B2B SaaS affiliate offer (cold-email-permitting terms) before
  any affiliate send.
- Any affiliate test send (EXP-C) — owner approval required.

## NEXT SAFE TASK
Finish TZ §11 reply classes + §17 admin UI + remaining §21 tests + §23 docs. All
additive; no send.

## LAST VERIFIED COMMANDS
```
# system health
cd /opt/email && curl -s http://127.0.0.1:4000/health        # {"status":"ok","db":"ok","redis":"ok"}
# tests
cd /opt/email/api && API_JWT_SECRET=… SESSION_SECRET=… DB_HOST=localhost DB_USER=x DB_PASSWORD=x DB_NAME=x node_modules/.bin/vitest run   # 73 passed
# affiliate routes mounted
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4000/affiliate/offers            # 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:4000/webhooks/affiliate/click   # 401
# backup verify
sha256sum -c /opt/backups/email-outreach/20260725T075113Z/SHA256SUMS
```
