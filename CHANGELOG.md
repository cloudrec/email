# Changelog

All notable changes to the Emails.Cheap platform. Dates are UTC.

## 2026-07-12 — Launch readiness & Deliverability Center (issue #1)
### Added
- **Deliverability Center**: `GET /deliverability/center` + `/checklist`
  (`services/deliverabilityCenter.ts`, `routes/deliverability.ts`) and operator page
  `portal/src/app/deliverability/page.tsx` (nav + en/ru/uk). Real-data aggregation of DNS/auth,
  Postal health, providers, mailbox/domain reputation, live bounce/complaint/unsub/reply rates,
  worker/queue health, a deterministic **Deliverability Advisor**, and a launch **verdict**
  (`NOT_READY` / `READY_FOR_CONTROLLED_TEST_SEND` / `READY_FOR_LOW_VOLUME_WARMUP`).
- Pure, unit-tested modules `services/outboundContentGuard.ts` and `services/replyClassifier.ts`.
- Tests: `outboundContentGuard.test.ts`, `classifyReplyGuard.test.ts` (import shipping code). api 57/57.
### Fixed
- **Inbound reply import restored** — systemd `email-reply-import.service` failed every run
  (missing `.env`); now runs inside the api container via the built dist.
- Portal one-by-one send now enforces content validation (empty body / `{{macro}}` /
  `<<<REPLACE>>>` / broken grammar) — previously bypassed.
- Tenant kill-switch (`outreach_paused`) honored by campaign runner + portal send (was drip-only).
- Portal daily-cap double-count fixed; portal send TOCTOU claim-lock added.
- Welcome / automated (noreply, mailer-daemon, notifications, WordPress) mail no longer classified
  as an "interested" lead; bounce follow-up now cancels the failed recipient.

## 2026-07-12 — Monitoring, alerts, security & reliability (pre-issue session)
### Added
- Prometheus + Grafana stack (`monitoring/`), api `/metrics` (worker heartbeat gauge), alert rules
  + Grafana email contact point (SMTP via Zoho, pending app-password).
### Fixed / Security
- P0: removed public Mailhog, blocked public `/reports/`, added security headers + nginx rate limit,
  pinned `SECRETS_MASTER_KEY`, `/api/metrics` not public.
- P1: backup retention + logrotate; portal error/401 states (warehouse, go-live, cohorts); worker
  durable Redis stream cursors; i18n gaps.
- Tavily HTTP 432 quota storm handled (burn key + degrade to OSM).
- Suppression regression fixed (bounce email no longer truncated to 60 chars on the stream).
- Return-path DNS (`rp.emails.cheap`) added by owner → delivery to strict receivers works.

## Earlier
See `AI_HANDOFF_CONTEXT.md` and `docs/` for Phase 16–22 history (Warehouse, Lead Intelligence,
self-hosted Postal, partner outreach, i18n).
