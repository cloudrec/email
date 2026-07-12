import dns from 'node:dns/promises';
import { query } from '../db.js';

// Role-address local parts considered "low engagement" but valid.
const ROLE_LOCAL_PARTS = new Set([
  'info', 'sales', 'support', 'admin', 'contact', 'hello', 'partnerships',
  'partner', 'office', 'team', 'help', 'service', 'inquiries', 'enquiries',
  'no-reply', 'noreply', 'postmaster', 'webmaster',
]);

// Disposable / temp email domains — minimal seed list. Extend over time.
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'temp-mail.org', '10minutemail.com',
  'yopmail.com', 'getnada.com', 'sharklasers.com', 'throwawaymail.com',
]);

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

export interface VerifyResult {
  syntax_ok: boolean;
  mx_ok: boolean;
  disposable: boolean;
  role_address: boolean;
  result: 'valid' | 'invalid' | 'risky' | 'unknown';
  score: number;
  detail: Record<string, any>;
}

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
      // Fallback: an A record allows mail per RFC 5321 §5.1
      const a = await dns.resolve4(domain).catch(() => [] as string[]);
      ok = a.length > 0;
    } catch {
      ok = false;
    }
  }
  mxCache.set(domain, { ok, expires: Date.now() + MX_TTL_MS });
  return ok;
}

export async function verifyEmail(email: string): Promise<VerifyResult> {
  const lower = email.trim().toLowerCase();
  const syntax_ok = EMAIL_RE.test(lower);
  if (!syntax_ok) {
    return { syntax_ok: false, mx_ok: false, disposable: false, role_address: false, result: 'invalid', score: 0, detail: { reason: 'syntax' } };
  }

  const [local, domain] = lower.split('@');
  const role_address = ROLE_LOCAL_PARTS.has(local);
  const disposable = DISPOSABLE_DOMAINS.has(domain);
  const mx_ok = await mxLookup(domain);

  let result: VerifyResult['result'];
  let score: number;
  if (!mx_ok)        { result = 'invalid'; score = 10; }
  else if (disposable) { result = 'risky'; score = 30; }
  else if (role_address) { result = 'valid'; score = 70; }
  else                 { result = 'valid'; score = 85; }

  return {
    syntax_ok,
    mx_ok,
    disposable,
    role_address,
    result,
    score,
    detail: { local, domain },
  };
}

export async function recordVerification(tenantId: number, leadId: number, v: VerifyResult, provider = 'internal'): Promise<void> {
  await query(
    `INSERT INTO lead_verification_results
       (tenant_id, lead_id, provider, syntax_ok, mx_ok, disposable, role_address, result, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [tenantId, leadId, provider, v.syntax_ok ? 1 : 0, v.mx_ok ? 1 : 0, v.disposable ? 1 : 0, v.role_address ? 1 : 0, v.result, JSON.stringify(v.detail)],
  );
  const leadStatus = v.result === 'valid' ? 'verified' :
                     v.result === 'invalid' ? 'invalid' :
                     v.result === 'risky'   ? 'risky'   : 'discovered';
  await query(
    'UPDATE discovered_leads SET status=?, verification_score=?, last_verified_at=NOW() WHERE id=? AND tenant_id=?',
    [leadStatus, v.score, leadId, tenantId],
  );
}

// External provider adapter contract (future Hunter/ZeroBounce/etc).
export interface ExternalVerifier {
  readonly name: string;
  verify(email: string): Promise<VerifyResult>;
}

const externalProviders = new Map<string, ExternalVerifier>();
export function registerVerifier(p: ExternalVerifier) { externalProviders.set(p.name, p); }
export function getVerifier(name = 'internal'): { verify: typeof verifyEmail } {
  if (name === 'internal') return { verify: verifyEmail };
  const p = externalProviders.get(name);
  if (!p) throw new Error(`Verifier not registered: ${name}`);
  return p;
}
