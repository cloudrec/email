-- Phase 22F — Self-Hosted SMTP Node Readiness Manager.
-- Stores METADATA ONLY about future dedicated self-hosted SMTP nodes so the
-- owner can see whether a node is safe/ready to use. NO MTA is installed by this
-- phase, NO port is opened, NO DNS is changed, NO email is sent. This table never
-- stores SMTP passwords, root passwords, SSH keys, or provider account secrets.
CREATE TABLE IF NOT EXISTS smtp_nodes (
  id                        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id                 INT NOT NULL,
  name                      VARCHAR(190) NOT NULL,
  node_type                 ENUM('self_hosted_vps','dedicated_smtp_server','postal_later','mailcow_later','postfix_later','generic_smtp_node')
                              NOT NULL DEFAULT 'generic_smtp_node',
  status                    ENUM('draft','checking','ready','warning','blocked','disabled')
                              NOT NULL DEFAULT 'draft',
  hostname                  VARCHAR(255) NULL,
  ipv4                      VARCHAR(45)  NULL,
  ipv6                      VARCHAR(64)  NULL,
  provider_name             VARCHAR(190) NULL,
  location                  VARCHAR(190) NULL,
  purpose                   ENUM('cold_outreach','transactional','internal_test')
                              NOT NULL DEFAULT 'internal_test',
  isolation_status          ENUM('unknown','dedicated','shared_with_app_server','shared_with_production','unsafe')
                              NOT NULL DEFAULT 'unknown',
  isolation_note            VARCHAR(500) NULL,
  ptr_expected              VARCHAR(255) NULL,
  ptr_detected              VARCHAR(255) NULL,
  ptr_status                ENUM('unchecked','pass','fail','mismatch') NOT NULL DEFAULT 'unchecked',
  sending_domain            VARCHAR(255) NULL,
  dkim_selector             VARCHAR(190) NULL,
  spf_status                ENUM('unchecked','pass','fail','warning','unknown') NOT NULL DEFAULT 'unchecked',
  dkim_status               ENUM('unchecked','pass','fail','warning','unknown') NOT NULL DEFAULT 'unchecked',
  dmarc_status              ENUM('unchecked','pass','fail','warning','unknown') NOT NULL DEFAULT 'unchecked',
  mx_status                 ENUM('unchecked','pass','fail','warning','unknown') NOT NULL DEFAULT 'unchecked',
  tls_status                ENUM('unchecked','pass','fail','unknown') NOT NULL DEFAULT 'unchecked',
  forward_dns_status        ENUM('unchecked','pass','fail','mismatch','unknown') NOT NULL DEFAULT 'unchecked',
  port25_status             ENUM('unchecked','blocked','open','unknown') NOT NULL DEFAULT 'unchecked',
  abuse_mailbox_status      ENUM('unchecked','planned','configured','missing') NOT NULL DEFAULT 'unchecked',
  postmaster_mailbox_status ENUM('unchecked','planned','configured','missing') NOT NULL DEFAULT 'unchecked',
  bounce_mailbox_status     ENUM('unchecked','planned','configured','missing') NOT NULL DEFAULT 'unchecked',
  blacklist_status          ENUM('unchecked','clean','listed','unknown') NOT NULL DEFAULT 'unchecked',
  -- Manual blacklist / reputation checklist (operator-recorded, no scraping)
  spamhaus_status           ENUM('clean','listed','unknown','not_applicable') NOT NULL DEFAULT 'unknown',
  spamhaus_checked_at       TIMESTAMP NULL,
  barracuda_status          ENUM('clean','listed','unknown','not_applicable') NOT NULL DEFAULT 'unknown',
  barracuda_checked_at      TIMESTAMP NULL,
  microsoft_snds_status     ENUM('clean','listed','unknown','not_applicable') NOT NULL DEFAULT 'unknown',
  google_postmaster_status  ENUM('clean','listed','unknown','not_applicable') NOT NULL DEFAULT 'unknown',
  readiness_score           INT NOT NULL DEFAULT 0,
  readiness_level           ENUM('not_ready','needs_dns','needs_reputation_check','ready_for_lab','ready_for_tiny_test','blocked')
                              NOT NULL DEFAULT 'not_ready',
  safe_to_connect_as_provider TINYINT(1) NOT NULL DEFAULT 0,
  safe_to_send              TINYINT(1) NOT NULL DEFAULT 0,
  risk_level                ENUM('low','medium','high','blocked') NOT NULL DEFAULT 'blocked',
  blockers_json             TEXT NULL,
  warnings_json             TEXT NULL,
  checklist_json            TEXT NULL,
  manual_done_json          TEXT NULL,            -- operator-completed manual checklist item keys
  next_action               VARCHAR(500) NULL,
  last_checked_at           TIMESTAMP NULL,
  last_error                VARCHAR(500) NULL,
  notes                     TEXT NULL,
  created_at                TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY k_tenant (tenant_id),
  KEY k_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
