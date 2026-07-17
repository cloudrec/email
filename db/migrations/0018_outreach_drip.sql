-- Phase 22G — Outreach drip scheduler.
-- Lets the operator turn on automatic, time-distributed sending of APPROVED
-- manual_outreach_queue items: each mailbox sends a few per hour, spread across a
-- daily window, respecting per-mailbox hourly + daily caps and a minimum interval.
-- DISABLED by default (enabled=0). The drip worker only runs for tenants that have
-- explicitly armed it AND are not outreach_paused. Real sends still gated per item
-- (approved + opt-out line + not suppressed + active mailbox).
CREATE TABLE IF NOT EXISTS outreach_drip_settings (
  tenant_id           INT NOT NULL PRIMARY KEY,
  enabled             TINYINT(1) NOT NULL DEFAULT 0,
  daily_per_mailbox   INT NOT NULL DEFAULT 20,
  hourly_per_mailbox  INT NOT NULL DEFAULT 2,
  min_interval_min    INT NOT NULL DEFAULT 25,     -- spacing between sends from one mailbox
  window_start_hour   TINYINT NOT NULL DEFAULT 0,  -- send only within [start,end) server-hour (UTC); 0..23
  window_end_hour     TINYINT NOT NULL DEFAULT 24, -- 24 = no upper bound
  enabled_at          TIMESTAMP NULL,
  last_tick_at        TIMESTAMP NULL,
  sent_total          INT NOT NULL DEFAULT 0,
  updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Drip resilience columns on the queue (ignore errors if they already exist).
ALTER TABLE manual_outreach_queue ADD COLUMN IF NOT EXISTS send_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE manual_outreach_queue ADD COLUMN IF NOT EXISTS last_send_error VARCHAR(255) NULL;
