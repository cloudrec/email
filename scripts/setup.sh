#!/usr/bin/env bash
# Initial bootstrap for /opt/email
set -euo pipefail

ROOT="/opt/email"
cd "$ROOT"

echo "[setup] Checking prerequisites..."
command -v docker >/dev/null || { echo "docker missing"; exit 1; }
docker compose version >/dev/null || { echo "docker compose plugin missing"; exit 1; }

if [[ ! -f .env ]]; then
  echo "[setup] Creating .env from .env.example"
  cp .env.example .env
  echo "[setup] EDIT /opt/email/.env now to set real secrets, then re-run."
  exit 0
fi

mkdir -p backups logs/nginx nginx/certs

echo "[setup] Building images..."
docker compose build

echo "[setup] Starting core stack..."
docker compose up -d

echo "[setup] Waiting for DB..."
for i in {1..30}; do
  if docker compose exec -T db healthcheck.sh --connect --innodb_initialized >/dev/null 2>&1; then
    echo "[setup] DB ready."
    break
  fi
  sleep 2
done

echo "[setup] Running migrations..."
docker compose exec -T api node /app/dist/cli/migrate.js || echo "[setup] migrate skipped (api may not be built yet)"

echo "[setup] Done. Run 'bash scripts/healthcheck.sh' to verify."
