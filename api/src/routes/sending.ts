import { Router } from 'express';
import { z } from 'zod';
import net from 'node:net';
import nodemailer from 'nodemailer';
import { query } from '../db.js';
import { authMiddleware, requireTenant, requireWriteAccess } from '../middleware/auth.js';
import { audit } from '../middleware/audit.js';
import { config } from '../config.js';
import { evaluateSmtp } from './system.js';

export const sendingRouter = Router();
sendingRouter.use(authMiddleware, requireTenant);

// Provider-neutral relay registry. Phase 21.
// Secrets are NEVER stored in this table — `username_ref`/`secret_ref` are the
// NAMES of env vars (or future secret-store keys) that hold the real credential.
// test-connection resolves them at runtime and never echoes them back.

const PROVIDER_DEFAULTS: Record<string, { host?: string; port?: number; secure?: boolean }> = {
  generic:  {},
  brevo:    { host: 'smtp-relay.brevo.com', port: 587, secure: false },
  smtp2go:  { host: 'mail.smtp2go.com',     port: 587, secure: false },
  mailgun:  { host: 'smtp.mailgun.org',     port: 587, secure: false },
  wooxy:    {},
  postal:   {},
  ses:      { host: 'email-smtp.us-east-1.amazonaws.com', port: 587, secure: false },
  zoho_smtp_imap: { host: 'smtp.zoho.eu', port: 587, secure: false },
};

// Env fallback restricted to mailbox-credential ref shapes only — never an
// arbitrary server env var (prevents a tenant setting secret_ref='API_JWT_SECRET'
// and exfiltrating it via an attacker-controlled SMTP host). Mirrors the
// allow-list in services/secretsVault.ts.
const ENV_REF_ALLOWED = /^[A-Z0-9_]+_(?:SMTP|IMAP)_(?:USER|PASSWORD)$/;
function resolveSecret(ref: string | null | undefined): string | undefined {
  if (!ref || !ENV_REF_ALLOWED.test(ref)) return undefined;
  const v = process.env[ref];
  return v && v.length ? v : undefined;
}

async function tcpProbe(host: string, port: number, timeoutMs = 4000): Promise<{ ok: boolean; detail: string }> {
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

// ── List ─────────────────────────────────────────────────────────────────────
sendingRouter.get('/providers', async (req, res) => {
  const rows = await query(
    `SELECT id, provider_type, name, smtp_host, smtp_port, smtp_secure,
            username_ref, secret_ref, from_domain, status, last_verified_at, last_error,
            created_at, updated_at
     FROM sending_providers WHERE tenant_id=? ORDER BY id ASC`,
    [req.auth!.tenantId],
  );
  // Never expose resolved secret values — only whether the referenced env var is set.
  const providers = rows.map((r: any) => ({
    ...r,
    secret_ref: r.secret_ref ?? null,
    secret_present: !!resolveSecret(r.secret_ref),
    username_present: !!resolveSecret(r.username_ref),
  }));
  res.json({ providers });
});

const createSchema = z.object({
  providerType: z.enum(['generic', 'brevo', 'smtp2go', 'mailgun', 'wooxy', 'postal', 'ses', 'zoho_smtp_imap']),
  name: z.string().min(1).max(120),
  smtpHost: z.string().max(255).optional(),
  smtpPort: z.coerce.number().int().min(1).max(65535).optional(),
  smtpSecure: z.boolean().optional(),
  usernameRef: z.string().max(120).optional(),
  secretRef: z.string().max(120).optional(),
  fromDomain: z.string().max(255).optional(),
});

sendingRouter.post('/providers', requireWriteAccess, async (req, res) => {
  const p = createSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'invalid_body', detail: p.error.issues });
  const d = p.data;

  // Reject anything that smells like a real secret pasted into a *_ref field.
  for (const ref of [d.usernameRef, d.secretRef]) {
    if (ref && !/^[A-Z0-9_]+$/.test(ref)) {
      return res.status(400).json({ error: 'ref_must_be_env_var_name', detail: 'username_ref/secret_ref must be an UPPER_SNAKE env-var name, not a literal credential.' });
    }
  }

  const def = PROVIDER_DEFAULTS[d.providerType] ?? {};
  const r = await query(
    `INSERT INTO sending_providers
       (tenant_id, provider_type, name, smtp_host, smtp_port, smtp_secure,
        username_ref, secret_ref, from_domain, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [
      req.auth!.tenantId, d.providerType, d.name,
      d.smtpHost ?? def.host ?? null,
      d.smtpPort ?? def.port ?? null,
      (d.smtpSecure ?? def.secure ?? false) ? 1 : 0,
      d.usernameRef ?? null, d.secretRef ?? null, d.fromDomain ?? null,
    ],
  );
  const id = Number(r.insertId);
  await audit(req, 'sending_provider.create', { type: 'sending_provider', id }, { providerType: d.providerType, name: d.name });
  res.status(201).json({ id, status: 'pending' });
});

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  smtpHost: z.string().max(255).optional(),
  smtpPort: z.coerce.number().int().min(1).max(65535).optional(),
  smtpSecure: z.boolean().optional(),
  usernameRef: z.string().max(120).optional(),
  secretRef: z.string().max(120).optional(),
  fromDomain: z.string().max(255).optional(),
  status: z.enum(['pending', 'active', 'disabled']).optional(),
});

sendingRouter.patch('/providers/:id', requireWriteAccess, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const p = patchSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'invalid_body', detail: p.error.issues });
  const [row] = await query('SELECT id FROM sending_providers WHERE id=? AND tenant_id=? LIMIT 1', [id, req.auth!.tenantId]);
  if (!row) return res.status(404).json({ error: 'not_found' });

  const map: Record<string, string> = {
    name: 'name', smtpHost: 'smtp_host', smtpPort: 'smtp_port', smtpSecure: 'smtp_secure',
    usernameRef: 'username_ref', secretRef: 'secret_ref', fromDomain: 'from_domain', status: 'status',
  };
  const sets: string[] = [];
  const vals: any[] = [];
  for (const [k, col] of Object.entries(map)) {
    const v = (p.data as any)[k];
    if (v === undefined) continue;
    if ((k === 'usernameRef' || k === 'secretRef') && v && !/^[A-Z0-9_]+$/.test(v)) {
      return res.status(400).json({ error: 'ref_must_be_env_var_name' });
    }
    sets.push(`${col}=?`);
    vals.push(k === 'smtpSecure' ? (v ? 1 : 0) : v);
  }
  if (!sets.length) return res.json({ ok: true, unchanged: true });
  vals.push(id);
  await query(`UPDATE sending_providers SET ${sets.join(', ')} WHERE id=?`, vals);
  await audit(req, 'sending_provider.update', { type: 'sending_provider', id }, { fields: Object.keys(p.data) });
  res.json({ ok: true });
});

// ── Test connection — TCP + (optional) SMTP AUTH verify. NEVER sends an email. ──
sendingRouter.post('/providers/:id/test-connection', requireWriteAccess, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const [pv] = await query(
    'SELECT * FROM sending_providers WHERE id=? AND tenant_id=? LIMIT 1',
    [id, req.auth!.tenantId],
  );
  if (!pv) return res.status(404).json({ error: 'not_found' });

  const host = pv.smtp_host;
  const port = Number(pv.smtp_port) || 587;
  if (!host) {
    return res.status(412).json({ error: 'no_host', detail: 'Set smtp_host before testing. Provider can stay pending without credentials.' });
  }

  const tcp = await tcpProbe(host, port);
  let verify: { ok: boolean | null; detail: string } = { ok: null, detail: 'verify_skipped_no_credentials' };

  const user = resolveSecret(pv.username_ref);
  const pass = resolveSecret(pv.secret_ref);

  if (tcp.ok && user && pass) {
    try {
      const t = nodemailer.createTransport({
        host, port, secure: port === 465 || !!pv.smtp_secure,
        auth: { user, pass },
        connectionTimeout: 6000, greetingTimeout: 6000, socketTimeout: 6000,
      });
      await t.verify();   // EHLO + AUTH only — does NOT send.
      t.close();
      verify = { ok: true, detail: 'verify_ok' };
    } catch (e: any) {
      // Scrub anything that could echo the password back.
      verify = { ok: false, detail: `verify_err:${(e?.code ?? e?.name ?? 'unknown')}` };
    }
  }

  const ok = tcp.ok && verify.ok !== false;
  const newStatus = verify.ok === true ? 'active' : (tcp.ok ? 'pending' : 'error');
  await query(
    `UPDATE sending_providers
       SET status=?, last_verified_at=?, last_error=? WHERE id=?`,
    [newStatus, verify.ok === true ? new Date() : null, ok ? null : `${tcp.detail};${verify.detail}`.slice(0, 500), id],
  );
  await audit(req, 'sending_provider.test', { type: 'sending_provider', id }, { tcp: tcp.detail, verify: verify.detail, status: newStatus });

  res.json({
    ok,
    host, port,
    tcp_reachable: tcp.ok, tcp_detail: tcp.detail,
    auth_verified: verify.ok, verify_detail: verify.detail,
    credentials_present: !!(user && pass),
    status: newStatus,
    note: 'No email was sent. Verify performs SMTP EHLO/AUTH only.',
  });
});

sendingRouter.delete('/providers/:id', requireWriteAccess, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const [row] = await query('SELECT id FROM sending_providers WHERE id=? AND tenant_id=? LIMIT 1', [id, req.auth!.tenantId]);
  if (!row) return res.status(404).json({ error: 'not_found' });

  const used = await query(
    `SELECT (SELECT COUNT(*) FROM domains WHERE provider_id=?) +
            (SELECT COUNT(*) FROM sender_identities WHERE provider_id=?) AS c`,
    [id, id],
  );
  if (Number(used[0].c) > 0) {
    return res.status(409).json({ error: 'provider_in_use', detail: 'Detach this provider from all domains/mailboxes before deleting.' });
  }
  await query('DELETE FROM sending_providers WHERE id=?', [id]);
  await audit(req, 'sending_provider.delete', { type: 'sending_provider', id });
  res.json({ ok: true });
});

// ── Send-control aggregator ──────────────────────────────────────────────────
// Single read for the Send Control dashboard: SMTP state, domains+mailboxes with
// live limits/counters, providers, webhook config, kill switch, last webhook.
sendingRouter.get('/control-status', async (req, res) => {
  const tenantId = req.auth!.tenantId!;

  const smtp = await evaluateSmtp().catch(() => null);

  const domains = await query(
    `SELECT id, domain, type, purpose, status, dns_status, daily_send_limit,
            hourly_send_limit, reputation_score, warmup_stage, provider_id
     FROM domains WHERE tenant_id=? ORDER BY id ASC`,
    [tenantId],
  );

  const mailboxes = await query(
    `SELECT si.id, si.from_email, si.display_name, si.from_name, si.purpose, si.status,
            si.daily_send_limit, si.hourly_send_limit, si.sent_today, si.bounced_today,
            si.complained_today, si.unsubscribed_today, si.last_sent_at, si.warmup_stage,
            si.paused_reason, si.domain_id, d.domain, d.status AS domain_status
     FROM sender_identities si LEFT JOIN domains d ON d.id=si.domain_id
     WHERE si.tenant_id=? ORDER BY si.id ASC`,
    [tenantId],
  );

  const providers = await query(
    `SELECT id, provider_type, name, smtp_host, smtp_port, status, last_verified_at, last_error
     FROM sending_providers WHERE tenant_id=? ORDER BY id ASC`,
    [tenantId],
  );

  const [safety] = await query(
    'SELECT outreach_paused, outreach_paused_reason FROM tenant_safety_settings WHERE tenant_id=? LIMIT 1',
    [tenantId],
  );

  const [lastWebhook] = await query(
    `SELECT action, target_id, created_at FROM audit_log
     WHERE tenant_id=? AND action LIKE 'webhook.%' ORDER BY id DESC LIMIT 1`,
    [tenantId],
  );

  // Real sends happen through the manual-outreach queue (sent_smtp / sent_manual),
  // NOT the campaigns table. The page used to read campaigns only and showed 0 even
  // while mail was going out. Count the actual send channel here.
  const [sendAgg] = await query(
    `SELECT
       SUM(status IN ('sent_smtp','sent_manual')) AS total_sent,
       SUM(status IN ('sent_smtp','sent_manual') AND DATE(sent_at)=UTC_DATE()) AS sent_today,
       SUM(status='approved') AS approved_pending,
       SUM(status='pending_review') AS pending_review,
       MAX(sent_at) AS last_sent_at
     FROM manual_outreach_queue WHERE tenant_id=?`,
    [tenantId],
  );

  const webhookConfigured = !!config.webhooks.bounceSecret && !config.webhooks.bounceSecret.startsWith('CHANGE_ME');
  const webhookAdapters = ['bounce', 'brevo', 'smtp2go', 'mailgun', 'generic'].map((a) => ({
    name: a,
    path: `/api/webhooks/${a}`,
    configured: webhookConfigured,
  }));

  // Block-readiness summary (foundation gates).
  const verifiedDomains = domains.filter((d: any) => d.status === 'verified');
  const blockers: string[] = [];
  if (!smtp || smtp.state !== 'ready') blockers.push('no_production_smtp');
  if (!verifiedDomains.length) blockers.push('no_verified_domain');
  if (!mailboxes.some((m: any) => m.status === 'active')) blockers.push('no_active_mailbox');
  if (!webhookConfigured) blockers.push('webhook_secret_not_configured');
  const level = blockers.length === 0 ? 'safe' : (verifiedDomains.length ? 'warning' : 'danger');

  res.json({
    smtp: smtp ? { state: smtp.state, host: smtp.host, port: smtp.port, ready: smtp.ready_for_send } : null,
    domains, mailboxes, providers,
    killSwitch: { paused: !!safety?.outreach_paused, reason: safety?.outreach_paused_reason ?? null },
    webhooks: { configured: webhookConfigured, adapters: webhookAdapters, lastEvent: lastWebhook ?? null },
    readiness: { level, blockers },
    realWorldSends: Number(sendAgg?.total_sent ?? 0),
    sends: {
      total: Number(sendAgg?.total_sent ?? 0),
      today: Number(sendAgg?.sent_today ?? 0),
      approvedPending: Number(sendAgg?.approved_pending ?? 0),
      pendingReview: Number(sendAgg?.pending_review ?? 0),
      lastSentAt: sendAgg?.last_sent_at ?? null,
    },
  });
});
