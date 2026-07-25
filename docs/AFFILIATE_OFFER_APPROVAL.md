# Affiliate Offer Approval

How an affiliate offer moves from DRAFT to APPROVED so it can be used for cold email.
An offer can **never** be used for sending until it is explicitly APPROVED with
`cold_email_allowed = 1` (TZ §5). The gate is fail-closed.

Router: `api/src/routes/affiliateOffers.ts`, mounted at `/affiliate/offers`.
All write endpoints require `requireWriteAccess` (an authenticated operator).

## Lifecycle

```
DRAFT ──approve──▶ APPROVED ──status PAUSED──▶ PAUSED ──approve──▶ APPROVED
  │                                              │
  └── status REJECTED ──▶ REJECTED               └── status REJECTED ──▶ REJECTED
PENDING_REVIEW ──approve──▶ APPROVED   (set by the stale-terms sweep)
```

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/affiliate/offers` | list offers |
| `GET` | `/affiliate/offers/:id` | one offer |
| `POST` | `/affiliate/offers` | create — always lands in **DRAFT** |
| `PATCH` | `/affiliate/offers/:id` | edit offer fields |
| `POST` | `/affiliate/offers/:id/approve` | DRAFT/PENDING_REVIEW/PAUSED → **APPROVED** |
| `POST` | `/affiliate/offers/:id/status` | APPROVED → PAUSED or REJECTED |

## Creating a DRAFT

```bash
curl -sX POST https://<host>/affiliate/offers \
  -H "Authorization: Bearer <operator-token>" -H 'Content-Type: application/json' \
  -d '{"name":"Acme SaaS","destinationUrl":"https://track.acme.com/click","allowedGeos":["GB","US"],
       "requiredDisclosure":"This is an advertisement.","prohibitedClaims":["guaranteed income"]}'
```

## Approving (the hard gate)

Approval **requires** `coldEmailAllowed:true`; otherwise it is rejected with
`cold_email_not_allowed`.

```bash
curl -sX POST https://<host>/affiliate/offers/<id>/approve \
  -H "Authorization: Bearer <operator-token>" -H 'Content-Type: application/json' \
  -d '{"coldEmailAllowed":true,"termsVerified":true,"verifiedBy":"Andrii"}'
```

On success the endpoint:
1. sets `status='APPROVED'`, `cold_email_allowed=1`, `terms_verified_at=NOW()`, `terms_verified_by`;
2. pins an **immutable** row in `affiliate_offer_terms_versions` (terms hash at approval time);
3. writes an `affiliate_offer.approve` entry to the audit log.

`409 not_approvable_from_current_status` means the offer is not in DRAFT/PENDING_REVIEW/PAUSED.

## Stale terms

`scripts/affiliate_terms_review.mjs` moves offers with terms older than the max age to
`PENDING_REVIEW`. The compliance gate also treats stale terms as `requiresReview`
(see [COMPLIANCE_AND_SUPPRESSION.md](COMPLIANCE_AND_SUPPRESSION.md)). Re-run `/approve`
to re-verify.

```bash
node scripts/affiliate_terms_review.mjs
```
