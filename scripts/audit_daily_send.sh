#!/usr/bin/env bash
# Daily audit-outreach send: regenerate the queue from prospect-audit, then send a
# capped batch (worst-scoring sites first) through Postal with all safety rails.
#
# Mirrors the warmup cron pattern: copies the current script into each container at
# run time, so a code edit takes effect on the next run without rebuilding images.
#
# Safety is enforced inside audit_outreach_send.mjs (suppression incl. Postal's own
# list, per-domain dedup via touchpoints, wrong-target filter, hard daily cap). This
# wrapper only wires the two containers together.
set -euo pipefail

CAP="${AUDIT_DAILY_CAP:-25}"
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
/usr/bin/docker cp "$EM/scripts/audit_outreach_send.mjs" "$EM_CID":/app/audit_outreach_send.mjs
/usr/bin/docker compose exec -T api node /app/audit_outreach_send.mjs --file /app/audit_queue.json --cap "$CAP" --send
