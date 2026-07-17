// Removes reputation-blocked recipients from Postal's own suppression list.
//
// Why this exists: Postal suppresses a recipient after a SINGLE failure, despite
// the reason reading "too many hard fails" —
// app/lib/message_dequeuer/outgoing_message_processor.rb:
//     return if recent_hard_fails < 1
// (the current failure is already counted, so one is enough). The entry lasts 30
// days, and every later message to that address is silently marked Held: SMTP
// still answers 250 OK to the sender, the message is accepted, and it is simply
// never delivered. Nothing surfaces as an error anywhere.
//
// That is correct behaviour for a dead mailbox. It is wrong for a Gmail
// reputation block — "550-5.7.1 ... very low reputation of the sending domain"
// says nothing about the recipient, only about us. Yet Postal benches the
// perfectly valid address for a month. During a reputation dip this quietly
// eats every Gmail recipient we touch, one 5.7.1 at a time.
//
// Real case (2026-07-12): cloudkroter@gmail.com hard-failed on a 5.7.1
// reputation block, was suppressed until 2026-08-11, and every send to it since
// was Held. It looked from the outside exactly like "Postal accepts but never
// delivers".
//
// Conservative by design: an entry is removed only when the failure is clearly
// reputational/transient AND does not also look like a genuinely bad mailbox.
// Anything unclassifiable (no failure output retained) is left alone — wrongly
// un-suppressing a dead address means sending to it again and hurting the very
// reputation this protects.
//
// Postal re-adds an address on its next hard fail, so this is not a permanent
// override — it just stops a reputation blip from turning into a 30-day ban.
//
//   docker cp scripts/postal_unsuppress_reputation.mjs "$(docker compose ps -q api)":/app/postal_unsuppress_reputation.mjs
//   docker compose exec -T api node /app/postal_unsuppress_reputation.mjs [--dry-run]
import { query } from './dist/db.js';

const DRY = process.argv.includes('--dry-run');
const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const log = (m) => console.log(`[${now()}] postal_unsuppress: ${m}`);

// Kept in lockstep with syncPostalBounces() in scripts/warmup_send.mjs, which
// makes the same call in the opposite direction (what to suppress on OUR side).
const INVALID = /(5\.1\.[013]|user unknown|no such (user|mailbox|recipient)|mailbox (unavailable|not found|does not exist|disabled|full)|recipient (unknown|rejected|not found|address rejected)|address (rejected|not found)|does not exist|no mailbox|account.*(disabled|closed|suspended))/i;
const REPUTATION = /(5\.7\.1|reputation|spam|blocked|blacklist|rp\.emails\.cheap|sender address rejected|greylist|try again|rate|deferred|temporar)/i;

async function main() {
  // Latest failure output per suppressed address — that's the evidence we judge on.
  let rows = [];
  try {
    rows = await query(`
      SELECT s.id, s.address, s.reason, d.output
        FROM \`postal-server-1\`.suppressions s
        LEFT JOIN \`postal-server-1\`.messages m ON m.id = (
            SELECT m2.id FROM \`postal-server-1\`.messages m2
             WHERE m2.rcpt_to = s.address AND m2.status IN ('HardFail','SoftFail')
             ORDER BY m2.timestamp DESC LIMIT 1)
        LEFT JOIN \`postal-server-1\`.deliveries d ON d.id = (
            SELECT MAX(d2.id) FROM \`postal-server-1\`.deliveries d2 WHERE d2.message_id = m.id)`);
  } catch (e) {
    log(`cannot read Postal suppression list: ${e.message}`);
    return;
  }

  let removed = 0, failed = 0, keptInvalid = 0, keptUnknown = 0;
  for (const r of rows) {
    const out = r.output || '';
    if (!out) { keptUnknown++; continue; }                       // no evidence -> don't guess
    if (!REPUTATION.test(out)) { keptInvalid++; continue; }      // not a reputation block
    if (INVALID.test(out)) { keptInvalid++; continue; }          // also looks like a dead mailbox
    if (!DRY) {
      // Must not be swallowed: a failed DELETE that still counts as removed
      // reports the address as unblocked while Postal goes on holding its mail.
      try {
        await query('DELETE FROM `postal-server-1`.suppressions WHERE id=?', [r.id]);
      } catch (e) {
        failed++;
        log(`FAILED to remove ${r.address}: ${e.message}`);
        continue;
      }
    }
    removed++;
    log(`${DRY ? 'WOULD REMOVE' : 'removed'} ${r.address} (${r.reason}) — ${out.replace(/\s+/g, ' ').slice(0, 90)}`);
  }

  log(`DONE: ${removed} reputation-blocked entr(ies) ${DRY ? 'would be ' : ''}removed`
    + `${failed ? `, ${failed} FAILED` : ''}; kept ${keptInvalid} genuinely-invalid, ${keptUnknown} unclassifiable`);
  if (removed) log('note: already-Held messages are NOT retried by Postal — they must be re-sent');
  if (failed) process.exitCode = 1;
}

main().then(() => process.exit(0)).catch((e) => { console.error('FATAL', e); process.exit(1); });
