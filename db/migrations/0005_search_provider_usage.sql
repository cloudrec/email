-- 0005_search_provider_usage.sql
-- Track every external search-provider call for credit accounting + audit.
-- Tenant-scoped. No API keys stored.

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS search_provider_usage (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id           BIGINT UNSIGNED NOT NULL,
  collector_campaign_id BIGINT UNSIGNED NULL,
  provider            VARCHAR(40) NOT NULL,
  query               VARCHAR(500) NOT NULL,
  country             VARCHAR(8) NULL,
  language            VARCHAR(8) NULL,
  requested_results   SMALLINT UNSIGNED NOT NULL DEFAULT 10,
  returned_results    SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  imported_results    SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  status              ENUM('ok','provider_error','credits_exhausted','timeout','not_configured','rate_limited') NOT NULL DEFAULT 'ok',
  error_code          VARCHAR(60) NULL,
  credits_estimated   SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  triggered_by        BIGINT UNSIGNED NULL,
  created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_spu_tenant_time (tenant_id, created_at),
  KEY idx_spu_provider (provider, created_at),
  CONSTRAINT fk_spu_tenant   FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_spu_campaign FOREIGN KEY (collector_campaign_id) REFERENCES collector_campaigns(id) ON DELETE SET NULL,
  CONSTRAINT fk_spu_user     FOREIGN KEY (triggered_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
