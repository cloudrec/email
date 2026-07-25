# B2B & Affiliate Outreach Engine

Overview of the two-mode outreach engine added on top of the existing `/opt/email`
sending platform (TZ_B2B_AFFILIATE_OUTREACH_ENGINE.md). Everything here is **additive** —
the legacy audit cron and manual-outreach flow are untouched. No real send happens
without human approval.

## The two modes

| Mode | `campaigns.campaign_mode` | What it sends |
|------|---------------------------|----------------|
| Own-product B2B | `OWN_PRODUCT_B2B` | Our own product/audit outreach |
| Affiliate | `AFFILIATE` | An **approved** affiliate offer only, with a compliance snapshot per message |

Legacy campaigns have `campaign_mode = NULL` and behave exactly as before.

## Component map (real paths)

- **Offer registry API** — `api/src/routes/affiliateOffers.ts`, mounted at `/affiliate/offers`.
- **Postback ingestion API** — `api/src/routes/affiliateTracking.ts`, mounted at `/webhooks/affiliate`.
- **Compliance gate (§10)** — `api/src/services/affiliateCompliance.ts`
  (`evaluateOfferCompliance` pure; `screenAffiliateMessage` writes the snapshot).
- **Message quality gate (§9)** — `api/src/services/messageQualityGate.ts`
  (`evaluateMessageQuality`), wired into `evaluateSendGate` in `api/src/routes/manualOutreach.ts`.
- **Suppression guard** — `api/src/services/suppression.ts`
  (`addSuppression`, `isSuppressed`, `isSuppressedGlobal`).
- **Reply classification + escalation (§11)** — `api/src/services/replyClassifier.ts`
  (`classifyReply`, `REPLY_ESCALATION`); escalation actions run in `api/src/cli/importReplies.ts`.
- **Schema** — `db/migrations/0022_*.sql` (campaigns columns + affiliate tables),
  `db/migrations/0023_*.sql` (inbox reply classification enum). Last migration = 0023.

## Data model added by 0022

- `campaigns` gains: `campaign_mode`, `lifecycle_state`, `affiliate_offer_id`, `mode_owner`,
  `max_send_volume`, `engine_config_json` (all nullable; legacy rows unaffected).
- New tables: `affiliate_offers`, `affiliate_offer_terms_versions`, `compliance_snapshots`,
  `click_events`, `conversion_events`, `revenue_events`, `campaign_experiments`.
  Every ingest table carries a `UNIQUE(idempotency_key)` so replays are no-ops.

## Build / run

```bash
cd /opt/email
docker compose build api && docker compose up -d api   # api is TS→dist baked into the image
make migrate                                            # apply pending migrations
make health                                             # readiness
```

## Tests

```bash
cd /opt/email/api && npm test                # host unit suite (100 passed)
npm run test:integration                     # DB-backed §21 invariants (needs a reachable DB)
```

The integration suite is skipped unless `RUN_DB_TESTS=1`. To run it against the live DB:

```bash
docker run --rm --network email-platform_internal --env-file /opt/email/.env \
  -e DB_HOST=db -e RUN_DB_TESTS=1 -v /opt/email/api:/app -w /app node:20 \
  node_modules/.bin/vitest run src/services/__tests__/engineInvariants.integration.test.ts
```

## Related docs

- [AFFILIATE_OFFER_APPROVAL.md](AFFILIATE_OFFER_APPROVAL.md)
- [COMPLIANCE_AND_SUPPRESSION.md](COMPLIANCE_AND_SUPPRESSION.md)
- [CAMPAIGN_OPERATIONS.md](CAMPAIGN_OPERATIONS.md)
- [REPLY_HANDLING.md](REPLY_HANDLING.md)
- [CONVERSION_TRACKING.md](CONVERSION_TRACKING.md)
- [ROLLBACK.md](ROLLBACK.md)
