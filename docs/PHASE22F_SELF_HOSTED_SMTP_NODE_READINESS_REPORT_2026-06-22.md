# Phase 22F — Self-Hosted SMTP Node Readiness Manager

_emails.cheap · `/opt/email` · 2026-06-23 · report-and-build phase._

This phase added a **readiness, risk, DNS, reputation and operations manager** for FUTURE
dedicated self-hosted SMTP nodes. It does **not** install any MTA, open any port, change
any DNS, or send any email. Sending stays blocked by default until every critical check
passes.

## 1. Live audit (at start)
- **SMTP:** `SMTP_HOST=mailhog` (test only). Production SMTP NOT configured.
- **Real emails sent:** 0. **Subscribed contacts:** 1 (pre-existing self-test).
- **Provider profiles:** 3 `sending_providers`. **Mailboxes:** 2 `sender_identities`
  (incl. live `novatradersio@zohomail.eu`, vault creds, SMTP/IMAP verified — Phase 22E.2).
- **Domains:** 1 (`mail.emails.cheap`, purpose main). **Templates:** 16 (1 approved).
- **Go-Live Wizard:** present (`/go-live`), readiness scoring intact.
- **Server:** host `vmi3293429`, public origin IP `84.247.139.105` (domain behind CDN —
  `emails.cheap` resolves to Cloudflare 188.114.x; container sees only 172.x docker IPs).
- **MTA installed/running:** none (`postfix`/`exim`/`sendmail`/`dovecot` absent) — read-only check.
- **Port 25 listening locally:** no (`ss -ltn` read-only) — unchanged.
- **DNS onboarding:** existing `dnsVerify.ts` + `/domains/:id/onboarding` (SPF/DKIM/DMARC/MX).
- **Blacklist/reputation checking:** none previously — added as manual checklist this phase.
- **Bounce handling:** webhook adapters (brevo/smtp2go/mailgun/generic) → normalized
  `webhook:bounce` stream + suppression + audit (existing).
- **Suppression / rate gates:** global+tenant suppression; campaignRunner enforces binding
  MIN of per-domain/per-mailbox/per-tenant daily+hourly (existing). All intact.

## 2. SMTP node data model
**Migration `db/migrations/0017_smtp_nodes.sql`** — new `smtp_nodes` table. **Metadata only:
no SMTP passwords, root passwords, SSH keys, or provider account secrets.** Columns:
identity (name, node_type, hostname, ipv4/ipv6, provider_name, location, purpose),
isolation_status (+ note), PTR (expected/detected/status), DNS auth statuses (spf/dkim/dmarc/
mx/tls/forward_dns), port25_status, abuse/postmaster/bounce mailbox statuses, blacklist_status,
manual reputation fields (spamhaus/barracuda/microsoft_snds/google_postmaster + checked_at),
readiness_score (0–100), readiness_level, risk_level, safe_to_connect_as_provider, safe_to_send,
blockers/warnings/checklist/manual_done JSON, next_action, last_checked_at, last_error, notes.
All ENUMs have safe defaults (STRICT mode compliant).

## 3. Readiness check engine
**`api/src/services/smtpNodes.ts` → `runReadiness()`** — local, deterministic. Read-only DNS
(`node:dns`) + optional read-only TCP connect to port 25 (**no SMTP data written, short
timeout**). Checks: required fields · isolation/production-IP guard · forward DNS · PTR/rDNS ·
SPF (+IP authorisation) · DKIM (selector TXT) · DMARC (p=none OK for warmup) · MX · TLS
(marked unknown — no handshake performed) · port 25 (opt-in probe) · abuse/postmaster/bounce
(metadata) · blacklist (manual). Outputs weighted `readiness_score`, `readiness_level`,
blockers, warnings, single `next_action`, `safe_to_connect_as_provider`, and `safe_to_send`
(**false unless ZERO critical checks fail**).

**Production-IP guard:** `productionIps()` = known origin `84.247.139.105` (hard fallback,
env-overridable via `SERVER_PUBLIC_IP`, **`.env` untouched**) + docker interface IPs. A node
whose IP matches is `blocked`, `risk=blocked`, isolation forced `shared_with_production`.

Critical blockers implemented: production-IP match · missing required fields · no/mismatched
PTR · no SPF · no DKIM · no DMARC · no bounce handling · blacklisted · cold_outreach + unsafe
isolation. Port-25-blocked + cold = warning (direct delivery would fail).

## 4. `/smtp-nodes` UI
**`portal/src/app/smtp-nodes/page.tsx`** — node list (name/host/IP/purpose/status/score/level/
top blocker), Add-node form, node detail (score strip, next action, grouped checklists
DNS/PTR/auth/MX-TLS-port/mailboxes, blockers/warnings, manual reputation selectors, DNS
checklist table). Actions: Save draft · Run readiness check (+ opt-in port-25 probe) · Disable ·
Mark manual item · Export Markdown/JSON · Create draft provider profile (gated). **No
send-test / send-campaign / open-port / install-MTA / proxy actions exist.** Nav item
`smtpNodes` (en "SMTP Nodes" / ru "SMTP-ноды" / uk "SMTP-ноди"); full page i18n in all three
locales (JSON parity validated).

## 5. DNS checklist generator
`dnsChecklist()` produces, per node: A (hostname→IP), PTR instruction (VPS panel),
SPF (`v=spf1 ip4:<ip> -all` + merge note), DKIM placeholder (`selector._domainkey.domain`),
DMARC (`v=DMARC1; p=none; rua=...`), MX/return-path note, abuse@+postmaster@ note.
**Instructions only — DNS is never modified.**

## 6. Provider-profile integration
`POST /smtp-nodes/:id/create-draft-provider` — allowed **only** at readiness level
`ready_for_tiny_test` AND `safe_to_connect_as_provider`. Creates a `sending_providers` row,
`provider_type=self_hosted_smtp_imap_later`, **status `pending`, outbound disabled**,
conservative limits **5/day · 2/hour**, **no secrets, no mailbox, no sending**. Below the gate
→ `412 not_ready`.

## 7. Risk policy engine
Risk levels low/medium/high/blocked. Cold outreach is `blocked` unless: dedicated non-production
IP · PTR pass · SPF pass · DKIM pass · DMARC pass · bounce handling · not blacklisted · low
limits · no auto-send. Any critical blocker ⇒ `safe_to_send=false`, provider creation refused,
reason shown.

## 8. Manual blacklist / reputation checklist
`PATCH /smtp-nodes/:id/reputation` records spamhaus/barracuda/microsoft_snds/google_postmaster
∈ {clean,listed,unknown,not_applicable} (+ checked_at timestamps). Any `listed` ⇒ blacklist
blocker ⇒ sending blocked. **No scraping, no paid API, no evasion/rotation advice.**

## 9. Report export
`GET /smtp-nodes/:id/report?format=markdown|json` — recomputes live (read-only, no port probe);
includes node metadata, checklist results, blockers, warnings, score, next action, DNS
checklist, and the explicit statement: _"This node is not allowed to send until all critical
blockers are resolved."_

## 10. Docs created
- `docs/SELF_HOSTED_SMTP_NODE_READINESS_OPERATOR_GUIDE_2026-06-22.md` (plain-English).
- `docs/PHASE22F_SELF_HOSTED_SMTP_NODE_READINESS_REPORT_2026-06-22.md` (this file).

## 11. Files changed
- **NEW** `db/migrations/0017_smtp_nodes.sql`
- **NEW** `api/src/services/smtpNodes.ts`
- **NEW** `api/src/routes/smtpNodes.ts`
- **NEW** `portal/src/app/smtp-nodes/page.tsx`
- `api/src/index.ts` (import + mount `/smtp-nodes`)
- `portal/src/components/AppShell.tsx` (nav item)
- `portal/src/locales/{en,ru,uk}.json` (nav label + `smtpNodes` page block)

## 12. Migrations added
`0017_smtp_nodes.sql` — applied cleanly (`[migrate] applied 0017_smtp_nodes.sql`).

## 13. Validation results
- `docker compose build api worker portal` — green.
- `migrate.js` — 0017 applied. `healthcheck.sh` — RESULT: OK.
- Pages 200: `/api/health`, `/smtp-nodes`, `/go-live`, `/mailboxes`, `/sender-studio`,
  `/manual-outreach`, `/send-control`, `/safety`.
- Authed smoke (JWT sub=1, x-tenant-id:1):
  - Create draft node ✔
  - **Production-IP node (84.247.139.105) ⇒ `blocked`, `safe_to_send=false`, blocker
    "Node IP equals the production app server IP — BLOCKED" ✔**
  - Fake domain/IP ⇒ blockers PTR/SPF/DKIM/DMARC/bounce, `not_ready` ✔
  - DNS checklist generated ✔
  - Report JSON + Markdown export (with sending-block statement) ✔
  - Provider gate below threshold ⇒ `412 not_ready` ✔
  - spamhaus=listed ⇒ blacklist blocker on re-check ✔
  - Manual item recorded ✔
  - Port-25 read-only probe returned status without sending ✔
  - **No send endpoint** (`POST /:id/send` ⇒ 404) ✔
  - Test rows disabled + deleted; `smtp_nodes` count back to 0 ✔

## 14. Safety confirmations
real emails sent **0** · production SMTP **not enabled** (`SMTP_HOST=mailhog`) · no campaign
scheduled · no mass subscribe (subscribed stays **1**) · no mass export · **no proxy support** ·
no open-relay logic · no IP-rotation logic · no MTA installed · **port 25 not opened** (not
listening) · firewall unchanged · DNS unchanged · `.env` unchanged · no secrets exposed ·
`/opt/seo` untouched · volumes not wiped · SMTP node cannot send from this phase · provider
profile from node is draft/pending/disabled only · `sending_providers` count unchanged at 3.

## 15. Exact next owner action
To eventually use a self-hosted node: **provision a separate VPS with a dedicated IP (never
`84.247.139.105`)**, set its PTR/rDNS, publish SPF/DKIM/DMARC, create abuse@/postmaster@/bounce
mailboxes, then in `/smtp-nodes` add the node and run the readiness check until it reaches
`ready_for_tiny_test`. Only then create the draft provider profile and have a human deliberately
configure a tiny first send. **Nothing sends automatically.**
