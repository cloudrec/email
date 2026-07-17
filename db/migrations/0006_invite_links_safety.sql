-- 0006_invite_links_safety.sql
-- Branded invite links + tenant safety controls.
-- Safety: no email sending. /i/:token redirects only. Suppression-aware.

SET NAMES utf8mb4;

-- ------------------------------------------------------------------
-- Tracking domains (per-tenant). Reuses 'domains' table layout but separate
-- because tracking semantics differ (CNAME-only, no DKIM keys needed).
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tracking_domains (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id         BIGINT UNSIGNED NOT NULL,
  domain            VARCHAR(255) NOT NULL,
  status            ENUM('pending','verified','failed','disabled') NOT NULL DEFAULT 'pending',
  dns_records_json  JSON NULL,
  verified_at       TIMESTAMP NULL,
  disabled_reason   VARCHAR(255) NULL,
  last_checked_at   TIMESTAMP NULL,
  last_status_detail JSON NULL,
  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_td (tenant_id, domain),
  KEY idx_td_status (status),
  CONSTRAINT fk_td_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- Invite links
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invite_links (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id           BIGINT UNSIGNED NOT NULL,
  lead_id             BIGINT UNSIGNED NULL,
  contact_id          BIGINT UNSIGNED NULL,
  outreach_draft_id   BIGINT UNSIGNED NULL,
  campaign_id         BIGINT UNSIGNED NULL,
  tracking_domain_id  BIGINT UNSIGNED NULL,
  token               VARCHAR(24) NOT NULL,
  destination_url     VARCHAR(2000) NOT NULL,
  landing_mode        ENUM('redirect','personal_page') NOT NULL DEFAULT 'redirect',
  status              ENUM('active','paused','expired','disabled','unsubscribed','suppressed') NOT NULL DEFAULT 'active',
  expires_at          TIMESTAMP NULL,
  click_count         INT UNSIGNED NOT NULL DEFAULT 0,
  last_clicked_at     TIMESTAMP NULL,
  created_by_user_id  BIGINT UNSIGNED NULL,
  created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_invite_token (token),
  KEY idx_il_tenant_status (tenant_id, status),
  KEY idx_il_lead (lead_id),
  KEY idx_il_contact (contact_id),
  KEY idx_il_draft (outreach_draft_id),
  CONSTRAINT fk_il_tenant   FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_il_lead     FOREIGN KEY (lead_id) REFERENCES discovered_leads(id) ON DELETE SET NULL,
  CONSTRAINT fk_il_contact  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL,
  CONSTRAINT fk_il_draft    FOREIGN KEY (outreach_draft_id) REFERENCES outreach_drafts(id) ON DELETE SET NULL,
  CONSTRAINT fk_il_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL,
  CONSTRAINT fk_il_td       FOREIGN KEY (tracking_domain_id) REFERENCES tracking_domains(id) ON DELETE SET NULL,
  CONSTRAINT fk_il_user     FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- Invite link clicks (privacy-aware: only hashed IP/UA stored)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invite_link_clicks (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id       BIGINT UNSIGNED NOT NULL,
  invite_link_id  BIGINT UNSIGNED NOT NULL,
  clicked_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ip_hash         CHAR(64) NULL,
  user_agent_hash CHAR(64) NULL,
  country         CHAR(2) NULL,
  referrer        VARCHAR(500) NULL,
  bot_score       TINYINT NULL,
  metadata_json   JSON NULL,
  PRIMARY KEY (id),
  KEY idx_ilc_link_time (invite_link_id, clicked_at),
  KEY idx_ilc_tenant_time (tenant_id, clicked_at),
  CONSTRAINT fk_ilc_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_ilc_link   FOREIGN KEY (invite_link_id) REFERENCES invite_links(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- Tenant safety settings (lazy-created on first read)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenant_safety_settings (
  tenant_id                       BIGINT UNSIGNED NOT NULL,
  invite_links_enabled            TINYINT(1) NOT NULL DEFAULT 1,
  custom_tracking_domains_enabled TINYINT(1) NOT NULL DEFAULT 0,
  max_invite_links_per_day        INT UNSIGNED NOT NULL DEFAULT 500,
  max_clicks_per_minute           INT UNSIGNED NOT NULL DEFAULT 120,
  max_redirects_per_minute        INT UNSIGNED NOT NULL DEFAULT 120,
  auto_disable_on_abuse           TINYINT(1) NOT NULL DEFAULT 1,
  require_manual_draft_approval   TINYINT(1) NOT NULL DEFAULT 1,
  outreach_paused                 TINYINT(1) NOT NULL DEFAULT 0,
  outreach_paused_reason          VARCHAR(255) NULL,
  created_at                      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id),
  CONSTRAINT fk_tss_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- Risk events (audit-grade)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenant_risk_events (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id     BIGINT UNSIGNED NOT NULL,
  event_type    VARCHAR(60) NOT NULL,
  severity      ENUM('info','warning','critical') NOT NULL DEFAULT 'info',
  reason        VARCHAR(500) NULL,
  metadata_json JSON NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_tre_tenant_time (tenant_id, created_at),
  KEY idx_tre_severity (severity, created_at),
  CONSTRAINT fk_tre_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
