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


echo "== 1.5) REPAIR SENDER PLACEHOLDERS =="
bash /opt/email/scripts/repair_sender_placeholders_in_queue.sh

# SENDER_NAME_REPAIR_AFTER_BUILD_20260628

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
