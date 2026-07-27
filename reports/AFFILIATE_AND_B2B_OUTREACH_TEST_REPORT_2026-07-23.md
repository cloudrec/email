# Affiliate & B2B Outreach — Test Report

**Filename date 2026-07-23** (TZ §24 fixed name). **Executed:** 2026-07-26 on branch
`launch-stage3`, `/opt/email`. Last migration = 0024.

## Summary

| Suite | Result |
|-------|--------|
| Host unit suite (`npm test`) | **129 passed**, 7 skipped (11 files) — incl. §9 quality gate (19), §17 engine-safety (9), §21 send gate (13), §18 send planner (7) |
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
| After §9 quality gate + §21 integration | 100 unit + 7 integration = 107 |
| After §17 engine-safety + §21 send gate | 122 unit + 7 integration = 129 |
| After §18 send-worker + planner | **129 unit + 7 integration = 136** |

New this session added: §17 engine-safety + contact detail, §18 campaign send-worker +
planner, §21 send gate. No existing passing test was removed or weakened.

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
| `campaignSendGate.test.ts` | 13 | §21 send-safety decision (#13/#14/#15 + suppressed/offer) |
| `campaignSendPlanner.test.ts` | 7 | §18 per-batch send planning + capacity accounting |
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
| 13 | duplicate message is not sent | ✅ | `campaignSendGate.test.ts` — `decideCampaignSend` blocks a repeated `campaignSendKey`; deterministic key contract |
| 14 | paused campaign is not processed | ✅ | `campaignSendGate.test.ts` — lifecycle_state PAUSED blocks the send decision |
| 15 | existing mailbox limits remain unchanged | ✅ | `campaignSendGate.test.ts` — send decision honours the per-mailbox daily limit unchanged (sends at limit−1, blocks at limit) |
| 16 | worker restart does not duplicate sends | ✅ | integration: replay with same `idempotency_key` → one row |
| 17 | positive reply creates a draft, not an auto-response | ✅ | `replyClassifierExtended.test.ts` |
| 18 | legal/privacy request is escalated | ✅ | `replyClassifierExtended.test.ts` |
| 19 | tracking maps conversion to campaign/contact/offer | ✅ | integration: click→conversion attribution join |
| 20 | backup and restore instructions are valid | ✅ (procedure) | `scripts/backup.sh` / `scripts/restore.sh` reviewed; pre-change backup verified present; documented in `docs/ROLLBACK.md` |

**20 of 20 automated.** #13/#14/#15 are covered by the pure `campaignSendGate` +
`campaignSendPlanner` (`api/src/services/`), and those are now consumed by a real worker:
`api/src/cli/campaignSendWorker.js`. The worker is **dry-run by default** (sends nothing,
writes nothing) and was exercised end-to-end against the live DB on a throwaway campaign:
recipients planned, paused→blocked, suppressed→blocked, LIVE-requested-but-not-armed→dry
run, `campaign_send_log` stayed empty, scratch data removed (0 residue). Real dispatch is
owner-gated (CAMPAIGN_SEND_LIVE=1 + campaign ACTIVE + CAMPAIGN_SEND_CONFIRM=uuid + cap).

## Unresolved risks

- **§13/§14/§15 verified via the worker in dry-run, not via a real send.** The worker
  (`campaignSendWorker.js`) applies the gate/planner and was proven end-to-end on a throwaway
  campaign (paused/suppressed/duplicate all blocked, `campaign_send_log` empty). A true
  "message physically withheld at SMTP" assertion needs an armed live run, which is
  owner-gated — not exercised here.
- **Integration suite needs a live DB** — it is not part of CI's default host run. It must
  be run manually (command above) before a release that touches suppression, tracking, or
  the reply importer.
- **No autonomous sending** — the worker is dry-run by default and on no cron; a real
  campaign send requires the owner to arm it (CAMPAIGN_SEND_LIVE=1 + campaign ACTIVE +
  CAMPAIGN_SEND_CONFIRM=uuid). By design (TZ: no real send without owner approval).

## Rollback

See `docs/ROLLBACK.md`. Levels: (1) `git revert` the engine commits + rebuild api;
(2) reverse migrations 0022/0023/0024 (additive, drop new tables + `campaigns` columns);
(3) full `make restore F=<backup>`. Pre-change backup:
`/opt/backups/email-outreach/20260725T075113Z/` (verified present).

## Production readiness

Gates, schema, offer registry, postback ingestion, reply escalation, suppression, admin
UI, and the campaign send-worker are **implemented and tested**. The send-worker defaults
to dry-run and is not on any cron; no autonomous campaign sending is enabled. Safe to leave
running as-is; the audit cron is unaffected.

## Next recommended action

The TZ is fully implemented and tested (§17 admin UI; §21 20/20; §18 send-worker in
dry-run). Next is an **owner-driven first live send**: set one campaign to `ACTIVE`, arm the
worker (CAMPAIGN_SEND_LIVE=1 + CAMPAIGN_SEND_CONFIRM=uuid) with a small `CAMPAIGN_SEND_MAX`
(1–5), watch delivery, then decide on scale-up. After a real armed run exists, add an
end-to-end test asserting a paused/duplicate/over-limit message is physically withheld.
