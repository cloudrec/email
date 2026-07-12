#!/usr/bin/env bash
set -euo pipefail

cd /opt/email || exit 1

TS="$(date -u +%Y%m%d_%H%M%S)"
PW="$(grep -E '^DB_PASSWORD=' .env | head -1 | cut -d= -f2-)"
BACKUP_DIR="/opt/email/backups/launcher_safe_approve_$TS"
REPORT="/opt/email/reports/LAUNCHER_SAFE_APPROVE_FIX_$TS.md"

mkdir -p "$BACKUP_DIR" /opt/email/reports

DB() {
  docker exec email_db mariadb -uemail_app -p"$PW" email_platform -e "$1"
}

echo "== 1) FORCE PAUSE / OFF =="
DB "
UPDATE tenant_safety_settings
SET outreach_paused=1,
    outreach_paused_reason='Paused before safe pending approval / launcher fix'
WHERE tenant_id=1;

UPDATE outreach_drip_settings
SET enabled=0
WHERE tenant_id=1;
"

echo "== 2) BACKUP =="
docker exec email_db mariadb-dump -uemail_app -p"$PW" email_platform \
  manual_outreach_queue \
  manual_outreach_templates \
  outreach_drip_settings \
  tenant_safety_settings \
  sender_identities \
  > "$BACKUP_DIR/before_launcher_safe_approve.sql"

cp -a /opt/email/scripts/launch_clients_help.sh "$BACKUP_DIR/launch_clients_help.sh.before" 2>/dev/null || true

echo "Backup: $BACKUP_DIR"

echo "== 3) CURRENT PENDING DIAGNOSTICS =="
DB "
SELECT status, safety_status, template_key, COUNT(*) cnt
FROM manual_outreach_queue
GROUP BY status, safety_status, template_key
ORDER BY status, safety_status, cnt DESC;
"

DB "
SELECT 
  id,
  mailbox_id,
  email,
  company_name,
  template_key,
  safety_status,
  draft_subject,
  LEFT(draft_body, 700) AS draft_preview,
  (
    COALESCE(draft_subject,'') = ''
    OR COALESCE(draft_body,'') = ''
    OR COALESCE(draft_subject,'') LIKE '%{{%'
    OR COALESCE(draft_subject,'') LIKE '%}}%'
    OR COALESCE(draft_body,'') LIKE '%{{%'
    OR COALESCE(draft_body,'') LIKE '%}}%'
    OR COALESCE(draft_subject,'') LIKE '%{|%'
    OR COALESCE(draft_subject,'') LIKE '%|}%'
    OR COALESCE(draft_body,'') LIKE '%{|%'
    OR COALESCE(draft_body,'') LIKE '%|}%'
    OR COALESCE(draft_body,'') LIKE '%unsubscribe here:%'
  ) AS unsafe
FROM manual_outreach_queue
WHERE tenant_id=1
  AND status='pending_review'
ORDER BY id DESC
LIMIT 80;
"

echo "== 4) MARK SAFE PENDING AS ok =="
DB "
UPDATE manual_outreach_queue
SET safety_status='ok',
    last_send_error=NULL
WHERE tenant_id=1
  AND status='pending_review'
  AND COALESCE(draft_subject,'') <> ''
  AND COALESCE(draft_body,'') <> ''
  AND COALESCE(draft_subject,'') NOT LIKE '%{{%'
  AND COALESCE(draft_subject,'') NOT LIKE '%}}%'
  AND COALESCE(draft_body,'') NOT LIKE '%{{%'
  AND COALESCE(draft_body,'') NOT LIKE '%}}%'
  AND COALESCE(draft_subject,'') NOT LIKE '%{|%'
  AND COALESCE(draft_subject,'') NOT LIKE '%|}%'
  AND COALESCE(draft_body,'') NOT LIKE '%{|%'
  AND COALESCE(draft_body,'') NOT LIKE '%|}%'
  AND COALESCE(draft_body,'') NOT LIKE '%unsubscribe here:%';
"

echo "== 5) APPROVE SAFE PENDING =="
bash /opt/email/scripts/approve_safe_queue.sh || true

echo "== 6) BLOCK UNSAFE LEFTOVERS =="
DB "
UPDATE manual_outreach_queue
SET status='skipped',
    safety_status='blocked',
    approved_at=NULL,
    send_attempts=0,
    last_send_error='Blocked by launcher_safe_approve: unsafe pending draft'
WHERE tenant_id=1
  AND status='pending_review'
  AND (
    COALESCE(draft_subject,'') = ''
    OR COALESCE(draft_body,'') = ''
    OR COALESCE(draft_subject,'') LIKE '%{{%'
    OR COALESCE(draft_subject,'') LIKE '%}}%'
    OR COALESCE(draft_body,'') LIKE '%{{%'
    OR COALESCE(draft_body,'') LIKE '%}}%'
    OR COALESCE(draft_subject,'') LIKE '%{|%'
    OR COALESCE(draft_subject,'') LIKE '%|}%'
    OR COALESCE(draft_body,'') LIKE '%{|%'
    OR COALESCE(draft_body,'') LIKE '%|}%'
    OR COALESCE(draft_body,'') LIKE '%unsubscribe here:%'
  );
"

echo "== 7) REPLACE launch_clients_help.sh WITH SAFE VERSION =="
cat > /opt/email/scripts/launch_clients_help.sh <<'LAUNCH'
#!/usr/bin/env bash
set -euo pipefail

cd /opt/email || exit 1

API="https://emails.cheap/api/manual-outreach"
TENANT="${TENANT_ID:-1}"
MAX="${MAX_LEADS:-50}"
TEMPLATE="${TEMPLATE_KEY:-clients_help_chat}"
SEND_MODE="${1:-}"

PW="$(grep -E '^DB_PASSWORD=' .env | head -1 | cut -d= -f2-)"
AUTH_TOKEN="$(grep -E '^API_ADMIN_TOKEN=' .env | head -1 | cut -d= -f2- || true)"

DB() {
  docker exec email_db mariadb -uemail_app -p"$PW" email_platform -N -B -e "$1"
}

H=(-H "content-type: application/json" -H "x-tenant-id: $TENANT")
if [ -n "$AUTH_TOKEN" ]; then
  H+=(-H "authorization: Bearer $AUTH_TOKEN")
fi

echo "== 0) KEEP DRIP PAUSED/OFF WHILE BUILDING =="
DB "
UPDATE tenant_safety_settings
SET outreach_paused=1,
    outreach_paused_reason='Paused while launcher builds/reviews queue'
WHERE tenant_id=$TENANT;

UPDATE outreach_drip_settings
SET enabled=0
WHERE tenant_id=$TENANT;
"

echo "== 1) BUILD COHORT =="
curl -s "${H[@]}" -X POST "$API/cohort/build" \
  -d "{\"max\":$MAX,\"templateKey\":\"$TEMPLATE\"}"
echo

echo "== 2) MARK SAFE PENDING + APPROVE ONLY SAFE ITEMS =="
DB "
UPDATE manual_outreach_queue
SET safety_status='ok',
    last_send_error=NULL
WHERE tenant_id=$TENANT
  AND status='pending_review'
  AND COALESCE(draft_subject,'') <> ''
  AND COALESCE(draft_body,'') <> ''
  AND COALESCE(draft_subject,'') NOT LIKE '%{{%'
  AND COALESCE(draft_subject,'') NOT LIKE '%}}%'
  AND COALESCE(draft_body,'') NOT LIKE '%{{%'
  AND COALESCE(draft_body,'') NOT LIKE '%}}%'
  AND COALESCE(draft_subject,'') NOT LIKE '%{|%'
  AND COALESCE(draft_subject,'') NOT LIKE '%|}%'
  AND COALESCE(draft_body,'') NOT LIKE '%{|%'
  AND COALESCE(draft_body,'') NOT LIKE '%|}%'
  AND COALESCE(draft_body,'') NOT LIKE '%unsubscribe here:%';

UPDATE manual_outreach_queue
SET status='approved',
    approved_at=UTC_TIMESTAMP(),
    last_send_error=NULL
WHERE tenant_id=$TENANT
  AND status='pending_review'
  AND safety_status='ok'
  AND COALESCE(draft_subject,'') <> ''
  AND COALESCE(draft_body,'') <> ''
  AND COALESCE(draft_subject,'') NOT LIKE '%{{%'
  AND COALESCE(draft_subject,'') NOT LIKE '%}}%'
  AND COALESCE(draft_body,'') NOT LIKE '%{{%'
  AND COALESCE(draft_body,'') NOT LIKE '%}}%'
  AND COALESCE(draft_subject,'') NOT LIKE '%{|%'
  AND COALESCE(draft_subject,'') NOT LIKE '%|}%'
  AND COALESCE(draft_body,'') NOT LIKE '%{|%'
  AND COALESCE(draft_body,'') NOT LIKE '%|}%'
  AND COALESCE(draft_body,'') NOT LIKE '%unsubscribe here:%';
"

APPROVED="$(DB "SELECT COUNT(*) FROM manual_outreach_queue WHERE tenant_id=$TENANT AND status='approved';" | tail -1 | tr -dc '0-9')"
PENDING="$(DB "SELECT COUNT(*) FROM manual_outreach_queue WHERE tenant_id=$TENANT AND status='pending_review';" | tail -1 | tr -dc '0-9')"

echo "approved_total=$APPROVED"
echo "pending_review=$PENDING"

echo "== 3) SAFETY SCAN =="
bash /opt/email/scripts/queue_safety_repair.sh || true

if [ "${APPROVED:-0}" -le 0 ]; then
  echo "ERROR: approved_total=0. Drip will NOT be enabled."
  DB "
  UPDATE outreach_drip_settings SET enabled=0 WHERE tenant_id=$TENANT;
  UPDATE tenant_safety_settings
  SET outreach_paused=1,
      outreach_paused_reason='Launcher stopped: approved_total=0'
  WHERE tenant_id=$TENANT;
  "
  exit 1
fi

if [ "$SEND_MODE" != "--send" ]; then
  echo
  echo "Queue is prepared but drip is still paused/off."
  echo "To send, run explicitly:"
  echo "  bash /opt/email/scripts/launch_clients_help.sh --send"
  echo "or:"
  echo "  bash /opt/email/scripts/sending_resume.sh --yes"
  exit 0
fi

echo "== 4) ENABLE DRIP EXPLICITLY =="
bash /opt/email/scripts/sending_resume.sh --yes
bash /opt/email/scripts/sending_status.sh
LAUNCH

chmod +x /opt/email/scripts/launch_clients_help.sh

echo "== 8) FINAL STATUS =="
bash /opt/email/scripts/sending_status.sh

{
  echo "# Launcher Safe Approve Fix"
  echo
  echo "UTC: $(date -u)"
  echo
  echo "Backup: $BACKUP_DIR"
  echo
  echo "Actions:"
  echo "- Forced drip OFF and kill-switch PAUSED."
  echo "- Marked safe pending_review items as safety_status=ok."
  echo "- Approved only safe pending_review items."
  echo "- Replaced launch_clients_help.sh with safe version."
  echo "- New launcher does NOT enable drip unless called with --send and approved_total > 0."
  echo
  echo "Current queue:"
  echo '```'
  DB "
  SELECT status, safety_status, template_key, COUNT(*) cnt
  FROM manual_outreach_queue
  GROUP BY status, safety_status, template_key
  ORDER BY status, safety_status, cnt DESC;
  "
  echo '```'
  echo
  echo "Current sending status:"
  echo '```'
  bash /opt/email/scripts/sending_status.sh
  echo '```'
} > "$REPORT"

echo
echo "DONE"
echo "Report: $REPORT"
