#!/usr/bin/env bash
set -euo pipefail

cd /opt/email || exit 1
PW="$(grep -E '^DB_PASSWORD=' .env | head -1 | cut -d= -f2-)"

DB() {
  docker exec email_db mariadb -uemail_app -p"$PW" email_platform -e "$1"
}

UNSAFE_CONDITION="
tenant_id=1
AND status IN ('approved','pending_review')
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
)
"

echo "== Queue safety scan =="
DB "
SELECT status, safety_status, template_key, COUNT(*) AS cnt
FROM manual_outreach_queue
WHERE $UNSAFE_CONDITION
GROUP BY status, safety_status, template_key
ORDER BY status, cnt DESC;
"

DB "
SELECT id, mailbox_id, email, company_name, template_key, draft_subject,
       LEFT(draft_body, 500) AS draft_preview,
       status, safety_status, last_send_error
FROM manual_outreach_queue
WHERE $UNSAFE_CONDITION
ORDER BY id ASC
LIMIT 50;
"

if [[ "${1:-}" == "--apply" ]]; then
  echo "== Applying repair: pause drip + skip unsafe open queue items =="
  DB "
  UPDATE tenant_safety_settings
  SET outreach_paused=1,
      outreach_paused_reason='Paused by queue_safety_repair'
  WHERE tenant_id=1;

  UPDATE outreach_drip_settings
  SET enabled=0
  WHERE tenant_id=1;

  UPDATE manual_outreach_queue
  SET status='skipped',
      safety_status='blocked',
      approved_at=NULL,
      send_attempts=0,
      last_send_error='Blocked by queue_safety_repair: unresolved placeholder or bad unsubscribe text'
  WHERE $UNSAFE_CONDITION;
  "

  echo "== After repair =="
  DB "
  SELECT status, safety_status, template_key, COUNT(*) AS cnt
  FROM manual_outreach_queue
  GROUP BY status, safety_status, template_key
  ORDER BY status, safety_status, cnt DESC;
  "
else
  echo
  echo "Dry run only. To apply:"
  echo "  bash /opt/email/scripts/queue_safety_repair.sh --apply"
fi
