#!/usr/bin/env bash
set -u
cd /opt/email || exit 1

TS="$(date -u +%Y%m%d_%H%M%S)"
OUT="/opt/email/reports/reply_import_diagnostics_${TS}"
mkdir -p "$OUT"

DB() {
  docker exec -i email_db sh -lc '
    mariadb -u"$MARIADB_USER" -p"$MARIADB_PASSWORD" "$MARIADB_DATABASE" --batch --raw
  ' <<< "$1"
}

Q() {
  local name="$1"
  local sql="$2"
  echo "== $name =="
  DB "$sql" > "$OUT/$name.tsv" 2>&1 || true
}

echo "Creating reply import diagnostics: $OUT"

Q "01_sender_inbound_flags" "
SELECT
  id,
  from_email,
  from_name,
  purpose,
  status,
  outbound_enabled,
  inbound_enabled,
  imap_enabled,
  imap_last_uid,
  imap_start_at,
  imap_last_checked_at,
  last_imap_test_at,
  last_reply_at,
  replies_today,
  interested_today,
  negative_today,
  bounce_like_today,
  complaints_today,
  unsubscribes_today,
  last_error,
  health_status
FROM sender_identities
WHERE tenant_id=1
ORDER BY status, from_email;
"

Q "02_active_mailboxes_inbound_only" "
SELECT
  id,
  from_email,
  status,
  outbound_enabled,
  inbound_enabled,
  imap_enabled,
  imap_last_checked_at,
  last_imap_test_at,
  last_reply_at,
  last_error
FROM sender_identities
WHERE tenant_id=1
  AND status='active'
ORDER BY from_email;
"

Q "03_reply_tables_count" "
SELECT COUNT(*) AS inbox_replies_total
FROM inbox_replies
WHERE tenant_id=1;

SELECT COUNT(*) AS touchpoints_with_replied_at
FROM outreach_touchpoints
WHERE tenant_id=1
  AND replied_at IS NOT NULL;
"

Q "04_mailboxes_with_sent_no_inbound" "
SELECT
  si.id,
  si.from_email,
  si.status,
  si.inbound_enabled,
  si.imap_enabled,
  si.last_imap_test_at,
  si.imap_last_checked_at,
  si.last_reply_at,
  COUNT(ot.id) AS sent_touchpoints
FROM sender_identities si
LEFT JOIN outreach_touchpoints ot
  ON ot.mailbox_id=si.id
 AND ot.tenant_id=si.tenant_id
WHERE si.tenant_id=1
GROUP BY
  si.id,
  si.from_email,
  si.status,
  si.inbound_enabled,
  si.imap_enabled,
  si.last_imap_test_at,
  si.imap_last_checked_at,
  si.last_reply_at
ORDER BY sent_touchpoints DESC;
"

Q "05_recent_smtp_senders" "
SELECT
  q.mailbox_id,
  si.from_email,
  COUNT(*) sent,
  MAX(q.sent_at) last_sent
FROM manual_outreach_queue q
LEFT JOIN sender_identities si ON si.id=q.mailbox_id
WHERE q.tenant_id=1
  AND q.status='sent_smtp'
GROUP BY q.mailbox_id, si.from_email
ORDER BY sent DESC;
"

grep -RInE "inbox_replies|imap|reply import|importReplies|sweep|read.*mail|fetch.*mail|last_uid|imap_last" \
  /opt/email/api /opt/email/workers /opt/email/scripts \
  --exclude-dir=node_modules \
  --exclude-dir=dist \
  --exclude-dir=build \
  2>/dev/null \
  > "$OUT/06_code_reply_imap_refs.txt" || true

docker compose logs --tail=800 2>&1 \
  | grep -Ei "imap|reply|inbox|mailbox|EAUTH|ECONNECTION|error|warn" \
  > "$OUT/07_logs_reply_imap_tail.txt" || true

ARCHIVE="/opt/email/reports/reply_import_diagnostics_${TS}.tar.gz"
tar -czf "$ARCHIVE" -C "/opt/email/reports" "reply_import_diagnostics_${TS}"

echo
echo "READY"
echo "Folder:  $OUT"
echo "Archive: $ARCHIVE"
