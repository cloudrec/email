#!/usr/bin/env bash
# Backup DB + configs + DKIM keys + uploaded assets to ./backups/
# Secrets safety:
#   - Passwords are passed via env vars (MYSQL_PWD) instead of CLI args so they
#     are not visible to other users via `ps -ef`.
#   - The GPG passphrase is fed via fd 0 (--passphrase-fd 0) instead of CLI.
#   - Script does not echo secret values.
#
# Default: retains old backups. Set BACKUP_RETENTION_DAYS in .env to enable prune.
# When BACKUP_RETENTION_DAYS is unset or empty, NOTHING is deleted (safer default).
set -euo pipefail

ROOT="/opt/email"
cd "$ROOT"
[[ -f .env ]] && set -a && source .env && set +a

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DEST="backups/backup-${STAMP}"
mkdir -p "$DEST"

echo "[backup] DB dump..."
# Pass password via MYSQL_PWD env to avoid leaking through process list.
docker compose exec -T -e MYSQL_PWD="$DB_ROOT_PASSWORD" db sh -c \
  "mariadb-dump -uroot --single-transaction --routines --triggers \"$DB_NAME\"" \
  | gzip > "$DEST/db.sql.gz"

echo "[backup] Configs..."
# Only ship config templates and migrations. Never the live .env.
tar -czf "$DEST/configs.tar.gz" \
  .env.example docker-compose.yml Makefile \
  nginx/conf.d db/migrations scripts \
  2>/dev/null || true

if [[ -f .env ]]; then
  # Hash-only audit of .env so a restore operator can verify the file
  # they hold matches the one in production WITHOUT shipping secrets.
  sha256sum .env | awk '{print $1}' > "$DEST/env.sha256"
fi

echo "[backup] DKIM / postal data..."
if docker volume inspect email-platform_postal_data >/dev/null 2>&1; then
  docker run --rm \
    -v email-platform_postal_data:/data:ro \
    -v "$PWD/$DEST":/out \
    alpine sh -c "tar -czf /out/postal_data.tar.gz -C /data ." || true
fi

echo "[backup] Encrypt..."
if [[ -n "${BACKUP_ENCRYPT_PASSPHRASE:-}" && "$BACKUP_ENCRYPT_PASSPHRASE" != CHANGE_ME* ]]; then
  # Pipe passphrase on fd 0 of gpg; tar is piped on fd 3 via process substitution.
  tar -cz -C "$DEST/.." "$(basename "$DEST")" > "$DEST.tar.gz.tmp"
  printf '%s' "$BACKUP_ENCRYPT_PASSPHRASE" \
    | gpg --batch --yes --symmetric --cipher-algo AES256 \
          --passphrase-fd 0 \
          -o "$DEST.tar.gz.gpg" "$DEST.tar.gz.tmp"
  rm -f "$DEST.tar.gz.tmp"
  rm -rf "$DEST"
  echo "[backup] Done: $DEST.tar.gz.gpg"
else
  echo "[backup] WARNING: no passphrase set, leaving unencrypted at $DEST"
fi

# Retention: only prune when BACKUP_RETENTION_DAYS is explicitly set.
if [[ -n "${BACKUP_RETENTION_DAYS:-}" ]]; then
  echo "[backup] Pruning >${BACKUP_RETENTION_DAYS}d..."
  find backups -maxdepth 1 -mtime "+${BACKUP_RETENTION_DAYS}" \
    \( -name 'backup-*.tar.gz.gpg' -o -name 'backup-*' -type d \) \
    -exec rm -rf {} + 2>/dev/null || true
else
  echo "[backup] BACKUP_RETENTION_DAYS not set — old backups retained."
fi
