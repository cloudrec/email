# Campaign Operations

Day-to-day operation of the engine: what runs on cron, how to build/deploy, migrate,
back up, and run the test suites. Nothing here sends without human approval.

## What runs on its own (do not break)

| When (CEST) | Job | Purpose |
|-------------|-----|---------|
| 10:00 | `scripts/warmup_send.mjs` | reputation warmup (emails.cheap) |
| 11:00 | `scripts/warmup_send_pilot.mjs` | warmup, 5 brand domains |
| 13:00 | `scripts/audit_daily_send.sh` | 25/day audit outreach, score<80, all safety rails |
| :05 hourly | `scripts/postal_unsuppress_reputation.mjs` | clear reputation-only Postal holds |
| 03:00 | `make backup` | nightly backup |

The audit outreach queue is built by
`prospect-audit/scripts/export_audit_queue.py` → JSON → `email/scripts/audit_outreach_send.mjs`.

## Build & deploy the API

The API is TypeScript compiled to `dist/` and baked into the image. After editing
`api/src/**`:

```bash
cd /opt/email
docker compose build api && docker compose up -d api
make health
```

## Makefile targets

```bash
make up        # start stack            make logs      # tail logs
make down      # stop stack             make ps        # container status
make restart   # restart stack          make health    # health check
make build     # build images           make migrate   # apply DB migrations
make backup    # scripts/backup.sh      make restore F=<file>  # scripts/restore.sh
make shell-api # shell into api          make shell-db  # shell into db
```

## Migrations

```bash
cd /opt/email && make migrate            # runs dist/cli/migrate.js inside the api container
```

Migrations live in `db/migrations/`. Last applied = `0024`. All engine migrations are
additive and reversible (see [ROLLBACK.md](ROLLBACK.md)).

## Database access

```bash
cd /opt/email
DBP=$(grep -E '^DB_ROOT_PASSWORD=' .env | cut -d= -f2); DBN=$(grep -E '^DB_NAME=' .env | cut -d= -f2)
docker compose exec -T db mariadb -uroot -p"$DBP" "$DBN" -e "SHOW TABLES;"
```

The client is `mariadb`, not `mysql`. The Postal message store is a **separate** DB
(`postal-server-1`).

## Campaign send-worker (TZ §18) — dry-run by default

The engine campaign sender is `api/src/cli/campaignSendWorker.js`. It plans one message
per subscribed recipient of each engine-mode campaign (`campaign_mode` set) through the
pure `campaignSendPlanner` / `campaignSendGate`, and dispatches **only when explicitly
armed by the owner**. It is NOT wired to any cron — run it by hand.

**Default (dry run) — sends nothing, writes nothing:**

```bash
cd /opt/email
docker compose exec -T api node dist/cli/campaignSendWorker.js            # all engine campaigns
docker compose exec -T api node dist/cli/campaignSendWorker.js <campaignId>
```

It prints, per campaign: `recipients / wouldSend / blocked` and a blocker breakdown
(`campaign_paused`, `contact_suppressed`, `duplicate_send`, `daily_limit_reached`,
`affiliate_offer_not_approved`).

**Live send — requires ALL of these (any missing ⇒ stays dry-run):**

1. `CAMPAIGN_SEND_LIVE=1` (global arm)
2. the campaign's `lifecycle_state = 'ACTIVE'`
3. `CAMPAIGN_SEND_CONFIRM=<campaign.uuid>` (per-campaign confirmation token)

plus a per-run cap `CAMPAIGN_SEND_MAX` (default 1), and every message must pass the §9
quality gate and (affiliate) §10 compliance gate. The worker claims each `send_key` in
`campaign_send_log` (UNIQUE) BEFORE dispatch, so a re-run or restart never double-sends.

```bash
docker compose exec -T \
  -e CAMPAIGN_SEND_LIVE=1 -e CAMPAIGN_SEND_CONFIRM=<uuid> -e CAMPAIGN_SEND_MAX=5 \
  api node dist/cli/campaignSendWorker.js <campaignId>
```

Idempotency ledger: `campaign_send_log` (migration 0024). Dry runs leave it empty; only
real sends write `status='sent'` rows.

## Send safety (TZ §18)

Every queue operation is idempotent: unique send key per campaign/contact/step,
no duplicate sends after a worker restart, no send when a campaign is paused, when a
contact is suppressed, or when an affiliate offer is not APPROVED. The suppressed-contact
and idempotency guarantees are covered by `npm run test:integration`.

## Tests

```bash
cd /opt/email/api
npm test                 # unit suite (129 passed, 7 integration skipped)
npm run test:integration # DB-backed §21 invariants — see B2B_AND_AFFILIATE_ENGINE.md for the container run
```
