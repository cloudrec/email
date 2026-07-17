-- Phase 22C — Sender Studio: email editor + HTML + safety/versioning.
-- Idempotent. Extends manual_outreach_templates (backward compatible: `body`
-- stays the canonical PLAIN-TEXT body that send/queue/followup code already
-- reads; new html_body/blocks_json/preheader are additive) and adds a
-- template version history table.

-- ── Extend templates ─────────────────────────────────────────────────────────
ALTER TABLE manual_outreach_templates
  ADD COLUMN IF NOT EXISTS preheader   VARCHAR(255) NULL              AFTER subject,
  ADD COLUMN IF NOT EXISTS html_body   MEDIUMTEXT   NULL              AFTER body,
  ADD COLUMN IF NOT EXISTS blocks_json MEDIUMTEXT   NULL              AFTER html_body,
  ADD COLUMN IF NOT EXISTS category    VARCHAR(40)  NOT NULL DEFAULT 'generic_service' AFTER blocks_json,
  ADD COLUMN IF NOT EXISTS language    VARCHAR(5)   NOT NULL DEFAULT 'en'  AFTER category,
  ADD COLUMN IF NOT EXISTS status      VARCHAR(20)  NOT NULL DEFAULT 'draft' AFTER language,
  ADD COLUMN IF NOT EXISTS editor_mode VARCHAR(20)  NOT NULL DEFAULT 'plain' AFTER status,
  ADD COLUMN IF NOT EXISTS use_case    VARCHAR(255) NULL              AFTER editor_mode,
  ADD COLUMN IF NOT EXISTS safety_status VARCHAR(20) NULL             AFTER use_case,
  ADD COLUMN IF NOT EXISTS version     INT          NOT NULL DEFAULT 1 AFTER safety_status,
  ADD COLUMN IF NOT EXISTS approved_by BIGINT       NULL              AFTER version;

-- Keep status in sync with the legacy `approved` flag for pre-existing rows.
UPDATE manual_outreach_templates SET status='approved' WHERE approved=1 AND status='draft';

-- Sensible default categories for the seeded Clients.Help pack.
UPDATE manual_outreach_templates SET category='cold_first_touch'
  WHERE category='generic_service' AND template_key IN
    ('clients_help_first_touch','clients_help_chat','remote_it_ps','no_ps_ab','seo_growth');
UPDATE manual_outreach_templates SET category='cold_followup'
  WHERE category='generic_service' AND template_key IN
    ('clients_help_followup_1','clients_help_followup_2');
UPDATE manual_outreach_templates SET category='clients_help_sales'
  WHERE category='generic_service' AND template_key='wrong_person';

-- ── Template version history ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS manual_outreach_template_versions (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id       BIGINT NOT NULL,
  template_id     BIGINT UNSIGNED NOT NULL,
  version_number  INT NOT NULL,
  name            VARCHAR(160) NULL,
  subject         VARCHAR(255) NOT NULL,
  preheader       VARCHAR(255) NULL,
  body            TEXT NOT NULL,
  html_body       MEDIUMTEXT NULL,
  blocks_json     MEDIUMTEXT NULL,
  category        VARCHAR(40) NULL,
  language        VARCHAR(5) NULL,
  editor_mode     VARCHAR(20) NULL,
  approval_status VARCHAR(20) NOT NULL DEFAULT 'draft',
  created_by      BIGINT NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_tmpl_version (template_id, version_number),
  KEY idx_tmpl (tenant_id, template_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
