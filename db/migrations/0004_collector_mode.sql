-- 0004_collector_mode.sql
-- Collector-only Lead Accumulation Mode.
-- Safety: collector NEVER sends. Drafts produced still arrive `pending_review`.
-- Imported contacts via lead-import still arrive `pending`.

SET NAMES utf8mb4;

-- ------------------------------------------------------------------
-- Per-tenant admin settings for collector limits
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS collector_admin_settings (
  tenant_id              BIGINT UNSIGNED NOT NULL,
  collector_enabled      TINYINT(1) NOT NULL DEFAULT 0,
  max_sources_per_day    INT UNSIGNED NOT NULL DEFAULT 100,
  max_leads_per_day      INT UNSIGNED NOT NULL DEFAULT 500,
  max_pages_per_source   SMALLINT UNSIGNED NOT NULL DEFAULT 5,
  allow_manual_urls      TINYINT(1) NOT NULL DEFAULT 1,
  allow_csv_import       TINYINT(1) NOT NULL DEFAULT 1,
  allow_search_provider  TINYINT(1) NOT NULL DEFAULT 0,
  paused_globally        TINYINT(1) NOT NULL DEFAULT 0,
  created_at             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id),
  CONSTRAINT fk_cas_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- Collector campaigns
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS collector_campaigns (
  id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id              BIGINT UNSIGNED NOT NULL,
  product_profile_id     BIGINT UNSIGNED NULL,
  name                   VARCHAR(200) NOT NULL,
  status                 ENUM('draft','active','paused','completed') NOT NULL DEFAULT 'draft',
  mode                   ENUM('manual_urls','csv_import','search_provider','mixed') NOT NULL DEFAULT 'manual_urls',
  keywords               JSON NULL,
  countries              JSON NULL,
  languages              JSON NULL,
  preset_codes           JSON NULL,
  max_sources_total      INT UNSIGNED NOT NULL DEFAULT 1000,
  max_sources_per_day    INT UNSIGNED NOT NULL DEFAULT 100,
  max_pages_per_source   SMALLINT UNSIGNED NOT NULL DEFAULT 5,
  crawl_delay_seconds    SMALLINT UNSIGNED NOT NULL DEFAULT 2,
  analyze_website        TINYINT(1) NOT NULL DEFAULT 0,
  generate_draft         TINYINT(1) NOT NULL DEFAULT 0,
  created_by_user_id     BIGINT UNSIGNED NULL,
  created_at             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_cc_tenant_status (tenant_id, status),
  CONSTRAINT fk_cc_tenant  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_cc_profile FOREIGN KEY (product_profile_id) REFERENCES tenant_product_profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_cc_user    FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- Sources attached to a collector campaign
-- Soft link to lead_sources; one collector campaign can pick up many.
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS collector_campaign_sources (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id         BIGINT UNSIGNED NOT NULL,
  campaign_id       BIGINT UNSIGNED NOT NULL,
  lead_source_id    BIGINT UNSIGNED NOT NULL,
  added_by_mode     ENUM('manual_urls','csv_import','search_provider') NOT NULL DEFAULT 'manual_urls',
  -- Worker-side scheduling state
  discovery_job_id  BIGINT UNSIGNED NULL,
  scheduled_at      TIMESTAMP NULL,
  finished_at       TIMESTAMP NULL,
  state             ENUM('pending','queued','running','succeeded','failed','skipped') NOT NULL DEFAULT 'pending',
  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_ccs (campaign_id, lead_source_id),
  KEY idx_ccs_state (campaign_id, state),
  KEY idx_ccs_tenant (tenant_id, state),
  CONSTRAINT fk_ccs_tenant   FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_ccs_campaign FOREIGN KEY (campaign_id) REFERENCES collector_campaigns(id) ON DELETE CASCADE,
  CONSTRAINT fk_ccs_source   FOREIGN KEY (lead_source_id) REFERENCES lead_sources(id) ON DELETE CASCADE,
  CONSTRAINT fk_ccs_job      FOREIGN KEY (discovery_job_id) REFERENCES discovery_jobs(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- Per-day stats for a collector campaign
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS collector_campaign_stats (
  tenant_id        BIGINT UNSIGNED NOT NULL,
  campaign_id      BIGINT UNSIGNED NOT NULL,
  `date`           DATE NOT NULL,
  sources_added    INT UNSIGNED NOT NULL DEFAULT 0,
  sources_crawled  INT UNSIGNED NOT NULL DEFAULT 0,
  leads_found      INT UNSIGNED NOT NULL DEFAULT 0,
  leads_new        INT UNSIGNED NOT NULL DEFAULT 0,
  websites_analyzed INT UNSIGNED NOT NULL DEFAULT 0,
  drafts_generated INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (campaign_id, `date`),
  KEY idx_ccst_tenant_date (tenant_id, `date`),
  CONSTRAINT fk_ccst_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_ccst_campaign FOREIGN KEY (campaign_id) REFERENCES collector_campaigns(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- Bulk import batches (paste / CSV)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS collector_import_batches (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id         BIGINT UNSIGNED NOT NULL,
  campaign_id       BIGINT UNSIGNED NULL,
  mode              ENUM('manual_urls','csv_import') NOT NULL,
  submitted_count   INT UNSIGNED NOT NULL DEFAULT 0,
  accepted_count    INT UNSIGNED NOT NULL DEFAULT 0,
  duplicates_count  INT UNSIGNED NOT NULL DEFAULT 0,
  invalid_count     INT UNSIGNED NOT NULL DEFAULT 0,
  blocked_count     INT UNSIGNED NOT NULL DEFAULT 0,
  queued_count      INT UNSIGNED NOT NULL DEFAULT 0,
  summary           JSON NULL,
  submitted_by      BIGINT UNSIGNED NULL,
  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_cib_tenant_time (tenant_id, created_at),
  CONSTRAINT fk_cib_tenant   FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_cib_campaign FOREIGN KEY (campaign_id) REFERENCES collector_campaigns(id) ON DELETE SET NULL,
  CONSTRAINT fk_cib_user     FOREIGN KEY (submitted_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- Search provider runs (history of search-import preview/import)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS collector_search_provider_runs (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id         BIGINT UNSIGNED NOT NULL,
  campaign_id       BIGINT UNSIGNED NULL,
  provider          VARCHAR(40) NOT NULL,
  query             VARCHAR(500) NOT NULL,
  country           VARCHAR(8) NULL,
  language          VARCHAR(8) NULL,
  max_results       SMALLINT UNSIGNED NOT NULL DEFAULT 20,
  results_count     INT UNSIGNED NOT NULL DEFAULT 0,
  imported_count    INT UNSIGNED NOT NULL DEFAULT 0,
  results           JSON NULL,
  error             VARCHAR(500) NULL,
  triggered_by      BIGINT UNSIGNED NULL,
  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_cspr_tenant_time (tenant_id, created_at),
  CONSTRAINT fk_cspr_tenant   FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_cspr_campaign FOREIGN KEY (campaign_id) REFERENCES collector_campaigns(id) ON DELETE SET NULL,
  CONSTRAINT fk_cspr_user     FOREIGN KEY (triggered_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- Default global admin row (single row, NULL tenant for global toggles)
-- Not used yet — reserved for super-admin "pause all collectors" flag.
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS collector_global_settings (
  id                   TINYINT UNSIGNED NOT NULL DEFAULT 1,
  paused_globally      TINYINT(1) NOT NULL DEFAULT 0,
  paused_reason        VARCHAR(255) NULL,
  updated_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT chk_cgs_single CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO collector_global_settings (id, paused_globally) VALUES (1, 0);

-- ------------------------------------------------------------------
-- Chain annotations: downstream loops credit the right campaign.
-- ------------------------------------------------------------------
ALTER TABLE website_analysis_jobs
  ADD COLUMN IF NOT EXISTS collector_campaign_id BIGINT UNSIGNED NULL,
  ADD KEY idx_waj_collector (collector_campaign_id);

ALTER TABLE outreach_drafts
  ADD COLUMN IF NOT EXISTS collector_campaign_id BIGINT UNSIGNED NULL,
  ADD KEY idx_od_collector (collector_campaign_id);
