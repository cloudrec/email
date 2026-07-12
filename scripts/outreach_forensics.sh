#!/usr/bin/env bash
set -u
cd /opt/email || exit 1

TS="$(date -u +%Y%m%d_%H%M%S)"
OUT="/opt/email/reports/outreach_forensics_${TS}"
mkdir -p "$OUT"

DB() {
  docker exec email_db sh -lc 'mariadb -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE" --batch --raw' <<< "$1"
}

Q() {
  local name="$1"
  local sql="$2"
  echo "== $name =="
  DB "$sql" > "$OUT/$name.tsv" 2>&1 || true
}

echo "Creating outreach forensics report: $OUT"

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

Q "04_last_100_sent_texts" "
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
  q.draft_body
FROM manual_outreach_queue q
LEFT JOIN sender_identities si ON si.id=q.mailbox_id
WHERE q.tenant_id=1
  AND q.status IN ('sent_smtp','sent_manual')
ORDER BY q.sent_at DESC
LIMIT 100;
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
  q.draft_body
FROM manual_outreach_queue q
LEFT JOIN sender_identities si ON si.id=q.mailbox_id
WHERE q.tenant_id=1
  AND q.status='approved'
ORDER BY q.approved_at ASC, q.id ASC
LIMIT 100;
"

Q "06_pending_review" "
SELECT
  q.id,
  q.created_at,
  q.mailbox_id,
  si.from_email,
  q.template_key,
  q.company_name,
  q.website,
  q.email,
  q.source_url,
  q.draft_subject,
  LEFT(q.draft_body, 1200) AS draft_body_preview,
  q.safety_status,
  q.last_send_error
FROM manual_outreach_queue q
LEFT JOIN sender_identities si ON si.id=q.mailbox_id
WHERE q.tenant_id=1
  AND q.status='pending_review'
ORDER BY q.created_at DESC
LIMIT 100;
"

Q "07_templates_all" "
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
  body
FROM manual_outreach_templates
WHERE tenant_id=1
ORDER BY approved DESC, updated_at DESC, id ASC;
"

Q "08_templates_used_by_auto_refill" "
SELECT
  id,
  template_key,
  name,
  status,
  approved,
  approved_at,
  subject,
  body
FROM manual_outreach_templates
WHERE tenant_id=1
  AND template_key LIKE 'clients_help_chat%'
ORDER BY id ASC;
"

Q "09_bad_company_names" "
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
LIMIT 100;
"

Q "10_sent_target_domains" "
SELECT
  LOWER(SUBSTRING_INDEX(email,'@',-1)) AS email_domain,
  COUNT(*) sent,
  MAX(sent_at) last_sent
FROM manual_outreach_queue
WHERE tenant_id=1
  AND status IN ('sent_smtp','sent_manual')
GROUP BY email_domain
ORDER BY sent DESC
LIMIT 200;
"

Q "11_replies_summary" "
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

Q "12_last_100_replies" "
SELECT
  id,
  mailbox_id,
  from_email,
  from_name,
  subject,
  body_snippet,
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

Q "13_sender_identity_metrics" "
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

Q "14_touchpoints_last_200" "
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
LIMIT 200;
"

Q "15_followup_tasks" "
SELECT
  id,
  queue_item_id,
  mailbox_id,
  email,
  company_name,
  due_at,
  status,
  followup_step,
  subject,
  body,
  blockers_json,
  sent_at,
  created_at
FROM manual_followup_tasks
WHERE tenant_id=1
ORDER BY created_at DESC
LIMIT 100;
"

Q "16_suppression_summary" "
SELECT reason, COUNT(*) cnt, MAX(created_at) last_created
FROM suppressions
WHERE tenant_id=1
GROUP BY reason
ORDER BY cnt DESC;
"

Q "17_stuck_items_full" "
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
  q.draft_body,
  q.created_at,
  q.updated_at
FROM manual_outreach_queue q
LEFT JOIN sender_identities si ON si.id=q.mailbox_id
WHERE q.tenant_id=1
  AND q.status='approved'
  AND q.send_attempts>=5
ORDER BY q.updated_at DESC;
"

# Also create readable markdown summary with the most important files listed.
cat > "$OUT/README.txt" <<EOF
Outreach forensics report created at $TS UTC.

Most important files:
- 04_last_100_sent_texts.tsv
- 05_next_approved_to_send.tsv
- 07_templates_all.tsv
- 08_templates_used_by_auto_refill.tsv
- 09_bad_company_names.tsv
- 11_replies_summary.tsv
- 12_last_100_replies.tsv
- 17_stuck_items_full.tsv
EOF

ARCHIVE="/opt/email/reports/outreach_forensics_${TS}.tar.gz"
tar -czf "$ARCHIVE" -C "/opt/email/reports" "outreach_forensics_${TS}"

echo
echo "READY"
echo "Folder:  $OUT"
echo "Archive: $ARCHIVE"
