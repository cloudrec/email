#!/usr/bin/env bash
set -u
cd /opt/email || exit 1

TS="$(date -u +%Y%m%d_%H%M%S)"
OUT="/opt/email/reports/outreach_forensics_fixed_${TS}"
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

echo "Creating fixed outreach forensics report: $OUT"

Q "01_drip_settings" "
SELECT *
FROM outreach_drip_settings
WHERE tenant_id=1;
"

Q "02_queue_status_counts" "
SELECT
  status,
  template_key,
  safety_status,
  COUNT(*) cnt,
  MIN(created_at) first_created,
  MAX(created_at) last_created,
  MIN(sent_at) first_sent,
  MAX(sent_at) last_sent
FROM manual_outreach_queue
WHERE tenant_id=1
GROUP BY status, template_key, safety_status
ORDER BY status, cnt DESC;
"

Q "03_sent_by_day_template" "
SELECT
  DATE(sent_at) day,
  template_key,
  COUNT(*) sent
FROM manual_outreach_queue
WHERE tenant_id=1
  AND status IN ('sent_smtp','sent_manual')
GROUP BY DATE(sent_at), template_key
ORDER BY day DESC, sent DESC;
"

Q "04_last_200_sent_texts" "
SELECT
  q.id,
  q.sent_at,
  q.mailbox_id,
  si.from_email,
  q.template_key,
  q.company_name,
  q.website,
  q.email,
  q.source_url,
  q.draft_subject,
  REPLACE(REPLACE(q.draft_body, CHAR(13), ' '), CHAR(10), ' | ') AS draft_body_one_line
FROM manual_outreach_queue q
LEFT JOIN sender_identities si ON si.id=q.mailbox_id
WHERE q.tenant_id=1
  AND q.status IN ('sent_smtp','sent_manual')
ORDER BY q.sent_at DESC
LIMIT 200;
"

Q "05_next_approved_to_send" "
SELECT
  q.id,
  q.created_at,
  q.approved_at,
  q.send_attempts,
  q.last_send_error,
  q.mailbox_id,
  si.from_email,
  q.template_key,
  q.company_name,
  q.website,
  q.email,
  q.source_url,
  q.draft_subject,
  REPLACE(REPLACE(q.draft_body, CHAR(13), ' '), CHAR(10), ' | ') AS draft_body_one_line
FROM manual_outreach_queue q
LEFT JOIN sender_identities si ON si.id=q.mailbox_id
WHERE q.tenant_id=1
  AND q.status='approved'
ORDER BY q.approved_at ASC, q.id ASC
LIMIT 200;
"

Q "06_templates_all" "
SELECT
  id,
  template_key,
  name,
  angle,
  category,
  language,
  status,
  approved,
  approved_at,
  updated_at,
  subject,
  REPLACE(REPLACE(body, CHAR(13), ' '), CHAR(10), ' | ') AS body_one_line
FROM manual_outreach_templates
WHERE tenant_id=1
ORDER BY approved DESC, updated_at DESC, id ASC;
"

Q "07_templates_auto_refill_candidates" "
SELECT
  id,
  template_key,
  name,
  status,
  approved,
  approved_at,
  subject,
  REPLACE(REPLACE(body, CHAR(13), ' '), CHAR(10), ' | ') AS body_one_line
FROM manual_outreach_templates
WHERE tenant_id=1
  AND template_key LIKE 'clients_help_chat%'
ORDER BY id ASC;
"

Q "08_bad_company_names" "
SELECT
  company_name,
  template_key,
  COUNT(*) cnt,
  MAX(sent_at) last_sent
FROM manual_outreach_queue
WHERE tenant_id=1
  AND status IN ('sent_smtp','sent_manual')
  AND (
    company_name IS NULL
    OR company_name=''
    OR LOWER(company_name)='your business'
    OR draft_subject LIKE '%your business%'
    OR draft_subject LIKE '%the your business%'
    OR draft_body LIKE '%your business%'
  )
GROUP BY company_name, template_key
ORDER BY cnt DESC
LIMIT 200;
"

Q "09_sent_target_domains" "
SELECT
  LOWER(SUBSTRING_INDEX(email,'@',-1)) AS email_domain,
  COUNT(*) sent,
  MAX(sent_at) last_sent
FROM manual_outreach_queue
WHERE tenant_id=1
  AND status IN ('sent_smtp','sent_manual')
GROUP BY email_domain
ORDER BY sent DESC
LIMIT 300;
"

Q "10_replies_summary" "
SELECT
  classification,
  COUNT(*) cnt,
  MIN(received_at) first_received,
  MAX(received_at) last_received
FROM inbox_replies
WHERE tenant_id=1
GROUP BY classification
ORDER BY cnt DESC;
"

Q "11_last_100_replies" "
SELECT
  id,
  mailbox_id,
  from_email,
  from_name,
  subject,
  REPLACE(REPLACE(body_snippet, CHAR(13), ' '), CHAR(10), ' | ') AS body_snippet_one_line,
  received_at,
  classification,
  confidence,
  queue_item_id,
  company_id,
  contact_point_id,
  handled
FROM inbox_replies
WHERE tenant_id=1
ORDER BY received_at DESC
LIMIT 100;
"

Q "12_sender_identity_metrics" "
SELECT
  id,
  from_email,
  purpose,
  status,
  daily_send_limit,
  hourly_send_limit,
  sent_today,
  smtp_sent_today,
  replies_today,
  interested_today,
  negative_today,
  bounce_like_today,
  complaints_today,
  unsubscribes_today,
  last_sent_at,
  last_reply_at,
  last_error,
  health_status
FROM sender_identities
WHERE tenant_id=1
ORDER BY status, from_email;
"

Q "13_touchpoints_last_300" "
SELECT
  id,
  queue_item_id,
  mailbox_id,
  email,
  subject,
  status,
  sent_at,
  replied_at,
  created_at
FROM outreach_touchpoints
WHERE tenant_id=1
ORDER BY created_at DESC
LIMIT 300;
"

Q "14_stuck_items_full" "
SELECT
  q.id,
  q.mailbox_id,
  si.from_email,
  q.email,
  q.company_name,
  q.website,
  q.template_key,
  q.status,
  q.send_attempts,
  q.last_send_error,
  q.draft_subject,
  REPLACE(REPLACE(q.draft_body, CHAR(13), ' '), CHAR(10), ' | ') AS draft_body_one_line,
  q.created_at,
  q.updated_at
FROM manual_outreach_queue q
LEFT JOIN sender_identities si ON si.id=q.mailbox_id
WHERE q.tenant_id=1
  AND q.status='approved'
  AND q.send_attempts>=5
ORDER BY q.updated_at DESC;
"

Q "15_invalid_or_suspicious_emails" "
SELECT
  id,
  email,
  company_name,
  website,
  template_key,
  status,
  draft_subject,
  created_at,
  sent_at
FROM manual_outreach_queue
WHERE tenant_id=1
  AND (
    email LIKE '% %'
    OR email LIKE '%%%20%'
    OR email LIKE '%@gmail.com'
    OR email LIKE '%@pec.it'
    OR email LIKE '%@mypec.eu'
    OR email LIKE '%@unige.it'
    OR email LIKE '%@unibo.it'
    OR email LIKE '%@bbva.com'
    OR email LIKE '%@aveva.com'
  )
ORDER BY COALESCE(sent_at, created_at) DESC
LIMIT 300;
"

cat > "$OUT/README.txt" <<EOF
Fixed outreach forensics report created at $TS UTC.

Read first:
- 04_last_200_sent_texts.tsv
- 05_next_approved_to_send.tsv
- 06_templates_all.tsv
- 07_templates_auto_refill_candidates.tsv
- 08_bad_company_names.tsv
- 10_replies_summary.tsv
- 11_last_100_replies.tsv
- 15_invalid_or_suspicious_emails.tsv
EOF

ARCHIVE="/opt/email/reports/outreach_forensics_fixed_${TS}.tar.gz"
tar -czf "$ARCHIVE" -C "/opt/email/reports" "outreach_forensics_fixed_${TS}"

echo
echo "READY"
echo "Folder:  $OUT"
echo "Archive: $ARCHIVE"
