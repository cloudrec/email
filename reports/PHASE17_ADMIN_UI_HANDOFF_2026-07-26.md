# §17 Admin UI — Handoff / Progress Report (2026-07-26)

Branch `launch-stage3`. Additive UI over the existing Next.js portal. **No sending, no
campaign activation, no limit/credential changes.** Cron/warmup/suppression/sending flow
untouched.

## Stack (confirmed)

- Portal: **Next.js 15 App Router + React 19**, container `portal` (docker-compose), behind
  nginx (`location / → portal:3000`, `/api/ → api:4000`). Host `127.0.0.1:13000`.
- Pages are `'use client'` with a **copy-pasted local `api()` helper** (JWT from `token`
  cookie → `authorization: Bearer`, super-admin `x-tenant-id` from `?tenantId=`). No shared
  client, no state lib, no UI lib. UI = CSS classes in `portal/src/app/globals.css`
  (`.panel`,`.panel-h`,`.btn*`,`.chip*`,`.notice*`,`.stat*`,`.field-group`,`.row`,`.cluster`,
  `.between`,`.empty`,`dl.kv`).
- Nav: `portal/src/components/AppShell.tsx` GROUPS; labels via `t(locale,'nav.<key>')`.
  `AutoShell` renders unknown routes bare, so new pages import `AppShell` themselves.
- Portal has **no local tsc**; typecheck happens in `docker compose build portal` (next build).

## Done this session

| TZ §17 section | Deliverable | Backend |
|---|---|---|
| Affiliate offers | `portal/src/app/affiliate-offers/page.tsx` — list, create DRAFT, **approve** (coldEmailAllowed+verifiedBy), pause/reject, detail (geos/traffic/terms/payout/tracking) | reused `/affiliate/offers` (no change) |
| Revenue | `portal/src/app/revenue/page.tsx` — KPIs per currency + recent ledger | **NEW** read-only `api/src/routes/affiliateRevenue.ts` → `GET /affiliate/revenue/summary` (mounted `index.ts`) |
| Replies | `portal/src/app/replies/page.tsx` — threaded, classification + escalation status, follow-up **draft** (no auto-send), suppress, import | reused `/manual-outreach/replies*` (no change) |
| Campaigns | engine badge (mode/lifecycle/offer/owner/limit) in existing `/campaigns` page, **read-only** | extended `campaigns.ts` list SELECT additively with engine cols |
| Nav + i18n | `engine` group (affiliateOffers/replies/revenue) in AppShell; keys added to en/ru/uk | — |

Only backend addition = the read-only revenue summary endpoint. Everything else reuses
existing APIs. api tsc clean; portal P1 build already passed (exit 0).

## Constraints honoured

- Campaign page is **read-only** for engine fields — no activate/send button added (activation
  = sending, forbidden). Offer **approval** is exposed (it is terms-verification, not sending).
- Revenue endpoint is SELECT-only; never writes `revenue_events`.
- No change to cron, warmup, mailbox limits, suppression, or the working send gate.

## NOT done (bounded out this session)

- **Contacts** (§17: source/relevance/status/suppression/campaign-history) — existing
  `/contacts` page reused as-is; not audited field-by-field. If the spec fields must all be
  present, extend that page (contacts API already exposes status/suppression).
- **Safety** (§17: bounce alerts/complaints/offer-policy-violations/stale-terms/paused-
  campaigns/mailbox-health) — existing `/safety` + `/deliverability` + `/admin/risk-events`
  cover bounces/complaints/mailbox health. **Gaps**: offer-policy-violations, stale-terms,
  paused-campaigns are not surfaced in one Safety view yet (data exists: compliance_snapshots,
  affiliate_offers.status=PENDING_REVIEW/terms_verified_at, campaigns.lifecycle_state).
- **Assigned operator** on replies — no column in `inbox_replies`; omitted. Add a column +
  API if operator assignment is required.

## How to deploy / verify

```bash
cd /opt/email
docker compose build api portal && docker compose up -d api portal
make health
# smoke the new endpoint (needs an operator JWT):
curl -s http://portal:3000/... # via nginx: GET /api/affiliate/revenue/summary
```

New pages: `/affiliate-offers`, `/revenue`, `/replies` (+ engine badges on `/campaigns`).

## Update 2026-07-27 — Safety aggregation DONE

Closed the three Safety gaps with a read-only endpoint + view:
- `api/src/services/engineSafety.ts` — pure `isTermsStale` / `daysSince` (30-day window,
  consistent with affiliateCompliance). 9 unit tests in `engineSafety.test.ts`.
- `api/src/routes/engineSafety.ts` — `GET /engine/safety` (tenant-authed, SELECT-only):
  offer-policy-violations (compliance_snapshots prohibited_claim_check='fail'), stale terms
  (APPROVED offers failing isTermsStale), paused campaigns (lifecycle_state='PAUSED').
  Mounted `/engine` in index.ts.
- `portal/src/app/engine-safety/page.tsx` — KPI tiles + three tables. Nav item
  `engineSafety` in the engine group; en/ru/uk labels.

Verified: endpoint 401 unauth (mounted+authed), page 200 + built into image, all three
SQL queries run against the live DB (0 rows — no engine data yet), api suite 109 passed /
7 skipped. Deployed (fresh api+portal images, health 200).

## Update 2026-07-27 (2) — Contacts field-parity DONE

- `api/src/routes/contacts.ts` — `GET /contacts/:id/detail` (tenant-scoped, read-only):
  source (consent_source + tags + latest outreach-queue source_url/company), relevance
  reason (manual_outreach_queue.reason), status, suppression (isSuppressedGlobal +
  reason/scope), campaign history (campaign_events + outreach_touchpoints).
- `portal/src/app/contacts/page.tsx` — per-row "Details" button + detail panel.
Endpoint 401 unauth, page 200, SQL validated live, suite 109/7, deployed.

**§17 is now COMPLETE** across all six sections: campaigns, affiliate offers, contacts,
replies, revenue, safety.

## Remaining (whole TZ)

Only the deferred §21 tests (#13 dup-message, #14 paused-campaign-not-processed, #15
mailbox-limits) — they need a campaign-driven send loop that does not exist yet. Build
only on explicit owner approval (it is the path to real sending).
