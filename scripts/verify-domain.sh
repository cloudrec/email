#!/usr/bin/env bash
# Run DNS verification for a domain. Usage: verify-domain.sh <domain>
set -euo pipefail

ROOT="/opt/email"
cd "$ROOT"

DOMAIN="${1:-}"
[[ -n "$DOMAIN" ]] || { echo "Usage: $0 <domain>"; exit 1; }

docker compose exec -T api node /app/dist/cli/verify-domain.js --domain "$DOMAIN"
