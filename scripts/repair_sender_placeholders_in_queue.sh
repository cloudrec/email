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
