-- 0002_lead_discovery.sql
-- Lead Discovery / Business Contact Finder module.
-- All business tables are tenant-scoped with FK to tenants(id).
-- Safety: discovered leads default to status='discovered'; imported contacts
-- default to status='pending' so they cannot be mass-sent without confirmation.

SET NAMES utf8mb4;

-- ------------------------------------------------------------------
-- Plan limits for Lead Discovery
-- ------------------------------------------------------------------
ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS max_discovered_leads_month INT UNSIGNED NOT NULL DEFAULT 0 AFTER storage_mb,
  ADD COLUMN IF NOT EXISTS max_source_domains_month   INT UNSIGNED NOT NULL DEFAULT 0 AFTER max_discovered_leads_month,
  ADD COLUMN IF NOT EXISTS max_verification_checks_month INT UNSIGNED NOT NULL DEFAULT 0 AFTER max_source_domains_month,
  ADD COLUMN IF NOT EXISTS lead_export_allowed        TINYINT(1) NOT NULL DEFAULT 0 AFTER max_verification_checks_month;

-- Backfill plan defaults (idempotent — only applies during this migration)
UPDATE plans SET max_discovered_leads_month=100,    max_source_domains_month=5,   max_verification_checks_month=200,   lead_export_allowed=0 WHERE code='free';
UPDATE plans SET max_discovered_leads_month=2000,   max_source_domains_month=50,  max_verification_checks_month=5000,  lead_export_allowed=1 WHERE code='starter';
UPDATE plans SET max_discovered_leads_month=15000,  max_source_domains_month=300, max_verification_checks_month=30000, lead_export_allowed=1 WHERE code='pro';
UPDATE plans SET max_discovered_leads_month=100000, max_source_domains_month=2000,max_verification_checks_month=200000,lead_export_allowed=1 WHERE code='agency';

-- Per-tenant override + master switch
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS lead_discovery_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER override_max_domains,
  ADD COLUMN IF NOT EXISTS override_max_discovered_leads_month    INT UNSIGNED NULL AFTER lead_discovery_enabled,
  ADD COLUMN IF NOT EXISTS override_max_source_domains_month      INT UNSIGNED NULL AFTER override_max_discovered_leads_month,
  ADD COLUMN IF NOT EXISTS override_max_verification_checks_month INT UNSIGNED NULL AFTER override_max_source_domains_month;

-- Track lead origin on imported contacts
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS source_url   VARCHAR(2000) NULL AFTER consent_source,
  ADD COLUMN IF NOT EXISTS source_lead_id BIGINT UNSIGNED NULL AFTER source_url,
  ADD KEY idx_contact_source_lead (source_lead_id);

-- ------------------------------------------------------------------
-- lead_sources: target websites/domains the tenant wants to discover from
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lead_sources (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id       BIGINT UNSIGNED NOT NULL,
  url             VARCHAR(2000) NOT NULL,
  domain          VARCHAR(255)  NOT NULL,
  label           VARCHAR(200)  NULL,
  status          ENUM('active','paused','blocked','removed') NOT NULL DEFAULT 'active',
  robots_allowed  TINYINT(1) NOT NULL DEFAULT 1,
  last_crawled_at TIMESTAMP NULL,
  last_status_detail JSON NULL,
  added_by        BIGINT UNSIGNED NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_source (tenant_id, url(500)),
  KEY idx_source_domain (tenant_id, domain),
  KEY idx_source_status (tenant_id, status),
  CONSTRAINT fk_lead_src_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_lead_src_user   FOREIGN KEY (added_by)  REFERENCES users(id)   ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- discovery_jobs: a queued/running unit of crawling work
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS discovery_jobs (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id       BIGINT UNSIGNED NOT NULL,
  source_id       BIGINT UNSIGNED NOT NULL,
  status          ENUM('queued','running','succeeded','failed','canceled','skipped_robots','rate_limited') NOT NULL DEFAULT 'queued',
  max_pages       INT UNSIGNED NOT NULL DEFAULT 5,
  pages_fetched   INT UNSIGNED NOT NULL DEFAULT 0,
  leads_found     INT UNSIGNED NOT NULL DEFAULT 0,
  leads_new       INT UNSIGNED NOT NULL DEFAULT 0,
  error           VARCHAR(1000) NULL,
  triggered_by    BIGINT UNSIGNED NULL,
  started_at      TIMESTAMP NULL,
  finished_at     TIMESTAMP NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_job_tenant_status (tenant_id, status),
  KEY idx_job_due (status, created_at),
  CONSTRAINT fk_lead_job_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_lead_job_source FOREIGN KEY (source_id) REFERENCES lead_sources(id) ON DELETE CASCADE,
  CONSTRAINT fk_lead_job_user   FOREIGN KEY (triggered_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- discovered_leads: emails harvested from public pages
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS discovered_leads (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id       BIGINT UNSIGNED NOT NULL,
  source_id       BIGINT UNSIGNED NULL,
  discovery_job_id BIGINT UNSIGNED NULL,
  email           VARCHAR(255) NOT NULL,
  email_domain    VARCHAR(255) NOT NULL,
  company_domain  VARCHAR(255) NULL,
  source_url      VARCHAR(2000) NULL,
  page_title      VARCHAR(500) NULL,
  context_snippet VARCHAR(1000) NULL,
  role_hint       VARCHAR(60) NULL,          -- info/sales/support/etc when detected
  status          ENUM('discovered','verified','invalid','risky','duplicate','suppressed','unsubscribed','imported') NOT NULL DEFAULT 'discovered',
  verification_score TINYINT NULL,           -- 0-100, NULL = not verified
  last_verified_at TIMESTAMP NULL,
  discovered_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  imported_at     TIMESTAMP NULL,
  imported_contact_id BIGINT UNSIGNED NULL,
  notes           VARCHAR(1000) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_lead_email (tenant_id, email),
  KEY idx_lead_status (tenant_id, status),
  KEY idx_lead_job (discovery_job_id),
  KEY idx_lead_source (source_id),
  CONSTRAINT fk_lead_tenant   FOREIGN KEY (tenant_id)        REFERENCES tenants(id)         ON DELETE CASCADE,
  CONSTRAINT fk_lead_src      FOREIGN KEY (source_id)        REFERENCES lead_sources(id)    ON DELETE SET NULL,
  CONSTRAINT fk_lead_job      FOREIGN KEY (discovery_job_id) REFERENCES discovery_jobs(id)  ON DELETE SET NULL,
  CONSTRAINT fk_lead_contact  FOREIGN KEY (imported_contact_id) REFERENCES contacts(id)     ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- lead_verification_results: each verification attempt (audit trail)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lead_verification_results (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id       BIGINT UNSIGNED NOT NULL,
  lead_id         BIGINT UNSIGNED NOT NULL,
  provider        VARCHAR(40) NOT NULL DEFAULT 'internal',
  syntax_ok       TINYINT(1) NOT NULL DEFAULT 0,
  mx_ok           TINYINT(1) NOT NULL DEFAULT 0,
  disposable      TINYINT(1) NOT NULL DEFAULT 0,
  role_address    TINYINT(1) NOT NULL DEFAULT 0,
  result          ENUM('valid','invalid','risky','unknown') NOT NULL DEFAULT 'unknown',
  detail          JSON NULL,
  checked_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ver_lead (lead_id),
  KEY idx_ver_tenant_time (tenant_id, checked_at),
  CONSTRAINT fk_ver_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_ver_lead   FOREIGN KEY (lead_id)   REFERENCES discovered_leads(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- lead_import_jobs: discovered_leads -> contacts batches
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lead_import_jobs (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id       BIGINT UNSIGNED NOT NULL,
  list_id         BIGINT UNSIGNED NULL,
  filter          JSON NULL,
  requested_count INT UNSIGNED NOT NULL DEFAULT 0,
  imported_count  INT UNSIGNED NOT NULL DEFAULT 0,
  skipped_count   INT UNSIGNED NOT NULL DEFAULT 0,
  status          ENUM('queued','running','succeeded','failed') NOT NULL DEFAULT 'queued',
  error           VARCHAR(1000) NULL,
  triggered_by    BIGINT UNSIGNED NULL,
  started_at      TIMESTAMP NULL,
  finished_at     TIMESTAMP NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_imp_tenant_status (tenant_id, status),
  CONSTRAINT fk_imp_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_imp_list   FOREIGN KEY (list_id)   REFERENCES lists(id)   ON DELETE SET NULL,
  CONSTRAINT fk_imp_user   FOREIGN KEY (triggered_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- Monthly usage tracking for lead discovery (counters per tenant)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lead_usage_month (
  tenant_id       BIGINT UNSIGNED NOT NULL,
  period          CHAR(7) NOT NULL,                -- YYYY-MM
  leads_discovered INT UNSIGNED NOT NULL DEFAULT 0,
  sources_added    INT UNSIGNED NOT NULL DEFAULT 0,
  verifications    INT UNSIGNED NOT NULL DEFAULT 0,
  exports          INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, period),
  CONSTRAINT fk_lead_usage_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
