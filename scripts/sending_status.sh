#!/usr/bin/env bash
# sending_status.sh — operator dashboard for the email drip sender.
# Shows real send counts from manual_outreach_queue, not only cached sender_identities counters.
set -euo pipefail
cd "$(dirname "$0")/.."

PW=$(grep -E '^DB_PASSWORD=' .env | head -1 | cut -d= -f2-)
DB() { docker exec email_db mariadb -uemail_app -p"$PW" email_platform -N -e "$1" 2>/dev/null; }
Q()  { docker exec email_db mariadb -uemail_app -p"$PW" email_platform -e "$1" 2>/dev/null; }

echo "================ EMAIL SENDING STATUS ================"
echo "now (UTC): $(DB 'SELECT UTC_TIMESTAMP();')"
echo

# --- Drip engine ---
IFS=$'\t' read -r EN TICK TOTAL DPB HPB < <(DB "SELECT enabled, last_tick_at, sent_total, daily_per_mailbox, hourly_per_mailbox FROM outreach_drip_settings WHERE tenant_id=1;")
PAUSED=$(DB "SELECT COALESCE(outreach_paused,0) FROM tenant_safety_settings WHERE tenant_id=1;")

echo "DRIP ENGINE"
[ "$EN" = "1" ] && echo "  state........: ON" || echo "  state........: OFF  <-- sending disabled"
[ "${PAUSED:-0}" = "1" ] && echo "  kill-switch..: PAUSED  <-- outreach_paused=1"
echo "  last tick....: $TICK   (worker heartbeat; should be < 2 min old)"
echo "  caps/mailbox.: ${DPB}/day  ${HPB}/hour"
echo

# --- Totals from real queue ---
echo "VOLUME"
Q "SELECT
     (SELECT COUNT(*) FROM manual_outreach_queue WHERE status IN ('sent_smtp','sent_manual')) AS sent_total,
     (SELECT COUNT(*) FROM manual_outreach_queue WHERE status IN ('sent_smtp','sent_manual') AND DATE(sent_at)=UTC_DATE()) AS real_sent_today,
     (SELECT MAX(sent_at) FROM manual_outreach_queue WHERE status IN ('sent_smtp','sent_manual')) AS last_send_at,
     (SELECT COUNT(*) FROM manual_outreach_queue WHERE status='approved') AS approved_waiting,
     (SELECT COUNT(*) FROM manual_outreach_queue WHERE status='pending_review') AS pending_review;"
echo

echo "CAPACITY SUMMARY"
Q "SELECT
     (SELECT COUNT(*) FROM sender_identities WHERE status='active') AS active_mailboxes,
     (SELECT COUNT(*) FROM sender_identities WHERE status='active' AND last_sent_at IS NOT NULL) AS mailboxes_ever_used,
     (SELECT COUNT(DISTINCT mailbox_id) FROM manual_outreach_queue WHERE status IN ('sent_smtp','sent_manual') AND DATE(sent_at)=UTC_DATE()) AS mailboxes_sent_today,
     (SELECT COUNT(*) FROM manual_outreach_queue WHERE status IN ('sent_smtp','sent_manual') AND sent_at >= UTC_TIMESTAMP() - INTERVAL 1 HOUR) AS sent_last_hour;"
echo

echo "SENT PER DAY (last 7)"
Q "SELECT DATE(sent_at) day, COUNT(*) sent FROM manual_outreach_queue
   WHERE status IN ('sent_smtp','sent_manual') AND sent_at >= UTC_DATE() - INTERVAL 7 DAY
   GROUP BY DATE(sent_at) ORDER BY day DESC;"
echo

echo "ACTIVE MAILBOXES (real queue counters + effective caps + cached DB counters)"
Q "SELECT
     si.id,
     si.from_email,
     si.status,
     si.daily_send_limit AS mailbox_daily_cap,
     si.hourly_send_limit AS mailbox_hourly_cap,
     LEAST(${DPB:-9999}, COALESCE(si.daily_send_limit,9999)) AS effective_daily_cap,
     LEAST(${HPB:-9999}, COALESCE(si.hourly_send_limit,9999)) AS effective_hourly_cap,
     COALESCE(t.real_sent_today,0) AS real_sent_today,
     COALESCE(h.sent_last_hour,0) AS sent_last_hour,
     GREATEST(0, LEAST(${DPB:-9999}, COALESCE(si.daily_send_limit,9999)) - COALESCE(t.real_sent_today,0)) AS daily_left,
     GREATEST(0, LEAST(${HPB:-9999}, COALESCE(si.hourly_send_limit,9999)) - COALESCE(h.sent_last_hour,0)) AS hourly_left,
     si.sent_today AS cached_sent_today,
     si.manual_sent_today AS cached_manual,
     si.smtp_sent_today AS cached_smtp,
     si.last_sent_at
   FROM sender_identities si
   LEFT JOIN (
     SELECT mailbox_id, COUNT(*) AS real_sent_today
     FROM manual_outreach_queue
     WHERE status IN ('sent_smtp','sent_manual')
       AND DATE(sent_at)=UTC_DATE()
     GROUP BY mailbox_id
   ) t ON t.mailbox_id=si.id
   LEFT JOIN (
     SELECT mailbox_id, COUNT(*) AS sent_last_hour
     FROM manual_outreach_queue
     WHERE status IN ('sent_smtp','sent_manual')
       AND sent_at >= UTC_TIMESTAMP() - INTERVAL 1 HOUR
     GROUP BY mailbox_id
   ) h ON h.mailbox_id=si.id
   WHERE si.status='active'
   ORDER BY si.last_sent_at DESC, si.id DESC;"
echo

echo "CACHED COUNTER MISMATCHES"
Q "SELECT
     si.id,
     si.from_email,
     COALESCE(t.real_sent_today,0) AS real_sent_today,
     si.sent_today AS cached_sent_today,
     si.manual_sent_today AS cached_manual,
     si.smtp_sent_today AS cached_smtp,
     si.last_sent_at
   FROM sender_identities si
   LEFT JOIN (
     SELECT mailbox_id, COUNT(*) AS real_sent_today
     FROM manual_outreach_queue
     WHERE status IN ('sent_smtp','sent_manual')
       AND DATE(sent_at)=UTC_DATE()
     GROUP BY mailbox_id
   ) t ON t.mailbox_id=si.id
   WHERE si.status='active'
     AND COALESCE(t.real_sent_today,0) <> COALESCE(si.sent_today,0)
   ORDER BY real_sent_today DESC, si.last_sent_at DESC;"
echo

# --- Stuck items ---
STUCK=$(DB "SELECT COUNT(*) FROM manual_outreach_queue WHERE status='approved' AND send_attempts>=5;")
echo "STUCK ITEMS (approved but failed >=5x -> drip skips them): ${STUCK:-0}"
if [ "${STUCK:-0}" != "0" ]; then
  echo "  >> Drip will NOT retry these. Run: bash scripts/sending_resume.sh"
  Q "SELECT mailbox_id, last_send_error, COUNT(*) cnt
     FROM manual_outreach_queue WHERE status='approved' AND send_attempts>=5
     GROUP BY mailbox_id, last_send_error;"
fi

echo "======================================================"
echo "Web view: https://email.clients.help/manual-outreach  (Drip + Today tabs)"
