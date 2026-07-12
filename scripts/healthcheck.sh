#!/usr/bin/env bash
# Health probe for /opt/email stack. Exits 0 if all OK, 1 if any FAIL.
set -uo pipefail

ROOT="/opt/email"
cd "$ROOT"
[[ -f .env ]] && set -a && source .env && set +a

FAILED=0
ok()   { printf "  \033[32mOK\033[0m  %s\n" "$1"; }
fail() { printf "  \033[31mFAIL\033[0m %s\n" "$1"; FAILED=1; }
warn() { printf "  \033[33mWARN\033[0m %s\n" "$1"; }

echo "== Email Platform health =="

# Containers
for svc in nginx portal api worker db redis; do
  state=$(docker compose ps --format '{{.Service}} {{.State}}' 2>/dev/null | awk -v s="$svc" '$1==s{print $2}')
  case "$state" in
    running) ok  "$svc running" ;;
    "")      warn "$svc not present" ;;
    *)       fail "$svc state=$state" ;;
  esac
done

# DB connectivity
if docker compose exec -T db healthcheck.sh --connect --innodb_initialized >/dev/null 2>&1; then
  ok "db connectivity"
else
  fail "db connectivity"
fi

# Redis ping
if docker compose exec -T -e RP="$REDIS_PASSWORD" redis sh -c 'redis-cli -a "$RP" ping' 2>/dev/null | grep -q PONG; then
  ok "redis PONG"
else
  fail "redis ping"
fi

# API /health
if docker compose exec -T api wget -qO- http://127.0.0.1:4000/health 2>/dev/null | grep -q ok; then
  ok "api /health"
else
  warn "api /health (may not be implemented yet)"
fi

# Disk
DISK_USED=$(df -P /opt/email | awk 'NR==2 {gsub("%","",$5); print $5}')
if [[ "${DISK_USED:-0}" -lt 85 ]]; then
  ok "disk ${DISK_USED}% used"
else
  fail "disk ${DISK_USED}% used"
fi

# Recent error count
ERRORS=$(docker compose logs --since=10m 2>/dev/null | grep -iE 'error|fatal|panic' | wc -l)
if [[ "$ERRORS" -lt 20 ]]; then
  ok "recent errors=$ERRORS (last 10m)"
else
  warn "recent errors=$ERRORS (last 10m)"
fi

echo
[[ "$FAILED" -eq 0 ]] && echo "RESULT: OK" || echo "RESULT: FAIL"
exit "$FAILED"
