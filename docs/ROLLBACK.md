# Rollback

How to undo the B2B/affiliate engine safely. The engine is additive: legacy campaigns,
the audit cron, and the manual-outreach flow do not depend on any of the new columns or
tables, so rolling back is low-risk. Three levels, least to most drastic.

## Pre-change backup (verified)

A full backup was taken before the engine work:

```
/opt/backups/email-outreach/20260725T075113Z/
```

Nightly backups also run at 03:00 CEST via `make backup` → `scripts/backup.sh`, written to
`/opt/email/backups/backup-<UTC-timestamp>` (encrypted to `.tar.gz.gpg` when
`BACKUP_ENCRYPT_PASSPHRASE` is set).

## Level 1 — revert code, keep schema

The new columns/tables are nullable and unused by legacy paths, so reverting only the code
is safe and usually enough. On branch `launch-stage3`, the engine commits are:

```
8782bcd  test(engine): DB integration invariants (§21)
47974b1  test(engine): conversion tracking maps (§21.19)
a678597  feat(engine): message quality gate (§9)
c5e455f  feat(engine): reply escalation actions (§11)
88bcb9b  feat(engine): finer reply classes + escalation map (§11)
4ce5131  feat(engine): 3 DRAFT experiments + reports (§20,§24)
22b9f3c  chore: track experiments seed
a7b8f1b  feat(engine): affiliate offer registry + postback API (§5,§12,§17,§18)
bc72be2  feat(engine): affiliate compliance gate + stale-terms review (§5,§10)
```

Revert what you need, then rebuild:

```bash
cd /opt/email
git revert --no-edit <sha> [<sha> ...]
docker compose build api && docker compose up -d api
make health
```

## Level 2 — reverse the additive migrations

Migrations 0022 (campaigns columns + affiliate tables) and 0023 (reply classification
enum) are additive and reversible. To drop them (only after Level 1, and after confirming
nothing you keep now reads these columns):

```bash
cd /opt/email
DBP=$(grep -E '^DB_ROOT_PASSWORD=' .env | cut -d= -f2); DBN=$(grep -E '^DB_NAME=' .env | cut -d= -f2)
docker compose exec -T db mariadb -uroot -p"$DBP" "$DBN" <<'SQL'
-- 0024 reverse: drop the campaign send log.
DROP TABLE IF EXISTS campaign_send_log;
-- 0022 reverse: drop the new tables and the added campaigns columns.
DROP TABLE IF EXISTS campaign_experiments, compliance_snapshots,
  revenue_events, conversion_events, click_events,
  affiliate_offer_terms_versions, affiliate_offers;
ALTER TABLE campaigns
  DROP COLUMN IF EXISTS engine_config_json,
  DROP COLUMN IF EXISTS max_send_volume,
  DROP COLUMN IF EXISTS mode_owner,
  DROP COLUMN IF EXISTS affiliate_offer_id,
  DROP COLUMN IF EXISTS lifecycle_state,
  DROP COLUMN IF EXISTS campaign_mode;
SQL
```

`inbox_replies.classification` (0023) is an ENUM widened with additive values — leaving it
in place is harmless. Only narrow it back if you have removed every row using a new value.

Take a fresh backup first:

```bash
make backup
```

## Level 3 — full restore

If the database is in an unknown state, restore from a backup archive. **This replaces all
current DB contents.**

```bash
cd /opt/email
make restore F=backups/backup-<UTC-timestamp>.tar.gz.gpg
# scripts/restore.sh prompts: type RESTORE to proceed, then decrypts + imports the dump
make health
```

`restore.sh` requires `BACKUP_ENCRYPT_PASSPHRASE` (from `.env`) to decrypt.

## Verify after any rollback

```bash
make health
cd /opt/email/api && npm test
```
