// Marks APPROVED affiliate offers PENDING_REVIEW once their terms verification goes
// stale (TZ §5: never silently keep using stale rules). Idempotent, safe to run on a
// schedule. Read-then-write only on affiliate_offers; touches nothing else.
//
//   docker cp scripts/affiliate_terms_review.mjs "$(docker compose ps -q api)":/app/affiliate_terms_review.mjs
//   docker compose exec -T api node /app/affiliate_terms_review.mjs [--max-age-days 30] [--dry-run]
import { query } from './dist/db.js';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const MAX_AGE = (() => { const i = args.indexOf('--max-age-days'); return i >= 0 ? +args[i + 1] : 30; })();
const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const log = (m) => console.log(`[${now()}] affiliate_terms_review: ${m}`);

const stale = await query(
  `SELECT id, offer_name, terms_verified_at FROM affiliate_offers
    WHERE status='APPROVED'
      AND (terms_verified_at IS NULL OR terms_verified_at < NOW() - INTERVAL ? DAY)`,
  [MAX_AGE]);

log(`${stale.length} APPROVED offer(s) with stale/unverified terms (max age ${MAX_AGE}d)`);
for (const o of stale) {
  log(`  ${DRY ? 'WOULD FLAG' : 'flag'} offer #${o.id} "${o.offer_name}" (terms_verified_at=${o.terms_verified_at ?? 'never'})`);
  if (!DRY) {
    await query('UPDATE affiliate_offers SET status=? WHERE id=?', ['PENDING_REVIEW', o.id]).catch((e) => log(`  WARN #${o.id}: ${e.message}`));
  }
}
log(`DONE: ${DRY ? 'dry run, ' : ''}${stale.length} offer(s) ${DRY ? 'would be' : ''} moved to PENDING_REVIEW`);
process.exit(0);
