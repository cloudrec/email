#!/usr/bin/env bash
# Create tenant via API CLI. Usage: create-tenant.sh --email X --domain Y --plan Z [--lang en|ru|uk]
set -euo pipefail

ROOT="/opt/email"
cd "$ROOT"

EMAIL=""; DOMAIN=""; PLAN="starter"; LANG="en"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --email)  EMAIL="$2";  shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --plan)   PLAN="$2";   shift 2 ;;
    --lang)   LANG="$2";   shift 2 ;;
    *) echo "unknown arg: $1"; exit 1 ;;
  esac
done

[[ -n "$EMAIL"  ]] || { echo "--email required";  exit 1; }
[[ -n "$DOMAIN" ]] || { echo "--domain required"; exit 1; }

docker compose exec -T api node /app/dist/cli/create-tenant.js \
  --email "$EMAIL" --domain "$DOMAIN" --plan "$PLAN" --lang "$LANG"
