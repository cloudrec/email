import { Router } from 'express';
import { z } from 'zod';
import net from 'node:net';
import nodemailer from 'nodemailer';
import { authMiddleware, requireSuperAdmin } from '../middleware/auth.js';
import { audit } from '../middleware/audit.js';
import { query } from '../db.js';
import { config } from '../config.js';

export const systemRouter = Router();
systemRouter.use(authMiddleware);

// SMTP readiness state machine:
//   not_configured             — missing SMTP_HOST or SMTP_FROM_ADDRESS, or
//                                SMTP_HOST is the unstarted 'postal' placeholder
//   test_only_mailhog          — SMTP_HOST is Mailhog (local dev only, not a real provider)
//   configured_but_unreachable — TCP probe to host:port failed
//   auth_failed                — nodemailer verify() rejected (bad EHLO/auth)
//   ready                      — TCP reachable + verify() OK
export type SmtpState = 'not_configured' | 'test_only_mailhog' | 'configured_but_unreachable' | 'auth_failed' | 'ready';

interface SmtpStatus {
  state: SmtpState;
  configured: boolean;
  host: string;
  port: number;
  user_set: boolean;
  from_address: string;
  reachable: boolean | null;
  reachable_detail: string | null;
  verify_ok: boolean | null;
  verify_detail: string | null;
  warnings: string[];
  ready_for_send: boolean;
}

async function tcpProbe(host: string, port: number, timeoutMs = 3000): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok: boolean, detail: string) => { if (done) return; done = true; try { sock.destroy(); } catch {} resolve({ ok, detail }); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true, 'tcp_connect_ok'));
    sock.once('timeout', () => finish(false, 'tcp_timeout'));
    sock.once('error', (e) => finish(false, `tcp_err:${e.message}`));
    sock.connect(port, host);
  });
}

async function nodemailerVerify(): Promise<{ ok: boolean; detail: string }> {
  try {
    const t = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: config.smtp.user ? { user: config.smtp.user, pass: process.env.SMTP_PASSWORD ?? '' } : undefined,
      connectionTimeout: 5000,
      greetingTimeout: 5000,
      socketTimeout: 5000,
    });
    await t.verify();
    t.close();
    return { ok: true, detail: 'verify_ok' };
  } catch (e: any) {
    return { ok: false, detail: `verify_err:${(e?.code ?? e?.name ?? 'unknown')}:${String(e?.message ?? '').slice(0, 200)}` };
  }
}

// Phase 22H: check whether ANY sender_identity has a provider with a configured
// SMTP relay (host + resolvable credentials). Returns true when at least one
// mailbox can originate outbound mail through the provider-based path.
// Matches domain by extracting it from from_email (handles NULL domain_id).
export async function hasOperationalMailboxes(): Promise<boolean> {
  try {
    const rows = await query(
      `SELECT 1 FROM sender_identities si
        JOIN sending_providers p ON p.id = si.provider_id
        JOIN domains d ON d.status='verified'
                         AND d.domain = SUBSTRING_INDEX(si.from_email, '@', -1)
       WHERE si.status='active' AND si.outbound_enabled=1
         AND p.smtp_host IS NOT NULL AND p.smtp_host <> ''
       LIMIT 1`,
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

export async function evaluateSmtp(): Promise<SmtpStatus> {
  const warnings: string[] = [];
  const host = config.smtp.host;
  const port = config.smtp.port;
  const user = config.smtp.user;
  const from = config.smtp.fromAddress;
  const placeholderPostal = host === 'postal';
  const isMailhog = host === 'mailhog' || (host === 'localhost' && port === 1025) || (host === '127.0.0.1' && port === 1025);

  if (!host) warnings.push('SMTP_HOST not set');
  if (!from) warnings.push('SMTP_FROM_ADDRESS not set');
  if (placeholderPostal) warnings.push("SMTP_HOST='postal' placeholder — start Postal (docker compose --profile smtp up -d postal) OR set SMTP_HOST to an external relay");
  if (isMailhog) warnings.push('SMTP_HOST is Mailhog (local test only) — configure a real provider (Brevo recommended first, SMTP2GO fallback, Mailgun, SES later; Postmark NOT recommended for cold outreach) for production campaigns. Real campaign scheduling is blocked.');
  if (host && !user && !placeholderPostal && !isMailhog) warnings.push('SMTP_USER empty — only acceptable for fully open relays you control');

  let reachable: boolean | null = null;
  let reachableDetail: string | null = null;
  let verifyOk: boolean | null = null;
  let verifyDetail: string | null = null;

  if (host && !placeholderPostal && !isMailhog) {
    const p = await tcpProbe(host, port);
    reachable = p.ok;
    reachableDetail = p.detail;
    if (!p.ok) warnings.push(`SMTP host unreachable: ${p.detail}`);

    if (p.ok) {
      const v = await nodemailerVerify();
      verifyOk = v.ok;
      verifyDetail = v.detail;
      if (!v.ok) warnings.push(`SMTP verify failed: ${v.detail}`);
    }
  }

  let state: SmtpState;
  if (!host || !from || placeholderPostal)  state = 'not_configured';
  else if (isMailhog)                        state = 'test_only_mailhog';
  else if (reachable === false)              state = 'configured_but_unreachable';
  else if (verifyOk === false)               state = 'auth_failed';
  else                                       state = 'ready';

  return {
    state,
    configured: !!host && !!from && !placeholderPostal,
    host,
    port,
    user_set: !!user,
    from_address: from,
    reachable,
    reachable_detail: reachableDetail,
    verify_ok: verifyOk,
    verify_detail: verifyDetail,
    warnings,
    ready_for_send: state === 'ready',
  };
}

systemRouter.get('/smtp-status', requireSuperAdmin, async (_req, res) => {
  res.json(await evaluateSmtp());
});

systemRouter.get('/info', requireSuperAdmin, async (_req, res) => {
  res.json({
    env: config.env,
    platformDomain: config.platformDomain,
    defaultLocale: config.defaultLocale,
    billingDefaultProvider: config.billing.defaultProvider,
    webhookSecretConfigured: !!config.webhooks.bounceSecret && !config.webhooks.bounceSecret.startsWith('CHANGE_ME'),
  });
});

// First-real-test-send: send exactly ONE email directly via nodemailer.
// Requires: SMTP state=ready, verified domain, sender identity.
// Rate-limit: 1 per 5 minutes per user (audit_log check).
// Logs: system.first_test_send to audit_log.
const firstTestSchema = z.object({
  to: z.string().email(),
});

systemRouter.post('/first-test-send', requireSuperAdmin, async (req, res) => {
  const parsed = firstTestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', detail: 'to must be a valid email' });
  const { to } = parsed.data;

  // Gate 1: SMTP must be production-ready
  const smtp = await evaluateSmtp();
  if (smtp.state !== 'ready') {
    return res.status(412).json({
      error: 'smtp_not_ready', smtpState: smtp.state,
      detail: smtp.state === 'test_only_mailhog'
        ? 'SMTP is Mailhog. Set a real provider in .env and restart api + worker.'
        : `SMTP not ready: ${smtp.state}`,
    });
  }

  // Gate 2: must have a verified sending domain
  const domains = await query(
    "SELECT id, domain, dkim_selector FROM domains WHERE status='verified' LIMIT 1",
    [],
  );
  if (!domains.length) {
    return res.status(412).json({ error: 'no_verified_domain', detail: 'No verified sending domain. Verify a domain in /domains first.' });
  }
  const sendingDomain = domains[0];

  // Gate 3: must have an ACTIVE sender identity (mailbox)
  const identities = await query(
    "SELECT id, from_email, from_name FROM sender_identities WHERE status='active' ORDER BY is_default DESC, id ASC LIMIT 1",
    [],
  );
  if (!identities.length) {
    return res.status(412).json({ error: 'no_active_sender_identity', detail: 'No active sender identity (mailbox) found. Create/activate one in /domains.' });
  }
  const identity = identities[0];

  // Gate 4: global kill switch — if outreach is paused for the tenant, block.
  const paused = await query(
    "SELECT outreach_paused, outreach_paused_reason FROM tenant_safety_settings WHERE outreach_paused=1 LIMIT 1",
    [],
  );
  if (paused.length) {
    return res.status(423).json({ error: 'outreach_paused', detail: `Sending kill switch is active: ${paused[0].outreach_paused_reason ?? 'paused'}. Clear it before sending.` });
  }

  // Rate limit: no more than 1 first-test-send per 5 minutes
  const recent = await query(
    "SELECT id FROM audit_log WHERE action='system.first_test_send' AND created_at > DATE_SUB(NOW(), INTERVAL 5 MINUTE) LIMIT 1",
    [],
  );
  if (recent.length) {
    return res.status(429).json({ error: 'rate_limited', detail: 'A first-test-send was already sent in the last 5 minutes. Wait and try again.' });
  }

  // Send directly via nodemailer
  const from = `"${config.smtp.fromName || identity.from_name}" <${config.smtp.fromAddress || identity.from_email}>`;
  const text = [
    `Hi,`,
    ``,
    `This is a one-time deliverability test from the Emails Cheap platform.`,
    `If you received this, the sending infrastructure (${sendingDomain.domain}) is working correctly.`,
    ``,
    `Sent via: ${smtp.host}:${smtp.port}`,
    `From: ${from}`,
    `Domain: ${sendingDomain.domain} (DKIM selector: ${sendingDomain.dkim_selector})`,
    ``,
    `To stop receiving messages: reply STOP or contact ${config.smtp.fromAddress || identity.from_email}.`,
    ``,
    `---`,
    `emails.cheap`,
  ].join('\n');

  try {
    const transport = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: config.smtp.user ? { user: config.smtp.user, pass: process.env.SMTP_PASSWORD ?? '' } : undefined,
      connectionTimeout: 8000,
      greetingTimeout: 8000,
      socketTimeout: 8000,
    });

    const info = await transport.sendMail({
      from,
      to,
      subject: `Deliverability test — ${sendingDomain.domain}`,
      text,
    });
    transport.close();

    await audit(req, 'system.first_test_send', {}, { to, messageId: info.messageId, smtpHost: smtp.host, domain: sendingDomain.domain });

    return res.json({ ok: true, messageId: info.messageId, to, from, domain: sendingDomain.domain });
  } catch (e: any) {
    await audit(req, 'system.first_test_send_failed', {}, { to, error: String(e?.message ?? e).slice(0, 500) });
    return res.status(502).json({ error: 'send_failed', detail: String(e?.message ?? e).slice(0, 500) });
  }
});
