// Phase 21A — Zoho manual bridge service.
// SMTP test (verify only, NEVER sends), IMAP test (connect only, no read-all),
// low-volume IMAP reply import, and deterministic reply classification.
// Secrets are resolved from process.env at call time and NEVER logged/echoed.

import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { config } from '../config.js';

export type ZohoPresence = {
  smtpHost: string; smtpPort: number; imapHost: string; imapPort: number;
  smtpUserRef: string; smtpPassRef: string; imapUserRef: string; imapPassRef: string;
  smtpUserPresent: boolean; smtpPassPresent: boolean;
  imapUserPresent: boolean; imapPassPresent: boolean;
  smtpConfigured: boolean; imapConfigured: boolean;
};

function present(ref: string): boolean {
  const v = process.env[ref];
  return !!(v && v.trim().length);
}

export function zohoPresence(): ZohoPresence {
  const z = config.zoho;
  const smtpUserPresent = present(z.smtpUserRef);
  const smtpPassPresent = present(z.smtpPassRef);
  const imapUserPresent = present(z.imapUserRef);
  const imapPassPresent = present(z.imapPassRef);
  return {
    smtpHost: z.smtpHost, smtpPort: z.smtpPort, imapHost: z.imapHost, imapPort: z.imapPort,
    smtpUserRef: z.smtpUserRef, smtpPassRef: z.smtpPassRef,
    imapUserRef: z.imapUserRef, imapPassRef: z.imapPassRef,
    smtpUserPresent, smtpPassPresent, imapUserPresent, imapPassPresent,
    smtpConfigured: smtpUserPresent && smtpPassPresent,
    imapConfigured: imapUserPresent && imapPassPresent,
  };
}

/** Bridge status string used by UI: not_configured / configured / smtp_ready / imap_ready / error */
export function zohoBridgeStatus(p: ZohoPresence): string {
  if (!p.smtpConfigured && !p.imapConfigured) return 'not_configured';
  if (p.smtpConfigured && p.imapConfigured) return 'configured';
  if (p.smtpConfigured) return 'smtp_ready';
  if (p.imapConfigured) return 'imap_ready';
  return 'not_configured';
}

/** SMTP EHLO + AUTH only. Does NOT send. Returns scrubbed detail. */
export async function testZohoSmtp(): Promise<{ ok: boolean; detail: string; configured: boolean }> {
  const z = config.zoho;
  const user = process.env[z.smtpUserRef];
  const pass = process.env[z.smtpPassRef];
  if (!user || !pass) return { ok: false, detail: 'not_configured', configured: false };
  try {
    const t = nodemailer.createTransport({
      host: z.smtpHost, port: z.smtpPort, secure: z.smtpPort === 465,
      requireTLS: z.smtpPort === 587,
      auth: { user, pass },
      connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 8000,
    });
    await t.verify();
    t.close();
    return { ok: true, detail: 'verify_ok', configured: true };
  } catch (e: any) {
    return { ok: false, detail: `verify_err:${e?.code ?? e?.name ?? 'unknown'}`, configured: true };
  }
}

function imapClient(): ImapFlow {
  const z = config.zoho;
  const user = process.env[z.imapUserRef]!;
  const pass = process.env[z.imapPassRef]!;
  return new ImapFlow({
    host: z.imapHost, port: z.imapPort, secure: true,
    auth: { user, pass }, logger: false,
    socketTimeout: 15000,
  });
}

/** Connect + open INBOX read-only, report message count, logout. Reads NO bodies. */
export async function testZohoImap(): Promise<{ ok: boolean; detail: string; configured: boolean; messages?: number }> {
  const z = config.zoho;
  if (!process.env[z.imapUserRef] || !process.env[z.imapPassRef]) {
    return { ok: false, detail: 'not_configured', configured: false };
  }
  let client: ImapFlow | null = null;
  try {
    client = imapClient();
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
};

/**
 * Low-volume incremental import. Reads recent INBOX messages with uid > sinceUid
 * (and on/after startAt). Does NOT delete or move anything. Hard cap on count.
 */
export async function fetchZohoReplies(opts: {
  sinceUid?: number | null; startAt?: Date | null; limit?: number;
}): Promise<{ ok: boolean; detail: string; replies: ImportedReply[]; maxUid: number }> {
  const z = config.zoho;
  if (!process.env[z.imapUserRef] || !process.env[z.imapPassRef]) {
    return { ok: false, detail: 'not_configured', replies: [], maxUid: opts.sinceUid ?? 0 };
  }
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  let client: ImapFlow | null = null;
  const replies: ImportedReply[] = [];
  let maxUid = opts.sinceUid ?? 0;
  try {
    client = imapClient();
    await client.connect();
    await client.mailboxOpen('INBOX', { readOnly: true });

    // Build a conservative search: messages after startAt, uid greater than last seen.
    const range = (opts.sinceUid && opts.sinceUid > 0) ? `${opts.sinceUid + 1}:*` : '1:*';
    const searchOpts: any = {};
    if (opts.startAt) searchOpts.since = opts.startAt;

    let count = 0;
    for await (const msg of client.fetch(range, { uid: true, envelope: true, bodyStructure: true, source: false }, { uid: true })) {
      if (!msg.uid || (opts.sinceUid && msg.uid <= opts.sinceUid)) continue;
      if (msg.uid > maxUid) maxUid = msg.uid;
      const env = msg.envelope;
      if (opts.startAt && env?.date && env.date < opts.startAt) continue;
      const from = env?.from?.[0];
      // Snippet: pull a small text part only (first ~600 chars). Best-effort.
      let snippet: string | null = null;
      try {
        const dl = await client.download(String(msg.uid), '1', { uid: true });
        if (dl?.content) {
          const chunks: Buffer[] = [];
          for await (const c of dl.content) { chunks.push(c as Buffer); if (Buffer.concat(chunks).length > 4000) break; }
          snippet = Buffer.concat(chunks).toString('utf8').replace(/\s+/g, ' ').trim().slice(0, 600);
        }
      } catch { /* snippet best-effort */ }
      replies.push({
        messageId: env?.messageId || `uid-${msg.uid}`,
        fromEmail: from?.address ? String(from.address).toLowerCase() : null,
        fromName: from?.name || null,
        subject: env?.subject || null,
        snippet,
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

export type ReplyClass =
  | 'interested' | 'not_interested' | 'do_not_contact' | 'wrong_person'
  | 'out_of_office' | 'bounce_like' | 'unknown';

/** Deterministic rule-based classification. LLM slot left for later. */
export function classifyReply(subject: string | null, snippet: string | null): {
  classification: ReplyClass; confidence: number; matched: string | null;
} {
  const text = `${subject ?? ''} \n ${snippet ?? ''}`.toLowerCase();
  const has = (...ws: string[]) => ws.find((w) => text.includes(w)) ?? null;

  let m: string | null;
  if ((m = has('unsubscribe', 'do not contact', "don't contact", 'remove me', 'stop emailing', 'opt out', 'opt-out', 'take me off')))
    return { classification: 'do_not_contact', confidence: 0.95, matched: m };
  if ((m = has('mail delivery', 'delivery failed', 'undeliverable', 'returned to sender', 'mailer-daemon', 'address not found', 'failure notice')))
    return { classification: 'bounce_like', confidence: 0.9, matched: m };
  if ((m = has('out of office', 'out of the office', 'auto-reply', 'autoreply', 'automatic reply', 'on annual leave', 'on holiday', 'maternity leave', 'currently away')))
    return { classification: 'out_of_office', confidence: 0.85, matched: m };
  if ((m = has('wrong person', 'no longer with', 'left the company', 'not the right', 'try contacting', 'forwarded to')))
    return { classification: 'wrong_person', confidence: 0.7, matched: m };
  if ((m = has('not interested', 'no thanks', 'no thank you', 'not for us', 'we already', 'not a fit', 'please stop')))
    return { classification: 'not_interested', confidence: 0.75, matched: m };
  if ((m = has('interested', 'tell me more', 'how much', 'pricing', 'book a call', 'happy to chat', 'sounds good', 'lets talk', "let's talk", 'more info')))
    return { classification: 'interested', confidence: 0.7, matched: m };
  return { classification: 'unknown', confidence: 0.0, matched: null };
}
