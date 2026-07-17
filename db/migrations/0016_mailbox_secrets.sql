-- Phase 22E.2 — client-side credential entry.
-- Lets the operator enter SMTP/IMAP credentials from the UI instead of editing
-- the server .env. Values are AES-256-GCM encrypted at rest (key derived from
-- API_JWT_SECRET) and resolved at call time, DB-first then env-var fallback.
-- Secrets are NEVER returned to the client or logged.
CREATE TABLE IF NOT EXISTS mailbox_secrets (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id  INT NOT NULL,
  ref_name   VARCHAR(190) NOT NULL,            -- the env-var NAME this value backs
  value_enc  TEXT NOT NULL,                    -- base64(iv | authTag | ciphertext)
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ref (ref_name),
  KEY k_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
