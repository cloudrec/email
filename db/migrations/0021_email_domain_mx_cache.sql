-- 0021: per-domain MX verdict cache.
--
-- Why: the warmup senders resolved MX live for every candidate and threw the
-- answer away (scripts/warmup_send.mjs, scripts/warmup_send_pilot.mjs). A
-- Google-hosted domain was rejected in-process, never recorded, and so stayed
-- at the head of the candidate ordering forever — the ordering is
-- `verification_score DESC, cp.id`, and ~114k rows tie at score 85, so the head
-- is completely static. Sendable domains got an outreach_touchpoints row and
-- dropped out; unsendable ones accumulated. Measured 2026-07-17: of the top 200
-- candidates, 167 were Google-hosted, 11 had no MX, 22 were sendable — and the
-- first 70 rows contained zero sendable domains. Tracks with a small ramp target
-- (diamond/acap: target 16 -> LIMIT 64) never saw past that wall and sent 1/16.
--
-- Keyed by domain, not contact: MX is a property of the domain, and there are
-- ~75k distinct domains behind ~160k email contact_points.
--
-- `sendable` is the denormalized answer the senders filter on (1 = has an MX
-- that isn't Google-hosted). `verdict` keeps *why*, which drives re-check age:
-- dns_fail is transient and must expire fast, google/no_mx are stable.
-- Idempotent so re-running the migration set is a no-op.

CREATE TABLE IF NOT EXISTS email_domain_mx (
  domain     VARCHAR(255)                                  NOT NULL,
  sendable   TINYINT(1)                                    NOT NULL,
  verdict    ENUM('ok','google','no_mx','dns_fail')        NOT NULL,
  checked_at TIMESTAMP                                     NOT NULL DEFAULT current_timestamp()
                                                           ON UPDATE current_timestamp(),
  PRIMARY KEY (domain),
  KEY idx_edm_sendable (sendable),
  KEY idx_edm_verdict_checked (verdict, checked_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
