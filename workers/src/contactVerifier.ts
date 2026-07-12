// contactVerifier.ts
// Continuously verifies contact_points emails (status='discovered') in the
// Warehouse: syntax + MX-record lookup + disposable + role check. No SMTP probe.
// Mirrors api/src/services/leadVerify.ts so the worker has no cross-package dep.
//
// status transitions on contact_points (type='email'):
//   no MX / no A  -> 'invalid'  (score 10)   terminal
//   disposable    -> 'risky'    (score 30)   terminal
//   role address  -> 'verified' (score 70)
//   normal        -> 'verified' (score 85)
// 'unknown' never produced here; rows that throw stay 'discovered' for retry.

import dns from 'node:dns/promises';
import { query } from './db.js';
import { logger } from './logger.js';

const TICK_INTERVAL_MS = 30_000;
const BATCH_SIZE = 300;

const ROLE_LOCAL_PARTS = new Set([
  'info', 'sales', 'support', 'admin', 'contact', 'hello', 'partnerships',
  'partner', 'office', 'team', 'help', 'service', 'inquiries', 'enquiries',
  'no-reply', 'noreply', 'postmaster', 'webmaster',
]);

const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'temp-mail.org', '10minutemail.com',
  'yopmail.com', 'getnada.com', 'sharklasers.com', 'throwawaymail.com',
]);

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

const mxCache = new Map<string, { ok: boolean; expires: number }>();
const MX_TTL_MS = 60 * 60 * 1000;

async function mxLookup(domain: string): Promise<boolean> {
  const cached = mxCache.get(domain);
  if (cached && cached.expires > Date.now()) return cached.ok;
  let ok = false;
  try {
    const records = await dns.resolveMx(domain);
    ok = records.length > 0 && records.some((r) => !!r.exchange);
  } catch {
    try {
      const a = await dns.resolve4(domain).catch(() => [] as string[]);
      ok = a.length > 0;
    } catch {
      ok = false;
    }
  }
  mxCache.set(domain, { ok, expires: Date.now() + MX_TTL_MS });
  return ok;
}

interface VerifyOutcome { status: 'verified' | 'invalid' | 'risky'; score: number; }

async function verifyEmail(email: string): Promise<VerifyOutcome> {
  const lower = email.trim().toLowerCase();
  if (!EMAIL_RE.test(lower)) return { status: 'invalid', score: 0 };
  const [local, domain] = lower.split('@');
  const role_address = ROLE_LOCAL_PARTS.has(local);
  const disposable = DISPOSABLE_DOMAINS.has(domain);
  const mx_ok = await mxLookup(domain);
  if (!mx_ok)        return { status: 'invalid', score: 10 };
  if (disposable)    return { status: 'risky',   score: 30 };
  if (role_address)  return { status: 'verified', score: 70 };
  return { status: 'verified', score: 85 };
}

const CONCURRENCY = 20;

async function tick(): Promise<void> {
  const rows = await query(
    `SELECT id, value FROM contact_points
     WHERE type='email' AND status='discovered'
     ORDER BY id ASC
     LIMIT ?`,
    [BATCH_SIZE],
  );
  if (!rows.length) return;

  const counts = { verified: 0, invalid: 0, risky: 0, errors: 0 };
  let i = 0;

  async function worker(): Promise<void> {
    while (i < rows.length) {
      const row = rows[i++];
      try {
        const v = await verifyEmail(String(row.value));
        await query(
          'UPDATE contact_points SET status=?, verification_score=?, verified_at=NOW() WHERE id=?',
          [v.status, v.score, row.id],
        );
        counts[v.status]++;
      } catch (e: any) {
        // transient (DB/DNS) — leave 'discovered' for retry next tick
        counts.errors++;
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  logger.info({ ...counts, batch: rows.length }, 'contactVerifier: tick done');
}

export async function contactVerifierLoop(): Promise<void> {
  logger.info('contactVerifier: starting');
  // stagger startup so it does not collide with promoter/collector ticks
  await new Promise((r) => setTimeout(r, 8_000));

  while (true) {
    try {
      await tick();
    } catch (e: any) {
      logger.error({ err: e.message }, 'contactVerifier: tick error');
    }
    await new Promise((r) => setTimeout(r, TICK_INTERVAL_MS));
  }
}
