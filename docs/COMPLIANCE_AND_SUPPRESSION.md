# Compliance & Suppression

The two hard checkpoints every message clears before it can be sent, plus the
suppression model that keeps blocked contacts out of the queue and the sender.

## 1. Offer-compliance gate (TZ §10)

`api/src/services/affiliateCompliance.ts`

- `evaluateOfferCompliance(offer, ctx)` — **pure**, no I/O. Returns
  `{ allowed, blockers[], requiresReview, checks }`.
- `screenAffiliateMessage(params)` — loads the offer, evaluates, and writes an
  **immutable** row to `compliance_snapshots` (offer id, campaign id, terms version,
  geo, disclosure-present, prohibited-claim result, approver, message hash).

Hard blocks (any one → do not send):
- offer not `APPROVED`;
- `cold_email_allowed` not explicitly `1`;
- tracking / destination URL missing or malformed;
- recipient geo on the blocked list, or not in the allowed list;
- required disclosure text missing from the message;
- a prohibited advertiser claim present.

Soft (`requiresReview`, needs a human): offer terms unverified or older than 30 days.

## 2. Message-quality gate (TZ §9)

`api/src/services/messageQualityGate.ts` — `evaluateMessageQuality(ctx)`, pure.
Wired into `evaluateSendGate` in `api/src/routes/manualOutreach.ts` (send + copy paths).

Hard blockers (prefixed `quality_` on the send gate): guaranteed income, false urgency,
fabricated case study, misleading `RE:/FWD:` subject, hidden affiliate nature, missing
sender identity, missing opt-out. Soft `reviewFlags` (advisory, surfaced not blocked):
manipulative language, fake familiarity, unverified savings claims.

On the live send path only the high-precision spam-tells are hard blockers; opt-out is
already enforced by the existing `no_opt_out_line` check, and identity is not re-checked
there to avoid false-blocking already-approved drafts.

## 3. Suppression model

`api/src/services/suppression.ts`

- `addSuppression(tenantId, email, reason, sourceEventId?)` — `INSERT IGNORE` into
  `suppressions` and sync `contacts.status`:
  `unsubscribe → unsubscribed`, `bounce_hard → bounced`, `complaint → complained`.
- `isSuppressed(tenantId, email)` — tenant-local `suppressions` check.
- `isSuppressedGlobal(tenantId, email)` — the full pre-queue / pre-send guard:
  tenant `suppressions` **OR** `global_contact_suppression` (by email or by domain).
  Re-exported from `routes/manualOutreach.ts` as `isEmailSuppressed`; consulted at
  enqueue and in `evaluateSendGate`.

A suppressed address cannot enter the queue and cannot be sent even if already queued
(TZ §21.1/§21.2). Suppression insert is idempotent.

## Inspecting suppressions

```bash
cd /opt/email
DBP=$(grep -E '^DB_ROOT_PASSWORD=' .env | cut -d= -f2); DBN=$(grep -E '^DB_NAME=' .env | cut -d= -f2)
docker compose exec -T db mariadb -uroot -p"$DBP" "$DBN" \
  -e "SELECT reason, COUNT(*) FROM suppressions GROUP BY reason;"
```

## Tests

- Pure gate invariants: `api/src/services/__tests__/affiliateCompliance.test.ts`,
  `messageQualityGate.test.ts`.
- DB-backed suppression invariants: `engineInvariants.integration.test.ts`
  (`npm run test:integration`).
