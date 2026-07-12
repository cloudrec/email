// Batch-verify contact_points emails (status='discovered') using the internal
// verifyEmail service (syntax + MX + disposable + role). No SMTP probe.
// Run inside the api container from /app/dist:
//   node /app/dist/verify-contact-points.mjs
import { verifyEmail } from './services/leadVerify.js';
import { query, pool } from './db.js';

const CONCURRENCY = 40;
const STATUS_MAP = { valid: 'verified', invalid: 'invalid', risky: 'risky' }; // unknown -> leave discovered

async function main() {
  const rows = await query(
    "SELECT id, value FROM contact_points WHERE type='email' AND status='discovered' ORDER BY id",
  );
  const total = rows.length;
  console.log(`[verify] ${total} emails to verify, concurrency=${CONCURRENCY}`);

  let i = 0;
  let done = 0;
  const counts = { verified: 0, invalid: 0, risky: 0, skipped: 0 };

  async function worker() {
    while (i < total) {
      const row = rows[i++];
      try {
        const v = await verifyEmail(row.value);
        const newStatus = STATUS_MAP[v.result];
        if (!newStatus) { counts.skipped++; }
        else {
          await query(
            'UPDATE contact_points SET status=?, verification_score=?, verified_at=NOW() WHERE id=?',
            [newStatus, v.score, row.id],
          );
          counts[newStatus]++;
        }
      } catch (e) {
        counts.skipped++;
      }
      if (++done % 2000 === 0) {
        console.log(`[verify] ${done}/${total} | verified=${counts.verified} invalid=${counts.invalid} risky=${counts.risky} skipped=${counts.skipped}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`[verify] DONE ${done}/${total} | verified=${counts.verified} invalid=${counts.invalid} risky=${counts.risky} skipped=${counts.skipped}`);
  await pool.end();
}

main().catch((e) => { console.error('[verify] FATAL', e); process.exit(1); });
