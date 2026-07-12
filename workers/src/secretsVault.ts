// Worker-side secrets vault. Hardened mirror of api/src/services/secretsVault.ts
// (the two packages can't share code). Single authoritative resolver for the
// worker — campaignRunner and manualOutreachDrip both use this instead of their
// own inline copies (which lacked the allowlist + used an insecure key fallback).
import crypto from 'node:crypto';
import { query } from './db.js';

// Prefer a dedicated SECRETS_MASTER_KEY; fall back to API_JWT_SECRET. Refuse to
// run on a missing/placeholder/too-short key so stored SMTP/IMAP secrets are never
// keyed off a publicly-known constant. (Same policy + same derived key as the API,
// so existing mailbox_secrets decrypt unchanged.)
const MASTER = process.env.SECRETS_MASTER_KEY || process.env.API_JWT_SECRET || '';
if (!MASTER || MASTER.length < 16 || MASTER.startsWith('CHANGE_ME')) {
  throw new Error('secretsVault(worker): SECRETS_MASTER_KEY/API_JWT_SECRET missing/placeholder — refusing to start');
}
const KEY = crypto.createHash('sha256').update(MASTER).digest();

// Env fallback is restricted to mailbox-credential ref shapes only — blocks the
// exfiltration vector where a tenant sets smtp_secret_ref='DB_PASSWORD' (etc.) and
// points the mailbox at an attacker SMTP host to AUTH-leak an arbitrary env value.
const ENV_REF_ALLOWED = /^[A-Z0-9_]+_(?:SMTP|IMAP)_(?:USER|PASSWORD)$/;

export function decryptSecret(b64: string): string {
  const buf = Buffer.from(b64, 'base64');
  const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), ct = buf.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

/** DB-first (mailbox_secrets), env-fallback restricted to credential ref shapes. */
export async function resolveSecret(ref: string | null | undefined): Promise<string | undefined> {
  if (!ref) return undefined;
  try {
    const rows = await query('SELECT value_enc FROM mailbox_secrets WHERE ref_name=? LIMIT 1', [ref]);
    if (rows.length && rows[0].value_enc) {
      try { return decryptSecret(rows[0].value_enc); } catch { /* fall through to env */ }
    }
  } catch { /* table may not exist yet — fall back to env */ }
  if (!ENV_REF_ALLOWED.test(ref)) return undefined;
  const v = process.env[ref];
  return v && v.length ? v : undefined;
}
