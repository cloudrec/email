#!/bin/bash
# Daily first-touch for the availability ("hire me") campaign.
#
# All gating lives in the sender (suppression, never-contacted-before, reserved-domain
# gate, opt-out link, dry-run unless --send). This wrapper only ships the files and
# caps volume, same pattern as audit_daily_send.sh / hire_me_followup_daily.sh.
set -euo pipefail

EM=/opt/email
CAP="${HIRE_ME_DAILY_CAP:-30}"

cd "$EM"
EM_CID=$(/usr/bin/docker compose ps -q api)
[ -n "$EM_CID" ] || { echo "api container not running"; exit 1; }

# The sender imports ./lib/mailBody.mjs (plain-text -> HTML alternative) — ship it or
# the import fails and the run sends nothing.
/usr/bin/docker exec "$EM_CID" mkdir -p /app/lib
/usr/bin/docker cp "$EM/scripts/lib/mailBody.mjs" "$EM_CID":/app/lib/mailBody.mjs
/usr/bin/docker cp "$EM/scripts/hire_me_send.mjs" "$EM_CID":/app/hire_me_send.mjs

/usr/bin/docker compose exec -T api node /app/hire_me_send.mjs --limit "$CAP" --send
