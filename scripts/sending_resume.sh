#!/usr/bin/env bash
# sending_resume.sh — resume the email drip sender.
#
# The drip engine (workers/src/manualOutreachDrip.ts) is now self-healing:
#   - vets each mailbox's SMTP creds and auto-pauses any that can't send;
#   - rescues items orphaned on a dead/paused mailbox onto a healthy one;
#   - trips a circuit breaker (auto-pause + reassign) on a mailbox that fails
#     repeatedly, so one bad mailbox can never stall the whole base.
# So resuming is just: clear the pause flags and arm the drip. The engine does
# the rest on its next tick (every 60s).
#
# Sends are REAL. Run deliberately.
# Usage:  bash /opt/email/scripts/sending_resume.sh         (asks to confirm)
#         bash /opt/email/scripts/sending_resume.sh --yes   (no prompt)
set -euo pipefail
cd "$(dirname "$0")/.."

PW=$(grep -E '^DB_PASSWORD=' .env | head -1 | cut -d= -f2-)
DB() { docker exec email_db mariadb -uemail_app -p"$PW" email_platform -N -e "$1" 2>/dev/null; }

ACTIVE=$(DB "SELECT COUNT(*) FROM sender_identities WHERE status='active' AND outbound_enabled=1;")
READY=$(DB "SELECT COUNT(*) FROM manual_outreach_queue WHERE status='approved';")
echo "Active outbound mailboxes : ${ACTIVE:-0}"
echo "Approved items ready      : ${READY:-0}"
if [ "${ACTIVE:-0}" = "0" ]; then
  echo "ERROR: no active outbound mailbox. Fix a provider/mailbox first." >&2
  exit 1
fi

if [ "${1:-}" != "--yes" ]; then
  read -r -p "Arm drip + clear kill-switch and start sending? [y/N] " a
  [ "$a" = "y" ] || [ "$a" = "Y" ] || { echo "aborted"; exit 0; }
fi

DB "UPDATE tenant_safety_settings SET outreach_paused=0 WHERE tenant_id=1;"
DB "UPDATE outreach_drip_settings SET enabled=1 WHERE tenant_id=1;"
echo "Done. Drip ARMED, kill-switch cleared. Sending starts within ~60s."
echo "Watch it flow:  bash scripts/sending_status.sh"
