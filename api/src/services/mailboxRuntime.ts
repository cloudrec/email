// Phase 22 — Provider-neutral mailbox runtime.
// Generalizes the Zoho bridge: given a sending_providers row (which stores ONLY
// env-var NAMES, never secrets), resolve credentials from process.env at call
// time and run:
//   • SMTP test  — EHLO + AUTH verify ONLY, NEVER sends an email
//   • IMAP test  — connect + open INBOX read-only, NEVER deletes/moves mail
//   • reply fetch — low-volume incremental, read-only, hard-capped
// Secrets are resolved in-memory only and NEVER logged or returned.

import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { resolveSecret } from './secretsVault.js';

export type ProviderRow = {
  id: number;
  provider_type: string;
  name: string | null;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_secure: number | null;
  imap_host: string | null;
  imap_port: number | null;
  imap_secure: number | null;
  smtp_user_ref: string | null;
  smtp_secret_ref: string | null;
  imap_user_ref: string | null;
  imap_secret_ref: string | null;
  username_ref?: string | null; // legacy
  secret_ref?: string | null;   // legacy
  inbound_enabled: number | null;
  outbound_enabled: number | null;
};

export type MailboxConn = {
  providerId: number;
  providerType: string;
  smtpHost: string; smtpPort: number; smtpSecure: boolean;
  imapHost: string; imapPort: number; imapSecure: boolean;
  smtpUserRef: string; smtpSecretRef: string;
  imapUserRef: string; imapSecretRef: string;
  smtpUserPresent: boolean; smtpSecretPresent: boolean;
  imapUserPresent: boolean; imapSecretPresent: boolean;
  smtpConfigured: boolean; imapConfigured: boolean;
  inboundEnabled: boolean; outboundEnabled: boolean;
};

function present(ref: string | null | undefined): boolean {
  if (!ref) return false;
  const v = process.env[ref];
  return !!(v && v.trim().length);
}

/** Resolve a provider row into a runtime connection descriptor (presence only — no secret values). */
export function resolveProvider(row: ProviderRow): MailboxConn {
  const smtpUserRef = row.smtp_user_ref || row.username_ref || '';
  const smtpSecretRef = row.smtp_secret_ref || row.secret_ref || '';
  const imapUserRef = row.imap_user_ref || smtpUserRef || '';
  const imapSecretRef = row.imap_secret_ref || smtpSecretRef || '';
  const smtpUserPresent = present(smtpUserRef);
  const smtpSecretPresent = present(smtpSecretRef);
  const imapUserPresent = present(imapUserRef);
  const imapSecretPresent = present(imapSecretRef);
  return {
    providerId: row.id,
    providerType: row.provider_type,
    smtpHost: row.smtp_host || '',
    smtpPort: Number(row.smtp_port || 587),
    smtpSecure: row.smtp_secure === 1 || Number(row.smtp_port) === 465,
    imapHost: row.imap_host || '',
    imapPort: Number(row.imap_port || 993),
    imapSecure: row.imap_secure !== 0,
    smtpUserRef, smtpSecretRef, imapUserRef, imapSecretRef,
    smtpUserPresent, smtpSecretPresent, imapUserPresent, imapSecretPresent,
    // Configured means the host + ref names exist.
    // Actual secrets are resolved later by resolveSecret(), DB-first then env fallback.
    smtpConfigured: !!row.smtp_host && !!smtpUserRef && !!smtpSecretRef,
    imapConfigured: !!row.imap_host && !!imapUserRef && !!imapSecretRef,
    inboundEnabled: row.inbound_enabled === 1,
    outboundEnabled: row.outbound_enabled !== 0,
  };
}

/** SMTP EHLO + AUTH only. Does NOT send. Returns scrubbed detail. */
export async function testSmtp(conn: MailboxConn): Promise<{ ok: boolean; detail: string; configured: boolean }> {
  if (!conn.smtpHost) return { ok: false, detail: 'not_configured', configured: false };
  // DB-stored (UI-entered) creds take priority, then .env fallback.
  const user = await resolveSecret(conn.smtpUserRef);
  const pass = await resolveSecret(conn.smtpSecretRef);
  if (!user || !pass) return { ok: false, detail: 'not_configured', configured: false };
  try {
    const t = nodemailer.createTransport({
      host: conn.smtpHost, port: conn.smtpPort, secure: conn.smtpPort === 465,
      requireTLS: conn.smtpPort === 587, auth: { user, pass },
      connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 8000,
    });
    await t.verify();
    t.close();
    return { ok: true, detail: 'verify_ok', configured: true };
  } catch (e: any) {
    return { ok: false, detail: `verify_err:${e?.code ?? e?.name ?? 'unknown'}`, configured: true };
  }
}

/**
 * Provider-neutral REAL send. Resolves SMTP creds from the vault (DB-first, env
 * fallback) and sends one message. NEVER logs the secret. Caller is responsible
 * for all pre-send gating (approved / opt-out / suppression / caps).
 */
export async function sendFromMailbox(
  conn: MailboxConn,
  msg: { from: string; to: string; subject: string; text: string; html?: string },
): Promise<{ ok: boolean; detail: string }> {
  if (!conn.smtpHost) return { ok: false, detail: 'not_configured' };
  const user = await resolveSecret(conn.smtpUserRef);
  const pass = await resolveSecret(conn.smtpSecretRef);
  if (!user || !pass) return { ok: false, detail: 'not_configured' };
  try {
    const t = nodemailer.createTransport({
      host: conn.smtpHost, port: conn.smtpPort, secure: conn.smtpPort === 465,
      requireTLS: conn.smtpPort === 587, auth: { user, pass },
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
    });
    await t.sendMail({ from: msg.from || user, to: msg.to, subject: msg.subject || '(no subject)', text: msg.text || '', ...(msg.html ? { html: msg.html } : {}) });
    t.close();
    return { ok: true, detail: 'sent' };
  } catch (e: any) {
    return { ok: false, detail: `smtp_err:${e?.code ?? e?.name ?? 'unknown'}` };
  }
}

async function imapClient(conn: MailboxConn): Promise<ImapFlow | null> {
  // DB-stored (UI-entered) creds take priority, then .env fallback.
  const user = await resolveSecret(conn.imapUserRef);
  const pass = await resolveSecret(conn.imapSecretRef);
  if (!user || !pass) return null;
  return new ImapFlow({
    host: conn.imapHost, port: conn.imapPort, secure: conn.imapSecure,
    auth: { user, pass }, logger: false, socketTimeout: 15000,
  });
}

/** Connect + open INBOX read-only, report message count, logout. Reads NO bodies. */
export async function testImap(conn: MailboxConn): Promise<{ ok: boolean; detail: string; configured: boolean; messages?: number }> {
  if (!conn.imapHost) return { ok: false, detail: 'not_configured', configured: false };
  let client: ImapFlow | null = null;
  try {
    client = await imapClient(conn);
    if (!client) return { ok: false, detail: 'not_configured', configured: false };
    await client.connect();
    const mbox = await client.mailboxOpen('INBOX', { readOnly: true });
    const messages = typeof mbox.exists === 'number' ? mbox.exists : undefined;
    await client.logout();
    return { ok: true, detail: 'imap_ok', configured: true, messages };
  } catch (e: any) {
    try { await client?.logout(); } catch { /* ignore */ }
    return { ok: false, detail: `imap_err:${e?.code ?? e?.responseText ?? e?.name ?? 'unknown'}`.slice(0, 200), configured: true };
  }
}

export type ImportedReply = {
  messageId: string; fromEmail: string | null; fromName: string | null;
  subject: string | null; snippet: string | null; receivedAt: Date | null; uid: number;
  rawBody?: string | null;
};

/** Extract clean plain text from a mailparser parsed message. */
function extractBodyText(parsed: any): string {
  if (parsed.text) {
    return parsed.text.replace(/\s+/g, ' ').trim();
  }
  if (parsed.html) {
    let html = parsed.html;
    html = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    html = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    html = html.replace(/<[^>]+>/g, '');
    html = html.replace(/&nbsp;/gi, ' ');
    html = html.replace(/&amp;/gi, '&');
    html = html.replace(/&lt;/gi, '<');
    html = html.replace(/&gt;/gi, '>');
    html = html.replace(/&quot;/gi, '"');
    html = html.replace(/&#(\d+);/g, (_m: string, n: string) => String.fromCharCode(Number(n)));
    return html.replace(/\s+/g, ' ').trim();
  }
  return '';
}

/** Low-volume incremental import. uid > sinceUid, on/after startAt. NO delete/move. Hard-capped.
 *  Uses full RFC822 source + mailparser simpleParser for reliable MIME body extraction. */
export async function fetchReplies(conn: MailboxConn, opts: {
  sinceUid?: number | null; startAt?: Date | null; limit?: number;
}): Promise<{ ok: boolean; detail: string; replies: ImportedReply[]; maxUid: number }> {
  if (!conn.imapHost) {
    return { ok: false, detail: 'not_configured', replies: [], maxUid: opts.sinceUid ?? 0 };
  }
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  let client: ImapFlow | null = null;
  const replies: ImportedReply[] = [];
  let maxUid = opts.sinceUid ?? 0;
  try {
    client = await imapClient(conn);
    if (!client) return { ok: false, detail: 'not_configured', replies: [], maxUid: opts.sinceUid ?? 0 };
    await client.connect();
    await client.mailboxOpen('INBOX', { readOnly: true });
    const range = (opts.sinceUid && opts.sinceUid > 0) ? `${opts.sinceUid + 1}:*` : '1:*';
    let count = 0;
    for await (const msg of client.fetch(range, { uid: true, envelope: true, bodyStructure: true, source: true }, { uid: true })) {
      if (!msg.uid || (opts.sinceUid && msg.uid <= opts.sinceUid)) continue;
      if (msg.uid > maxUid) maxUid = msg.uid;
      const env = msg.envelope;
      if (opts.startAt && env?.date && env.date < opts.startAt) continue;
      const from = env?.from?.[0];

      let snippet: string | null = null;
      let rawBody: string | null = null;

      // Parse full RFC822 source with mailparser for reliable body extraction.
      // imapflow source yields individual bytes (numbers), not Buffer chunks.
      if (msg.source) {
        try {
          const bytes: number[] = [];
          for await (const c of msg.source) {
            bytes.push(c as number);
            if (bytes.length > 100_000) break;
          }
          if (bytes.length) {
            const fullSource = Buffer.from(bytes);
            const parsed = await simpleParser(fullSource);
            rawBody = extractBodyText(parsed);
            snippet = rawBody.slice(0, 1000);
          }
        } catch { /* mailparser failure — fall through to envelope-only */ }
      }

      replies.push({
        messageId: env?.messageId || `uid-${msg.uid}`,
        fromEmail: from?.address ? String(from.address).toLowerCase() : null,
        fromName: from?.name || null,
        subject: env?.subject || null,
        snippet: snippet ?? null,
        rawBody: rawBody ?? null,
        receivedAt: env?.date ? new Date(env.date) : null,
        uid: msg.uid,
      });
      if (++count >= limit) break;
    }
    await client.logout();
    return { ok: true, detail: `imported:${replies.length}`, replies, maxUid };
  } catch (e: any) {
    try { await client?.logout(); } catch { /* ignore */ }
    return { ok: false, detail: `imap_err:${e?.code ?? e?.name ?? 'unknown'}`.slice(0, 200), replies, maxUid };
  }
}

// Reply classification now lives in the dependency-free ./replyClassifier module
// (so it can be unit-tested without pulling in db/config/imap). Re-exported here
// for existing callers.
export { classifyReply, type ReplyClass } from './replyClassifier.js';
