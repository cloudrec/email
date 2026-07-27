-- 0024: durable per-message send log for the campaign send-worker (TZ §18/§21).
-- Additive, isolated table. The UNIQUE(send_key) is the idempotency anchor: the same
-- (campaign, contact, step) can be claimed at most once, so a worker restart or a re-run
-- never double-sends (TZ §21 #13 duplicate, #16 restart-no-dup).
--
-- IMPORTANT: a DRY RUN writes NO rows here — it only logs what it would do. This table
-- holds ONLY real send claims (dry_run=0): the live worker INSERTs the send_key BEFORE
-- dispatch (claim), then updates status to 'sent'/'failed'. `alreadySentKeys` for the gate
-- is read from status='sent' rows, so a prior dry run never blocks a later real send.
-- The dry_run column exists for forward-compatibility only; the live path always sets 0.
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS campaign_send_log;

CREATE TABLE IF NOT EXISTS campaign_send_log (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id     BIGINT UNSIGNED NOT NULL,
  campaign_id   BIGINT UNSIGNED NOT NULL,
  contact_id    BIGINT UNSIGNED NULL,
  step          INT NOT NULL DEFAULT 1,
  send_key      VARCHAR(190) NOT NULL,
  status        ENUM('planned','sent','skipped','failed') NOT NULL DEFAULT 'planned',
  dry_run       TINYINT(1) NOT NULL DEFAULT 1,
  blockers      VARCHAR(500) NULL,
  mailbox_id    BIGINT UNSIGNED NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (id),
  UNIQUE KEY uk_csl_sendkey (send_key),
  KEY idx_csl_campaign (campaign_id),
  KEY idx_csl_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
