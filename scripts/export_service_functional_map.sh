#!/usr/bin/env bash
set -euo pipefail

cd /opt/email || exit 1

TS="$(date -u +%Y%m%d_%H%M%S)"
OUT="/opt/email/reports/SERVICE_FUNCTIONAL_MAP_$TS"
mkdir -p "$OUT"

PW="$(grep -E '^DB_PASSWORD=' .env | head -1 | cut -d= -f2-)"

DB() {
  docker exec email_db mariadb -uemail_app -p"$PW" email_platform --batch --raw -e "$1" 2>&1
}

section() {
  echo
  echo "================================================================================"
  echo "$1"
  echo "================================================================================"
}

# 00 overview
{
  section "SERVICE FUNCTIONAL MAP"
  echo "Generated UTC: $(date -u)"
  echo "Path: /opt/email"
  echo
  echo "Goal: read-only export of service structure, routes, DB tables, mailboxes, templates, drip, worker and logs."
} > "$OUT/00_README.md"

# 01 filesystem tree
{
  section "PROJECT TREE"
  find /opt/email \
    -path '/opt/email/node_modules' -prune -o \
    -path '/opt/email/.git' -prune -o \
    -path '/opt/email/dist' -prune -o \
    -path '/opt/email/api/node_modules' -prune -o \
    -path '/opt/email/portal/node_modules' -prune -o \
    -path '/opt/email/workers/node_modules' -prune -o \
    -maxdepth 5 -print | sort
} > "$OUT/01_project_tree.txt"

# 02 safe env names only, no secret values
{
  section "ENV KEYS ONLY - VALUES REDACTED"
  grep -E '^[A-Z0-9_]+=' /opt/email/.env 2>/dev/null \
    | sed -E 's/^([^=]+)=.*/\1=***REDACTED***/' \
    | sort || true
} > "$OUT/02_env_keys_redacted.txt"

# 03 docker state
{
  section "DOCKER PS"
  docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}"
  echo
  section "DOCKER COMPOSE FILES"
  find /opt/email -maxdepth 3 \( -name 'docker-compose*.yml' -o -name 'compose*.yml' -o -name 'Dockerfile*' \) -print | sort
  echo
  section "CONTAINER COMMANDS - NO ENV"
  for c in email_api email_worker email_portal email_db email_redis email_mailhog email_postal_smtp email_postal_web email_postal_worker; do
    echo "--- $c ---"
    docker inspect "$c" --format 'Image={{.Config.Image}} Cmd={{json .Config.Cmd}} Entrypoint={{json .Config.Entrypoint}} WorkingDir={{.Config.WorkingDir}}' 2>/dev/null || true
  done
} > "$OUT/03_docker_runtime.txt"

# 04 package scripts
{
  section "PACKAGE JSON FILES"
  find /opt/email -maxdepth 4 -name package.json -not -path '*/node_modules/*' -print | sort
  echo
  section "PACKAGE SCRIPTS"
  for p in $(find /opt/email -maxdepth 4 -name package.json -not -path '*/node_modules/*' | sort); do
    echo
    echo "--- $p ---"
    node -e "const p=require('$p'); console.log(JSON.stringify({name:p.name,scripts:p.scripts,dependencies:p.dependencies?Object.keys(p.dependencies):[],devDependencies:p.devDependencies?Object.keys(p.devDependencies):[]}, null, 2))" 2>/dev/null || cat "$p"
  done
} > "$OUT/04_package_scripts.txt"

# 05 API routes
{
  section "API ROUTE MOUNTS"
  grep -RniE "app\.use\(|router\.(get|post|put|patch|delete)\(" /opt/email/api/src 2>/dev/null | sort || true

  echo
  section "API ROUTE FILES"
  find /opt/email/api/src -type f \( -name '*.ts' -o -name '*.js' \) \
    | grep -Ei '/routes/|/services/' \
    | sort
} > "$OUT/05_api_routes_and_services.txt"

# 06 worker/drip code
{
  section "WORKER AND DRIP CODE REFERENCES"
  grep -RniE "manualOutreachDrip|drip|sendMail|nodemailer|smtp|manual_outreach_queue|outreach_drip_settings|sender_identities|mailbox" \
    /opt/email/workers /opt/email/api/src /opt/email/scripts 2>/dev/null | sort || true
} > "$OUT/06_worker_drip_references.txt"

# 07 frontend/UI map
{
  section "PORTAL ROUTES / UI REFERENCES"
  grep -RniE "manual-outreach|sender-studio|mailboxes|go-live|drip|templates|queue|reply|warmup|route|path:" \
    /opt/email/portal /opt/email/frontend /opt/email/app 2>/dev/null \
    --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.next | sort || true
} > "$OUT/07_portal_ui_map.txt"

# 08 DB schema
{
  section "DATABASE TABLES"
  DB "SHOW TABLES;"

  echo
  section "IMPORTANT TABLE COLUMNS"
  for t in \
    sender_identities \
    sending_providers \
    manual_outreach_queue \
    manual_outreach_templates \
    manual_outreach_template_versions \
    outreach_drip_settings \
    tenant_safety_settings \
    mailbox_secrets \
    inbox_replies \
    outreach_touchpoints \
    domains
  do
    echo
    echo "--- $t ---"
    DB "SHOW COLUMNS FROM $t;" || true
  done
} > "$OUT/08_database_schema.txt"

# 09 current state
{
  section "DRIP SETTINGS"
  DB "
SELECT 
  d.*,
  s.outreach_paused,
  s.outreach_paused_reason
FROM outreach_drip_settings d
LEFT JOIN tenant_safety_settings s ON s.tenant_id=d.tenant_id
WHERE d.tenant_id=1;
"

  echo
  section "MAILBOXES / SENDER IDENTITIES"
  DB "
SELECT 
  id, from_email, status, purpose,
  outbound_enabled, inbound_enabled,
  daily_send_limit, hourly_send_limit,
  sent_today, manual_sent_today, smtp_sent_today,
  last_sent_at, health_status, last_error,
  last_smtp_test_at, provider_id
FROM sender_identities
ORDER BY id;
"

  echo
  section "QUEUE BY STATUS AND MAILBOX"
  DB "
SELECT status, mailbox_id, COUNT(*) cnt
FROM manual_outreach_queue
GROUP BY status, mailbox_id
ORDER BY status, mailbox_id;
"

  echo
  section "STUCK APPROVED ITEMS"
  DB "
SELECT id, mailbox_id, status, send_attempts, last_send_error, created_at, updated_at
FROM manual_outreach_queue
WHERE status='approved' AND send_attempts>=5
ORDER BY send_attempts DESC, id ASC
LIMIT 100;
"
} > "$OUT/09_current_runtime_state.txt"

# 10 templates full export
{
  section "TEMPLATE TABLE STRUCTURE"
  DB "SHOW COLUMNS FROM manual_outreach_templates;"
  echo
  section "TEMPLATE ROWS - FULL"
  DB "SELECT * FROM manual_outreach_templates ORDER BY id;"
  echo
  section "TEMPLATE VERSIONS - RECENT"
  DB "SELECT * FROM manual_outreach_template_versions ORDER BY id DESC LIMIT 100;"
} > "$OUT/10_templates_full_export.txt"

# 11 queue examples
{
  section "APPROVED QUEUE EXAMPLES"
  DB "SELECT * FROM manual_outreach_queue WHERE status='approved' ORDER BY id ASC LIMIT 30;"
  echo
  section "RECENT SENT EXAMPLES"
  DB "SELECT * FROM manual_outreach_queue WHERE status IN ('sent_smtp','sent_manual') ORDER BY sent_at DESC LIMIT 30;"
} > "$OUT/11_queue_examples.txt"

# 12 migrations/docs
{
  section "MIGRATIONS LIST"
  find /opt/email/db/migrations -type f -maxdepth 1 -print | sort 2>/dev/null || true
  echo
  section "MIGRATION CONTENT INDEX"
  grep -RniE "CREATE TABLE|ALTER TABLE|manual_outreach|sender_identities|drip|template|mailbox|provider|smtp" \
    /opt/email/db/migrations 2>/dev/null | sort || true
  echo
  section "DOCS / REPORTS INDEX"
  find /opt/email -maxdepth 4 \( -path '*/docs/*' -o -path '*/reports/*' \) -type f | sort
} > "$OUT/12_migrations_docs_index.txt"

# 13 logs
{
  section "EMAIL WORKER LOGS - LAST 500"
  docker logs email_worker --tail 500 2>&1 || true
  echo
  section "EMAIL API LOGS - LAST 300"
  docker logs email_api --tail 300 2>&1 || true
  echo
  section "EMAIL PORTAL LOGS - LAST 200"
  docker logs email_portal --tail 200 2>&1 || true
} > "$OUT/13_recent_container_logs.txt"

# 14 grep for where texts are edited/sent
{
  section "WHERE TEMPLATES ARE CREATED / UPDATED / APPROVED / SENT"
  grep -RniE "manual_outreach_templates|template_versions|approve|approved|body_html|body_text|subject|Sender Studio|sender-studio|send.*template|renderTemplate|preview" \
    /opt/email/api/src /opt/email/portal /opt/email/workers 2>/dev/null \
    --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.next | sort || true
} > "$OUT/14_template_editing_and_sending_map.txt"

# 15 quick operator summary
{
  section "QUICK OPERATOR COMMANDS"
  cat <<'EOF'
Useful commands:

cd /opt/email
bash scripts/sending_status.sh
bash scripts/sending_resume.sh --yes

docker logs email_worker --since 30m --tail 300
docker logs email_api --since 30m --tail 300

List templates:
PW=$(grep -E '^DB_PASSWORD=' .env | head -1 | cut -d= -f2-)
docker exec email_db mariadb -uemail_app -p"$PW" email_platform -e "SELECT id, template_key, name, category, status, approved FROM manual_outreach_templates ORDER BY id;"

Full template content:
docker exec email_db mariadb -uemail_app -p"$PW" email_platform -e "SELECT * FROM manual_outreach_templates ORDER BY id\G"

Queue by mailbox:
docker exec email_db mariadb -uemail_app -p"$PW" email_platform -e "SELECT status, mailbox_id, COUNT(*) cnt FROM manual_outreach_queue GROUP BY status, mailbox_id ORDER BY status, mailbox_id;"
EOF
} > "$OUT/15_operator_cheatsheet.txt"

# archive
cd /opt/email/reports
tar -czf "SERVICE_FUNCTIONAL_MAP_$TS.tar.gz" "SERVICE_FUNCTIONAL_MAP_$TS"

echo
echo "DONE:"
echo "$OUT"
echo "/opt/email/reports/SERVICE_FUNCTIONAL_MAP_$TS.tar.gz"
