-- Phase 21A — Zero-budget Zoho bridge + own manual outreach stack.
-- Adds: zoho_smtp_imap provider type, manual outreach queue (operator-driven,
-- NO bulk send), IMAP reply inbox, manual-bridge templates (operator-approved),
-- and per-mailbox manual/IMAP counters. NO secrets stored — credentials live in
-- .env only (ZOHO_SMTP_USER / ZOHO_SMTP_PASSWORD / ZOHO_IMAP_USER / ZOHO_IMAP_PASSWORD).

-- ── Provider type: add zoho_smtp_imap ────────────────────────────────────────
ALTER TABLE sending_providers
  MODIFY COLUMN provider_type
    ENUM('generic','brevo','smtp2go','mailgun','wooxy','postal','ses','zoho_smtp_imap')
    NOT NULL DEFAULT 'generic';

-- ── Per-mailbox manual + IMAP state (Zoho bridge counters) ───────────────────
ALTER TABLE sender_identities
  ADD COLUMN IF NOT EXISTS manual_sent_today INT NOT NULL DEFAULT 0 AFTER sent_today;
ALTER TABLE sender_identities
  ADD COLUMN IF NOT EXISTS manual_counters_day DATE NULL AFTER manual_sent_today;
ALTER TABLE sender_identities
  ADD COLUMN IF NOT EXISTS imap_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER paused_reason;
ALTER TABLE sender_identities
  ADD COLUMN IF NOT EXISTS imap_last_uid BIGINT UNSIGNED NULL AFTER imap_enabled;
ALTER TABLE sender_identities
  ADD COLUMN IF NOT EXISTS imap_start_at TIMESTAMP NULL AFTER imap_last_uid;
ALTER TABLE sender_identities
  ADD COLUMN IF NOT EXISTS imap_last_checked_at TIMESTAMP NULL AFTER imap_start_at;

-- ── Manual Outreach Queue ────────────────────────────────────────────────────
-- One row = one lead an operator may contact MANUALLY (SMTP one-by-one OR copy
-- to Zoho webmail). No bulk button, no scheduler. Each item is approved by hand.
CREATE TABLE IF NOT EXISTS manual_outreach_queue (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  mailbox_id BIGINT UNSIGNED NULL,
  contact_point_id BIGINT UNSIGNED NULL,
  company_id BIGINT UNSIGNED NULL,
  company_name VARCHAR(255) NULL,
  website VARCHAR(255) NULL,
  email VARCHAR(255) NOT NULL,
  reason VARCHAR(500) NULL,
  source_url VARCHAR(500) NULL,
  template_key VARCHAR(60) NULL,
  draft_subject VARCHAR(255) NULL,
  draft_body TEXT NULL,
  safety_status ENUM('ok','suppressed','blocked','unknown') NOT NULL DEFAULT 'unknown',
  status ENUM('pending_review','approved','sent_manual','sent_smtp','skipped','do_not_contact')
    NOT NULL DEFAULT 'pending_review',
  approved_at TIMESTAMP NULL,
  sent_at TIMESTAMP NULL,
  sent_method ENUM('manual','smtp') NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_moq_tenant_email (tenant_id, email),
  INDEX idx_moq_tenant_status (tenant_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Reply inbox (IMAP, low-volume, read-only import) ─────────────────────────
CREATE TABLE IF NOT EXISTS inbox_replies (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  mailbox_id BIGINT UNSIGNED NULL,
  message_id VARCHAR(512) NOT NULL,
  from_email VARCHAR(320) NULL,
  from_name VARCHAR(255) NULL,
  subject VARCHAR(512) NULL,
  body_snippet TEXT NULL,
  received_at TIMESTAMP NULL,
  classification ENUM('interested','not_interested','do_not_contact','wrong_person',
    'out_of_office','bounce_like','unknown') NOT NULL DEFAULT 'unknown',
  classification_source ENUM('rule','llm','manual') NOT NULL DEFAULT 'rule',
  contact_point_id BIGINT UNSIGNED NULL,
  company_id BIGINT UNSIGNED NULL,
  queue_item_id BIGINT UNSIGNED NULL,
  handled TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_reply_tenant_msgid (tenant_id, message_id),
  INDEX idx_reply_tenant_class (tenant_id, classification),
  INDEX idx_reply_received (tenant_id, received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Manual-bridge first-touch templates (operator MUST approve) ──────────────
CREATE TABLE IF NOT EXISTS manual_outreach_templates (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  template_key VARCHAR(60) NOT NULL,
  name VARCHAR(160) NOT NULL,
  angle VARCHAR(120) NULL,
  subject VARCHAR(255) NOT NULL,
  body TEXT NOT NULL,
  approved TINYINT(1) NOT NULL DEFAULT 0,
  approved_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_tmpl_tenant_key (tenant_id, template_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
