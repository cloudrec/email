-- 0001_core_schema.sql
-- Email Platform - core multi-tenant schema
-- MariaDB 11.4 / utf8mb4

SET NAMES utf8mb4;
SET time_zone = '+00:00';

-- ------------------------------------------------------------------
-- Plans (global)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plans (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  code            VARCHAR(40)  NOT NULL UNIQUE,
  name            VARCHAR(120) NOT NULL,
  price_cents     INT UNSIGNED NOT NULL DEFAULT 0,
  currency        CHAR(3)      NOT NULL DEFAULT 'USD',
  billing_period  ENUM('month','year','one_time','manual') NOT NULL DEFAULT 'month',
  max_contacts    INT UNSIGNED NOT NULL DEFAULT 1000,
  max_sends_month INT UNSIGNED NOT NULL DEFAULT 10000,
  max_send_daily  INT UNSIGNED NOT NULL DEFAULT 2000,
  max_domains     SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  max_users       SMALLINT UNSIGNED NOT NULL DEFAULT 3,
  max_automations SMALLINT UNSIGNED NOT NULL DEFAULT 5,
  max_api_calls_day INT UNSIGNED NOT NULL DEFAULT 10000,
  storage_mb      INT UNSIGNED NOT NULL DEFAULT 500,
  is_active       TINYINT(1)   NOT NULL DEFAULT 1,
  is_public       TINYINT(1)   NOT NULL DEFAULT 1,
  metadata        JSON NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- Tenants (workspaces)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenants (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid            CHAR(36) NOT NULL UNIQUE,
  slug            VARCHAR(80) NOT NULL UNIQUE,
  name            VARCHAR(160) NOT NULL,
  status          ENUM('trial','active','suspended','payment_pending','canceled','deleted_soft','deleted_hard') NOT NULL DEFAULT 'trial',
  plan_id         INT UNSIGNED NULL,
  default_locale  ENUM('en','ru','uk') NOT NULL DEFAULT 'en',
  timezone        VARCHAR(64) NOT NULL DEFAULT 'UTC',
  trial_ends_at   TIMESTAMP NULL,
  suspended_at    TIMESTAMP NULL,
  suspended_reason VARCHAR(255) NULL,
  -- absolute usage caps override plan when set
  override_max_contacts   INT UNSIGNED NULL,
  override_max_sends_month INT UNSIGNED NULL,
  override_max_send_daily  INT UNSIGNED NULL,
  override_max_domains     SMALLINT UNSIGNED NULL,
  metadata        JSON NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at      TIMESTAMP NULL,
  PRIMARY KEY (id),
  KEY idx_tenants_status (status),
  CONSTRAINT fk_tenants_plan FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- Users
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uuid            CHAR(36) NOT NULL UNIQUE,
  email           VARCHAR(255) NOT NULL UNIQUE,
  password_hash   VARCHAR(255) NOT NULL,
  full_name       VARCHAR(160) NULL,
  locale          ENUM('en','ru','uk') NOT NULL DEFAULT 'en',
  is_super_admin  TINYINT(1) NOT NULL DEFAULT 0,
  email_verified_at TIMESTAMP NULL,
  last_login_at   TIMESTAMP NULL,
  totp_secret     VARCHAR(64) NULL,
  totp_enabled    TINYINT(1) NOT NULL DEFAULT 0,
  status          ENUM('active','suspended','locked') NOT NULL DEFAULT 'active',
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_users_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- tenant <-> user membership with role
CREATE TABLE IF NOT EXISTS tenant_users (
  tenant_id   BIGINT UNSIGNED NOT NULL,
  user_id     BIGINT UNSIGNED NOT NULL,
  role        ENUM('tenant_owner','tenant_admin','marketer','analyst','read_only','support_admin') NOT NULL,
  invited_by  BIGINT UNSIGNED NULL,
  invited_at  TIMESTAMP NULL,
  accepted_at TIMESTAMP NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, user_id),
  KEY idx_tu_user (user_id),
  CONSTRAINT fk_tu_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_tu_user   FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- API keys (per tenant)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_keys (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  user_id     BIGINT UNSIGNED NULL,
  name        VARCHAR(120) NOT NULL,
  key_prefix  CHAR(8) NOT NULL,
  key_hash    CHAR(64) NOT NULL,
  scopes      JSON NULL,
  last_used_at TIMESTAMP NULL,
  expires_at  TIMESTAMP NULL,
  revoked_at  TIMESTAMP NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_apikey_hash (key_hash),
  KEY idx_apikey_tenant (tenant_id),
  CONSTRAINT fk_apikey_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_apikey_user   FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- Domains + sender identities
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS domains (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id       BIGINT UNSIGNED NOT NULL,
  domain          VARCHAR(255) NOT NULL,
  type            ENUM('sending','tracking') NOT NULL DEFAULT 'sending',
  status          ENUM('pending','verified','failed','warning','disabled') NOT NULL DEFAULT 'pending',
  dkim_selector   VARCHAR(40) NOT NULL DEFAULT 'mail',
  dkim_public_key TEXT NULL,
  dkim_private_key TEXT NULL,
  spf_record      VARCHAR(255) NULL,
  dmarc_record    VARCHAR(255) NULL,
  return_path_host VARCHAR(255) NULL,
  mx_required     TINYINT(1) NOT NULL DEFAULT 0,
  last_checked_at TIMESTAMP NULL,
  last_status_detail JSON NULL,
  daily_send_limit INT UNSIGNED NULL,
  reputation_score TINYINT NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_domain (tenant_id, domain, type),
  KEY idx_domains_status (status),
  CONSTRAINT fk_domains_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sender_identities (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  domain_id   BIGINT UNSIGNED NOT NULL,
  from_email  VARCHAR(255) NOT NULL,
  from_name   VARCHAR(160) NOT NULL,
  reply_to    VARCHAR(255) NULL,
  is_default  TINYINT(1) NOT NULL DEFAULT 0,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_sender (tenant_id, from_email),
  CONSTRAINT fk_sender_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_sender_domain FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- Contacts, lists, segments, suppression
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contacts (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id       BIGINT UNSIGNED NOT NULL,
  email           VARCHAR(255) NOT NULL,
  first_name      VARCHAR(120) NULL,
  last_name       VARCHAR(120) NULL,
  status          ENUM('subscribed','unsubscribed','bounced','complained','pending') NOT NULL DEFAULT 'subscribed',
  consent_source  VARCHAR(120) NULL,
  consent_at      TIMESTAMP NULL,
  unsubscribed_at TIMESTAMP NULL,
  bounced_at      TIMESTAMP NULL,
  complained_at   TIMESTAMP NULL,
  language        ENUM('en','ru','uk') NULL,
  country         CHAR(2) NULL,
  custom_fields   JSON NULL,
  tags            JSON NULL,
  last_event_at   TIMESTAMP NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_contact_email (tenant_id, email),
  KEY idx_contact_status (tenant_id, status),
  CONSTRAINT fk_contact_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS lists (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  name        VARCHAR(160) NOT NULL,
  description VARCHAR(500) NULL,
  contact_count INT UNSIGNED NOT NULL DEFAULT 0,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_list_name (tenant_id, name),
  CONSTRAINT fk_list_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS list_contacts (
  list_id    BIGINT UNSIGNED NOT NULL,
  contact_id BIGINT UNSIGNED NOT NULL,
  added_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (list_id, contact_id),
  KEY idx_lc_contact (contact_id),
  CONSTRAINT fk_lc_list    FOREIGN KEY (list_id)    REFERENCES lists(id)    ON DELETE CASCADE,
  CONSTRAINT fk_lc_contact FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS segments (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  name        VARCHAR(160) NOT NULL,
  rules       JSON NOT NULL,
  is_dynamic  TINYINT(1) NOT NULL DEFAULT 1,
  cached_count INT UNSIGNED NULL,
  cached_at   TIMESTAMP NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_segment_name (tenant_id, name),
  CONSTRAINT fk_seg_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS suppressions (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id  BIGINT UNSIGNED NOT NULL,
  email      VARCHAR(255) NOT NULL,
  reason     ENUM('unsubscribe','bounce_hard','complaint','manual','import') NOT NULL,
  source_event_id BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_suppress (tenant_id, email),
  CONSTRAINT fk_supp_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- Campaigns + events
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS campaigns (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id       BIGINT UNSIGNED NOT NULL,
  uuid            CHAR(36) NOT NULL UNIQUE,
  name            VARCHAR(200) NOT NULL,
  subject         VARCHAR(500) NOT NULL,
  preheader       VARCHAR(255) NULL,
  sender_identity_id BIGINT UNSIGNED NOT NULL,
  list_id         BIGINT UNSIGNED NULL,
  segment_id      BIGINT UNSIGNED NULL,
  html_body       MEDIUMTEXT NOT NULL,
  text_body       MEDIUMTEXT NULL,
  status          ENUM('draft','scheduled','sending','paused','sent','failed','canceled') NOT NULL DEFAULT 'draft',
  scheduled_at    TIMESTAMP NULL,
  started_at      TIMESTAMP NULL,
  finished_at     TIMESTAMP NULL,
  total_recipients INT UNSIGNED NOT NULL DEFAULT 0,
  sent_count      INT UNSIGNED NOT NULL DEFAULT 0,
  delivered_count INT UNSIGNED NOT NULL DEFAULT 0,
  opened_count    INT UNSIGNED NOT NULL DEFAULT 0,
  clicked_count   INT UNSIGNED NOT NULL DEFAULT 0,
  bounced_count   INT UNSIGNED NOT NULL DEFAULT 0,
  complained_count INT UNSIGNED NOT NULL DEFAULT 0,
  unsubscribed_count INT UNSIGNED NOT NULL DEFAULT 0,
  created_by      BIGINT UNSIGNED NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_camp_tenant_status (tenant_id, status),
  KEY idx_camp_scheduled (status, scheduled_at),
  CONSTRAINT fk_camp_tenant   FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_camp_sender   FOREIGN KEY (sender_identity_id) REFERENCES sender_identities(id),
  CONSTRAINT fk_camp_list     FOREIGN KEY (list_id)    REFERENCES lists(id)    ON DELETE SET NULL,
  CONSTRAINT fk_camp_segment  FOREIGN KEY (segment_id) REFERENCES segments(id) ON DELETE SET NULL,
  CONSTRAINT fk_camp_user     FOREIGN KEY (created_by) REFERENCES users(id)    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS campaign_events (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  campaign_id BIGINT UNSIGNED NOT NULL,
  contact_id  BIGINT UNSIGNED NULL,
  email       VARCHAR(255) NOT NULL,
  event_type  ENUM('queued','sent','delivered','opened','clicked','bounced_soft','bounced_hard','complained','unsubscribed','failed') NOT NULL,
  url         VARCHAR(2000) NULL,
  ip          VARCHAR(45) NULL,
  user_agent  VARCHAR(500) NULL,
  detail      JSON NULL,
  occurred_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ev_camp (campaign_id, event_type),
  KEY idx_ev_contact (contact_id),
  KEY idx_ev_tenant_time (tenant_id, occurred_at),
  CONSTRAINT fk_ev_tenant   FOREIGN KEY (tenant_id)   REFERENCES tenants(id)   ON DELETE CASCADE,
  CONSTRAINT fk_ev_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
  CONSTRAINT fk_ev_contact  FOREIGN KEY (contact_id)  REFERENCES contacts(id)  ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- Automations (trigger -> condition -> action)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS automations (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  name        VARCHAR(200) NOT NULL,
  status      ENUM('draft','active','paused','archived') NOT NULL DEFAULT 'draft',
  `trigger`   JSON NOT NULL,
  graph       JSON NOT NULL,
  created_by  BIGINT UNSIGNED NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_auto_tenant_status (tenant_id, status),
  CONSTRAINT fk_auto_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_auto_user   FOREIGN KEY (created_by) REFERENCES users(id)  ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS automation_runs (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id     BIGINT UNSIGNED NOT NULL,
  automation_id BIGINT UNSIGNED NOT NULL,
  contact_id    BIGINT UNSIGNED NOT NULL,
  current_node  VARCHAR(60) NULL,
  status        ENUM('running','completed','failed','canceled') NOT NULL DEFAULT 'running',
  next_run_at   TIMESTAMP NULL,
  started_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at   TIMESTAMP NULL,
  state         JSON NULL,
  PRIMARY KEY (id),
  KEY idx_runs_due (status, next_run_at),
  KEY idx_runs_auto (automation_id),
  CONSTRAINT fk_run_tenant FOREIGN KEY (tenant_id)     REFERENCES tenants(id)     ON DELETE CASCADE,
  CONSTRAINT fk_run_auto   FOREIGN KEY (automation_id) REFERENCES automations(id) ON DELETE CASCADE,
  CONSTRAINT fk_run_contact FOREIGN KEY (contact_id)   REFERENCES contacts(id)    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- Forms
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS forms (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  name        VARCHAR(160) NOT NULL,
  slug        VARCHAR(120) NOT NULL,
  fields      JSON NOT NULL,
  list_id     BIGINT UNSIGNED NULL,
  double_optin TINYINT(1) NOT NULL DEFAULT 1,
  thank_you_url VARCHAR(500) NULL,
  submissions INT UNSIGNED NOT NULL DEFAULT 0,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_form_slug (tenant_id, slug),
  CONSTRAINT fk_form_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_form_list   FOREIGN KEY (list_id)   REFERENCES lists(id)   ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- Billing (provider-agnostic)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subscriptions (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id     BIGINT UNSIGNED NOT NULL,
  plan_id       INT UNSIGNED NOT NULL,
  status        ENUM('trial','active','past_due','canceled','expired','manual') NOT NULL DEFAULT 'trial',
  provider      VARCHAR(40) NOT NULL DEFAULT 'manual',
  provider_subscription_id VARCHAR(120) NULL,
  current_period_start TIMESTAMP NULL,
  current_period_end   TIMESTAMP NULL,
  cancel_at_period_end TINYINT(1) NOT NULL DEFAULT 0,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_sub_tenant (tenant_id, status),
  CONSTRAINT fk_sub_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_sub_plan   FOREIGN KEY (plan_id)   REFERENCES plans(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS invoices (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id       BIGINT UNSIGNED NOT NULL,
  subscription_id BIGINT UNSIGNED NULL,
  number          VARCHAR(40) NOT NULL UNIQUE,
  amount_cents    INT UNSIGNED NOT NULL,
  currency        CHAR(3) NOT NULL DEFAULT 'USD',
  status          ENUM('open','paid','void','refunded','overdue') NOT NULL DEFAULT 'open',
  issued_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  due_at          TIMESTAMP NULL,
  paid_at         TIMESTAMP NULL,
  notes           VARCHAR(1000) NULL,
  PRIMARY KEY (id),
  KEY idx_inv_tenant (tenant_id, status),
  CONSTRAINT fk_inv_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_inv_sub    FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payments (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  invoice_id  BIGINT UNSIGNED NULL,
  provider    VARCHAR(40) NOT NULL,
  provider_reference VARCHAR(160) NULL,
  amount_cents INT UNSIGNED NOT NULL,
  currency    CHAR(3) NOT NULL DEFAULT 'USD',
  status      ENUM('pending','succeeded','failed','refunded') NOT NULL DEFAULT 'pending',
  actor_user_id BIGINT UNSIGNED NULL,
  notes       VARCHAR(1000) NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_pay_tenant (tenant_id, status),
  CONSTRAINT fk_pay_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_pay_inv    FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE SET NULL,
  CONSTRAINT fk_pay_actor  FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- Usage (per-tenant counters)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usage_daily (
  tenant_id   BIGINT UNSIGNED NOT NULL,
  `date`      DATE NOT NULL,
  sent_count  INT UNSIGNED NOT NULL DEFAULT 0,
  api_calls   INT UNSIGNED NOT NULL DEFAULT 0,
  bounces     INT UNSIGNED NOT NULL DEFAULT 0,
  complaints  INT UNSIGNED NOT NULL DEFAULT 0,
  unsubscribes INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, `date`),
  CONSTRAINT fk_usage_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------------
-- Audit log
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id   BIGINT UNSIGNED NULL,
  user_id     BIGINT UNSIGNED NULL,
  actor_email VARCHAR(255) NULL,
  action      VARCHAR(80) NOT NULL,
  target_type VARCHAR(60) NULL,
  target_id   VARCHAR(60) NULL,
  ip          VARCHAR(45) NULL,
  user_agent  VARCHAR(500) NULL,
  metadata    JSON NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_audit_tenant_time (tenant_id, created_at),
  KEY idx_audit_action (action)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
