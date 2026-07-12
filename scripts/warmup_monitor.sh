#!/usr/bin/env bash
# Warmup health snapshot — appended to logs/warmup_monitor.log for oversight.
# Real-time regulation is done by the worker (warmupScheduler auto-pause on
# bounce>3%/complaint>0.1%); this snapshot surfaces Postal delivery + reputation
# so a human/operator can adjust targeting (e.g. avoid Google-hosted while cold).
set -euo pipefail
cd /opt/email
LOG=/opt/email/logs/warmup_monitor.log
TS="$(date -u '+%Y-%m-%d %H:%M UTC')"
RP="$(grep '^MARIADB_ROOT_PASSWORD' .env 2>/dev/null | cut -d= -f2- || true)"

q(){ docker compose exec -T db sh -c "mariadb -u root -p\"\$MARIADB_ROOT_PASSWORD\" $1 -N -e \"$2\"" 2>/dev/null | grep -vE 'Warning|insecure'; }

# Postal delivery last 24h by status
DELIV="$(q 'postal-server-1' 'SELECT CONCAT(status,\"=\",COUNT(*)) FROM messages WHERE timestamp>UNIX_TIMESTAMP()-86400 GROUP BY status;' | tr '\n' ' ')"
# Real bounce/complaint today (app counters — the dangerous signals warmup pauses on)
RISK="$(q email_platform 'SELECT CONCAT(\"sent=\",SUM(sent_today),\" bounce=\",SUM(bounce_like_today),\" complaint=\",SUM(complaints_today),\" unsub=\",SUM(unsubscribes_today),\" reply=\",SUM(replies_today)) FROM sender_identities WHERE status=\"active\";')"
# Auto-paused mailboxes (circuit breaker / warmup auto-pause)
PAUSED="$(q email_platform 'SELECT COUNT(*) FROM sender_identities WHERE status=\"paused\";')"
# Blacklist (real DNSBL)
REV="105.139.247.84"; SPAM="$(dig +short A ${REV}.zen.spamhaus.org 2>/dev/null | head -1)"; BARR="$(dig +short A ${REV}.b.barracudacentral.org 2>/dev/null | head -1)"
# 127.255.255.x = Spamhaus "query via public/blocked resolver" error, NOT a listing.
case "$SPAM" in 127.255.255.*) SPAM="check_unavailable";; "") SPAM="clean";; 127.0.0.*) SPAM="LISTED:$SPAM";; esac
BARR="${BARR:-clean}"; case "$BARR" in 127.0.0.*) BARR="LISTED:$BARR";; esac
# Suppressions total
SUP="$(q email_platform 'SELECT COUNT(*) FROM suppressions;')"

echo "[$TS] postal24h: ${DELIV}| risk: ${RISK} | paused=${PAUSED} | spamhaus=${SPAM} barracuda=${BARR} | suppressions=${SUP}" >> "$LOG"

# Safety auto-throttle: if today's real complaints>0 or bounce rate is high, warn loudly in the log.
echo "$RISK" | awk '{for(i=1;i<=NF;i++){split($i,a,"=");v[a[1]]=a[2]} if(v["complaint"]+0>0||(v["sent"]+0>=20 && v["bounce"]/(v["sent"]+0.001)>0.03)) print "  [ALERT] complaint/bounce breach — review + consider pausing"}' >> "$LOG" 2>/dev/null || true
