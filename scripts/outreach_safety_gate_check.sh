#!/usr/bin/env bash
set -u
cd /opt/email || exit 1

docker exec email_db sh -lc '
mariadb -u"$MARIADB_USER" -p"$MARIADB_PASSWORD" "$MARIADB_DATABASE" -e "
SELECT
  status,
  template_key,
  COUNT(*) AS bad_items
FROM manual_outreach_queue
WHERE tenant_id=1
  AND status IN (\"approved\", \"pending_review\")
  AND (
    company_name IS NULL
    OR company_name = \"\"
    OR LOWER(company_name) = \"your business\"
    OR draft_subject LIKE \"%{{%\"
    OR draft_body LIKE \"%{{%\"
    OR draft_subject LIKE \"%your business%\"
    OR draft_body LIKE \"%your business%\"
    OR draft_subject LIKE \"%the your business%\"
    OR draft_body LIKE \"%the your business%\"
    OR email LIKE \"% %\"
    OR email LIKE \"%%%20%\"
    OR email LIKE \"%@gmail.com\"
    OR email LIKE \"%@pec.it\"
    OR email LIKE \"%@mypec.eu\"
    OR email LIKE \"%@unige.it\"
    OR email LIKE \"%@unibo.it\"
    OR email LIKE \"%@bbva.com\"
    OR email LIKE \"%@aveva.com\"
    OR email LIKE \"training%@%\"
    OR email LIKE \"internship%@%\"
    OR email LIKE \"api.%@%\"
    OR email LIKE \"protocollo%@%\"
  )
GROUP BY status, template_key
ORDER BY bad_items DESC;

SELECT
  id,
  status,
  template_key,
  email,
  company_name,
  website,
  draft_subject,
  LEFT(draft_body, 400) AS body_preview
FROM manual_outreach_queue
WHERE tenant_id=1
  AND status IN (\"approved\", \"pending_review\")
  AND (
    company_name IS NULL
    OR company_name = \"\"
    OR LOWER(company_name) = \"your business\"
    OR draft_subject LIKE \"%{{%\"
    OR draft_body LIKE \"%{{%\"
    OR draft_subject LIKE \"%your business%\"
    OR draft_body LIKE \"%your business%\"
    OR draft_subject LIKE \"%the your business%\"
    OR draft_body LIKE \"%the your business%\"
    OR email LIKE \"% %\"
    OR email LIKE \"%%%20%\"
    OR email LIKE \"%@gmail.com\"
    OR email LIKE \"%@pec.it\"
    OR email LIKE \"%@mypec.eu\"
    OR email LIKE \"%@unige.it\"
    OR email LIKE \"%@unibo.it\"
    OR email LIKE \"%@bbva.com\"
    OR email LIKE \"%@aveva.com\"
    OR email LIKE \"training%@%\"
    OR email LIKE \"internship%@%\"
    OR email LIKE \"api.%@%\"
    OR email LIKE \"protocollo%@%\"
  )
ORDER BY created_at DESC
LIMIT 100;
"
'
