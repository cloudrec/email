#!/usr/bin/env bash
set -u
cd /opt/email || exit 1

OUT="/opt/email/reports/reply_import_route_debug_$(date -u +%Y%m%d_%H%M%S).txt"

{
  echo "=== manualOutreach route snippets ==="
  grep -nE "router\.(get|post|put|patch|delete).*inbox|router\.(get|post|put|patch|delete).*reply|inbox.import|rtFetchReplies|imap_last_checked|inbox_replies" \
    /opt/email/api/src/routes/manualOutreach.ts -C 8 || true

  echo
  echo "=== mailboxes route snippets ==="
  grep -nE "router\.(get|post|put|patch|delete).*imap|router\.(get|post|put|patch|delete).*test|rtTestImap|testImap|mailboxRuntime" \
    /opt/email/api/src/routes/mailboxes.ts -C 8 || true

  echo
  echo "=== all route imports refs ==="
  grep -RInE "rtFetchReplies|inbox.import|imap_last_checked|INSERT INTO inbox_replies|testImap|rtTestImap" \
    /opt/email/api/src/routes /opt/email/api/src/services \
    --exclude-dir=node_modules || true

  echo
  echo "=== compose services ==="
  docker compose ps
} > "$OUT" 2>&1

echo "saved: $OUT"
cat "$OUT"
