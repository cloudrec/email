#!/usr/bin/env bash
set -euo pipefail

echo "==============================="
echo " Reply Import Status Dashboard"
echo "==============================="
echo

DB() {
  docker exec -i email_db mariadb -u"$MARIADB_USER" -p"$MARIADB_PASSWORD" "$MARIADB_DATABASE" --batch --raw 2>/dev/null <<< "$1" || \
  docker exec -i email_db mariadb -u"email_app" -p"wmhZyOGaZOQpTXjSBcFeUPgO5A9ShJG0MkcBQuQT" "email_platform" --batch --raw 2>/dev/null <<< "$1"
}

echo "--- Enabled Inbound Mailboxes ---"
DB "
SELECT id, from_email, status, imap_enabled, imap_last_uid,
       imap_last_checked_at, last_imap_test_at, last_error
FROM sender_identities
WHERE tenant_id=1 AND inbound_enabled=1 AND imap_enabled=1
ORDER BY from_email;
" 2>/dev/null | column -t -s $'\t' 2>/dev/null || true
echo

echo "--- Replies by Classification ---"
DB "
SELECT classification, COUNT(*) AS count
FROM inbox_replies WHERE tenant_id=1
GROUP BY classification
ORDER BY count DESC;
" 2>/dev/null | column -t -s $'\t' 2>/dev/null || true
echo

echo "--- Suppressions by Reason ---"
DB "
SELECT reason, COUNT(*) AS count
FROM suppressions WHERE tenant_id=1
GROUP BY reason
ORDER BY count DESC;
" 2>/dev/null | column -t -s $'\t' 2>/dev/null || true
echo

echo "--- Latest 20 Replies ---"
DB "
SELECT id, from_email, subject, classification, confidence,
       contact_point_id, queue_item_id, failed_recipient,
       bounce_category, bounce_confidence, received_at
FROM inbox_replies WHERE tenant_id=1
ORDER BY id DESC LIMIT 20;
" 2>/dev/null | column -t -s $'\t' 2>/dev/null || true
echo

echo "--- Bounce-like Replies Missing Failed-Recipient Link ---"
DB "
SELECT id, from_email, subject, mailbox_id, body_snippet IS NULL AS no_body,
       contact_point_id, queue_item_id, failed_recipient
FROM inbox_replies
WHERE tenant_id=1 AND classification='bounce_like'
  AND (failed_recipient IS NULL OR queue_item_id IS NULL)
ORDER BY id DESC;
" 2>/dev/null | column -t -s $'\t' 2>/dev/null || true
echo

echo "--- Timer Status ---"
if systemctl is-enabled email-reply-import.timer &>/dev/null; then
  systemctl status email-reply-import.timer --no-pager 2>&1 | head -10
else
  echo "Timer not installed/enabled."
fi
echo

echo "--- Drip Status (must remain OFF) ---"
DB "
SELECT enabled, enabled_at, last_tick_at, sent_total,
       daily_per_mailbox, hourly_per_mailbox, min_interval_min
FROM outreach_drip_settings WHERE tenant_id=1;
" 2>/dev/null | column -t -s $'\t' 2>/dev/null || true
echo

echo "Done."
