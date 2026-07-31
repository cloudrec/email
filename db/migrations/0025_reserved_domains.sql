-- 0025: domain reservation gate (Prospect Audit Email Safety Gate).
-- A reserved domain is one queued for a new PERSONAL audit batch and must be EXCLUDED
-- from every automated selection (first-touch, follow-up, warmup) until the owner
-- reviews and approves it. Reservation is NOT a send and must never create a
-- sent-touchpoint — this table is purely an exclusion list.
--
-- Idempotent by construction: UNIQUE(domain) + upsert. Rollback is soft — set
-- released_at (re-includes the domain) rather than deleting, so the journal survives.
--
-- ROLLBACK (drop entirely):
--   DROP TABLE IF EXISTS reserved_domains;

CREATE TABLE IF NOT EXISTS reserved_domains (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  domain       VARCHAR(255) NOT NULL,          -- normalized: lowercase, no www., no trailing dot
  reason       VARCHAR(190) NOT NULL DEFAULT 'personal_audit_batch',
  source       VARCHAR(190) NOT NULL DEFAULT 'selected_domains.txt',
  reserved_at  TIMESTAMP NOT NULL DEFAULT current_timestamp(),
  released_at  TIMESTAMP NULL,                 -- non-null => no longer reserved (rollback)
  PRIMARY KEY (id),
  UNIQUE KEY uk_reserved_domain (domain),
  KEY idx_reserved_active (released_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
