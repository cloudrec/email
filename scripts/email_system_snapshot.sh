#!/usr/bin/env bash
set -u

cd /opt/email || exit 1

TS="$(date -u +%Y%m%d_%H%M%S)"
OUT="/opt/email/reports/email_system_snapshot_${TS}"
mkdir -p "$OUT"/{docker,app,db,logs,grep}

LOG="$OUT/00_RUN.log"

log() {
  echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$LOG"
}

safe_run() {
  local name="$1"
  shift
  log "RUN $name"
  {
    echo "# COMMAND: $*"
    "$@"
  } > "$OUT/$name" 2>&1 || {
    echo "FAILED rc=$?" >> "$OUT/$name"
    log "FAILED $name"
  }
}

redact_stream() {
  sed -E '
    s/((PASSWORD|PASS|TOKEN|SECRET|API_KEY|PRIVATE_KEY|SMTP_PASSWORD|IMAP_PASSWORD|DATABASE_URL|DB_URL|JWT|COOKIE|SESSION|CREDENTIAL)[A-Z0-9_ -]*[=:]).*/\1[REDACTED]/Ig;
    s/(mysql:\/\/[^:]+:)[^@]+@/\1[REDACTED]@/Ig;
    s/(postgres:\/\/[^:]+:)[^@]+@/\1[REDACTED]@/Ig;
  '
}

log "Creating email system snapshot at $OUT"

# Basic system
safe_run "app/pwd.txt" pwd
safe_run "app/date.txt" date -u
safe_run "app/git_status.txt" git status --short
safe_run "app/git_log.txt" git log --oneline -20
safe_run "app/top_level_tree.txt" find /opt/email -maxdepth 3 -type f \
  ! -path "*/node_modules/*" \
  ! -path "*/.git/*" \
  ! -path "*/dist/*" \
  ! -path "*/build/*" \
  ! -path "*/reports/*" \
  | sort

safe_run "app/scripts_list.txt" find /opt/email/scripts -maxdepth 2 -type f -printf "%p\n" 2>/dev/null

# Docker / compose
safe_run "docker/compose_ps.txt" docker compose ps --all
safe_run "docker/docker_ps.txt" docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}"
safe_run "docker/compose_services.txt" docker compose ps --services

log "Saving sanitized docker compose config"
docker compose config 2>&1 | redact_stream > "$OUT/docker/compose_config_sanitized.txt"

log "Saving env key names only"
for svc in $(docker compose ps --services 2>/dev/null); do
  cid="$(docker compose ps -q "$svc" 2>/dev/null || true)"
  if [ -n "$cid" ]; then
    docker exec "$cid" sh -lc 'printenv | cut -d= -f1 | sort' > "$OUT/docker/env_keys_${svc}.txt" 2>&1 || true
    docker inspect "$cid" --format '{{.Name}} {{.Config.Image}} {{.State.Status}} {{.State.StartedAt}}' > "$OUT/docker/inspect_short_${svc}.txt" 2>&1 || true
  fi
done

# Logs
log "Saving compose logs tail"
docker compose logs --tail=250 2>&1 | redact_stream > "$OUT/logs/compose_logs_tail_250.txt"

# Important project files, sanitized
log "Saving important project config files if present"
for f in \
  package.json \
  pnpm-lock.yaml \
  package-lock.json \
  yarn.lock \
  docker-compose.yml \
  docker-compose.yaml \
  compose.yml \
  compose.yaml \
  prisma/schema.prisma \
  src/prisma/schema.prisma \
  README.md \
  AI_HANDOFF_CONTEXT.md
do
  if [ -f "$f" ]; then
    mkdir -p "$OUT/app/$(dirname "$f")"
    cat "$f" | redact_stream > "$OUT/app/$f"
  fi
done

# Migrations / schema files list
find /opt/email -maxdepth 5 \( -path "*/migrations/*" -o -path "*/prisma/*" -o -name "*.sql" \) \
  -type f \
  ! -path "*/node_modules/*" \
  ! -path "*/.git/*" \
  ! -path "*/reports/*" \
  | sort > "$OUT/app/db_related_files.txt" 2>&1 || true

# Grep important backend words
log "Grepping important mail/outreach symbols"
grep -RInE "manual_outreach|outreach_template|template_id|rendered|sent_smtp|approved|pending_review|drip|sender_identities|sending_providers|reply|bounce|unsubscribe|suppression|subject|body|smtp|imap|mailbox" /opt/email \
  --exclude-dir=node_modules \
  --exclude-dir=.git \
  --exclude-dir=dist \
  --exclude-dir=build \
  --exclude-dir=reports \
  --exclude="*.log" \
  2>/dev/null \
  | redact_stream \
  > "$OUT/grep/mail_outreach_symbols.txt" || true

# Current known app status scripts
log "Running known status scripts"
if [ -f /opt/email/scripts/sending_status.sh ]; then
  bash /opt/email/scripts/sending_status.sh > "$OUT/app/sending_status_output.txt" 2>&1 || true
fi

# Detect DB service
DB_SERVICE=""
DB_KIND=""

for svc in $(docker compose ps --services 2>/dev/null); do
  cid="$(docker compose ps -q "$svc" 2>/dev/null || true)"
  [ -n "$cid" ] || continue
  img="$(docker inspect -f '{{.Config.Image}}' "$cid" 2>/dev/null || true)"
  line="$svc $img"
  case "$line" in
    *mariadb*|*mysql*)
      DB_SERVICE="$svc"
      DB_KIND="mysql"
      break
      ;;
    *postgres*|*postgis*)
      DB_SERVICE="$svc"
      DB_KIND="postgres"
      break
      ;;
  esac
done

echo "DB_SERVICE=$DB_SERVICE" > "$OUT/db/db_detected.txt"
echo "DB_KIND=$DB_KIND" >> "$OUT/db/db_detected.txt"

if [ -z "$DB_SERVICE" ]; then
  log "DB service not detected by image name"
else
  DB_CID="$(docker compose ps -q "$DB_SERVICE" 2>/dev/null || true)"
  echo "DB_CID=$DB_CID" >> "$OUT/db/db_detected.txt"

  docker exec "$DB_CID" sh -lc 'command -v mysql || true; command -v mariadb || true; command -v psql || true; ls -la /usr/bin 2>/dev/null | egrep "mysql|maria|psql" || true' > "$OUT/db/db_client_detection.txt" 2>&1 || true

  mysql_query() {
    local sql="$1"
    local outfile="$2"
    local skip_headers="${3:-0}"

    local tmp_sql="$OUT/db/.query.sql"
    printf "%s\n" "$sql" > "$tmp_sql"

    local opts="--batch --raw"
    if [ "$skip_headers" = "1" ]; then
      opts="$opts --skip-column-names"
    fi

    # Try client inside DB container first: mariadb or mysql
    if docker exec "$DB_CID" sh -lc 'command -v mariadb >/dev/null 2>&1 || command -v mysql >/dev/null 2>&1'; then
      docker exec -i "$DB_CID" sh -lc 'cat > /tmp/email_snapshot_query.sql' < "$tmp_sql"
      docker exec "$DB_CID" sh -lc "
        DB=\"\${MYSQL_DATABASE:-\${MARIADB_DATABASE:-}}\"
        U=\"\${MYSQL_USER:-\${MARIADB_USER:-root}}\"
        P=\"\${MYSQL_PASSWORD:-\${MARIADB_PASSWORD:-\${MYSQL_ROOT_PASSWORD:-\${MARIADB_ROOT_PASSWORD:-}}}}\"
        BIN=\"\$(command -v mariadb || command -v mysql)\"
        MYSQL_PWD=\"\$P\" \"\$BIN\" $opts -u\"\$U\" \"\$DB\" < /tmp/email_snapshot_query.sql
      " > "$outfile" 2>&1 || true
      return
    fi

    # Fallback: temporary mariadb client container on DB container network namespace
    local U P DB
    U="$(docker exec "$DB_CID" sh -lc 'printf "%s" "${MYSQL_USER:-${MARIADB_USER:-root}}"' 2>/dev/null || true)"
    P="$(docker exec "$DB_CID" sh -lc 'printf "%s" "${MYSQL_PASSWORD:-${MARIADB_PASSWORD:-${MYSQL_ROOT_PASSWORD:-${MARIADB_ROOT_PASSWORD:-}}}}"' 2>/dev/null || true)"
    DB="$(docker exec "$DB_CID" sh -lc 'printf "%s" "${MYSQL_DATABASE:-${MARIADB_DATABASE:-}}"' 2>/dev/null || true)"

    docker run --rm --network "container:$DB_CID" -e MYSQL_PWD="$P" mariadb:11 \
      mariadb $opts -h127.0.0.1 -u"$U" "$DB" < "$tmp_sql" > "$outfile" 2>&1 || true
  }

  if [ "$DB_KIND" = "mysql" ]; then
    log "Dumping MySQL/MariaDB schema overview"

    mysql_query "
SELECT DATABASE() AS current_database;
SHOW TABLES;
" "$OUT/db/01_tables.txt"

    mysql_query "
SELECT
  TABLE_NAME,
  COLUMN_NAME,
  ORDINAL_POSITION,
  DATA_TYPE,
  IS_NULLABLE,
  COLUMN_KEY,
  COLUMN_DEFAULT,
  EXTRA
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
ORDER BY TABLE_NAME, ORDINAL_POSITION;
" "$OUT/db/02_all_columns.txt"

    mysql_query "
SELECT
  TABLE_NAME,
  COLUMN_NAME,
  DATA_TYPE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND (
    TABLE_NAME REGEXP 'outreach|template|queue|campaign|message|sender|identity|mailbox|provider|reply|bounce|suppression|touchpoint|drip'
    OR COLUMN_NAME REGEXP 'template|subject|body|rendered|status|sent|reply|bounce|mailbox|provider|smtp|imap'
  )
ORDER BY TABLE_NAME, ORDINAL_POSITION;
" "$OUT/db/03_relevant_columns.txt"

    mysql_query "
SELECT DISTINCT TABLE_NAME
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME REGEXP 'outreach|template|queue|campaign|message|sender|identity|mailbox|provider|reply|bounce|suppression|touchpoint|drip'
ORDER BY TABLE_NAME;
" "$OUT/db/04_relevant_tables.txt" 1

    log "Sampling relevant DB tables with sensitive columns excluded"

    while read -r tbl; do
      [ -n "$tbl" ] || continue

      safe_tbl="$(echo "$tbl" | tr -cd 'A-Za-z0-9_-' )"

      mysql_query "SHOW COLUMNS FROM \`$tbl\`;" "$OUT/db/schema_${safe_tbl}.txt"

      cols="$(mysql_query "
SELECT GROUP_CONCAT(CONCAT('\`', COLUMN_NAME, '\`') ORDER BY ORDINAL_POSITION SEPARATOR ', ')
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = '$tbl'
  AND COLUMN_NAME NOT REGEXP 'password|passwd|secret|token|credential|private|hash|salt|oauth|cookie|session|api_key|apikey|smtp_password|imap_password';
" "$OUT/db/.cols_${safe_tbl}.txt" 1; cat "$OUT/db/.cols_${safe_tbl}.txt" | tail -n 1)"

      if [ -z "$cols" ] || echo "$cols" | grep -qi "ERROR"; then
        echo "No safe columns detected or query failed for $tbl" > "$OUT/db/sample_${safe_tbl}.txt"
        continue
      fi

      order_col="$(mysql_query "
SELECT COLUMN_NAME
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = '$tbl'
  AND COLUMN_NAME IN ('updated_at','created_at','last_sent_at','sent_at','id')
ORDER BY FIELD(COLUMN_NAME,'updated_at','last_sent_at','sent_at','created_at','id')
LIMIT 1;
" "$OUT/db/.order_${safe_tbl}.txt" 1; cat "$OUT/db/.order_${safe_tbl}.txt" | tail -n 1)"

      if [ -n "$order_col" ] && ! echo "$order_col" | grep -qi "ERROR"; then
        mysql_query "SELECT $cols FROM \`$tbl\` ORDER BY \`$order_col\` DESC LIMIT 30;" "$OUT/db/sample_${safe_tbl}.txt"
      else
        mysql_query "SELECT $cols FROM \`$tbl\` LIMIT 30;" "$OUT/db/sample_${safe_tbl}.txt"
      fi
    done < "$OUT/db/04_relevant_tables.txt"

    rm -f "$OUT"/db/.cols_* "$OUT"/db/.order_* "$OUT/db/.query.sql" 2>/dev/null || true
  fi
fi

# Archive
ARCHIVE="/opt/email/reports/email_system_snapshot_${TS}.tar.gz"
tar -czf "$ARCHIVE" -C "/opt/email/reports" "email_system_snapshot_${TS}" 2>/dev/null || true

log "DONE"
log "Folder: $OUT"
log "Archive: $ARCHIVE"

echo
echo "===================================================="
echo "SNAPSHOT READY"
echo "Folder:  $OUT"
echo "Archive: $ARCHIVE"
echo "===================================================="
