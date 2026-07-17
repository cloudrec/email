-- Phase 22D — Multi-mailbox orchestrator + mailbox fleet manager.
-- Idempotent. Reuses sending_providers as the reusable PROVIDER PROFILE model
-- (shared SMTP/IMAP host/port; secrets stay env-ref names only) and extends
-- sender_identities into a full mailbox-account / fleet model. Adds the
-- outreach_touchpoints contact ledger. NOTHING here enables real sending.

-- ── Provider profile defaults (reuse sending_providers) ──────────────────────
-- Shared host/port already exist (smtp_host/port/secure, imap_host/port/secure,
-- *_ref). Add per-profile defaults applied to new mailboxes. Secrets NEVER here.
ALTER TABLE sending_providers
  ADD COLUMN IF NOT EXISTS default_from_name    VARCHAR(160) NULL  AFTER name,
  ADD COLUMN IF NOT EXISTS default_daily_limit  INT NOT NULL DEFAULT 5 AFTER outbound_enabled,
  ADD COLUMN IF NOT EXISTS default_hourly_limit INT NOT NULL DEFAULT 2 AFTER default_daily_limit;

-- Status vocabulary: keep legacy 'pending' for back-compat, profiles use active/disabled/error.
ALTER TABLE sending_providers
  MODIFY COLUMN status ENUM('pending','active','disabled','error') NOT NULL DEFAULT 'pending';

-- ── Mailbox account / fleet model (extend sender_identities) ─────────────────
-- `from_email` stays the canonical address column (existing send code reads it);
-- API exposes it as `email`. inbound_enabled mirrors legacy imap_enabled.
ALTER TABLE sender_identities
  MODIFY COLUMN domain_id BIGINT UNSIGNED NULL,
  MODIFY COLUMN purpose ENUM('main','cold_outreach','transactional','internal_test','support')
    NOT NULL DEFAULT 'cold_outreach',
  MODIFY COLUMN status ENUM('draft','active','paused','disabled','error') NOT NULL DEFAULT 'draft';

ALTER TABLE sender_identities
  ADD COLUMN IF NOT EXISTS outbound_enabled  TINYINT(1) NOT NULL DEFAULT 1 AFTER status,
  ADD COLUMN IF NOT EXISTS inbound_enabled   TINYINT(1) NOT NULL DEFAULT 0 AFTER outbound_enabled,
  ADD COLUMN IF NOT EXISTS smtp_user_ref     VARCHAR(120) NULL AFTER inbound_enabled,
  ADD COLUMN IF NOT EXISTS smtp_secret_ref   VARCHAR(120) NULL AFTER smtp_user_ref,
  ADD COLUMN IF NOT EXISTS imap_user_ref     VARCHAR(120) NULL AFTER smtp_secret_ref,
  ADD COLUMN IF NOT EXISTS imap_secret_ref   VARCHAR(120) NULL AFTER imap_user_ref,
  ADD COLUMN IF NOT EXISTS health_status     ENUM('safe','warning','danger','unknown') NOT NULL DEFAULT 'unknown' AFTER paused_reason,
  ADD COLUMN IF NOT EXISTS last_smtp_test_at TIMESTAMP NULL AFTER health_status,
  ADD COLUMN IF NOT EXISTS last_imap_test_at TIMESTAMP NULL AFTER last_smtp_test_at,
  ADD COLUMN IF NOT EXISTS last_reply_at     TIMESTAMP NULL AFTER last_imap_test_at,
  ADD COLUMN IF NOT EXISTS last_error        VARCHAR(500) NULL AFTER last_reply_at,
  ADD COLUMN IF NOT EXISTS smtp_sent_today   INT NOT NULL DEFAULT 0 AFTER sent_today,
  ADD COLUMN IF NOT EXISTS replies_today     INT NOT NULL DEFAULT 0 AFTER smtp_sent_today,
  ADD COLUMN IF NOT EXISTS interested_today  INT NOT NULL DEFAULT 0 AFTER replies_today,
  ADD COLUMN IF NOT EXISTS negative_today    INT NOT NULL DEFAULT 0 AFTER interested_today,
  ADD COLUMN IF NOT EXISTS bounce_like_today INT NOT NULL DEFAULT 0 AFTER negative_today,
  ADD COLUMN IF NOT EXISTS complaints_today  INT NOT NULL DEFAULT 0 AFTER bounce_like_today,
  ADD COLUMN IF NOT EXISTS unsubscribes_today INT NOT NULL DEFAULT 0 AFTER complaints_today;

-- inbound_enabled mirrors legacy imap_enabled for pre-existing rows.
UPDATE sender_identities SET inbound_enabled=1 WHERE imap_enabled=1 AND inbound_enabled=0;
-- Pre-existing active mailboxes keep active; new health unknown until tested.
UPDATE sender_identities SET health_status='unknown' WHERE health_status IS NULL;

-- ── Contact touch ledger ─────────────────────────────────────────────────────
-- Answers: who did we contact, from which mailbox, when, what step, did they
-- reply, should we follow up / never contact again.
CREATE TABLE IF NOT EXISTS outreach_touchpoints (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id         BIGINT NOT NULL,
  contact_point_id  BIGINT UNSIGNED NULL,
  contact_id        BIGINT UNSIGNED NULL,
  company_id        BIGINT UNSIGNED NULL,
  queue_item_id     BIGINT UNSIGNED NULL,
  followup_task_id  BIGINT UNSIGNED NULL,
  mailbox_id        BIGINT UNSIGNED NULL,
  provider_profile_id BIGINT UNSIGNED NULL,
  campaign_id       BIGINT UNSIGNED NULL,
  email             VARCHAR(255) NULL,
  channel ENUM('email','manual_zoho','manual_generic','contact_form','telegram','whatsapp')
    NOT NULL DEFAULT 'email',
  direction ENUM('outbound','inbound') NOT NULL DEFAULT 'outbound',
  touch_type ENUM('first_touch','followup_1','followup_2','reply','manual_note')
    NOT NULL DEFAULT 'first_touch',
  subject           VARCHAR(255) NULL,
  body_hash         VARCHAR(64) NULL,
  status ENUM('planned','copied','sent_manual','sent_smtp','replied','skipped','blocked','failed')
    NOT NULL DEFAULT 'planned',
  sent_at           TIMESTAMP NULL,
  replied_at        TIMESTAMP NULL,
  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  metadata_json     TEXT NULL,
  INDEX idx_tp_tenant (tenant_id),
  INDEX idx_tp_email (tenant_id, email),
  INDEX idx_tp_company (tenant_id, company_id),
  INDEX idx_tp_mailbox (mailbox_id),
  INDEX idx_tp_queue (queue_item_id),
  INDEX idx_tp_contact_point (contact_point_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
