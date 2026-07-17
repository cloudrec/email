-- Phase 22 — Own Outreach Runtime.
-- Generalizes the Zoho bridge into a provider-neutral mailbox runtime, upgrades the
-- reply inbox (confidence + reason + more classifications), and adds a SAFE
-- follow-up task queue (manual/operator-driven, NO bulk send, NO scheduler).
-- NO secrets are stored — provider rows hold env-var NAMES only.

-- ── Provider type: add generic / future provider types ───────────────────────
ALTER TABLE sending_providers
  MODIFY COLUMN provider_type
    ENUM('generic','brevo','smtp2go','mailgun','wooxy','postal','ses','zoho_smtp_imap',
         'generic_smtp_imap','gmail_workspace_later','microsoft_365_later','self_hosted_smtp_imap_later')
    NOT NULL DEFAULT 'generic';

-- ── Provider-neutral mailbox runtime fields (env-var NAMES only, never secrets) ─
ALTER TABLE sending_providers
  ADD COLUMN IF NOT EXISTS imap_host VARCHAR(255) NULL AFTER smtp_secure;
ALTER TABLE sending_providers
  ADD COLUMN IF NOT EXISTS imap_port INT NULL AFTER imap_host;
ALTER TABLE sending_providers
  ADD COLUMN IF NOT EXISTS imap_secure TINYINT(1) NOT NULL DEFAULT 1 AFTER imap_port;
-- smtp_user_ref / smtp_secret_ref mirror username_ref / secret_ref under the
-- runtime's canonical names; imap_*_ref are new. All hold env-var NAMES.
ALTER TABLE sending_providers
  ADD COLUMN IF NOT EXISTS smtp_user_ref VARCHAR(120) NULL AFTER imap_secure;
ALTER TABLE sending_providers
  ADD COLUMN IF NOT EXISTS smtp_secret_ref VARCHAR(120) NULL AFTER smtp_user_ref;
ALTER TABLE sending_providers
  ADD COLUMN IF NOT EXISTS imap_user_ref VARCHAR(120) NULL AFTER smtp_secret_ref;
ALTER TABLE sending_providers
  ADD COLUMN IF NOT EXISTS imap_secret_ref VARCHAR(120) NULL AFTER imap_user_ref;
ALTER TABLE sending_providers
  ADD COLUMN IF NOT EXISTS inbound_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER imap_secret_ref;
ALTER TABLE sending_providers
  ADD COLUMN IF NOT EXISTS outbound_enabled TINYINT(1) NOT NULL DEFAULT 1 AFTER inbound_enabled;
ALTER TABLE sending_providers
  ADD COLUMN IF NOT EXISTS test_status ENUM('untested','smtp_ok','imap_ok','both_ok','error')
    NOT NULL DEFAULT 'untested' AFTER outbound_enabled;
ALTER TABLE sending_providers
  ADD COLUMN IF NOT EXISTS last_smtp_test_at TIMESTAMP NULL AFTER test_status;
ALTER TABLE sending_providers
  ADD COLUMN IF NOT EXISTS last_imap_test_at TIMESTAMP NULL AFTER last_smtp_test_at;

-- Backfill canonical refs from the legacy columns where present.
UPDATE sending_providers SET smtp_user_ref = username_ref WHERE smtp_user_ref IS NULL AND username_ref IS NOT NULL;
UPDATE sending_providers SET smtp_secret_ref = secret_ref WHERE smtp_secret_ref IS NULL AND secret_ref IS NOT NULL;

-- ── Reply inbox 2.0: confidence, reason, extra classifications ────────────────
ALTER TABLE inbox_replies
  MODIFY COLUMN classification
    ENUM('interested','not_interested','do_not_contact','unsubscribe','wrong_person',
         'out_of_office','bounce_like','auto_reply','unknown')
    NOT NULL DEFAULT 'unknown';
ALTER TABLE inbox_replies
  ADD COLUMN IF NOT EXISTS confidence DECIMAL(3,2) NOT NULL DEFAULT 0.00 AFTER classification_source;
ALTER TABLE inbox_replies
  ADD COLUMN IF NOT EXISTS classification_reason VARCHAR(255) NULL AFTER confidence;

-- ── Safe follow-up task queue (manual, NO bulk, NO scheduler) ────────────────
-- One row = one follow-up an operator MAY send by hand after review. Blocked
-- automatically if a reply arrived, the contact is suppressed, the mailbox is
-- paused, the daily cap is hit, or the opt-out line is missing.
CREATE TABLE IF NOT EXISTS manual_followup_tasks (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  queue_item_id BIGINT UNSIGNED NULL,
  contact_point_id BIGINT UNSIGNED NULL,
  company_id BIGINT UNSIGNED NULL,
  mailbox_id BIGINT UNSIGNED NULL,
  email VARCHAR(255) NOT NULL,
  company_name VARCHAR(255) NULL,
  due_at TIMESTAMP NULL,
  status ENUM('pending','ready','copied','sent_manually','skipped','cancelled','blocked')
    NOT NULL DEFAULT 'pending',
  followup_step TINYINT NOT NULL DEFAULT 1,
  subject VARCHAR(255) NULL,
  body TEXT NULL,
  blockers_json TEXT NULL,
  sent_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_fu_tenant_email_step (tenant_id, email, followup_step),
  INDEX idx_fu_tenant_status (tenant_id, status),
  INDEX idx_fu_due (tenant_id, due_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
