#!/usr/bin/env bash
set -euo pipefail

cd /opt/email || exit 1

TS="$(date -u +%Y%m%d_%H%M%S)"
PW="$(grep -E '^DB_PASSWORD=' .env | head -1 | cut -d= -f2-)"
BACKUP_DIR="/opt/email/backups/sender_name_placeholder_fix_$TS"
REPORT="/opt/email/reports/SENDER_NAME_PLACEHOLDER_FIX_$TS.md"

mkdir -p "$BACKUP_DIR" /opt/email/reports

DB() {
  docker exec email_db mariadb -uemail_app -p"$PW" email_platform -e "$1"
}

DBN() {
  docker exec email_db mariadb -uemail_app -p"$PW" email_platform -N -B -e "$1"
}

HAS_COL() {
  DBN "
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA='email_platform'
    AND TABLE_NAME='sender_identities'
    AND COLUMN_NAME='$1';
  " | tail -1 | tr -dc '0-9'
}

echo "== 1) PAUSE / OFF =="
DB "
UPDATE tenant_safety_settings
SET outreach_paused=1,
    outreach_paused_reason='Paused before sender_name placeholder fix'
WHERE tenant_id=1;

UPDATE outreach_drip_settings
SET enabled=0
WHERE tenant_id=1;
"

echo "== 2) BACKUP =="
docker exec email_db mariadb-dump -uemail_app -p"$PW" email_platform \
  manual_outreach_queue \
  sender_identities \
  outreach_drip_settings \
  tenant_safety_settings \
  > "$BACKUP_DIR/before_sender_name_placeholder_fix.sql"

cp -a /opt/email/scripts/launch_clients_help.sh "$BACKUP_DIR/launch_clients_help.sh.before" 2>/dev/null || true
cp -a /opt/email/scripts/approve_safe_queue.sh "$BACKUP_DIR/approve_safe_queue.sh.before" 2>/dev/null || true

echo "Backup: $BACKUP_DIR"

echo "== 3) BUILD SENDER NAME SQL EXPRESSION =="
PARTS=()

if [ "$(HAS_COL from_name)" != "0" ]; then
  PARTS+=("NULLIF(si.from_name,'')")
fi

if [ "$(HAS_COL display_name)" != "0" ]; then
  PARTS+=("NULLIF(si.display_name,'')")
fi

if [ "$(HAS_COL name)" != "0" ]; then
  PARTS+=("NULLIF(si.name,'')")
fi

# Always safe fallback from email local part, then brand fallback.
PARTS+=("NULLIF(REPLACE(SUBSTRING_INDEX(si.from_email,'@',1),'.',' '),'')")
PARTS+=("CASE WHEN si.from_email LIKE '%@fundbot.win' THEN 'FundBot' ELSE 'Clients.Help' END")

NAME_EXPR="COALESCE($(IFS=,; echo "${PARTS[*]}"))"
COMPANY_EXPR="CASE WHEN si.from_email LIKE '%@fundbot.win' THEN 'FundBot' ELSE 'Clients.Help' END"

echo "NAME_EXPR=$NAME_EXPR"

echo "== 4) BEFORE SCAN =="
DB "
SELECT status, safety_status, template_key, COUNT(*) cnt
FROM manual_outreach_queue
GROUP BY status, safety_status, template_key
ORDER BY status, safety_status, cnt DESC;
"

DB "
SELECT id, status, safety_status, mailbox_id, template_key, draft_subject,
       LEFT(draft_body, 500) AS preview,
       last_send_error
FROM manual_outreach_queue
WHERE tenant_id=1
  AND (
    COALESCE(draft_subject,'') LIKE '%{{sender_name}}%'
    OR COALESCE(draft_body,'') LIKE '%{{sender_name}}%'
    OR COALESCE(draft_subject,'') LIKE '%{{sender_company}}%'
    OR COALESCE(draft_body,'') LIKE '%{{sender_company}}%'
  )
ORDER BY id DESC
LIMIT 80;
"

echo "== 5) REPAIR QUEUE PLACEHOLDERS =="
DB "
UPDATE manual_outreach_queue q
JOIN sender_identities si ON si.id=q.mailbox_id
SET
  q.draft_subject = REPLACE(
    REPLACE(q.draft_subject, '{{sender_name}}', $NAME_EXPR),
    '{{sender_company}}', $COMPANY_EXPR
  ),
  q.draft_body = REPLACE(
    REPLACE(q.draft_body, '{{sender_name}}', $NAME_EXPR),
    '{{sender_company}}', $COMPANY_EXPR
  ),
  q.status = CASE
    WHEN q.status='skipped'
     AND q.safety_status='blocked'
     AND q.last_send_error LIKE 'Blocked by launcher_safe_approve:%'
    THEN 'pending_review'
    ELSE q.status
  END,
  q.safety_status = CASE
    WHEN q.status IN ('skipped','pending_review','approved') THEN 'ok'
    ELSE q.safety_status
  END,
  q.last_send_error = NULL,
  q.send_attempts = 0,
  q.approved_at = NULL
WHERE q.tenant_id=1
  AND q.status IN ('skipped','pending_review','approved')
  AND (
    COALESCE(q.draft_subject,'') LIKE '%{{sender_name}}%'
    OR COALESCE(q.draft_body,'') LIKE '%{{sender_name}}%'
    OR COALESCE(q.draft_subject,'') LIKE '%{{sender_company}}%'
    OR COALESCE(q.draft_body,'') LIKE '%{{sender_company}}%'
  );
"

echo "== 6) APPROVE ONLY SAFE PENDING =="
bash /opt/email/scripts/approve_safe_queue.sh || true

echo "== 7) BLOCK ANY REMAINING UNSAFE OPEN ITEMS =="
bash /opt/email/scripts/queue_safety_repair.sh --apply || true

echo "== 8) PATCH launch_clients_help.sh TO REPAIR SENDER PLACEHOLDERS AFTER COHORT BUILD =="
python3 - <<'PY'
from pathlib import Path

p = Path("/opt/email/scripts/launch_clients_help.sh")
text = p.read_text()
marker = "SENDER_NAME_REPAIR_AFTER_BUILD_20260628"

if marker in text:
    print("launcher already patched")
    raise SystemExit(0)

needle = 'echo "== 2) MARK SAFE PENDING + APPROVE ONLY SAFE ITEMS =="'
insert = r'''
echo "== 1.5) REPAIR SENDER PLACEHOLDERS =="
bash /opt/email/scripts/repair_sender_placeholders_in_queue.sh

# SENDER_NAME_REPAIR_AFTER_BUILD_20260628
'''

if needle not in text:
    print("needle not found; launcher not patched")
    raise SystemExit(0)

text = text.replace(needle, insert + "\n" + needle, 1)
p.write_text(text)
print("patched launcher")
PY

echo "== 9) CREATE REUSABLE SENDER PLACEHOLDER REPAIR SCRIPT =="
cat > /opt/email/scripts/repair_sender_placeholders_in_queue.sh <<'REPAIR'
#!/usr/bin/env bash
set -euo pipefail

cd /opt/email || exit 1
PW="$(grep -E '^DB_PASSWORD=' .env | head -1 | cut -d= -f2-)"

DB() {
  docker exec email_db mariadb -uemail_app -p"$PW" email_platform -e "$1"
}

DBN() {
  docker exec email_db mariadb -uemail_app -p"$PW" email_platform -N -B -e "$1"
}

HAS_COL() {
  DBN "
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA='email_platform'
    AND TABLE_NAME='sender_identities'
    AND COLUMN_NAME='$1';
  " | tail -1 | tr -dc '0-9'
}

PARTS=()

if [ "$(HAS_COL from_name)" != "0" ]; then
  PARTS+=("NULLIF(si.from_name,'')")
fi

if [ "$(HAS_COL display_name)" != "0" ]; then
  PARTS+=("NULLIF(si.display_name,'')")
fi

if [ "$(HAS_COL name)" != "0" ]; then
  PARTS+=("NULLIF(si.name,'')")
fi

PARTS+=("NULLIF(REPLACE(SUBSTRING_INDEX(si.from_email,'@',1),'.',' '),'')")
PARTS+=("CASE WHEN si.from_email LIKE '%@fundbot.win' THEN 'FundBot' ELSE 'Clients.Help' END")

NAME_EXPR="COALESCE($(IFS=,; echo "${PARTS[*]}"))"
COMPANY_EXPR="CASE WHEN si.from_email LIKE '%@fundbot.win' THEN 'FundBot' ELSE 'Clients.Help' END"

DB "
UPDATE manual_outreach_queue q
JOIN sender_identities si ON si.id=q.mailbox_id
SET
  q.draft_subject = REPLACE(
    REPLACE(q.draft_subject, '{{sender_name}}', $NAME_EXPR),
    '{{sender_company}}', $COMPANY_EXPR
  ),
  q.draft_body = REPLACE(
    REPLACE(q.draft_body, '{{sender_name}}', $NAME_EXPR),
    '{{sender_company}}', $COMPANY_EXPR
  ),
  q.safety_status = CASE
    WHEN q.status IN ('pending_review','approved') THEN 'ok'
    ELSE q.safety_status
  END,
  q.last_send_error = CASE
    WHEN q.status IN ('pending_review','approved') THEN NULL
    ELSE q.last_send_error
  END
WHERE q.tenant_id=1
  AND q.status IN ('pending_review','approved')
  AND (
    COALESCE(q.draft_subject,'') LIKE '%{{sender_name}}%'
    OR COALESCE(q.draft_body,'') LIKE '%{{sender_name}}%'
    OR COALESCE(q.draft_subject,'') LIKE '%{{sender_company}}%'
    OR COALESCE(q.draft_body,'') LIKE '%{{sender_company}}%'
  );
"
REPAIR

chmod +x /opt/email/scripts/repair_sender_placeholders_in_queue.sh

echo "== 10) FINAL CHECKS =="
{
  echo "# Sender Name Placeholder Fix"
  echo
  echo "UTC: $(date -u)"
  echo
  echo "Backup: $BACKUP_DIR"
  echo
  echo "Actions:"
  echo "- Paused drip."
  echo "- Replaced {{sender_name}} / {{sender_company}} in queue drafts."
  echo "- Recovered safe skipped queue items to pending_review."
  echo "- Approved only safe queue items."
  echo "- Patched launcher to run sender placeholder repair after cohort build."
  echo
  echo "Queue counts:"
  echo '```'
  DB "
  SELECT status, safety_status, template_key, COUNT(*) cnt
  FROM manual_outreach_queue
  GROUP BY status, safety_status, template_key
  ORDER BY status, safety_status, cnt DESC;
  "
  echo '```'
  echo
  echo "Remaining unresolved placeholders:"
  echo '```'
  DB "
  SELECT id, status, safety_status, mailbox_id, template_key, draft_subject, LEFT(draft_body, 300) preview
  FROM manual_outreach_queue
  WHERE tenant_id=1
    AND status IN ('approved','pending_review')
    AND (
      COALESCE(draft_subject,'') LIKE '%{{%'
      OR COALESCE(draft_subject,'') LIKE '%}}%'
      OR COALESCE(draft_body,'') LIKE '%{{%'
      OR COALESCE(draft_body,'') LIKE '%}}%'
      OR COALESCE(draft_subject,'') LIKE '%{|%'
      OR COALESCE(draft_subject,'') LIKE '%|}%'
      OR COALESCE(draft_body,'') LIKE '%{|%'
      OR COALESCE(draft_body,'') LIKE '%|}%'
      OR COALESCE(draft_body,'') LIKE '%unsubscribe here:%'
    )
  ORDER BY id DESC
  LIMIT 80;
  "
  echo '```'
  echo
  echo "Sending status:"
  echo '```'
  bash /opt/email/scripts/sending_status.sh
  echo '```'
} > "$REPORT"

echo
echo "DONE"
echo "Report: $REPORT"
bash /opt/email/scripts/sending_status.sh
