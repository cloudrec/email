-- 0007_theme_system.sql
-- Theme persistence: platform-wide default + per-user override.

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS platform_settings (
  `key`      VARCHAR(60) NOT NULL,
  `value`    JSON NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO platform_settings (`key`, `value`) VALUES ('theme.default', JSON_QUOTE('mission-control'));

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS theme_preference VARCHAR(60) NULL AFTER locale;
