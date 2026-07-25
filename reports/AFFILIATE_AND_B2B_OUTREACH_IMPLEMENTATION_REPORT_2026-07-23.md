# B2B + Affiliate Outreach Engine — Implementation Report

**Date:** 2026-07-23 (work executed through 2026-07-25)
**Project:** `/opt/email`
**Approach:** audit-first, additive, no destructive rewrite, no send without approval.

---

## What was found (Phase 0)

`/opt/email` is a mature outreach platform (see `reports/PHASE_0_CURRENT_SYSTEM_AUDIT.md`).
~60% of the TZ already existed and was reused: suppression (`global_contact_suppression` +
`suppressions`), contacts (`contact_points` + `companies`), versioned templates, versioned
drafts, `outreach_approval_events`, `audit_log`, reply ingestion (`inbox_replies`),
mailboxes + encrypted `mailbox_secrets`, `sending_providers`, `company_product_fit`,
33 API routes incl. `campaigns`/`contacts`/`sending`/`outreachDrafts`/`adminSafety`.

## What was changed

### Backup (TZ §2.1)
`/opt/backups/email-outreach/20260725T075113Z/` — schema.sql (79 tables), data.sql.gz
(30M), docker-compose*, crontab.txt, migrations/, nginx vhost. `SHA256SUMS` present and
verified; gzip integrity checked; decompresses to a valid MariaDB dump.

### Migrations (additive, reversible)
`db/migrations/0022_b2b_affiliate_engine.sql`:
- `campaigns` += `campaign_mode` (OWN_PRODUCT_B2B|AFFILIATE), `lifecycle_state` (TZ §8
  states, independent of legacy `status`), `affiliate_offer_id`, `mode_owner`,
  `max_send_volume`, `engine_config_json`. All nullable → legacy broadcast campaigns and
  their route unaffected (verified: 2 existing rows, both `campaign_mode` NULL).
- New tables: `affiliate_offers`, `affiliate_offer_terms_versions`, `compliance_snapshots`,
  `click_events`, `conversion_events`, `revenue_events`, `campaign_experiments`. Each event
  table has a UNIQUE `idempotency_key`.
- Rollback in the migration header.

### Affiliate compliance gate (TZ §10) — `api/src/services/affiliateCompliance.ts`
Fail-closed. `evaluateOfferCompliance` (pure) blocks when: offer not APPROVED,
`cold_email_allowed` not explicitly set, tracking/destination URL invalid, geo blocked or
not in the allow-list, required disclosure absent from the message, a prohibited claim
present, or terms unverified/stale. `screenAffiliateMessage` wraps it + writes an
immutable `compliance_snapshots` row. **9 unit tests cover TZ invariants 6–11** (+ geo-block,
invalid-URL).

### Stale-terms review (TZ §5) — `scripts/affiliate_terms_review.mjs`
Moves APPROVED offers to PENDING_REVIEW once terms go stale; never silently reuses stale
rules. Verified dry-run (0 offers currently).

### Affiliate offer registry API (TZ §5,§17) — `api/src/routes/affiliateOffers.ts`
Authed CRUD. Create → always DRAFT. `cold_email_allowed` not settable via create/patch —
the only path to APPROVED is `POST /:id/approve`, which requires `coldEmailAllowed=true` +
`termsVerified` + `verifiedBy`, and pins an immutable terms version. Every mutation writes
`audit_log`.

### Postback ingestion API (TZ §12,§18) — `api/src/routes/affiliateTracking.ts`
Public, token-authed, rate-limited. `/webhooks/affiliate/{click,conversion,revenue}`.
Deterministic `idempotency_key` + `INSERT IGNORE` on a UNIQUE index. **Verified live:** the
same conversion posted twice → 200 both times, **1 row** (TZ invariant 12). Revenue events
track `commission_pending/approved/rejected`, `refund`, `chargeback` separately so no
profit is claimed before commissions settle (TZ §12).

### Three DRAFT experiments (TZ §20) — `db/seed_experiments_2026-07-25.sql`
- **EXP-A** OWN_PRODUCT_B2B, Website Audit (dental, UK).
- **EXP-B** OWN_PRODUCT_B2B, Clients.Help missed-enquiries (UK local service).
- **EXP-C** AFFILIATE, B2B SaaS — points at a DRAFT offer with `cold_email_allowed=0`, so
  the compliance gate **blocks any send**; it cannot go live until a real program's terms
  are verified and approved.
All three `lifecycle_state='DRAFT'`; no send path from DRAFT to RUNNING.

## Files modified / added

```
reports/PHASE_0_CURRENT_SYSTEM_AUDIT.md          (new)
db/migrations/0022_b2b_affiliate_engine.sql      (new)
db/seed_experiments_2026-07-25.sql               (new)
api/src/services/affiliateCompliance.ts          (new)
api/src/services/__tests__/affiliateCompliance.test.ts (new, 9 tests)
api/src/routes/affiliateOffers.ts                (new)
api/src/routes/affiliateTracking.ts              (new)
api/src/index.ts                                 (mounted 2 routers)
scripts/affiliate_terms_review.mjs               (new)
```
Commits: `6039644`, `bc72be2`, `a7b8f1b` (+ this report / experiments to follow).

## Tests before & after

- Before: 64 tests (6 files) — all passing.
- After: **73 tests (6 files) — all passing.** No existing test removed or weakened.
- Live: postback idempotency (dup conversion → 1 row); both new routes mounted (401
  without auth/token); api healthy (`db:ok, redis:ok`); migration additive (legacy
  campaigns untouched).

## Unresolved risks

- **Per-mailbox 20/day-2/hour NOT enforced in code** (owner chose to keep current volume
  as-is). Limits still live only in send scripts, not the schema fields. Revisit if volume
  policy changes.
- **Reply classes** not yet expanded to the full TZ §11 set (MEETING_REQUEST /
  REQUEST_DETAILS / REFERRAL / LEGAL_OR_PRIVACY). Current classifier is coarser.
- **Admin UI** (TZ §17) not built — the affiliate/campaign management is API-only so far.
- **Message-generation quality gate** (TZ §9) relies on the existing `outboundContentGuard`;
  the affiliate-specific claim check is in the compliance gate but a fuller §9.1 generator
  guard is pending.
- **~8 of the 20 TZ tests** remain (worker-restart-no-dup, complaint-pauses-campaign,
  unsubscribe→global-suppression as automated tests, etc.).
- **6 of 7 docs** (§23) pending.

## Rollback

```
# code
git revert a7b8f1b bc72be2 6039644
# experiments + schema (data)
mariadb ... < (rollback blocks in db/seed_experiments_2026-07-25.sql and
                db/migrations/0022_b2b_affiliate_engine.sql headers)
docker compose build api && docker compose up -d api
# full restore if needed
gunzip < /opt/backups/email-outreach/20260725T075113Z/data.sql.gz | mariadb ...
```

## Production readiness

- Own-product B2B track: the live audit campaign already runs (25/day, kept as-is per owner).
- Affiliate track: schema + gate + registry + postback **built and tested**, but **no
  affiliate offer is approved and no affiliate email can send** (gate is fail-closed). Safe
  to leave dormant until a real program with cold-email-permitting terms is registered.

## Exact next recommended action

1. Owner registers one real B2B SaaS affiliate offer whose written terms allow cold email;
   verify terms; `POST /affiliate/offers/:id/approve`.
2. Build the remaining TZ §11 reply classes + §17 admin UI + finish the §21 test set and
   §23 docs.
3. Only then consider a controlled affiliate test send (owner-approved) via EXP-C.
