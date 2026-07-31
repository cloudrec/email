# Prospect Audit Email Safety Gate — Report (2026-07-31)

Goal: stop routine cold/warmup mail from accidentally hitting domains queued for a new
personal audit batch, and stage a handoff that only exposes owner-approved records — with
**zero sends** from the batch. Delivered, tested on a fixture, inert until activated.

## audit emails sent: 0
No `--send` was used anywhere in this work. Every sender run was a dry run. The reservation
table is empty (fixture cleaned), so the gate is currently a no-op. Nothing was emailed.

## Current cron & limits (unchanged — recorded per instruction)

| When (CEST) | Job | Volume |
|---|---|---|
| 10:00 | `warmup_send.mjs` (emails.cheap) | warmup ramp (day ~18, ~150/day) |
| 11:00 | `warmup_send_pilot.mjs` (5 brand domains) | warmup |
| 13:00 | `audit_daily_send.sh` first-touch | 25/run |
| 15:00 | `audit_followup_daily.sh` touch-2 | 25/day |
| 17:00 | `audit_daily_send.sh` first-touch | 25/run |
| :05 hourly | `postal_unsuppress_reputation.mjs` | reputation-hold clear |
| 03:00 | `make backup` | — |

**Recorded risk:** clients.help is at **75/day** (50 first-touch + 25 follow-up) across 4
warmed boxes (~19/box) — aggressive for cold. Per instruction I did **not** expand sending,
did **not** add new audit leads, and did **not** stop any cron. If Postal Held/HardFail for
clients.help climbs, back off in order: remove the 15:00 follow-up line, then the 17:00
first-touch line. Crontab backups: `scratchpad/crontab.bak`, `crontab.bak2`.

## What changed

**/opt/email** (commit `525a1c5`)
- `db/migrations/0025_reserved_domains.sql` — `reserved_domains` (UNIQUE domain, soft-release
  via `released_at`). Applied. Last migration now 0025.
- `api/src/services/reservedDomains.ts` — `normalizeDomain` (pure), `loadReservedDomains`,
  `isReserved` (exact + subdomain match). Baked into api dist.
- Exclusion wired into all four send paths:
  - `scripts/audit_outreach_send.mjs` (first-touch) — skips reserved before send.
  - `scripts/audit_followup_send.mjs` (touch-2) — skips reserved.
  - `scripts/warmup_send.mjs`, `scripts/warmup_send_pilot.mjs` — `NOT EXISTS reserved_domains`
    in the candidate SQL.
- `scripts/reserve_domains.mjs` (+ `reserve_domains.sh` wrapper) — reservation tool.

**/opt/prospect-audit** (commit `eecd92f`)
- `scripts/export_approved_handoff.py` — stages ONLY `lifecycle.approved` prospects; below
  approved is never included. DRY-RUN default. Empty now (0 approved).

## Design notes

- **Senders are the authoritative chokepoint.** Even if a reserved domain reaches the export
  queue, every sender excludes it, so a reserved domain cannot be emailed. (export-level
  exclusion in prospect-audit was left out: it reads Postgres while `reserved_domains` is in
  MariaDB, and the senders already guarantee no-send.)
- **Reservation ≠ send.** The reserve tool writes only `reserved_domains`; it never creates a
  touchpoint, so no false "sent" state.
- **Idempotent / journaled / dry-run / rollback** — see commands below.
- **Subdomain-safe:** reserving `example.com` also covers `mail.example.com`.

## Tests

- `api/src/services/__tests__/reservedDomains.test.ts` — 10 unit tests (normalize, exact,
  email, subdomain, non-match, empty-set no-op). Full suite: **139 passed / 7 skipped**.
- Fixture end-to-end (`scratchpad/selected_domains.fixture.txt`, 5 domains):
  - dry-run wrote nothing; **overlap report flagged `madeinlondondental.co.uk` as
    ALREADY-CONTACTED** (proves current outreach can intersect the reserved batch).
  - commit reserved 5; re-commit was a clean no-op (idempotent, 5 rows, 0 dups).
  - audit sender then logged `skip hello@madeinlondondental.co.uk: reserved for audit batch`.
  - `--release-all` re-included all; sender reserved-skips dropped to 0.
  - fixture rows deleted — **0 residue**.
- Staging: 936 complete audits reviewed → **0 approved → empty handoff**.

## Rollback

- Un-reserve one domain: `scripts/reserve_domains.sh --release <domain>`
- Un-reserve everything: `scripts/reserve_domains.sh --release-all`
- Drop the whole mechanism: `DROP TABLE reserved_domains;` (migration 0025 rollback) — senders
  tolerate its absence only after their reserved-check is removed; simpler is `--release-all`
  which makes the gate inert without code changes.

## Exact activation (once `/opt/prospect-audit/exports/selected_domains.txt` exists)

```bash
cd /opt/email
# 1. DRY RUN — review overlap + what would be reserved (writes nothing):
scripts/reserve_domains.sh
# 2. ACTIVATE — reserve the domains (idempotent; excludes them from all sends):
scripts/reserve_domains.sh --commit
# 3. Confirm:
scripts/reserve_domains.sh --list
```

The gate takes effect at the next cron run (senders are re-copied into the container each
run and read the live `reserved_domains` table). No cron edit needed. Until the file exists
and `--commit` is run, the gate is inert and nothing is excluded.

## Paths

- Gate table: MariaDB `email_platform.reserved_domains`
- Service: `/opt/email/api/src/services/reservedDomains.ts`
- Reserve tool: `/opt/email/scripts/reserve_domains.mjs` + `reserve_domains.sh`
- Domain list (owner-provided): `/opt/prospect-audit/exports/selected_domains.txt`
- Approved handoff: `/opt/prospect-audit/scripts/export_approved_handoff.py` → `data/approved_handoff.json`
- Fixture: `scratchpad/selected_domains.fixture.txt`
