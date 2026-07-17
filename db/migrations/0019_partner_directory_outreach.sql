-- Phase 22G — Partner Directory Contact-Form Outreach Queue.
-- Non-email, operator-controlled outreach channel. NOTHING here sends email or
-- submits any web form automatically. All tables tenant-scoped. No secrets stored.

-- ── Directory sources (where partner companies are listed) ───────────────────
CREATE TABLE IF NOT EXISTS partner_directory_sources (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  name VARCHAR(200) NOT NULL,
  source_url VARCHAR(1000) NULL,
  platform ENUM('ziftone','manual','other') NOT NULL DEFAULT 'manual',
  status ENUM('active','disabled','needs_review') NOT NULL DEFAULT 'active',
  notes VARCHAR(2000) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_pds_tenant (tenant_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Outreach targets (visible partner companies saved from a source) ─────────
CREATE TABLE IF NOT EXISTS partner_directory_targets (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  source_id BIGINT UNSIGNED NULL,
  company_id BIGINT UNSIGNED NULL,
  company_name VARCHAR(300) NOT NULL,
  profile_url VARCHAR(1000) NULL,
  website_url VARCHAR(1000) NULL,
  category VARCHAR(150) NULL,
  country VARCHAR(120) NULL,
  description VARCHAR(2000) NULL,
  contact_button_present TINYINT(1) NOT NULL DEFAULT 0,
  contact_form_url VARCHAR(1000) NULL,
  status ENUM('new','selected','queued','contacted','replied','interested','not_interested','do_not_contact','skipped','blocked')
    NOT NULL DEFAULT 'new',
  last_contacted_at TIMESTAMP NULL,
  contact_attempt_count INT NOT NULL DEFAULT 0,
  notes VARCHAR(2000) NULL,
  raw_metadata_json LONGTEXT NULL,
  dedupe_key VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_pdt_dedupe (tenant_id, dedupe_key),
  INDEX idx_pdt_tenant (tenant_id, status),
  INDEX idx_pdt_source (source_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Contact-form task queue (one task = one company contact form) ────────────
CREATE TABLE IF NOT EXISTS partner_contact_tasks (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  target_id BIGINT UNSIGNED NOT NULL,
  channel ENUM('contact_form') NOT NULL DEFAULT 'contact_form',
  status ENUM('pending_review','ready','opened','copied','submitted_manually','replied','skipped','blocked','do_not_contact')
    NOT NULL DEFAULT 'pending_review',
  message_subject VARCHAR(300) NULL,
  message_body TEXT NOT NULL,
  contact_form_url VARCHAR(1000) NULL,
  blockers_json LONGTEXT NULL,
  assigned_to VARCHAR(200) NULL,
  due_at TIMESTAMP NULL,
  submitted_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_pct_tenant (tenant_id, status),
  INDEX idx_pct_target (target_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Partner contact-form message templates (NOT email; copy/paste only) ──────
CREATE TABLE IF NOT EXISTS partner_message_templates (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  template_key VARCHAR(120) NOT NULL,
  name VARCHAR(200) NOT NULL,
  use_case VARCHAR(120) NULL,
  subject VARCHAR(300) NULL,
  body TEXT NOT NULL,
  is_seed TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_pmt_key (tenant_id, template_key),
  INDEX idx_pmt_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Daily rate-limit ledger (per source per day submissions + per-day tasks) ─
CREATE TABLE IF NOT EXISTS partner_outreach_daily (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  ymd CHAR(10) NOT NULL,
  source_id BIGINT UNSIGNED NULL,
  submissions INT NOT NULL DEFAULT 0,
  tasks_created INT NOT NULL DEFAULT 0,
  UNIQUE KEY uq_pod (tenant_id, ymd, source_id),
  INDEX idx_pod_tenant (tenant_id, ymd)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
