# Conversion Tracking

How affiliate networks report clicks, conversions, and revenue back to the engine, and
how those events attribute to a campaign / contact / offer. Every write is idempotent
(TZ §12/§17/§18): a network retrying the same event produces a single row.

Router: `api/src/routes/affiliateTracking.ts`, mounted at `/webhooks/affiliate`.
Every request is token-authorized.

## Endpoints

| Method | Path | Table |
|--------|------|-------|
| `POST` | `/webhooks/affiliate/click` | `click_events` |
| `POST` | `/webhooks/affiliate/conversion` | `conversion_events` |
| `POST` | `/webhooks/affiliate/revenue` | `revenue_events` |

## Idempotency

Each event's `idempotency_key` is a deterministic SHA-256 over
`kind | offerId | campaignId | clickId | subId | eventType | externalId | contactEmail`
(`idemKey()` in the router). The insert is `INSERT IGNORE` against a `UNIQUE(idempotency_key)`.
Same logical event → same key → one row. This is what makes a **duplicate conversion a
no-op** and a **worker restart / postback retry non-duplicating** (§21.12 / §21.16).

## Attribution (§21.19)

A conversion stores `campaign_id`, `offer_id`, `contact_email`, `click_id`, and `sub_id`.
Because a click and its conversion carry the same values, a conversion joins back to its
originating click on `click_id` and is attributable to the exact campaign, offer, and
contact that produced it.

```sql
SELECT cv.campaign_id, cv.offer_id, cv.contact_email, cv.event_type
FROM conversion_events cv
JOIN click_events ck ON ck.click_id = cv.click_id;
```

## Example postbacks

```bash
# Click
curl -sX POST https://<host>/webhooks/affiliate/click \
  -H "Authorization: Bearer <postback-token>" -H 'Content-Type: application/json' \
  -d '{"campaignId":3,"offerId":5,"contactEmail":"lead@example.com","clickId":"ck-123","subId":"s1"}'

# Conversion (sale)
curl -sX POST https://<host>/webhooks/affiliate/conversion \
  -H "Authorization: Bearer <postback-token>" -H 'Content-Type: application/json' \
  -d '{"campaignId":3,"offerId":5,"contactEmail":"lead@example.com","clickId":"ck-123","eventType":"sale"}'

# Revenue
curl -sX POST https://<host>/webhooks/affiliate/revenue \
  -H "Authorization: Bearer <postback-token>" -H 'Content-Type: application/json' \
  -d '{"campaignId":3,"offerId":5,"mode":"AFFILIATE","eventType":"commission","amount":42.00,"currency":"USD"}'
```

The response echoes `idempotency_key`. Re-POSTing the same payload returns the same key
and does not create a second row.

## Revenue is separate from conversions

Money moves in `revenue_events`, not `conversion_events`: a sale can later be refunded or
charged back, and affiliate commission is only "real" once approved (TZ §12 — no profit
claim before that).

## Tests

`engineInvariants.integration.test.ts` covers idempotent conversion ingest and the
click→conversion attribution join (`npm run test:integration`).
