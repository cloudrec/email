// Phase 22E.2 — secrets vault.
// Lets operators store SMTP/IMAP credentials from the UI without editing .env.
// Values are AES-256-GCM encrypted at rest with a key derived from
// API_JWT_SECRET. Resolution order at call time: DB (mailbox_secrets) first,
// then process.env[ref] fallback (so existing .env-based mailboxes keep working).
// Secrets are decrypted in-memory only — never logged, never returned to clients.

import crypto from 'crypto';
import { query } from '../db.js';

// Master key for at-rest secret encryption. A dedicated SECRETS_MASTER_KEY is
// preferred; fall back to API_JWT_SECRET. Refuse to boot on the old hard-coded
// dev constant / a missing key so stored SMTP/IMAP secrets are never encrypted
// under a publicly-known key.
const MASTER = process.env.SECRETS_MASTER_KEY || process.env.API_JWT_SECRET || '';
if (!MASTER || MASTER.length < 16 || MASTER.startsWith('CHANGE_ME')) {
  throw new Error(
    'secretsVault: SECRETS_MASTER_KEY/API_JWT_SECRET is missing, too short, or a placeholder — refusing to start',
  );
}
const KEY = crypto.createHash('sha256').update(MASTER).digest(); // 32 bytes for aes-256-gcm

// Only these env-var name shapes may satisfy a tenant-supplied secret ref via the
// process.env fallback (legacy .env-based mailboxes). This blocks the exfiltration
// vector where a tenant sets smtp_secret_ref='API_JWT_SECRET' (or DB_PASSWORD,
// POSTAL_API_KEY, …) and points the mailbox at an attacker SMTP host to have the
// server AUTH-leak an arbitrary env value. Mailbox credential refs are always
// suffixed _SMTP_USER / _SMTP_PASSWORD / _IMAP_USER / _IMAP_PASSWORD.
const ENV_REF_ALLOWED = /^[A-Z0-9_]+_(?:SMTP|IMAP)_(?:USER|PASSWORD)$/;

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

export function decryptSecret(b64: string): string {
  const buf = Buffer.from(b64, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/** Store (upsert) a secret value under its env-var ref name, encrypted. */
export async function setSecret(tenantId: number, refName: string, plain: string): Promise<void> {
  if (!refName) return;
  const enc = encryptSecret(plain);
  await query(
    `INSERT INTO mailbox_secrets (tenant_id, ref_name, value_enc) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE value_enc=VALUES(value_enc), tenant_id=VALUES(tenant_id)`,
    [tenantId, refName, enc],
  );
}

/** DB-first, env-fallback. Returns undefined if neither has a value. */
export async function resolveSecret(refName: string | null | undefined): Promise<string | undefined> {
  if (!refName) return undefined;
  try {
    const rows = await query('SELECT value_enc FROM mailbox_secrets WHERE ref_name=? LIMIT 1', [refName]);
    if (rows.length && rows[0].value_enc) {
      try { return decryptSecret(rows[0].value_enc); } catch { /* fall through to env */ }
    }
  } catch { /* table may not exist yet — fall back to env */ }
  // Env fallback is restricted to mailbox-credential ref shapes only — never an
  // arbitrary server env var (see ENV_REF_ALLOWED above).
  if (!ENV_REF_ALLOWED.test(refName)) return undefined;
  const v = process.env[refName];
  return v && v.length ? v : undefined;
}

/** Presence check without exposing the value. */
export async function secretPresent(refName: string | null | undefined): Promise<boolean> {
  return !!(await resolveSecret(refName));
}

/** Which ref names currently have a DB-stored value (for UI "saved" badges). No values. */
export async function storedRefs(tenantId: number, refs: string[]): Promise<Set<string>> {
  const clean = refs.filter(Boolean);
  if (!clean.length) return new Set();
  const ph = clean.map(() => '?').join(',');
  const rows = await query(`SELECT ref_name FROM mailbox_secrets WHERE tenant_id=? AND ref_name IN (${ph})`, [tenantId, ...clean]);
  return new Set(rows.map((r: any) => r.ref_name));
}
