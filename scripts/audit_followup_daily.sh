#!/usr/bin/env bash
# Daily audit follow-up (touch 2): regenerate the queue, then send a capped batch of
# second-touch nudges to past audit contacts who have NOT explicitly refused. Drains the
# backlog of non-responders at a safe pace. Mirrors audit_daily_send.sh.
#
# Safety is enforced inside audit_followup_send.mjs: audit-mailbox scope, first_touch
# 3–21 days old, not-yet-followed, not explicitly-refused/engaged, suppression + Postal
# list checks, hard daily cap. Idempotent — touch_type='followup_1' prevents re-nagging.
set -euo pipefail

CAP="${AUDIT_FOLLOWUP_CAP:-25}"
PA=/opt/prospect-audit
EM=/opt/email
QUEUE_HOST="$PA/exports/audit_queue.json"

cd "$PA"
PA_CID=$(/usr/bin/docker compose ps -q backend)
/usr/bin/docker cp "$PA/scripts/export_audit_queue.py" "$PA_CID":/app/scripts/export_audit_queue.py
mkdir -p "$PA/exports"
/usr/bin/docker compose exec -T backend python scripts/export_audit_queue.py > "$QUEUE_HOST" 2>/dev/null

cd "$EM"
EM_CID=$(/usr/bin/docker compose ps -q api)
/usr/bin/docker cp "$QUEUE_HOST" "$EM_CID":/app/audit_queue.json
/usr/bin/docker cp "$EM/scripts/audit_followup_send.mjs" "$EM_CID":/app/audit_followup_send.mjs
/usr/bin/docker compose exec -T api node /app/audit_followup_send.mjs --file /app/audit_queue.json --cap "$CAP" --send
