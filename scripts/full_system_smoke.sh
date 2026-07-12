#!/usr/bin/env bash
# Phase 22E — full-system operator-journey smoke. READ-heavy + safe writes only.
# No real emails, no campaign schedule, no mass subscribe. Cleans up test rows.
set -uo pipefail
cd /opt/email
set -a; . ./.env 2>/dev/null; set +a
API=http://127.0.0.1:4000
PORTAL=http://127.0.0.1:13000
TOKEN=$(docker compose exec -T api node -e "const j=require('jsonwebtoken');console.log(j.sign({sub:1,tenant:1},process.env.API_JWT_SECRET,{expiresIn:'2h'}))" 2>/dev/null)
AUTH=(-H "authorization: Bearer $TOKEN" -H "x-tenant-id: 1" -H "content-type: application/json")
DB(){ docker compose exec -T db mariadb -u"$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" -N -e "$1" 2>/dev/null | grep -v "Using a password"; }

PASS=0; FAIL=0; declare -a FAILS
# check NAME EXPECTED METHOD PATH [BODY] [grep-substr]
ck(){ local name="$1" exp="$2" method="$3" path="$4" body="${5:-}" want="${6:-}"
  local out code
  if [ -n "$body" ]; then out=$(curl -s -m 20 -w $'\n%{http_code}' "${AUTH[@]}" -X "$method" "$API$path" -d "$body")
  else out=$(curl -s -m 20 -w $'\n%{http_code}' "${AUTH[@]}" -X "$method" "$API$path"); fi
  code=$(echo "$out" | tail -1); local data=$(echo "$out" | sed '$d')
  local ok=1
  [ "$code" = "$exp" ] || ok=0
  if [ -n "$want" ]; then echo "$data" | grep -q "$want" || ok=0; fi
  if [ $ok = 1 ]; then PASS=$((PASS+1)); printf "  PASS %-3s %-6s %s\n" "$code" "$method" "$name"
  else FAIL=$((FAIL+1)); FAILS+=("$name [got $code want $exp]"); printf "  FAIL %-3s %-6s %s  exp=%s want='%s'\n" "$code" "$method" "$name" "$exp" "$want"; echo "       body: $(echo "$data"|head -c 200)"; fi
}
pg(){ local p="$1"; local c=$(curl -s -o /dev/null -m 15 -w "%{http_code}" "$PORTAL$p"); if [ "$c" = 200 ]; then PASS=$((PASS+1)); printf "  PASS 200 PAGE  %s\n" "$p"; else FAIL=$((FAIL+1)); FAILS+=("PAGE $p=$c"); printf "  FAIL %s PAGE  %s\n" "$c" "$p"; fi; }

echo "TOKEN len=${#TOKEN}"
echo; echo "== A. Health & auth =="
ck health 200 GET /health "" '"status":"ok"'
UC=$(curl -s -m10 -o /dev/null -w "%{http_code}" "$API/warehouse/stats")
if [ "$UC" = 401 ]; then PASS=$((PASS+1)); echo "  PASS 401 GET   unauth rejected (no token)"; else FAIL=$((FAIL+1)); FAILS+=("unauth not rejected=$UC"); echo "  FAIL unauth not rejected code=$UC"; fi

echo; echo "== B. Page render (operator pages) =="
for p in /dashboard /leads /collector /warehouse /warehouse/cohorts /campaigns /send-control /go-live /manual-outreach /sender-studio /mailboxes /domains /safety /settings /onboarding /setup /stats; do pg "$p"; done

echo; echo "== C. Warehouse (lead DB the operator browses) =="
ck wh-stats 200 GET /warehouse/stats
ck wh-analytics 200 GET /warehouse/analytics
ck wh-companies 200 GET "/warehouse/companies?limit=5"
ck wh-industries 200 GET /warehouse/industries
ck wh-review-queue 200 GET /warehouse/review-queue
ck wh-search 200 POST /warehouse/search '{"q":"plumbing in GB"}'
ck wh-cohort-preview 200 POST /warehouse/cohorts/preview '{"country":"GB"}' '"eligible"'
ck wh-cohort-export 200 POST /warehouse/cohorts/export '{"format":"csv","limit":5,"acknowledge":true}'
ck wh-supp-export 200 GET /warehouse/suppression-export
ck wh-outreach-tasks 200 GET /warehouse/outreach-tasks
CID=$(curl -s -m10 "${AUTH[@]}" "$API/warehouse/companies?limit=1" | python3 -c "import sys,json;d=json.load(sys.stdin);print((d.get('companies') or d.get('rows') or [{}])[0].get('id',''))" 2>/dev/null)
[ -n "$CID" ] && ck wh-company-detail 200 GET "/warehouse/companies/$CID"

echo; echo "== D. Sender Studio (templates) =="
ck ss-meta 200 GET /sender-studio/meta
ck ss-templates 200 GET /sender-studio/templates '' '"templates"'
TID=$(DB "SELECT id FROM manual_outreach_templates WHERE tenant_id=1 AND template_key='ch_first_touch_no_ps' LIMIT 1;")
ck ss-validate 200 GET "/sender-studio/templates/$TID/validate" '' '"canApprove"'
ck ss-preview 200 GET "/sender-studio/templates/$TID/preview?mode=desktop"
ck ss-versions 200 GET "/sender-studio/templates/$TID/versions"
ck ss-adhoc-validate 200 POST /sender-studio/validate '{"subject":"Hi {{company}}","body":"Test. Unsubscribe: {{unsub}}. 123 St."}'

echo; echo "== E. Mailboxes / Fleet (operator adds + tests a mailbox) =="
ck mb-providers 200 GET /mailboxes/providers '' '"profiles"'
ck mb-fleet 200 GET /mailboxes/fleet '' '"total"'
ck mb-list 200 GET /mailboxes/
# create a throwaway draft mailbox
NEWMB=$(curl -s -m10 "${AUTH[@]}" -X POST "$API/mailboxes/" -d '{"email":"smoketest_tmp@example.com","provider_profile_id":3,"purpose":"cold_outreach"}')
NEWID=$(echo "$NEWMB" | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
if [ -n "$NEWID" ]; then PASS=$((PASS+1)); echo "  PASS --- create draft mailbox id=$NEWID"
  ck mb-env-snippet 200 GET "/mailboxes/$NEWID/env-snippet"
  ck mb-test-smtp-runs 200 POST "/mailboxes/$NEWID/test-smtp" '{}'   # runs; verify-only, will not pass
  ck mb-activate-gate 412 POST "/mailboxes/$NEWID/activate" '{}'      # blocked: smtp not passed
  curl -s -m10 "${AUTH[@]}" -X DELETE "$API/mailboxes/$NEWID" -o /dev/null -w "  --- cleanup mailbox DELETE %{http_code}\n"
else FAIL=$((FAIL+1)); FAILS+=("create draft mailbox"); echo "  FAIL create draft mailbox: $(echo "$NEWMB"|head -c160)"; fi
ck mb-csv-export 200 GET /mailboxes/export/csv

echo; echo "== F. Sending infra =="
ck snd-control 200 GET /sending/control-status
ck snd-providers 200 GET /sending/providers

echo; echo "== G. Manual Outreach (daily operating) =="
ck mo-status 200 GET /manual-outreach/status '' '"queue"'
ck mo-today 200 GET /manual-outreach/today '' '"nextRecommendedAction"'
ck mo-cohort-preview 200 POST /manual-outreach/cohort/preview '{"country":"GB","max":10}' '"matched"'
ck mo-queue 200 GET /manual-outreach/queue
ck mo-followups 200 GET /manual-outreach/followups
ck mo-warmup 200 GET /manual-outreach/warmup
ck mo-templates 200 GET /manual-outreach/templates
ck mo-why-blocked 200 GET "/manual-outreach/why-blocked?email=nobody@nowhere.tld"

echo; echo "== H. Go-Live wizard (full first-launch flow) =="
ck gl-status 200 GET /go-live/status '' '"readiness"'
ck gl-plan 200 POST /go-live/plan '{"dayNumber":1}' '"safeRecommendedTotal"'
ck gl-dryrun 200 POST /go-live/dry-run '{"source":"existing_warehouse"}' '"wouldQueueCount"'
ck gl-ack-gate 400 POST /go-live/create-first-queue '{"source":"existing_warehouse"}'
# happy path (template approved) — then cleanup
GLC=$(curl -s -m20 "${AUTH[@]}" -X POST "$API/go-live/create-first-queue" -d '{"source":"existing_warehouse","acknowledge":true}')
GLINS=$(echo "$GLC" | python3 -c "import sys,json;print(json.load(sys.stdin).get('inserted',-1))" 2>/dev/null)
if [ "$GLINS" -ge 1 ] 2>/dev/null; then PASS=$((PASS+1)); echo "  PASS --- create-first-queue inserted=$GLINS (pending_review)"
else FAIL=$((FAIL+1)); FAILS+=("create-first-queue happy"); echo "  FAIL create-first-queue: $(echo "$GLC"|head -c160)"; fi

echo; echo "== I. Campaigns (must stay blocked on mailhog) =="
ck camp-list 200 GET /campaigns
CAMPID=$(DB "SELECT id FROM campaigns WHERE tenant_id=1 ORDER BY id LIMIT 1;")
if [ -n "$CAMPID" ]; then
  CS=$(curl -s -m10 -w $'\n%{http_code}' "${AUTH[@]}" -X POST "$API/campaigns/$CAMPID/schedule" -d '{}')
  CC=$(echo "$CS"|tail -1)
  if [ "$CC" = 412 ] || echo "$CS" | grep -qi "smtp"; then PASS=$((PASS+1)); echo "  PASS $CC  campaign schedule blocked (smtp not ready)"; else FAIL=$((FAIL+1)); FAILS+=("campaign schedule gate=$CC"); echo "  FAIL campaign schedule gate code=$CC $(echo "$CS"|head -c120)"; fi
else echo "  SKIP no campaign exists to test schedule gate"; fi

echo; echo "== J. Safety / suppression =="
ck saf-tenant 200 GET /admin/tenant-safety
ck saf-risk 200 GET /admin/risk-events
# add + remove a throwaway suppression (operator suppresses a negative)
SUPADD=$(curl -s -m10 -w $'\n%{http_code}' "${AUTH[@]}" -X POST "$API/manual-outreach/suppress" -d '{"email":"smoke_supp_tmp@example.com","reason":"manual"}')
SC=$(echo "$SUPADD"|tail -1)
if [ "$SC" = 200 ] || [ "$SC" = 201 ]; then PASS=$((PASS+1)); echo "  PASS $SC  suppress add"; else FAIL=$((FAIL+1)); FAILS+=("suppress add=$SC"); echo "  FAIL suppress add $SC $(echo "$SUPADD"|head -c150)"; fi

echo; echo "== K. Collector (read-only status) =="
ck col-agent 200 GET /collector/agent-status
ck col-presets 200 GET /collector/presets
ck col-free 200 GET /collector/free-providers

echo; echo "== L. Domains =="
ck dom-list 200 GET /domains
DOMID=$(DB "SELECT id FROM domains WHERE tenant_id=1 ORDER BY id LIMIT 1;")
[ -n "$DOMID" ] && ck dom-onboarding 200 GET "/domains/$DOMID/onboarding"
[ -n "$DOMID" ] && ck dom-warmup 200 GET "/domains/$DOMID/warmup"

echo; echo "== CLEANUP test artifacts =="
DB "DELETE FROM manual_outreach_queue WHERE tenant_id=1 AND (reason LIKE 'Go-Live first queue%' OR email='smoketest_tmp@example.com');" && echo "  queue test rows removed"
DB "DELETE FROM sender_identities WHERE tenant_id=1 AND from_email='smoketest_tmp@example.com';" && echo "  test mailbox removed (if delete left it)"
DB "DELETE FROM suppressions WHERE tenant_id=1 AND email='smoke_supp_tmp@example.com';" && echo "  test suppression removed"

echo; echo "== INVARIANTS (safety) =="
RS=$(DB "SELECT COALESCE(SUM(status='sent_smtp'),0) FROM manual_outreach_queue WHERE tenant_id=1;")
SUBS=$(DB "SELECT COUNT(*) FROM contacts WHERE status='subscribed';")
SCH=$(DB "SELECT COUNT(*) FROM campaigns WHERE status='scheduled';")
QLEFT=$(DB "SELECT COUNT(*) FROM manual_outreach_queue WHERE tenant_id=1;")
echo "  real SMTP sends (queue)   = $RS   (expect 0)"
echo "  subscribed contacts       = $SUBS (expect 1)"
echo "  campaigns scheduled       = $SCH  (expect 0)"
echo "  leftover queue rows       = $QLEFT (expect 0)"
echo "  SMTP_HOST                 = $SMTP_HOST (expect mailhog)"

echo; echo "================= RESULT ================="
echo "PASS=$PASS  FAIL=$FAIL"
if [ $FAIL -gt 0 ]; then printf '%s\n' "${FAILS[@]}"; fi
