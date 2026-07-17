-- Phase 21 — Own Sending Infrastructure Foundation.
-- Provider-neutral relay registry + multi-domain purpose/limits + mailbox
-- (sender-identity) limits & live counters. NO secrets stored here — only refs.

CREATE TABLE IF NOT EXISTS sending_providers (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  provider_type ENUM('generic','brevo','smtp2go','mailgun','wooxy','postal','ses') NOT NULL DEFAULT 'generic',
  name VARCHAR(120) NOT NULL,
  smtp_host VARCHAR(255) NULL,
  smtp_port INT NULL,
  smtp_secure TINYINT(1) NOT NULL DEFAULT 0,
  username_ref VARCHAR(120) NULL,
  secret_ref VARCHAR(120) NULL,
  from_domain VARCHAR(255) NULL,
  status ENUM('pending','active','disabled','error') NOT NULL DEFAULT 'pending',
  last_verified_at TIMESTAMP NULL,
  last_error VARCHAR(500) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_sp_tenant (tenant_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Multi-domain management ──────────────────────────────────────────────────
ALTER TABLE domains
  ADD COLUMN IF NOT EXISTS purpose ENUM('main','cold_outreach','transactional','tracking','bounce') NOT NULL DEFAULT 'cold_outreach' AFTER type;

ALTER TABLE domains
  ADD COLUMN IF NOT EXISTS dns_status ENUM('unknown','pending','partial','verified','failed') NOT NULL DEFAULT 'unknown' AFTER status;

ALTER TABLE domains
  ADD COLUMN IF NOT EXISTS hourly_send_limit INT NOT NULL DEFAULT 5 AFTER daily_send_limit;

ALTER TABLE domains
  ADD COLUMN IF NOT EXISTS warmup_stage INT NOT NULL DEFAULT 0 AFTER reputation_score;

ALTER TABLE domains
  ADD COLUMN IF NOT EXISTS provider_id BIGINT NULL AFTER warmup_stage;

ALTER TABLE domains
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

-- ── Mailbox / sender-identity management ─────────────────────────────────────
ALTER TABLE sender_identities
  ADD COLUMN IF NOT EXISTS display_name VARCHAR(160) NULL AFTER from_name;

ALTER TABLE sender_identities
  ADD COLUMN IF NOT EXISTS provider_id BIGINT NULL AFTER domain_id;

ALTER TABLE sender_identities
  ADD COLUMN IF NOT EXISTS purpose ENUM('main','cold_outreach','transactional') NOT NULL DEFAULT 'cold_outreach' AFTER provider_id;

ALTER TABLE sender_identities
  ADD COLUMN IF NOT EXISTS status ENUM('active','paused','disabled') NOT NULL DEFAULT 'active' AFTER purpose;

ALTER TABLE sender_identities
  ADD COLUMN IF NOT EXISTS daily_send_limit INT NOT NULL DEFAULT 10 AFTER status;

ALTER TABLE sender_identities
  ADD COLUMN IF NOT EXISTS hourly_send_limit INT NOT NULL DEFAULT 3 AFTER daily_send_limit;

ALTER TABLE sender_identities
  ADD COLUMN IF NOT EXISTS sent_today INT NOT NULL DEFAULT 0 AFTER hourly_send_limit;

ALTER TABLE sender_identities
  ADD COLUMN IF NOT EXISTS bounced_today INT NOT NULL DEFAULT 0 AFTER sent_today;

ALTER TABLE sender_identities
  ADD COLUMN IF NOT EXISTS complained_today INT NOT NULL DEFAULT 0 AFTER bounced_today;

ALTER TABLE sender_identities
  ADD COLUMN IF NOT EXISTS unsubscribed_today INT NOT NULL DEFAULT 0 AFTER complained_today;

ALTER TABLE sender_identities
  ADD COLUMN IF NOT EXISTS counters_day DATE NULL AFTER unsubscribed_today;

ALTER TABLE sender_identities
  ADD COLUMN IF NOT EXISTS last_sent_at TIMESTAMP NULL AFTER counters_day;

ALTER TABLE sender_identities
  ADD COLUMN IF NOT EXISTS warmup_stage INT NOT NULL DEFAULT 0 AFTER last_sent_at;

ALTER TABLE sender_identities
  ADD COLUMN IF NOT EXISTS paused_reason VARCHAR(255) NULL AFTER warmup_stage;

ALTER TABLE sender_identities
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

-- Existing main sending domain stays protected: mark it transactional/main, keep
-- its 20/day limit. Cold scraped outreach must use a separate satellite domain.
UPDATE domains SET purpose='main' WHERE domain='mail.emails.cheap' AND purpose='cold_outreach';
