// Warms email_domain_mx (migration 0021) — resolves MX once per domain and
// stores the verdict, so the warmup senders can filter unsendable domains in
// SQL instead of rediscovering them with a live DNS lookup on every run.
//
// Without a warm cache the senders still work, they just fill it lazily as they
// crawl the candidate list — which is exactly the slow path this fixes, since
// the head of that list is ~97% Google-hosted. Run this once after migrating.
//
// Safe to re-run: only rows that are missing or past their re-check age are
// touched, so a second run right after the first does almost nothing.
//
//   docker cp scripts/backfill_mx_cache.mjs "$(docker compose ps -q api)":/app/backfill_mx_cache.mjs
//   docker compose exec -T api node /app/backfill_mx_cache.mjs [--limit N] [--dry-run]
import { query } from './dist/db.js';
import dns from 'node:dns';

const args = process.argv.slice(2);
const LIMIT = (() => { const i = args.indexOf('--limit'); return i >= 0 ? +args[i + 1] : 0; })();
const DRY = args.includes('--dry-run');
const CONCURRENCY = 24;
const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const log = (m) => console.log(`[${now()}] backfill_mx: ${m}`);

// Keep these three in lockstep with warmup_send.mjs / warmup_send_pilot.mjs.
const GOOG = /(aspmx.*google|google\.com|googlemail|gmail-smtp)/i;
const STALE = { dns_fail: 3, google: 30, no_mx: 30, ok: 30 };   // days before re-check

// A dedicated resolver so a hung nameserver can't stall the whole pass — the
// default dns.promises has no timeout knob and will wait indefinitely.
const resolver = new dns.promises.Resolver({ timeout: 5000, tries: 2 });

// Distinguishing "this domain has no mail server" from "DNS was unhappy just
// now" matters: the first is a permanent verdict, the second must expire fast,
// otherwise one flaky resolver moment blacklists a good domain for a month.
function classifyErr(code) {
  return (code === 'ENODATA' || code === 'ENOTFOUND' || code === 'NXDOMAIN') ? 'no_mx' : 'dns_fail';
}

async function classify(domain) {
  try {
    const mx = await resolver.resolveMx(domain);
    if (!mx.length) return 'no_mx';
    return mx.some((m) => GOOG.test(m.exchange)) ? 'google' : 'ok';
  } catch (e) {
    return classifyErr(e.code);
  }
}

async function main() {
  // Only domains the senders could actually pick: verified email contacts whose
  // cache row is absent or past its per-verdict re-check age.
  const staleCase = Object.entries(STALE)
    .map(([v, d]) => `WHEN mx.verdict='${v}' THEN mx.checked_at < NOW() - INTERVAL ${d} DAY`)
    .join(' ');
  const rows = await query(`
    SELECT DISTINCT cp.email_domain AS domain
    FROM contact_points cp
    LEFT JOIN email_domain_mx mx ON mx.domain = cp.email_domain
    WHERE cp.type='email' AND cp.status='verified' AND cp.email_domain IS NOT NULL
      AND (mx.domain IS NULL OR CASE ${staleCase} ELSE TRUE END)
    ${LIMIT ? 'LIMIT ' + LIMIT : ''}`);

  log(`${rows.length} domain(s) to resolve (concurrency ${CONCURRENCY}${DRY ? ', DRY RUN' : ''})`);
  if (!rows.length) { log('cache already warm — nothing to do'); return; }

  const tally = { ok: 0, google: 0, no_mx: 0, dns_fail: 0 };
  let done = 0, cursor = 0;

  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= rows.length) return;
      const domain = rows[i].domain;
      const verdict = await classify(domain);
      tally[verdict]++;
      if (!DRY) {
        await query(
          `INSERT INTO email_domain_mx (domain, sendable, verdict) VALUES (?,?,?)
           ON DUPLICATE KEY UPDATE sendable=VALUES(sendable), verdict=VALUES(verdict)`,
          [domain, verdict === 'ok' ? 1 : 0, verdict],
        ).catch((e) => log(`WARN upsert ${domain}: ${e.message}`));
      }
      if (++done % 2000 === 0) log(`${done}/${rows.length} — ${JSON.stringify(tally)}`);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  log(`DONE ${done} resolved — ${JSON.stringify(tally)}`);
  log(`sendable: ${tally.ok} (${(100 * tally.ok / done).toFixed(1)}%)`);
}

main().then(() => process.exit(0)).catch((e) => { console.error('FATAL', e); process.exit(1); });
