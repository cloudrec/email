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

Migrations live in `db/migrations/`. Last applied = `0023`. All engine migrations are
additive and reversible (see [ROLLBACK.md](ROLLBACK.md)).

## Database access

```bash
cd /opt/email
DBP=$(grep -E '^DB_ROOT_PASSWORD=' .env | cut -d= -f2); DBN=$(grep -E '^DB_NAME=' .env | cut -d= -f2)
docker compose exec -T db mariadb -uroot -p"$DBP" "$DBN" -e "SHOW TABLES;"
```

The client is `mariadb`, not `mysql`. The Postal message store is a **separate** DB
(`postal-server-1`).

## Send safety (TZ §18)

Every queue operation is idempotent: unique send key per campaign/contact/step,
no duplicate sends after a worker restart, no send when a campaign is paused, when a
contact is suppressed, or when an affiliate offer is not APPROVED. The suppressed-contact
and idempotency guarantees are covered by `npm run test:integration`.

## Tests

```bash
cd /opt/email/api
npm test                 # unit suite (100 passed, integration skipped)
npm run test:integration # DB-backed §21 invariants — see B2B_AND_AFFILIATE_ENGINE.md for the container run
```
