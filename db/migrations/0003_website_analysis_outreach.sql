-- 0003_website_analysis_outreach.sql
-- Website Analysis + Human-Approved Personalized Outreach Texts.
-- Safety: drafts cannot enter send queue without explicit approval event.

SET NAMES utf8mb4;

-- ------------------------------------------------------------------
-- Tenant product profile: what the tenant is promoting
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenant_product_profiles (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id       BIGINT UNSIGNED NOT NULL,
  name            VARCHAR(200) NOT NULL,
  product_url     VARCHAR(500) NULL,
  description     VARCHAR(2000) NOT NULL,
  target_customer VARCHAR(1000) NULL,
  key_benefits    JSON NULL,
  allowed_claims  JSON NULL,
  forbidden_claims JSON NULL,
  preferred_tone  ENUM('neutral','friendly','professional','short_direct') NOT NULL DEFAULT 'neutral',
  default_language ENUM('en','ru','uk') NOT NULL DEFAULT 'en',
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  is_default      TINYINT(1) NOT NULL DEFAULT 0,
  created_by      BIGINT UNSIGNED NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_profile_tenant (tenant_id, is_active),
  CONSTRAINT fk_profile_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_profile_user   FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- Website analysis jobs (crawl + summarize)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS website_analysis_jobs (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id       BIGINT UNSIGNED NOT NULL,
  product_profile_id BIGINT UNSIGNED NULL,
  target_url      VARCHAR(2000) NOT NULL,
  target_domain   VARCHAR(255) NOT NULL,
  lead_id         BIGINT UNSIGNED NULL,
  language        ENUM('en','ru','uk') NOT NULL DEFAULT 'en',
  status          ENUM('queued','running','succeeded','failed','canceled','skipped_robots') NOT NULL DEFAULT 'queued',
  pages_fetched   INT UNSIGNED NOT NULL DEFAULT 0,
  error           VARCHAR(1000) NULL,
  triggered_by    BIGINT UNSIGNED NULL,
  started_at      TIMESTAMP NULL,
  finished_at     TIMESTAMP NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_anajob_tenant_status (tenant_id, status),
  KEY idx_anajob_lead (lead_id),
  CONSTRAINT fk_anajob_tenant  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_anajob_profile FOREIGN KEY (product_profile_id) REFERENCES tenant_product_profiles(id) ON DELETE SET NULL,
  CONSTRAINT fk_anajob_lead    FOREIGN KEY (lead_id) REFERENCES discovered_leads(id) ON DELETE SET NULL,
  CONSTRAINT fk_anajob_user    FOREIGN KEY (triggered_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- Website analysis results (structured summary)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS website_analysis_results (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id       BIGINT UNSIGNED NOT NULL,
  job_id          BIGINT UNSIGNED NOT NULL,
  company_name    VARCHAR(255) NULL,
  industry        VARCHAR(120) NULL,
  business_type   VARCHAR(160) NULL,
  offering_summary VARCHAR(2000) NULL,
  pain_points     JSON NULL,
  relevance_reason VARCHAR(2000) NULL,
  relevance_warning VARCHAR(2000) NULL,
  contact_emails  JSON NULL,
  source_urls     JSON NULL,
  page_titles     JSON NULL,
  raw_facts       JSON NULL,
  confidence_score TINYINT NOT NULL DEFAULT 0,
  language_detected ENUM('en','ru','uk','other') NOT NULL DEFAULT 'other',
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_anares_job (job_id),
  KEY idx_anares_tenant (tenant_id, created_at),
  CONSTRAINT fk_anares_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_anares_job    FOREIGN KEY (job_id) REFERENCES website_analysis_jobs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- Outreach drafts (current head pointer per draft)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outreach_drafts (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id       BIGINT UNSIGNED NOT NULL,
  product_profile_id BIGINT UNSIGNED NOT NULL,
  analysis_result_id BIGINT UNSIGNED NOT NULL,
  lead_id         BIGINT UNSIGNED NULL,
  current_version_id BIGINT UNSIGNED NULL,
  status          ENUM('draft','pending_review','approved','rejected','sent_test','queued','sent') NOT NULL DEFAULT 'draft',
  approval_required TINYINT(1) NOT NULL DEFAULT 1,
  approved_at     TIMESTAMP NULL,
  approved_by     BIGINT UNSIGNED NULL,
  rejected_at     TIMESTAMP NULL,
  rejected_by     BIGINT UNSIGNED NULL,
  rejection_reason VARCHAR(1000) NULL,
  language        ENUM('en','ru','uk') NOT NULL DEFAULT 'en',
  tone            ENUM('neutral','friendly','professional','short_direct') NOT NULL DEFAULT 'neutral',
  test_sent_at    TIMESTAMP NULL,
  test_sent_to    VARCHAR(255) NULL,
  campaign_id     BIGINT UNSIGNED NULL,
  created_by      BIGINT UNSIGNED NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_draft_tenant_status (tenant_id, status),
  KEY idx_draft_lead (lead_id),
  CONSTRAINT fk_draft_tenant  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_draft_profile FOREIGN KEY (product_profile_id) REFERENCES tenant_product_profiles(id),
  CONSTRAINT fk_draft_result  FOREIGN KEY (analysis_result_id) REFERENCES website_analysis_results(id),
  CONSTRAINT fk_draft_lead    FOREIGN KEY (lead_id) REFERENCES discovered_leads(id) ON DELETE SET NULL,
  CONSTRAINT fk_draft_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL,
  CONSTRAINT fk_draft_apprv   FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_draft_rejct   FOREIGN KEY (rejected_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_draft_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- Outreach draft versions (full text history)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outreach_draft_versions (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id       BIGINT UNSIGNED NOT NULL,
  draft_id        BIGINT UNSIGNED NOT NULL,
  version_no      INT UNSIGNED NOT NULL,
  generator       VARCHAR(60) NOT NULL DEFAULT 'internal',
  subject_options JSON NOT NULL,
  email_short     MEDIUMTEXT NOT NULL,
  email_long      MEDIUMTEXT NOT NULL,
  follow_up       MEDIUMTEXT NULL,
  personalization_points JSON NULL,
  risks_or_uncertainties JSON NULL,
  confidence_score TINYINT NOT NULL DEFAULT 0,
  cited_facts     JSON NULL,
  ai_prompt_hash  CHAR(64) NULL,
  created_by      BIGINT UNSIGNED NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_dv (draft_id, version_no),
  KEY idx_dv_tenant (tenant_id, created_at),
  CONSTRAINT fk_dv_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_dv_draft  FOREIGN KEY (draft_id) REFERENCES outreach_drafts(id) ON DELETE CASCADE,
  CONSTRAINT fk_dv_user   FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE outreach_drafts
  ADD CONSTRAINT fk_draft_current_version
  FOREIGN KEY (current_version_id) REFERENCES outreach_draft_versions(id) ON DELETE SET NULL;

-- ------------------------------------------------------------------
-- Approval events (audit trail of approve/reject/test/send)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outreach_approval_events (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id       BIGINT UNSIGNED NOT NULL,
  draft_id        BIGINT UNSIGNED NOT NULL,
  draft_version_id BIGINT UNSIGNED NULL,
  event           ENUM('generated','edited','approved','rejected','test_sent','queued','sent','recalled') NOT NULL,
  actor_user_id   BIGINT UNSIGNED NULL,
  recipient_email VARCHAR(255) NULL,
  lead_id         BIGINT UNSIGNED NULL,
  campaign_id     BIGINT UNSIGNED NULL,
  reason          VARCHAR(1000) NULL,
  metadata        JSON NULL,
  occurred_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_oae_draft (draft_id, occurred_at),
  KEY idx_oae_tenant (tenant_id, occurred_at),
  CONSTRAINT fk_oae_tenant  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_oae_draft   FOREIGN KEY (draft_id) REFERENCES outreach_drafts(id) ON DELETE CASCADE,
  CONSTRAINT fk_oae_version FOREIGN KEY (draft_version_id) REFERENCES outreach_draft_versions(id) ON DELETE SET NULL,
  CONSTRAINT fk_oae_user    FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_oae_lead    FOREIGN KEY (lead_id) REFERENCES discovered_leads(id) ON DELETE SET NULL,
  CONSTRAINT fk_oae_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
