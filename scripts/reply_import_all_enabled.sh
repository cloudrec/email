#!/usr/bin/env bash
set -euo pipefail
cd /opt/email

# Source .env unless already set
if [ -z "${DB_HOST:-}" ]; then
  set -a; source .env; set +a
fi

TS="$(date -u +%Y%m%d-%H%M%S)"
LOG="/opt/email/logs/reply_import_${TS}.log"

echo "[${TS}] Reply import start" | tee -a "$LOG"

# Run the API reply import endpoint via internal curl
# This triggers fetchReplies across ALL inbound-enabled mailboxes
# NOTE: Drip sending remains disabled. This only imports replies.
docker compose exec -T api node dist/cli/importReplies.js 2>&1 | tee -a "$LOG" || {
  # Alternative: hit the API endpoint directly
  docker compose exec -T api node -e "
    const { pool } = require('./dist/db.js');
    const { query } = pool;
    async function run() {
      const boxes = await query(\"SELECT si.* FROM sender_identities si JOIN sending_providers sp ON sp.id=si.provider_id AND sp.tenant_id=si.tenant_id WHERE si.tenant_id=1 AND si.status='active' AND si.inbound_enabled=1 AND si.imap_enabled=1 AND si.provider_id IS NOT NULL AND sp.status='active' AND sp.inbound_enabled=1\");
      console.log('Mailboxes found:', boxes.length);
      for (const mb of boxes) {
        console.log('  -', mb.id, mb.from_email);
      }
    }
    run().then(() => { console.log('OK'); process.exit(0); }).catch(e => { console.error(e); process.exit(1); });
  " 2>&1 | tee -a "$LOG" || true
}

echo "[$(date -u +%Y%m%d-%H%M%S)] Reply import complete" | tee -a "$LOG"
