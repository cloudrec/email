#!/usr/bin/env bash
# Restore from encrypted backup file. DESTRUCTIVE - confirms first.
set -euo pipefail

ROOT="/opt/email"
cd "$ROOT"
[[ -f .env ]] && set -a && source .env && set +a

FILE="${1:-}"
if [[ -z "$FILE" || ! -f "$FILE" ]]; then
  echo "Usage: $0 backups/backup-YYYYMMDDTHHMMSSZ.tar.gz.gpg"
  exit 1
fi

echo "WARNING: This will REPLACE current DB contents with the dump from $FILE."
read -r -p "Type 'RESTORE' to proceed: " ANS
[[ "$ANS" == "RESTORE" ]] || { echo "Aborted."; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "[restore] Decrypting..."
gpg --batch --yes --decrypt --passphrase "$BACKUP_ENCRYPT_PASSPHRASE" "$FILE" \
  | tar -xz -C "$TMP"

INNER=$(find "$TMP" -maxdepth 1 -name 'backup-*' -type d | head -1)
[[ -n "$INNER" ]] || { echo "no backup dir inside archive"; exit 1; }

echo "[restore] Importing DB..."
gunzip -c "$INNER/db.sql.gz" \
  | docker compose exec -T db sh -c "mariadb -uroot -p\"$DB_ROOT_PASSWORD\" \"$DB_NAME\""

echo "[restore] Done. Run 'make health'."
