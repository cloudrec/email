# Production Launch Runbook

Operator guide to launching real cold outreach on Emails.Cheap safely. Nothing sends
automatically — every step is gated and reversible.

## 0. Golden rules
- Campaigns and drip are **disabled by default**. They send only when explicitly enabled.
- Every send is gated: approved template · non-empty subject/body · no unresolved macros ·
  active mailbox · not suppressed · under daily/hourly cap · tenant kill-switch off · not
  already sent. If any fails, the send is blocked with an **exact reason code**.
- Warmup is **automatic**: each mailbox starts at 5/day and ramps 5→8→12→18→25→… one step per
  day while healthy; it **auto-pauses** if bounce >3% or complaint >0.1% that day.

## 1. How to verify DNS (do this first, per sending domain)
Open **Deliverability Center** (`/deliverability`) or call `GET /api/deliverability/center`.
Confirm for each sending domain: **SPF ✓, DKIM ✓, DMARC ✓, return-path (rp.<domain>) resolves ✓**,
PTR aligned to `mail.<domain>`, Spamhaus/Barracuda = clean. The page lists the exact missing
record as a blocker. Return-path fix for a Postal domain:
```
rp.<domain>.  A    84.247.139.105
rp.<domain>.  MX   10 mail.<domain>.
rp.<domain>.  TXT  "v=spf1 a mx include:spf.<domain> ~all"
```

## 2. How to add a sending domain (Postal)
1. In Postal console: `server.domains.create name: <domain>` → publish the 4 TXT (verify/SPF/DKIM/DMARC)
   + the `rp.<domain>` A/MX above → `check_dns`.
2. In the app: `/domains` → add domain → verify (live DNS check).
3. Create sender identities on it (step 3).

## 3. How to add a mailbox (sender identity)
- `/mailboxes` (fleet) → the mailbox = a `sender_identities` row: `from_email`, `provider_id`
  (transport), `daily/hourly` limits, `warmup_stage`.
- **Test SMTP** (and IMAP if it will receive replies) from the mailbox row — must pass
  (`test_status = smtp_ok`) before it can send.
- Set `inbound_enabled + imap_enabled` on at least one mailbox so replies/bounces are imported.
- New mailboxes auto-enter warmup at day 1 (5/day).

## 4. How to add / configure an SMTP provider
- `sending_providers` = the transport + credential layer (`smtp_host/port`, `provider_type`,
  credential **ref names** only — secrets live in the vault `mailbox_secrets`, never in the row).
- Add via the mailbox/provider UI; store the SMTP password with the secret vault (never `.env`
  for tenant mailboxes). Postal is provider type `postal` (from `hello@emails.cheap`).

## 5. How to warm domains
Automatic. Enable one or two mailboxes on the domain, keep volume tiny, and let the warmup
scheduler ramp them. Watch the Deliverability Center bounce/complaint/reply rates daily. If a
mailbox auto-pauses (`paused_reason` starts `warmup_auto_pause`), fix list quality before
re-activating. Do **not** manually raise limits ahead of the ramp.

## 6. How to start the first campaign (controlled)
1. Confirm **Deliverability Center verdict** = `READY_FOR_CONTROLLED_TEST_SEND` (or warmup) with
   **no blockers** for the sending domain.
2. Build an explicit contact **list** (never send to the raw warehouse). Contacts must be
   `subscribed`.
3. Create + **approve** a template (spam/compliance validator must pass; it enforces opt-out
   line, no macros left, no broken links).
4. Send a **test** to yourself (`/first-test-send` or campaign test) and confirm inbox delivery.
5. Schedule the campaign. campaignRunner sends only to `subscribed`, non-suppressed contacts,
   under caps, from the assigned mailbox. Keep volume within the warmup limit.

## 7. How to monitor replies
- The reply importer runs every 15 min (`email-reply-import.timer`) over IMAP-enabled mailboxes.
- View replies at `/manual-outreach` (replies tab). Each reply gets a deterministic status:
  interested / not_interested / do_not_contact / unsubscribe / wrong_person / out_of_office /
  bounce_like / auto_reply / unknown. Welcome/automated mail is never marked interested.
- A **STOP** or unsubscribe reply auto-suppresses. Hard bounces auto-suppress + cancel follow-ups.

## 8. How to stop campaigns (kill-switch)
- Pause a single campaign: `/send-control` or `POST /campaigns/:id/pause`.
- **Global tenant kill-switch:** set `tenant_safety_settings.outreach_paused = 1` (via send-control
  / admin safety). This stops **campaigns, drip, and portal one-by-one sends** immediately.
- Disable a mailbox: set its status `paused`/`disabled` or `outbound_enabled = 0`.

## 9. How to recover
- **Mailbox auto-paused:** check `paused_reason`; clean the list / fix creds; set status back to
  `active`. Warmup resumes at its current day.
- **Worker down:** Grafana alert `WorkerHeartbeatStale` fires; `docker compose restart worker`
  (it auto-exits + restarts on a dead DB pool). Heartbeat visible in Deliverability Center.
- **Reply import failing:** `systemctl status email-reply-import.service`; it runs inside the api
  container (`docker compose exec -T api node dist/cli/importReplies.js`).
- **Restore data:** encrypted daily backups in `/opt/email/backups/` (+ launch backups in
  `/opt/backups/`). Decrypt with the backup passphrase; import the SQL dump.
- **Blocklisted IP:** Deliverability Center shows Spamhaus/Barracuda `listed`; pause sending and
  request delisting.

## 10. Safe-launch checklist (must all be green)
DNS (SPF/DKIM/DMARC/return-path/PTR) · Spamhaus/Barracuda clean · provider SMTP verified · IMAP
enabled · approved template · active warmed mailbox · worker healthy · bounce/complaint within
limits · suppression pipeline active · campaigns/drip disabled until you enable them. The
Deliverability Center computes this and prints the verdict: `NOT_READY` /
`READY_FOR_CONTROLLED_TEST_SEND` / `READY_FOR_LOW_VOLUME_WARMUP`.
