# Affiliate & B2B Outreach — Test Report

**Filename date 2026-07-23** (TZ §24 fixed name). **Executed:** 2026-07-26 on branch
`launch-stage3`, `/opt/email`. Last migration = 0023.

## Summary

| Suite | Result |
|-------|--------|
| Host unit suite (`npm test`) | **109 passed**, 7 skipped (9 files) — incl. §9 quality gate (19) and §17 engine-safety (9) |
| DB integration suite (`npm run test:integration`, live DB) | **7 passed** |
| TypeScript (`tsc --noEmit`) | clean, exit 0 |
| API build + health | rebuilt, container healthy |

The 7 integration tests are `describe.skip` on the host (fake DB creds) and run only with
`RUN_DB_TESTS=1` against a reachable DB, so the default host run stays green.

## Tests before and after

| Point | Unit tests |
|-------|-----------|
| Engine work start (baseline) | 64 |
| After reply classes/escalation (§11) | 81 |
| After this session (§9 quality gate + §21 integration) | **100 unit + 7 integration = 107** |

New this session: `messageQualityGate.test.ts` (19), `engineInvariants.integration.test.ts` (7).
No existing passing test was removed or weakened.

## How to run

```bash
# Host unit suite
cd /opt/email/api && npm test

# DB integration suite against the live DB (throwaway container on the compose network)
docker run --rm --network email-platform_internal --env-file /opt/email/.env \
  -e DB_HOST=db -e RUN_DB_TESTS=1 -v /opt/email/api:/app -w /app node:20 \
  node_modules/.bin/vitest run src/services/__tests__/engineInvariants.integration.test.ts
```

Scratch rows use the `@engine-test.invalid` marker and `enginetest-<stamp>-*` idempotency
keys and are deleted in `afterAll`. Verified **0 residue** in `suppressions`, `contacts`,
`click_events`, `conversion_events` after each run.

## Unit test files (host)

| File | Tests | Area |
|------|-------|------|
| `affiliateCompliance.test.ts` | 9 | §10 offer-compliance gate |
| `messageQualityGate.test.ts` | 19 | §9 message-quality gate |
| `replyClassifierExtended.test.ts` | 8 | §11 reply classes + escalation map |
| `classifyReply.test.ts` / `classifyReplyGuard.test.ts` | 8 / 7 | reply classification |
| `bounceParser.test.ts` | 36 | bounce parsing → suppression reason |
| `outboundContentGuard.test.ts` | 7 | pre-send content blockers |
| `engineSafety.test.ts` | 9 | §17 terms-staleness / daysSince (engine-safety view) |
| `launchScenario.test.ts` | 6 | launch scenario |

## TZ §21 coverage matrix

| # | Required invariant | Status | Where |
|---|--------------------|--------|-------|
| 1 | suppressed contact cannot enter a queue | ✅ | `isSuppressedGlobal` guard consulted at enqueue; integration guard test |
| 2 | suppressed contact cannot be sent even if queued | ✅ | same guard in `evaluateSendGate`; integration guard test |
| 3 | hard bounce creates suppression | ✅ | integration: `hard bounce creates a suppression` |
| 4 | unsubscribe creates global suppression | ✅ | integration: `unsubscribe creates a global suppression` |
| 5 | complaint pauses campaign | ✅ | `REPLY_ESCALATION` map (unit) + complaint→suppression action (integration) |
| 6 | unapproved affiliate offer blocks | ✅ | `affiliateCompliance.test.ts` |
| 7 | offer without email permission blocks | ✅ | `affiliateCompliance.test.ts` |
| 8 | blocked geography prevents sending | ✅ | `affiliateCompliance.test.ts` |
| 9 | stale offer terms force review | ✅ | `affiliateCompliance.test.ts` |
| 10 | missing disclosure blocks sending | ✅ | `affiliateCompliance.test.ts` |
| 11 | prohibited claim blocks sending | ✅ | `affiliateCompliance.test.ts` |
| 12 | duplicate conversion is ignored | ✅ | integration: idempotent conversion ingest |
| 13 | duplicate message is not sent | ⚠️ gap | no campaign-driven send path yet (audit is a cron); idempotency mechanism exists (`UNIQUE(idempotency_key)`) but no campaign send to assert against |
| 14 | paused campaign is not processed | ⚠️ gap | same — needs the campaign send loop that does not exist yet |
| 15 | existing mailbox limits remain unchanged | ⚠️ partial | `evaluateSendGate` daily-cap logic untouched; no dedicated regression test added |
| 16 | worker restart does not duplicate sends | ✅ | integration: replay with same `idempotency_key` → one row |
| 17 | positive reply creates a draft, not an auto-response | ✅ | `replyClassifierExtended.test.ts` |
| 18 | legal/privacy request is escalated | ✅ | `replyClassifierExtended.test.ts` |
| 19 | tracking maps conversion to campaign/contact/offer | ✅ | integration: click→conversion attribution join |
| 20 | backup and restore instructions are valid | ✅ (procedure) | `scripts/backup.sh` / `scripts/restore.sh` reviewed; pre-change backup verified present; documented in `docs/ROLLBACK.md` |

**17 of 20 automated, 3 deferred** (#13/#14/#15) — all blocked on a campaign-driven send
path that does not exist yet (live outreach is the audit cron, not a campaign engine).

## Unresolved risks

- **§13/§14/§15 untested end-to-end** until a campaign send loop exists. The guards
  (suppression, offer-approval, idempotency) are in place and unit/integration-tested, but
  the "paused campaign is skipped" and "duplicate message not sent" claims cannot be
  exercised without that loop.
- **Integration suite needs a live DB** — it is not part of CI's default host run. It must
  be run manually (command above) before a release that touches suppression, tracking, or
  the reply importer.
- **`campaigns` rows do not yet drive real sends** — the engine is API + gates + schema;
  no autonomous campaign sending is wired. This is by design (TZ: no real send without
  owner approval) but means several §21 items stay latent.

## Rollback

See `docs/ROLLBACK.md`. Levels: (1) `git revert` the engine commits + rebuild api;
(2) reverse migrations 0022/0023 (additive, drop new tables + `campaigns` columns);
(3) full `make restore F=<backup>`. Pre-change backup:
`/opt/backups/email-outreach/20260725T075113Z/` (verified present).

## Production readiness

Gates, schema, offer registry, postback ingestion, reply escalation, and suppression are
**implemented and tested**. No autonomous campaign sending is enabled. Safe to leave
running as-is; the audit cron is unaffected.

## Next recommended action

Build the **§17 admin UI** (currently API-only) and, alongside it, the campaign-driven
send loop that unblocks §21 #13/#14/#15. Then write those three tests against it.
