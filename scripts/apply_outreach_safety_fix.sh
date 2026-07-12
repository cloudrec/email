#!/usr/bin/env bash
set -euo pipefail

cd /opt/email || exit 1

TS="$(date -u +%Y%m%d_%H%M%S)"
PW="$(grep -E '^DB_PASSWORD=' .env | head -1 | cut -d= -f2-)"
BACKUP_DIR="/opt/email/backups/outreach_safety_fix_$TS"
REPORT="/opt/email/reports/OUTREACH_SAFETY_FIX_$TS.md"

mkdir -p "$BACKUP_DIR" /opt/email/reports

DB() {
  docker exec email_db mariadb -uemail_app -p"$PW" email_platform -e "$1"
}

echo "== 1) PAUSE OUTREACH =="
DB "
UPDATE tenant_safety_settings
SET outreach_paused=1,
    outreach_paused_reason='Paused by outreach safety fix'
WHERE tenant_id=1;

UPDATE outreach_drip_settings
SET enabled=0
WHERE tenant_id=1;
"

echo "== 2) BACKUP DB TABLES + CODE =="
docker exec email_db mariadb-dump -uemail_app -p"$PW" email_platform \
  manual_outreach_templates \
  manual_outreach_template_versions \
  manual_outreach_queue \
  tenant_safety_settings \
  outreach_drip_settings \
  sender_identities \
  > "$BACKUP_DIR/before_outreach_safety_fix.sql"

tar -czf "$BACKUP_DIR/code_before_outreach_safety_fix.tar.gz" \
  api workers scripts docker-compose.yml 2>/dev/null || true

echo "DB backup: $BACKUP_DIR/before_outreach_safety_fix.sql"
echo "Code backup: $BACKUP_DIR/code_before_outreach_safety_fix.tar.gz"

echo "== 3) FIX TEMPLATE APPROVAL CONSISTENCY + REMOVE BAD UNSUBSCRIBE PLACEHOLDER =="
DB "
UPDATE manual_outreach_templates
SET
  body = TRIM(
    REPLACE(
      REPLACE(
        REPLACE(
          REPLACE(body,
            ' — or unsubscribe here: {{unsubscribe_url}}',
            ''
          ),
          ' — unsubscribe here: {{unsubscribe_url}}',
          ''
        ),
        ' or unsubscribe here: {{unsubscribe_url}}',
        ''
      ),
      'unsubscribe here: {{unsubscribe_url}}',
      ''
    )
  ),
  html_body = CASE
    WHEN html_body IS NULL THEN NULL
    ELSE TRIM(
      REPLACE(
        REPLACE(
          REPLACE(
            REPLACE(html_body,
              ' — or unsubscribe here: {{unsubscribe_url}}',
              ''
            ),
            ' — unsubscribe here: {{unsubscribe_url}}',
            ''
          ),
          ' or unsubscribe here: {{unsubscribe_url}}',
          ''
        ),
        'unsubscribe here: {{unsubscribe_url}}',
        ''
      )
    )
  END,
  safety_status = COALESCE(safety_status, 'safe')
WHERE tenant_id=1
  AND (
    body LIKE '%{{unsubscribe_url}}%'
    OR COALESCE(html_body,'') LIKE '%{{unsubscribe_url}}%'
  );

UPDATE manual_outreach_templates
SET status='approved',
    approved=1,
    approved_at=COALESCE(approved_at, UTC_TIMESTAMP()),
    safety_status=COALESCE(safety_status, 'safe')
WHERE tenant_id=1
  AND approved=1;

UPDATE manual_outreach_templates
SET approved=0,
    approved_at=NULL
WHERE tenant_id=1
  AND status <> 'approved'
  AND approved=0;
"

echo "== 4) CREATE QUEUE SAFETY REPAIR SCRIPT =="
cat > /opt/email/scripts/queue_safety_repair.sh <<'REPAIR'
#!/usr/bin/env bash
set -euo pipefail

cd /opt/email || exit 1
PW="$(grep -E '^DB_PASSWORD=' .env | head -1 | cut -d= -f2-)"

DB() {
  docker exec email_db mariadb -uemail_app -p"$PW" email_platform -e "$1"
}

UNSAFE_CONDITION="
tenant_id=1
AND status IN ('approved','pending_review')
AND (
  COALESCE(draft_subject,'') = ''
  OR COALESCE(draft_body,'') = ''
  OR COALESCE(draft_subject,'') LIKE '%{{%'
  OR COALESCE(draft_subject,'') LIKE '%}}%'
  OR COALESCE(draft_body,'') LIKE '%{{%'
  OR COALESCE(draft_body,'') LIKE '%}}%'
  OR COALESCE(draft_subject,'') LIKE '%{|%'
  OR COALESCE(draft_subject,'') LIKE '%|}%'
  OR COALESCE(draft_body,'') LIKE '%{|%'
  OR COALESCE(draft_body,'') LIKE '%|}%'
  OR COALESCE(draft_body,'') LIKE '%unsubscribe here:%'
)
"

echo "== Queue safety scan =="
DB "
SELECT status, safety_status, template_key, COUNT(*) AS cnt
FROM manual_outreach_queue
WHERE $UNSAFE_CONDITION
GROUP BY status, safety_status, template_key
ORDER BY status, cnt DESC;
"

DB "
SELECT id, mailbox_id, email, company_name, template_key, draft_subject,
       LEFT(draft_body, 500) AS draft_preview,
       status, safety_status, last_send_error
FROM manual_outreach_queue
WHERE $UNSAFE_CONDITION
ORDER BY id ASC
LIMIT 50;
"

if [[ "${1:-}" == "--apply" ]]; then
  echo "== Applying repair: pause drip + skip unsafe open queue items =="
  DB "
  UPDATE tenant_safety_settings
  SET outreach_paused=1,
      outreach_paused_reason='Paused by queue_safety_repair'
  WHERE tenant_id=1;

  UPDATE outreach_drip_settings
  SET enabled=0
  WHERE tenant_id=1;

  UPDATE manual_outreach_queue
  SET status='skipped',
      safety_status='blocked',
      approved_at=NULL,
      send_attempts=0,
      last_send_error='Blocked by queue_safety_repair: unresolved placeholder or bad unsubscribe text'
  WHERE $UNSAFE_CONDITION;
  "

  echo "== After repair =="
  DB "
  SELECT status, safety_status, template_key, COUNT(*) AS cnt
  FROM manual_outreach_queue
  GROUP BY status, safety_status, template_key
  ORDER BY status, safety_status, cnt DESC;
  "
else
  echo
  echo "Dry run only. To apply:"
  echo "  bash /opt/email/scripts/queue_safety_repair.sh --apply"
fi
REPAIR

chmod +x /opt/email/scripts/queue_safety_repair.sh

echo "== 5) CREATE SAFE APPROVE SCRIPT =="
cat > /opt/email/scripts/approve_safe_queue.sh <<'APPROVE'
#!/usr/bin/env bash
set -euo pipefail

cd /opt/email || exit 1
PW="$(grep -E '^DB_PASSWORD=' .env | head -1 | cut -d= -f2-)"

DB() {
  docker exec email_db mariadb -uemail_app -p"$PW" email_platform -e "$1"
}

echo "== Approve only safe pending_review queue items =="

DB "
UPDATE manual_outreach_queue
SET status='approved',
    approved_at=UTC_TIMESTAMP(),
    last_send_error=NULL
WHERE tenant_id=1
  AND status='pending_review'
  AND safety_status='ok'
  AND COALESCE(draft_subject,'') <> ''
  AND COALESCE(draft_body,'') <> ''
  AND COALESCE(draft_subject,'') NOT LIKE '%{{%'
  AND COALESCE(draft_subject,'') NOT LIKE '%}}%'
  AND COALESCE(draft_body,'') NOT LIKE '%{{%'
  AND COALESCE(draft_body,'') NOT LIKE '%}}%'
  AND COALESCE(draft_subject,'') NOT LIKE '%{|%'
  AND COALESCE(draft_subject,'') NOT LIKE '%|}%'
  AND COALESCE(draft_body,'') NOT LIKE '%{|%'
  AND COALESCE(draft_body,'') NOT LIKE '%|}%'
  AND COALESCE(draft_body,'') NOT LIKE '%unsubscribe here:%';

SELECT status, safety_status, template_key, COUNT(*) AS cnt
FROM manual_outreach_queue
GROUP BY status, safety_status, template_key
ORDER BY status, safety_status, cnt DESC;
"
APPROVE

chmod +x /opt/email/scripts/approve_safe_queue.sh

echo "== 6) PATCH WORKER: BLOCK UNSAFE DRAFTS BEFORE SMTP =="
python3 - <<'PY'
from pathlib import Path
import re

p = Path("/opt/email/workers/src/manualOutreachDrip.ts")
if not p.exists():
    raise SystemExit(f"Missing file: {p}")

text = p.read_text()
marker = "OUTREACH_SAFETY_GUARD_20260628"

helper = r'''

// OUTREACH_SAFETY_GUARD_20260628
type DraftSafetyResult = { ok: true } | { ok: false; reason: string };

function hasUnresolvedTemplateSyntax(value: unknown): boolean {
  const s = String(value ?? '');
  return /\{\{[^}]+\}\}/.test(s) || /\{[^{}\n]+\|[^{}\n]+\}/.test(s);
}

function validateOutboundDraftBeforeSmtp(item: any): DraftSafetyResult {
  const subject = String(item?.draft_subject ?? '').trim();
  const body = String(item?.draft_body ?? '').trim();

  if (!subject) return { ok: false, reason: 'missing_subject' };
  if (!body) return { ok: false, reason: 'missing_body' };

  if (hasUnresolvedTemplateSyntax(subject) || hasUnresolvedTemplateSyntax(body)) {
    return { ok: false, reason: 'unresolved_template_placeholder' };
  }

  if (/unsubscribe here\s*:/i.test(body)) {
    return { ok: false, reason: 'bad_unsubscribe_placeholder_or_url_text' };
  }

  if (body.length < 80) {
    return { ok: false, reason: 'body_too_short' };
  }

  return { ok: true };
}

'''

guard = r'''  const draftSafety = validateOutboundDraftBeforeSmtp(item);
  if (!draftSafety.ok) {
    const reason = `blocked:${draftSafety.reason}`;
    await query(
      "UPDATE manual_outreach_queue SET status='pending_review', approved_at=NULL, safety_status='blocked', send_attempts=0, last_send_error=? WHERE id=?",
      [reason, item.id],
    );
    logger.warn({ itemId: item.id, mailboxId: mailbox.id, reason: draftSafety.reason }, 'drip: blocked unsafe draft before SMTP');
    return 'item_blocked' as any;
  }

'''

changed = False

if marker not in text:
    # Insert helper after import block.
    lines = text.splitlines(True)
    idx = 0
    seen_import = False
    for i, line in enumerate(lines):
        if line.startswith("import "):
            seen_import = True
            idx = i + 1
            continue
        if seen_import and not line.startswith("import ") and line.strip() != "":
            break
    lines.insert(idx, helper + "\n")
    text = "".join(lines)
    changed = True

needle = "  const fromAddr = mailbox.from_email || user;"
if "drip: blocked unsafe draft before SMTP" not in text:
    if needle not in text:
        raise SystemExit(f"Could not find worker insertion point: {needle}")
    text = text.replace(needle, guard + needle, 1)
    changed = True

if changed:
    p.write_text(text)
    print(f"patched {p}")
else:
    print(f"already patched {p}")
PY

echo "== 7) PATCH OLD LAUNCH SCRIPT SO IT CANNOT APPROVE UNSAFE QUEUE =="
python3 - <<'PY'
from pathlib import Path

p = Path("/opt/email/scripts/launch_clients_help.sh")
if not p.exists():
    print("launch_clients_help.sh not found; skip")
    raise SystemExit(0)

text = p.read_text()
marker = "OUTREACH_SAFE_APPROVE_GUARD_20260628"

if marker in text:
    print("launch_clients_help.sh already patched")
    raise SystemExit(0)

old = "AND status='pending_review' AND safety_status='ok';"
new = """AND status='pending_review'
        AND safety_status='ok'
        AND COALESCE(draft_subject,'') <> ''
        AND COALESCE(draft_body,'') <> ''
        AND COALESCE(draft_subject,'') NOT LIKE '%{{%'
        AND COALESCE(draft_subject,'') NOT LIKE '%}}%'
        AND COALESCE(draft_body,'') NOT LIKE '%{{%'
        AND COALESCE(draft_body,'') NOT LIKE '%}}%'
        AND COALESCE(draft_subject,'') NOT LIKE '%{|%'
        AND COALESCE(draft_subject,'') NOT LIKE '%|}%'
        AND COALESCE(draft_body,'') NOT LIKE '%{|%'
        AND COALESCE(draft_body,'') NOT LIKE '%|}%'
        AND COALESCE(draft_body,'') NOT LIKE '%unsubscribe here:%';"""

if old not in text:
    print("Exact approve SQL pattern not found; leaving launch script unchanged")
    raise SystemExit(0)

text = text.replace(old, new + f" -- {marker}", 1)
p.write_text(text)
print("patched launch_clients_help.sh")
PY

echo "== 8) APPLY QUEUE SAFETY REPAIR =="
bash /opt/email/scripts/queue_safety_repair.sh --apply

echo "== 9) BUILD + RESTART WORKER ONLY =="
if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
else
  DC="docker-compose"
fi

$DC build worker
$DC up -d worker

echo "== 10) FINAL CHECKS =="
{
  echo "# Outreach Safety Fix Report"
  echo
  echo "UTC: $(date -u)"
  echo
  echo "## Backup"
  echo "- DB: $BACKUP_DIR/before_outreach_safety_fix.sql"
  echo "- Code: $BACKUP_DIR/code_before_outreach_safety_fix.tar.gz"
  echo
  echo "## Changes"
  echo "- Paused drip and kill-switch."
  echo "- Removed unresolved {{unsubscribe_url}} phrase from templates."
  echo "- Normalized approved template status fields."
  echo "- Added /opt/email/scripts/queue_safety_repair.sh"
  echo "- Added /opt/email/scripts/approve_safe_queue.sh"
  echo "- Patched worker safety gate before SMTP send."
  echo "- Patched launch_clients_help.sh safe approval guard if pattern was found."
  echo
  echo "## Current status"
  echo '```'
  bash /opt/email/scripts/sending_status.sh || true
  echo '```'
  echo
  echo "## Template placeholder scan"
  echo '```'
  DB "
  SELECT id, template_key, status, approved, safety_status,
         (body LIKE '%{{unsubscribe_url}}%') AS body_has_bad_unsub,
         (COALESCE(html_body,'') LIKE '%{{unsubscribe_url}}%') AS html_has_bad_unsub
  FROM manual_outreach_templates
  WHERE tenant_id=1
  ORDER BY id;
  " || true
  echo '```'
  echo
  echo "## Queue scan"
  echo '```'
  DB "
  SELECT status, safety_status, template_key, COUNT(*) cnt
  FROM manual_outreach_queue
  GROUP BY status, safety_status, template_key
  ORDER BY status, safety_status, cnt DESC;
  " || true
  echo '```'
  echo
  echo "## Resume"
  echo "Do not resume until queue/template scan is clean."
  echo "Safe approval command: bash /opt/email/scripts/approve_safe_queue.sh"
  echo "Resume command: bash /opt/email/scripts/sending_resume.sh --yes"
} > "$REPORT"

echo
echo "DONE"
echo "Report: $REPORT"
echo
bash /opt/email/scripts/sending_status.sh
