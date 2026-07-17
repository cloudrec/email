-- 0020: inbox_replies bounce-parse columns.
-- These columns are written by both reply importers (api/src/cli/importReplies.ts
-- and POST /replies/import) and by scripts/backfill_bounce_suppressions.ts, but were
-- only ever added out-of-band on the live DB — no migration created them. A DB rebuilt
-- purely from migrations would fail every reply import with ER_BAD_FIELD_ERROR.
-- Idempotent (IF NOT EXISTS): a no-op on the live DB, completes the migration set.

ALTER TABLE inbox_replies
  ADD COLUMN IF NOT EXISTS failed_recipient      VARCHAR(320)                 NULL,
  ADD COLUMN IF NOT EXISTS bounce_category       VARCHAR(60)                  NULL,
  ADD COLUMN IF NOT EXISTS bounce_confidence     DECIMAL(3,2)                 NULL,
  ADD COLUMN IF NOT EXISTS classification_source ENUM('rule','llm','manual')  NOT NULL DEFAULT 'rule';
