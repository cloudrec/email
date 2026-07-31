#!/usr/bin/env bash
# Wrapper for the domain reservation gate. Copies the reserve script + the domain list
# into the api container, then runs reserve_domains.mjs. DRY RUN by default; pass --commit
# to activate. Reservation is NOT a send.
#
#   scripts/reserve_domains.sh                                  # dry run on the default file
#   scripts/reserve_domains.sh --commit                        # activate reservation
#   scripts/reserve_domains.sh --file /path/to/list.txt        # dry run on a specific file
#   scripts/reserve_domains.sh --release-all                   # rollback (re-include all)
set -euo pipefail

EM=/opt/email
DEFAULT_FILE=/opt/prospect-audit/exports/selected_domains.txt
HOST_FILE="$DEFAULT_FILE"
PASS=()
# Pull a host-side --file out of the args (the container path is fixed to /app/…).
while [[ $# -gt 0 ]]; do
  case "$1" in
    --file) HOST_FILE="$2"; shift 2 ;;
    *) PASS+=("$1"); shift ;;
  esac
done

cd "$EM"
CID=$(/usr/bin/docker compose ps -q api)
/usr/bin/docker cp "$EM/scripts/reserve_domains.mjs" "$CID":/app/reserve_domains.mjs
if [[ -f "$HOST_FILE" ]]; then
  /usr/bin/docker cp "$HOST_FILE" "$CID":/app/selected_domains.txt
else
  echo "[reserve] file not found: $HOST_FILE — nothing to do (gate stays inert)."
  exit 0
fi
/usr/bin/docker compose exec -T api node /app/reserve_domains.mjs --file /app/selected_domains.txt "${PASS[@]}"
