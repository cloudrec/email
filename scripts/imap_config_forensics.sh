#!/usr/bin/env bash
set -u
cd /opt/email || exit 1

TS="$(date -u +%Y%m%d_%H%M%S)"
OUT="/opt/email/reports/imap_config_forensics_${TS}.txt"

{
  echo "=== inboundMailboxes function ==="
  grep -nE "function inboundMailboxes|async function inboundMailboxes|const inboundMailboxes|inboundMailboxes" \
    /opt/email/api/src/routes/manualOutreach.ts -C 35 || true

  echo
  echo "=== mailboxConn function ==="
  grep -nE "function mailboxConn|async function mailboxConn|const mailboxConn|mailboxConn" \
    /opt/email/api/src/routes/manualOutreach.ts -C 45 || true

  echo
  echo "=== resolveProvider / imapConfigured logic ==="
  grep -nE "imapConfigured|imapHost|imapPort|imapUser|imapPass|imap.*Configured|resolveProvider|MailboxConn" \
    /opt/email/api/src/services/mailboxRuntime.ts -C 25 || true

  echo
  echo "=== sender_identities columns ==="
  docker exec email_db sh -lc '
  mariadb -u"$MARIADB_USER" -p"$MARIADB_PASSWORD" "$MARIADB_DATABASE" -e "
  SELECT COLUMN_NAME
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE()
    AND TABLE_NAME=\"sender_identities\"
  ORDER BY ORDINAL_POSITION;
  "
  '

  echo
  echo "=== sending_providers columns ==="
  docker exec email_db sh -lc '
  mariadb -u"$MARIADB_USER" -p"$MARIADB_PASSWORD" "$MARIADB_DATABASE" -e "
  SELECT COLUMN_NAME
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE()
    AND TABLE_NAME=\"sending_providers\"
  ORDER BY ORDINAL_POSITION;
  "
  '

  echo
  echo "=== active mailbox provider mapping, no secrets ==="
  docker exec email_db sh -lc '
  mariadb -u"$MARIADB_USER" -p"$MARIADB_PASSWORD" "$MARIADB_DATABASE" -e "
  SELECT
    si.id,
    si.from_email,
    si.provider_id,
    sp.name AS provider_name,
    sp.provider_type,
    si.status,
    si.outbound_enabled,
    si.inbound_enabled,
    si.imap_enabled,
    si.last_imap_test_at,
    si.imap_last_checked_at,
    si.last_error
  FROM sender_identities si
  LEFT JOIN sending_providers sp ON sp.id=si.provider_id
  WHERE si.tenant_id=1
    AND si.status=\"active\"
  ORDER BY si.id;
  "
  '

  echo
  echo "=== provider rows, env/ref columns only, no secret values ==="
  docker exec email_db sh -lc '
  mariadb -u"$MARIADB_USER" -p"$MARIADB_PASSWORD" "$MARIADB_DATABASE" -e "
  SELECT *
  FROM sending_providers
  WHERE tenant_id=1
  ORDER BY id;
  "
  ' | sed -E 's/([Pp]ass[^[:space:]]*[[:space:]]+)[^[:space:]]+/\1***REDACTED***/g; s/([Ss]ecret[^[:space:]]*[[:space:]]+)[^[:space:]]+/\1***REDACTED***/g; s/([Tt]oken[^[:space:]]*[[:space:]]+)[^[:space:]]+/\1***REDACTED***/g'

  echo
  echo "=== env names related to mail, smtp, imap, postal, zoho, space, no values ==="
  docker exec email_api sh -lc '
  node -e "console.log(Object.keys(process.env).filter(k => /(imap|smtp|postal|zoho|space|mail|jwt)/i.test(k)).sort().join(\"\\n\"))"
  '

} > "$OUT" 2>&1

echo "saved: $OUT"
cat "$OUT"
