# Roadmap

## Now — launch readiness (issue #1)
- [x] Fix outbound safety gates (content validation, kill-switch, cap count, TOCTOU) + tests
- [x] Restore inbound reply import (systemd) + welcome-mail classification guard
- [x] Deliverability Center + Launch Checklist + deterministic advisor (real data)
- [x] Controlled external test send with per-recipient delivery evidence
- [ ] **Owner DNS:** add `rp.fundbot.win` A + MX (mirror emails.cheap) — blocks fundbot delivery
- [ ] **Gmail reputation warmup** from emails.cheap (5→10→20/day), monitor via Deliverability Center
- [ ] Obtain a mail-enabled test inbox to prove real inbox delivery + reply/stop round-trip

## Next — deliverability hardening
- Automated DNSBL/blacklist lookups (Spamhaus, Barracuda) — currently manual entry
- Live TLS/STARTTLS probe surfaced per node (currently node readiness only)
- Deliverability timeline (historical DNS/reputation/rate changes) reusing Prometheus/Grafana
- Google Postmaster Tools + Microsoft SNDS ingestion (scaffold + `not_configured` until creds)
- Real Postal HTTP-API health probe (beyond SMTP banner)

## Later — Stage 2 product
- Subject/copy optimizer (rule-based first; LLM behind the existing `aiAdapter` abstraction)
- Campaign optimizer (sender/window/segment/template recommendations within caps)
- Reply assistant: summarize + draft suggestions (classification already shipped)
- LLM provider plug-in (OpenAI/Anthropic) behind `aiAdapter` — deterministic internal provider is
  the always-on fallback

## Operational
- Alert notification: set the Zoho app-password so Grafana WorkerHeartbeatStale emails fire
- S3/off-host backup copy (local encrypted daily backups exist; no offsite yet)
- Per-tenant webhook tokens; cross-tenant warehouse-write gating (from earlier audit)

Safety invariant across all of the above: **never** enable campaigns/drip or send to real leads
without explicit operator authorization; suppression/bounce/complaint/unsubscribe protections are
always enforced.
