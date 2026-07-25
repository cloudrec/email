-- 0022: B2B + Affiliate outreach engine — additive schema.
--
-- Per TZ §2.2 (no destructive rewrite) and §19 (additive, reversible). Nothing here
-- drops or rewrites an existing column. The existing broadcast `campaigns` table and
-- its code path are untouched — new columns are nullable/defaulted, so old rows and
-- old queries behave exactly as before. `outreach_touchpoints.campaign_id` already
-- exists, so the campaign→mode tag needs no touchpoint change.
--
-- ROLLBACK (reverse order):
--   DROP TABLE IF EXISTS campaign_experiments, revenue_events, conversion_events,
--     click_events, compliance_snapshots, affiliate_offer_terms_versions, affiliate_offers;
--   ALTER TABLE campaigns
--     DROP COLUMN campaign_mode, DROP COLUMN lifecycle_state,
--     DROP COLUMN affiliate_offer_id, DROP COLUMN engine_config_json,
--     DROP COLUMN mode_owner, DROP COLUMN max_send_volume;

-- ── campaigns: two-mode + TZ lifecycle, additive ────────────────────────────
-- The legacy `status` enum stays as the broadcast state. `lifecycle_state` is the
-- NEW cold-outreach state machine (TZ §8); the two are independent so neither code
-- path interferes with the other. campaign_mode NULL = a legacy broadcast campaign.
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS campaign_mode ENUM('OWN_PRODUCT_B2B','AFFILIATE') NULL AFTER uuid,
  ADD COLUMN IF NOT EXISTS lifecycle_state VARCHAR(32) NULL AFTER campaign_mode,
  ADD COLUMN IF NOT EXISTS affiliate_offer_id BIGINT UNSIGNED NULL AFTER lifecycle_state,
  ADD COLUMN IF NOT EXISTS mode_owner VARCHAR(120) NULL,
  ADD COLUMN IF NOT EXISTS max_send_volume INT NULL,
  ADD COLUMN IF NOT EXISTS engine_config_json JSON NULL;

-- lifecycle_state allowed values (enforced in app, documented here):
--   DRAFT, TARGETING_REVIEW, COMPLIANCE_REVIEW, CONTENT_REVIEW, READY_FOR_TEST,
--   TEST_RUNNING, TEST_REVIEW, APPROVED_FOR_LIMITED_RUN, RUNNING, PAUSED,
--   COMPLETED, REJECTED. No direct DRAFT->RUNNING (TZ §8).

-- ── affiliate offer registry (TZ §5) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS affiliate_offers (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id             BIGINT UNSIGNED NOT NULL DEFAULT 1,
  network_name          VARCHAR(160) NOT NULL,
  advertiser_name       VARCHAR(200) NOT NULL,
  offer_name            VARCHAR(200) NOT NULL,
  external_offer_id     VARCHAR(120) NULL,
  status                ENUM('DRAFT','PENDING_REVIEW','APPROVED','PAUSED','REJECTED','EXPIRED')
                          NOT NULL DEFAULT 'DRAFT',
  destination_url       VARCHAR(2000) NULL,
  tracking_url_template VARCHAR(2000) NULL,
  allowed_geos_json     JSON NULL,
  blocked_geos_json     JSON NULL,
  allowed_traffic_sources_json JSON NULL,
  -- The single hard gate: an offer cannot go live for email unless this is explicitly 1.
  cold_email_allowed    TINYINT(1) NOT NULL DEFAULT 0,
  incentive_allowed     TINYINT(1) NOT NULL DEFAULT 0,
  brand_bidding_allowed TINYINT(1) NOT NULL DEFAULT 0,
  direct_linking_allowed TINYINT(1) NOT NULL DEFAULT 0,
  required_disclosure   VARCHAR(1000) NULL,
  prohibited_claims_json JSON NULL,
  payout_type           VARCHAR(40) NULL,          -- CPA / CPL / RevShare / …
  payout_amount         DECIMAL(12,2) NULL,
  payout_currency       CHAR(3) NULL,
  cookie_window_days    INT NULL,
  terms_source          VARCHAR(2000) NULL,        -- URL or stored-doc reference
  terms_verified_at     TIMESTAMP NULL,
  terms_verified_by     VARCHAR(120) NULL,
  created_at            TIMESTAMP NOT NULL DEFAULT current_timestamp(),
  updated_at            TIMESTAMP NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (id),
  KEY idx_ao_status (status),
  KEY idx_ao_network (network_name),
  KEY idx_ao_terms_verified (terms_verified_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Immutable history of offer terms, so a compliance snapshot can pin an exact version.
CREATE TABLE IF NOT EXISTS affiliate_offer_terms_versions (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  offer_id          BIGINT UNSIGNED NOT NULL,
  terms_hash        CHAR(64) NOT NULL,
  terms_source      VARCHAR(2000) NULL,
  terms_snapshot    MEDIUMTEXT NULL,
  cold_email_allowed TINYINT(1) NOT NULL DEFAULT 0,
  verified_at       TIMESTAMP NULL,
  verified_by       VARCHAR(120) NULL,
  created_at        TIMESTAMP NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (id),
  KEY idx_aotv_offer (offer_id),
  KEY idx_aotv_hash (terms_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── immutable per-message compliance snapshot (TZ §10) ───────────────────────
CREATE TABLE IF NOT EXISTS compliance_snapshots (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  campaign_id           BIGINT UNSIGNED NULL,
  offer_id              BIGINT UNSIGNED NULL,
  contact_email         VARCHAR(255) NULL,
  offer_terms_version_id BIGINT UNSIGNED NULL,
  terms_verified_at     TIMESTAMP NULL,
  allowed_geo           VARCHAR(8) NULL,
  allowed_traffic_source VARCHAR(60) NULL,
  required_disclosure_present TINYINT(1) NOT NULL DEFAULT 0,
  prohibited_claim_check ENUM('pass','fail','skipped') NOT NULL DEFAULT 'skipped',
  approver              VARCHAR(120) NULL,
  message_hash          CHAR(64) NOT NULL,
  created_at            TIMESTAMP NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (id),
  KEY idx_cs_campaign (campaign_id),
  KEY idx_cs_offer (offer_id),
  KEY idx_cs_msg (message_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── affiliate attribution: clicks / conversions / revenue (TZ §12) ───────────
-- idempotency_key makes every ingest path safe to replay (postback retries, imports).
CREATE TABLE IF NOT EXISTS click_events (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  campaign_id    BIGINT UNSIGNED NULL,
  offer_id       BIGINT UNSIGNED NULL,
  contact_email  VARCHAR(255) NULL,
  sub_id         VARCHAR(120) NULL,
  click_id       VARCHAR(190) NULL,
  idempotency_key VARCHAR(190) NOT NULL,
  occurred_at    TIMESTAMP NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (id),
  UNIQUE KEY uk_click_idem (idempotency_key),
  KEY idx_click_campaign (campaign_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS conversion_events (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  campaign_id    BIGINT UNSIGNED NULL,
  offer_id       BIGINT UNSIGNED NULL,
  contact_email  VARCHAR(255) NULL,
  event_type     ENUM('lead','qualified_lead','sale','meeting','proposal','won','lost') NOT NULL,
  sub_id         VARCHAR(120) NULL,
  click_id       VARCHAR(190) NULL,
  idempotency_key VARCHAR(190) NOT NULL,
  occurred_at    TIMESTAMP NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (id),
  UNIQUE KEY uk_conv_idem (idempotency_key),
  KEY idx_conv_campaign (campaign_id),
  KEY idx_conv_type (event_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Money moves separately from conversions: a sale can later be refunded/charged back,
-- and affiliate commission is only "real" once approved (TZ §12: no profit claim before that).
CREATE TABLE IF NOT EXISTS revenue_events (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  campaign_id    BIGINT UNSIGNED NULL,
  offer_id       BIGINT UNSIGNED NULL,
  mode           ENUM('OWN_PRODUCT_B2B','AFFILIATE') NOT NULL,
  event_type     ENUM('revenue','commission_pending','commission_approved',
                      'commission_rejected','refund','chargeback') NOT NULL,
  amount         DECIMAL(12,2) NOT NULL DEFAULT 0,
  currency       CHAR(3) NULL,
  contact_email  VARCHAR(255) NULL,
  idempotency_key VARCHAR(190) NOT NULL,
  occurred_at    TIMESTAMP NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (id),
  UNIQUE KEY uk_rev_idem (idempotency_key),
  KEY idx_rev_campaign (campaign_id),
  KEY idx_rev_type (event_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── experiments (TZ §20) ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS campaign_experiments (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  campaign_id    BIGINT UNSIGNED NULL,
  name           VARCHAR(200) NOT NULL,
  hypothesis     TEXT NULL,
  definition_json JSON NULL,
  expected_metrics_json JSON NULL,
  stop_conditions_json  JSON NULL,
  status         VARCHAR(32) NOT NULL DEFAULT 'DRAFT',
  created_at     TIMESTAMP NOT NULL DEFAULT current_timestamp(),
  updated_at     TIMESTAMP NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (id),
  KEY idx_exp_campaign (campaign_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
