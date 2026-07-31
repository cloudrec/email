// Reserve domains for the personal audit batch (Prospect Audit Email Safety Gate).
//
// Reads a domain list (one per line; '#' comments and blanks ignored; emails/URLs are
// accepted and reduced to their domain), normalizes each, and marks them RESERVED so the
// automated senders (first-touch, follow-up, warmup) exclude them until the owner approves.
//
// Reservation is NOT a send: this writes ONLY the reserved_domains table. It never inserts
// an outreach_touchpoint and never contacts anyone.
//
// Modes (idempotent, safe to re-run):
//   (default)          DRY RUN — parse the file, show what WOULD be reserved + an overlap
//                      report against the current send selection. Writes nothing.
//   --commit           Upsert the domains as reserved (released_at=NULL). Idempotent.
//   --release <domain> Soft-release one domain (rollback: sets released_at=NOW()).
//   --release-all      Soft-release the whole current reservation (rollback).
//   --list             Print the active reservation and exit.
//   --overlap-only     Only run the overlap report (no reserve).
//
//   docker cp scripts/reserve_domains.mjs "$(docker compose ps -q api)":/app/reserve_domains.mjs
//   docker cp <file> "$(docker compose ps -q api)":/app/selected_domains.txt
//   docker compose exec -T api node /app/reserve_domains.mjs --file /app/selected_domains.txt          # dry run
//   docker compose exec -T api node /app/reserve_domains.mjs --file /app/selected_domains.txt --commit  # activate
import { query } from './dist/db.js';
import { normalizeDomain } from './dist/services/reservedDomains.js';
import fs from 'node:fs';

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const has = (n) => args.includes(n);
const FILE = arg('--file', '/app/selected_domains.txt');
const COMMIT = has('--commit');
const OVERLAP_ONLY = has('--overlap-only');
const LIST = has('--list');
const RELEASE = arg('--release');
const RELEASE_ALL = has('--release-all');

const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const log = (m) => console.log(`[${now()}] reserve: ${m}`);

// ---- rollback paths ----
if (RELEASE) {
  const d = normalizeDomain(RELEASE);
  const r = await query('UPDATE reserved_domains SET released_at=NOW() WHERE domain=? AND released_at IS NULL', [d]);
  log(`released ${d}: ${r.affectedRows} row(s) re-included in sending`);
  process.exit(0);
}
if (RELEASE_ALL) {
  const r = await query('UPDATE reserved_domains SET released_at=NOW() WHERE released_at IS NULL');
  log(`released ALL: ${r.affectedRows} domain(s) re-included in sending`);
  process.exit(0);
}
if (LIST) {
  const rows = await query('SELECT domain, reason, reserved_at FROM reserved_domains WHERE released_at IS NULL ORDER BY domain');
  log(`${rows.length} domain(s) currently reserved`);
  for (const r of rows) console.log(`  ${r.domain}  (${r.reason}, ${r.reserved_at})`);
  process.exit(0);
}

// ---- parse the input file ----
let raw;
try { raw = fs.readFileSync(FILE, 'utf8'); }
catch { console.error(`cannot read ${FILE} — provide --file <path> (fixture ok). Nothing changed.`); process.exit(2); }

const seen = new Set();
const domains = [];
for (const line of raw.split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const d = normalizeDomain(t);
  if (d && !seen.has(d)) { seen.add(d); domains.push(d); }
}
log(`parsed ${domains.length} unique domain(s) from ${FILE}`);
if (!domains.length && !OVERLAP_ONLY) { log('nothing to reserve'); process.exit(0); }

// ---- overlap report: do any reserved domains sit in the current send selection? ----
// This is the "does the current outreach overlap the reserved batch?" check. It is
// read-only. Overlap is exactly what the gate prevents once committed.
async function overlapReport(list) {
  if (!list.length) { log('overlap: no domains to check'); return; }
  const ph = list.map(() => '?').join(',');
  const contacted = await query(
    `SELECT DISTINCT SUBSTRING_INDEX(email,'@',-1) dom FROM outreach_touchpoints
      WHERE touch_type='first_touch' AND direction='outbound'
        AND SUBSTRING_INDEX(email,'@',-1) IN (${ph})`, list);
  const pending = await query(
    `SELECT DISTINCT SUBSTRING_INDEX(email,'@',-1) dom
       FROM manual_outreach_queue WHERE status IN ('pending_review','approved')
        AND SUBSTRING_INDEX(email,'@',-1) IN (${ph})`, list).catch(() => []);
  log(`overlap: ${contacted.length} reserved domain(s) already have a first-touch; ${pending.length} sit in a manual queue`);
  for (const r of contacted) console.log(`  ALREADY-CONTACTED: ${r.dom}`);
  for (const r of pending) console.log(`  IN-MANUAL-QUEUE:   ${r.dom}`);
}

await overlapReport(domains);

if (OVERLAP_ONLY) process.exit(0);

if (!COMMIT) {
  log(`DRY RUN — ${domains.length} domain(s) WOULD be reserved. Re-run with --commit to activate. Nothing written.`);
  for (const d of domains.slice(0, 20)) console.log(`  would reserve: ${d}`);
  if (domains.length > 20) console.log(`  … +${domains.length - 20} more`);
  process.exit(0);
}

// ---- commit: idempotent upsert (re-reserve un-releases) ----
// Count by before/after (driver-agnostic — MariaDB's affectedRows for ON DUPLICATE is
// unreliable for "changed nothing" updates). A re-run of the same list is a clean no-op.
const [{ active: before }] = await query('SELECT COUNT(*) active FROM reserved_domains WHERE released_at IS NULL');
for (const d of domains) {
  await query(
    `INSERT INTO reserved_domains (domain, reason, source) VALUES (?, 'personal_audit_batch', ?)
     ON DUPLICATE KEY UPDATE released_at=NULL, reason=VALUES(reason), source=VALUES(source)`,
    [d, FILE]);
}
const [{ active: after }] = await query('SELECT COUNT(*) active FROM reserved_domains WHERE released_at IS NULL');
log(`COMMITTED: ${domains.length} in list; reserved went ${before} -> ${after} active (excluded from all sends). Re-runs are no-ops.`);
process.exit(0);
