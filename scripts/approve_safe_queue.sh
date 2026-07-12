#!/usr/bin/env bash
set -euo pipefail

cd /opt/email || exit 1
PW="$(grep -E '^DB_PASSWORD=' .env | head -1 | cut -d= -f2-)"

DB() {
  docker exec email_db mariadb -uemail_app -p"$PW" email_platform -e "$1"
}

echo "== Approve only safe pending_review queue items =="

DB "
UPDATE manual_outreach_queue
SET status='approved',
    approved_at=UTC_TIMESTAMP(),
    last_send_error=NULL
WHERE tenant_id=1
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

SELECT status, safety_status, template_key, COUNT(*) AS cnt
FROM manual_outreach_queue
GROUP BY status, safety_status, template_key
ORDER BY status, safety_status, cnt DESC;
"
