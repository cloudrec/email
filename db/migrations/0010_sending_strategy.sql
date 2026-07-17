CREATE TABLE IF NOT EXISTS outreach_tasks (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  company_id BIGINT NULL,
  contact_point_id BIGINT NULL,
  channel ENUM('contact_form','telegram','whatsapp','manual_review','website_form') NOT NULL,
  status ENUM('open','in_progress','done','skipped') NOT NULL DEFAULT 'open',
  target_value VARCHAR(500) NULL,
  note VARCHAR(1000) NULL,
  payload_json LONGTEXT NULL,
  created_by_user_id BIGINT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_ot_tenant (tenant_id, status),
  INDEX idx_ot_company (company_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS bounce_check_batches (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  direction ENUM('export','import') NOT NULL,
  row_count INT NOT NULL DEFAULT 0,
  deliverable INT NOT NULL DEFAULT 0,
  undeliverable INT NOT NULL DEFAULT 0,
  risky INT NOT NULL DEFAULT 0,
  unknown INT NOT NULL DEFAULT 0,
  created_by_user_id BIGINT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_bcb_tenant (tenant_id, direction)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
