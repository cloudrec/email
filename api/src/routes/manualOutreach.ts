import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { authMiddleware, requireTenant, requireWriteAccess } from '../middleware/auth.js';
import { audit } from '../middleware/audit.js';
import { addSuppression } from '../services/suppression.js';
import { contentBlockers } from '../services/outboundContentGuard.js';
import { redis } from '../redis.js';
import {
  zohoPresence, zohoBridgeStatus, testZohoSmtp, testZohoImap,
} from '../services/zoho.js';
import {
  resolveProvider, testSmtp as rtTestSmtp, testImap as rtTestImap,
  sendFromMailbox as rtSendFromMailbox, fetchReplies as rtFetchReplies,
  classifyReply, type ProviderRow, type MailboxConn,
} from '../services/mailboxRuntime.js';
import {
  parseBounceContent, isBounceSender, isMailerDaemon, shouldAutoSuppressBounce, type BounceParseResult,
} from '../services/bounceParser.js';
import {
  recordTouchpoint, assignMailboxes, priorMailboxMaps, rollMailboxCounters,
  type AssignItem, type AssignStrategy,
} from '../services/mailboxFleet.js';

// Phase 21A — Manual Outreach (Zoho zero-budget bridge).
// Operator-driven, one-by-one. NO bulk send, NO scheduler, NO mass subscribe.

export const manualOutreachRouter = Router();
manualOutreachRouter.use(authMiddleware, requireTenant);

export const QUEUE_DEFAULT_MAX = 20;
export const QUEUE_HARD_MAX = 50;
export const DEFAULT_DAILY = 5;

// Warmup schedule for the Zoho manual bridge (recommendation only, never auto-applied).
function recommendedLimit(dayIndex: number): number {
  if (dayIndex <= 1) return 5;
  if (dayIndex <= 3) return 10;
  if (dayIndex <= 7) return 15;
  return 20;
}

function hasOptOut(body: string | null | undefined): boolean {
  if (!body) return false;
  const t = body.toLowerCase();
  return /unsubscribe|opt[\s-]?out|reply\s+["'“”]?\s*stop|\bstop\b.*won'?t email|no longer wish|reply .*to stop|don'?t want to hear|i'?ll remove you|i won'?t email again/.test(t);
}

export async function isEmailSuppressed(tenantId: number, email: string): Promise<boolean> {
  const e = email.toLowerCase();
  const domain = e.split('@')[1] ?? '';
  const rows = await query(
    `SELECT 1 FROM suppressions WHERE tenant_id=? AND email=? LIMIT 1`, [tenantId, e],
  );
  if (rows.length) return true;
  const g = await query(
    `SELECT 1 FROM global_contact_suppression
     WHERE (type='email' AND normalized_value=?) OR (type='domain' AND normalized_value=?) LIMIT 1`,
    [e, domain],
  );
  return g.length > 0;
}

// Roll per-mailbox manual counter to today, return the row with fresh counters.
async function mailboxWithCounters(tenantId: number, mailboxId: number): Promise<any | null> {
  const [m] = await query('SELECT * FROM sender_identities WHERE id=? AND tenant_id=? LIMIT 1', [mailboxId, tenantId]);
  if (!m) return null;
  const today = new Date().toISOString().slice(0, 10);
  const day = m.manual_counters_day ? new Date(m.manual_counters_day).toISOString().slice(0, 10) : null;
  if (day !== today) {
    await query('UPDATE sender_identities SET manual_sent_today=0, manual_counters_day=? WHERE id=?', [today, mailboxId]);
    m.manual_sent_today = 0;
    m.manual_counters_day = today;
  }
  return m;
}

// ── Provider-neutral mailbox runtime helpers ─────────────────────────────────
// Load a provider row (canonical + legacy columns) for the runtime resolver.
async function loadProvider(tenantId: number, providerId: number): Promise<ProviderRow | null> {
  const [p] = await query('SELECT * FROM sending_providers WHERE id=? AND tenant_id=? LIMIT 1', [providerId, tenantId]);
  return (p as ProviderRow) ?? null;
}

// Resolve the runtime connection for a mailbox (sender_identity → its provider).
async function mailboxConn(tenantId: number, mailbox: any) {
  if (!mailbox?.provider_id) return null;
  const prov = await loadProvider(tenantId, mailbox.provider_id);
  if (!prov) return null;

  // Per-mailbox credential refs must override provider defaults.
  // Without this, reply import checks provider-level env refs only and returns imap_not_configured
  // even when a specific mailbox has valid IMAP refs.
  const merged = {
    ...prov,
    smtp_user_ref: mailbox.smtp_user_ref || prov.smtp_user_ref || prov.username_ref || '',
    smtp_secret_ref: mailbox.smtp_secret_ref || prov.smtp_secret_ref || prov.secret_ref || '',
    imap_user_ref: mailbox.imap_user_ref || prov.imap_user_ref || mailbox.smtp_user_ref || prov.smtp_user_ref || prov.username_ref || '',
    imap_secret_ref: mailbox.imap_secret_ref || prov.imap_secret_ref || mailbox.smtp_secret_ref || prov.smtp_secret_ref || prov.secret_ref || '',
    inbound_enabled: mailbox.inbound_enabled,
    outbound_enabled: mailbox.outbound_enabled,
  } as ProviderRow;

  return resolveProvider(merged);
}

// All inbound-enabled mailboxes for a tenant (IMAP reading turned on + provider inbound flag).
async function inboundMailboxes(tenantId: number): Promise<any[]> {
  return query(
    `SELECT si.* FROM sender_identities si
     JOIN sending_providers sp ON sp.id=si.provider_id AND sp.tenant_id=si.tenant_id
     WHERE si.tenant_id=?
       AND si.status='active'
       AND si.inbound_enabled=1
       AND si.imap_enabled=1
       AND si.provider_id IS NOT NULL
       AND sp.status='active'
       AND sp.inbound_enabled=1`, [tenantId],
  );
}

// ── Template variable UX (Phase 22) ──────────────────────────────────────────
// Internally templates store {{var}}. The UI shows operators clear replacement
// fields: <<< REPLACE: Human label >>>. These maps convert between the two.
const VAR_LABELS: Record<string, string> = {
  company: 'Company name',
  service: 'Service / offer noticed',
  city: 'City',
  business_address: 'Business address',
  sender_name: 'Your name',
  sender_address: 'Your business address',
};
const DEMO_VARS: Record<string, string> = {
  company: 'Bright Spark Electrics',
  service: 'emergency call-outs',
  city: 'Leeds',
  business_address: '12 High St, Leeds',
  sender_name: 'Alex Morgan',
  sender_address: 'Clients.Help · 4 Market Sq, Leeds',
};

function toReplaceFields(s: string): string {
  return s.replace(/\{\{(\w+)\}\}/g, (_, k) => `<<< REPLACE: ${VAR_LABELS[k] ?? k} >>>`);
}
function toHumanPreview(s: string): string {
  return s.replace(/\{\{(\w+)\}\}/g, (_, k) => DEMO_VARS[k] ?? `[${k}]`);
}

// ── Zoho bridge: status + tests ──────────────────────────────────────────────
manualOutreachRouter.get('/zoho/status', async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const p = zohoPresence();
  const [provider] = await query(
    `SELECT id, name, status, last_verified_at, last_error FROM sending_providers
     WHERE tenant_id=? AND provider_type='zoho_smtp_imap' ORDER BY id ASC LIMIT 1`, [tenantId],
  );
  const [mailbox] = await query(
    `SELECT id, from_email, status, daily_send_limit, manual_sent_today, imap_enabled,
            imap_start_at, imap_last_checked_at, warmup_stage, created_at
     FROM sender_identities WHERE tenant_id=? AND provider_id=? LIMIT 1`,
    [tenantId, provider?.id ?? -1],
  );
  res.json({
    bridgeStatus: zohoBridgeStatus(p),
    envVars: {
      smtpUser: p.smtpUserRef, smtpPassword: p.smtpPassRef,
      imapUser: p.imapUserRef, imapPassword: p.imapPassRef,
    },
    smtp: { host: p.smtpHost, port: p.smtpPort, secure: 'STARTTLS', configured: p.smtpConfigured,
            userPresent: p.smtpUserPresent, passwordPresent: p.smtpPassPresent },
    imap: { host: p.imapHost, port: p.imapPort, secure: true, configured: p.imapConfigured,
            userPresent: p.imapUserPresent, passwordPresent: p.imapPassPresent },
    provider: provider ?? null,
    mailbox: mailbox ?? null,
    copyModeAvailable: true,   // copy/paste always works even without credentials
    note: 'Secrets live in .env only. This endpoint never returns credential values.',
  });
});

// Ensure provider + mailbox rows exist for the Zoho bridge.
manualOutreachRouter.post('/zoho/connect', requireWriteAccess, async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const p = zohoPresence();
  // Provider row (refs only — no secrets stored).
  let [provider] = await query(
    `SELECT id FROM sending_providers WHERE tenant_id=? AND provider_type='zoho_smtp_imap' LIMIT 1`, [tenantId],
  );
  if (!provider) {
    const r = await query(
      `INSERT INTO sending_providers
        (tenant_id, provider_type, name, smtp_host, smtp_port, smtp_secure,
         imap_host, imap_port, imap_secure, username_ref, secret_ref,
         smtp_user_ref, smtp_secret_ref, imap_user_ref, imap_secret_ref,
         inbound_enabled, outbound_enabled, status)
       VALUES (?, 'zoho_smtp_imap', 'Zoho manual bridge', ?, ?, 0, ?, ?, 1, ?, ?, ?, ?, ?, ?, 1, 1, 'pending')`,
      [tenantId, p.smtpHost, p.smtpPort, p.imapHost, p.imapPort,
       p.smtpUserRef, p.smtpPassRef, p.smtpUserRef, p.smtpPassRef, p.imapUserRef, p.imapPassRef],
    );
    provider = { id: Number(r.insertId) };
  }
  // Mailbox = sender_identity. Use the configured Zoho address if present, else placeholder.
  const mailboxEmail = (process.env[p.smtpUserRef] || process.env[p.imapUserRef] || 'zoho-mailbox@configure.me').toLowerCase();
  let [mailbox] = await query(
    `SELECT id FROM sender_identities WHERE tenant_id=? AND provider_id=? LIMIT 1`, [tenantId, provider.id],
  );
  if (!mailbox) {
    // domain_id is NOT NULL in schema — attach to the main domain as a placeholder anchor.
    const [dom] = await query('SELECT id FROM domains WHERE tenant_id=? ORDER BY id ASC LIMIT 1', [tenantId]);
    const r = await query(
      `INSERT INTO sender_identities
        (tenant_id, domain_id, provider_id, from_email, from_name, display_name, purpose, status,
         daily_send_limit, hourly_send_limit)
       VALUES (?, ?, ?, ?, 'Outreach', 'Zoho Manual Bridge', 'cold_outreach', 'active', ?, ?)`,
      [tenantId, dom?.id ?? null, provider.id, mailboxEmail, DEFAULT_DAILY, DEFAULT_DAILY],
    );
    mailbox = { id: Number(r.insertId) };
  }
  await audit(req, 'zoho.connect', { type: 'sending_provider', id: provider.id }, { mailboxId: mailbox.id });
  res.json({ ok: true, providerId: provider.id, mailboxId: mailbox.id, bridgeStatus: zohoBridgeStatus(p) });
});

manualOutreachRouter.post('/zoho/test-smtp', requireWriteAccess, async (req, res) => {
  const r = await testZohoSmtp();
  await audit(req, 'zoho.test_smtp', { type: 'sending_provider' }, { ok: r.ok, detail: r.detail });
  if (r.configured) {
    await query(
      `UPDATE sending_providers SET status=?, last_verified_at=?, last_error=?
       WHERE tenant_id=? AND provider_type='zoho_smtp_imap'`,
      [r.ok ? 'active' : 'error', r.ok ? new Date() : null, r.ok ? null : r.detail, req.auth!.tenantId],
    );
  }
  res.json({ ...r, note: 'No email was sent. SMTP EHLO/AUTH verify only.' });
});

manualOutreachRouter.post('/zoho/test-imap', requireWriteAccess, async (req, res) => {
  const r = await testZohoImap();
  await audit(req, 'zoho.test_imap', { type: 'sending_provider' }, { ok: r.ok, detail: r.detail });
  res.json({ ...r, note: 'Connect + open INBOX read-only. No messages were read, moved, or deleted.' });
});

// ── Provider-neutral mailbox runtime (Phase 22) ──────────────────────────────
// Supported provider types. *_later types are recognised but OAuth is NOT built;
// env-ref credentials only for now.
const PROVIDER_TYPES = [
  'zoho_smtp_imap', 'generic_smtp_imap', 'gmail_workspace_later',
  'microsoft_365_later', 'self_hosted_smtp_imap_later',
] as const;

// List configured providers with readiness booleans (NEVER secret values).
manualOutreachRouter.get('/providers', async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const rows = await query('SELECT * FROM sending_providers WHERE tenant_id=? ORDER BY id ASC', [tenantId]);
  const out = rows.map((r: ProviderRow) => {
    const c = resolveProvider(r);
    return {
      id: r.id, providerType: r.provider_type, name: r.name,
      smtp: { host: c.smtpHost, port: c.smtpPort, secure: c.smtpSecure,
              userRef: c.smtpUserRef, secretRef: c.smtpSecretRef,
              userPresent: c.smtpUserPresent, secretPresent: c.smtpSecretPresent, configured: c.smtpConfigured },
      imap: { host: c.imapHost, port: c.imapPort, secure: c.imapSecure,
              userRef: c.imapUserRef, secretRef: c.imapSecretRef,
              userPresent: c.imapUserPresent, secretPresent: c.imapSecretPresent, configured: c.imapConfigured },
      inboundEnabled: c.inboundEnabled, outboundEnabled: c.outboundEnabled,
      testStatus: (r as any).test_status, lastSmtpTestAt: (r as any).last_smtp_test_at,
      lastImapTestAt: (r as any).last_imap_test_at, status: (r as any).status, lastError: (r as any).last_error,
    };
  });
  res.json({ providers: out, supportedTypes: PROVIDER_TYPES,
    note: 'DB stores env-var NAMES only. Secrets live in .env. Values are never returned.' });
});

const providerSchema = z.object({
  providerType: z.enum(PROVIDER_TYPES),
  name: z.string().min(1).max(160),
  smtpHost: z.string().max(255).optional(),
  smtpPort: z.coerce.number().int().min(1).max(65535).optional(),
  smtpSecure: z.boolean().optional(),
  imapHost: z.string().max(255).optional(),
  imapPort: z.coerce.number().int().min(1).max(65535).optional(),
  imapSecure: z.boolean().optional(),
  smtpUserRef: z.string().max(120).optional(),
  smtpSecretRef: z.string().max(120).optional(),
  imapUserRef: z.string().max(120).optional(),
  imapSecretRef: z.string().max(120).optional(),
  inboundEnabled: z.boolean().optional(),
  outboundEnabled: z.boolean().optional(),
});

// Connect a provider (create row). Stores env-var NAMES only, never secrets.
manualOutreachRouter.post('/providers', requireWriteAccess, async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const p = providerSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'invalid_body', detail: p.error.issues });
  const d = p.data;
  const r = await query(
    `INSERT INTO sending_providers
      (tenant_id, provider_type, name, smtp_host, smtp_port, smtp_secure,
       imap_host, imap_port, imap_secure, username_ref, secret_ref,
       smtp_user_ref, smtp_secret_ref, imap_user_ref, imap_secret_ref,
       inbound_enabled, outbound_enabled, status, test_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'untested')`,
    [tenantId, d.providerType, d.name, d.smtpHost ?? null, d.smtpPort ?? 587, d.smtpSecure ? 1 : 0,
     d.imapHost ?? null, d.imapPort ?? 993, d.imapSecure === false ? 0 : 1,
     d.smtpUserRef ?? null, d.smtpSecretRef ?? null,
     d.smtpUserRef ?? null, d.smtpSecretRef ?? null, d.imapUserRef ?? null, d.imapSecretRef ?? null,
     d.inboundEnabled ? 1 : 0, d.outboundEnabled === false ? 0 : 1],
  );
  await audit(req, 'provider.connect', { type: 'sending_provider', id: Number(r.insertId) }, { providerType: d.providerType });
  res.status(201).json({ id: Number(r.insertId), note: 'Secrets stay in .env. Set the named env vars, then run SMTP/IMAP tests.' });
});

manualOutreachRouter.post('/providers/:id/test-smtp', requireWriteAccess, async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const prov = await loadProvider(tenantId, parseInt(req.params.id, 10));
  if (!prov) return res.status(404).json({ error: 'not_found' });
  const conn = resolveProvider(prov);
  const r = await rtTestSmtp(conn);
  if (r.configured) {
    await query(
      `UPDATE sending_providers SET last_smtp_test_at=NOW(), last_error=?,
         status=?, test_status=CASE WHEN ?='imap_ok' OR ?='both_ok' THEN 'both_ok' ELSE ? END
       WHERE id=?`,
      [r.ok ? null : r.detail, r.ok ? 'active' : 'error',
       (prov as any).test_status, (prov as any).test_status, r.ok ? 'smtp_ok' : 'error', prov.id],
    );
  }
  await audit(req, 'provider.test_smtp', { type: 'sending_provider', id: prov.id }, { ok: r.ok, detail: r.detail });
  res.json({ ...r, note: 'No email sent. SMTP EHLO/AUTH verify only.' });
});

manualOutreachRouter.post('/providers/:id/test-imap', requireWriteAccess, async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const prov = await loadProvider(tenantId, parseInt(req.params.id, 10));
  if (!prov) return res.status(404).json({ error: 'not_found' });
  const conn = resolveProvider(prov);
  const r = await rtTestImap(conn);
  if (r.configured) {
    await query(
      `UPDATE sending_providers SET last_imap_test_at=NOW(),
         test_status=CASE WHEN test_status IN('smtp_ok','both_ok') THEN 'both_ok' ELSE ? END
       WHERE id=?`,
      [r.ok ? 'imap_ok' : 'error', prov.id],
    );
  }
  await audit(req, 'provider.test_imap', { type: 'sending_provider', id: prov.id }, { ok: r.ok, detail: r.detail });
  res.json({ ...r, note: 'Connect + open INBOX read-only. No messages read, moved, or deleted.' });
});

// ── Templates (operator MUST approve) ────────────────────────────────────────
const SEED_TEMPLATES = [
  {
    template_key: 'clients_help_chat',
    name: 'Clients.Help — missed website leads',
    angle: 'missed_leads',
    subject: 'Quick question about enquiries from {{company}} website',
    body: `Hi,

I came across {{company}} and noticed visitors landing on your site outside business hours. A lot of small firms lose those enquiries simply because nobody is there to reply at that moment.

We run Clients.Help, a small tool that catches website chats and missed enquiries so they reach you as a normal message. No long contract, nothing to install.

If this isn't relevant or I've reached the wrong person, just reply "stop" and I won't email again.

Best,
{{sender_name}}
{{sender_address}}`,
  },
  {
    template_key: 'seo_growth',
    name: 'SEO / service growth angle',
    angle: 'growth',
    subject: 'Growing enquiries for {{company}}',
    body: `Hi,

I work with local service businesses like {{company}} on getting found and turning more website visits into booked work.

Would a short, no-pressure note on what I'd look at first be useful? If not, no problem at all — reply "unsubscribe" and you won't hear from me again.

Best,
{{sender_name}}
{{sender_address}}`,
  },
  {
    template_key: 'wrong_person',
    name: 'Generic "wrong person?" angle',
    angle: 'routing',
    subject: 'Am I writing to the right person at {{company}}?',
    body: `Hi,

Apologies if this lands in the wrong inbox. I'm trying to reach whoever handles new enquiries and bookings at {{company}}.

If that's not you, could you point me the right way? And if you'd rather not be contacted, just reply "opt out" and I'll remove you.

Thanks,
{{sender_name}}
{{sender_address}}`,
  },
  {
    template_key: 'clients_help_first_touch',
    name: 'Clients.Help — first touch',
    angle: 'first_touch',
    subject: 'Enquiries from the {{company}} website',
    body: `Hi,

I came across {{company}} while looking at {{service}} around {{city}}. Many small firms quietly lose website enquiries that arrive after hours — nobody is there to reply, so the visitor moves on.

We run Clients.Help: it catches those website chats and missed enquiries and forwards them to you as a normal message. Nothing to install, no long contract.

Worth a quick look? If this isn't relevant or I've reached the wrong person, reply "stop" and I won't email again.

Best,
{{sender_name}}
{{sender_address}}`,
  },
  {
    template_key: 'clients_help_followup_1',
    name: 'Clients.Help — follow-up 1 (3-4 days)',
    angle: 'followup',
    subject: 'Re: Enquiries from the {{company}} website',
    body: `Hi,

Just floating this back up in case it slipped past. The idea is simple: catch the enquiries {{company}} currently misses outside hours and get them to you straight away.

Happy to send a one-line example of how it would look for you. If not useful, reply "unsubscribe" and you won't hear from me again.

Best,
{{sender_name}}
{{sender_address}}`,
  },
  {
    template_key: 'clients_help_followup_2',
    name: 'Clients.Help — follow-up 2 (7-10 days)',
    angle: 'followup',
    subject: 'Last note re {{company}}',
    body: `Hi,

I'll leave it here so I'm not cluttering your inbox. If catching missed website enquiries for {{company}} ever becomes a priority, just reply and I'll set it up in a few minutes.

Either way, thanks for your time. Reply "opt out" and I'll remove you for good.

Best,
{{sender_name}}
{{sender_address}}`,
  },
  {
    template_key: 'remote_it_ps',
    name: 'A/B — with P.S. remote IT services',
    angle: 'ab_ps',
    subject: 'Enquiries from the {{company}} website',
    body: `Hi,

I noticed {{company}} offering {{service}} around {{city}}. A lot of small firms lose after-hours website enquiries simply because nobody is there to reply.

Clients.Help catches those chats and missed enquiries and forwards them to you as a normal message. No install, no long contract.

Worth a quick look? If not relevant, reply "stop" and I won't email again.

Best,
{{sender_name}}
{{sender_address}}

P.S. We also handle remote IT support for small teams — happy to mention it if that's ever a headache.`,
  },
  {
    template_key: 'no_ps_ab',
    name: 'A/B — no P.S. (control)',
    angle: 'ab_no_ps',
    subject: 'Enquiries from the {{company}} website',
    body: `Hi,

I noticed {{company}} offering {{service}} around {{city}}. A lot of small firms lose after-hours website enquiries simply because nobody is there to reply.

Clients.Help catches those chats and missed enquiries and forwards them to you as a normal message. No install, no long contract.

Worth a quick look? If not relevant, reply "stop" and I won't email again.

Best,
{{sender_name}}
{{sender_address}}`,
  },
];

export async function ensureTemplates(tenantId: number) {
  const existing = await query('SELECT template_key FROM manual_outreach_templates WHERE tenant_id=?', [tenantId]);
  const have = new Set(existing.map((r: any) => r.template_key));
  for (const t of SEED_TEMPLATES) {
    if (have.has(t.template_key)) continue;
    await query(
      `INSERT INTO manual_outreach_templates (tenant_id, template_key, name, angle, subject, body, approved)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
      [tenantId, t.template_key, t.name, t.angle, t.subject, t.body],
    );
  }
}

manualOutreachRouter.get('/templates', async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  await ensureTemplates(tenantId);
  const rows = await query(
    'SELECT id, template_key, name, angle, subject, body, approved, approved_at FROM manual_outreach_templates WHERE tenant_id=? ORDER BY id ASC',
    [tenantId],
  );
  res.json({ templates: rows });
});

const tmplPatch = z.object({
  approved: z.boolean().optional(),
  subject: z.string().min(1).max(255).optional(),
  body: z.string().min(1).max(8000).optional(),
  name: z.string().min(1).max(160).optional(),
});
manualOutreachRouter.patch('/templates/:id', requireWriteAccess, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const p = tmplPatch.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'invalid_body', detail: p.error.issues });
  const [row] = await query('SELECT id FROM manual_outreach_templates WHERE id=? AND tenant_id=? LIMIT 1', [id, req.auth!.tenantId]);
  if (!row) return res.status(404).json({ error: 'not_found' });
  const sets: string[] = []; const vals: any[] = [];
  if (p.data.subject !== undefined) { sets.push('subject=?'); vals.push(p.data.subject); }
  if (p.data.body !== undefined) { sets.push('body=?'); vals.push(p.data.body); }
  if (p.data.name !== undefined) { sets.push('name=?'); vals.push(p.data.name); }
  if (p.data.approved !== undefined) { sets.push('approved=?', 'approved_at=?'); vals.push(p.data.approved ? 1 : 0, p.data.approved ? new Date() : null); }
  if (!sets.length) return res.json({ ok: true, unchanged: true });
  vals.push(id);
  await query(`UPDATE manual_outreach_templates SET ${sets.join(', ')} WHERE id=?`, vals);
  await audit(req, 'manual_template.update', { type: 'manual_template', id }, { fields: Object.keys(p.data) });
  res.json({ ok: true });
});

// Stable per-recipient seed so the same company always gets the same spintax
// variant (consistent across resend / preview), but different companies vary.
function spinSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return Math.abs(h);
}

// Collapse spintax `{opt a|opt b|opt c}` → one option. {{var}} tokens are
// protected with sentinels first so options containing {{company}} survive the
// `[^{}]` match, then restored. Without this, raw spintax was stored AND sent as
// the literal subject, and long company names overflowed draft_subject(255).
export function collapseSpintax(s: string, seed: number): string {
  const protectedStr = s.replace(/\{\{(\w+)\}\}/g, '$1');
  const done = protectedStr.replace(/\{([^{}]*\|[^{}]*)\}/g, (_, group: string) => {
    const opts = group.split('|');
    return opts[seed % opts.length];
  });
  return done.replace(/(\w+)/g, '{{$1}}');
}

export function renderTemplate(tpl: { subject: string; body: string }, vars: Record<string, string>) {
  const seed = spinSeed(vars.company || '');
  const fill = (s: string) =>
    collapseSpintax(s, seed).replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? `{{${k}}}`);
  // draft_subject is varchar(255); hard-cap so a long subject can never overflow
  // the column and crash the insert (unhandled rejection → hung request).
  return { subject: fill(tpl.subject).slice(0, 255), body: fill(tpl.body) };
}

// Two display modes for a template (Phase 22 — no curly-brace confusion):
//   human    → demo data filled in (preview what the recipient sees)
//   variable → clear <<< REPLACE: Label >>> fields the operator must fill
manualOutreachRouter.get('/templates/:id/render', async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const id = parseInt(req.params.id, 10);
  const mode = req.query.mode === 'human' ? 'human' : 'variable';
  const [t] = await query('SELECT subject, body FROM manual_outreach_templates WHERE id=? AND tenant_id=? LIMIT 1', [id, tenantId]);
  if (!t) return res.status(404).json({ error: 'not_found' });
  const xf = mode === 'human' ? toHumanPreview : toReplaceFields;
  res.json({
    mode, subject: xf(t.subject), body: xf(t.body),
    fields: Object.entries(VAR_LABELS).filter(([k]) => (t.subject + t.body).includes(`{{${k}}}`)).map(([k, label]) => ({ key: k, label })),
    note: mode === 'variable'
      ? 'Replace each <<< REPLACE: ... >>> field before sending.'
      : 'Demo data shown for preview only.',
  });
});

// ── Tiny cohort builder ──────────────────────────────────────────────────────
const cohortSchema = z.object({
  country: z.string().max(2).optional(),
  industries: z.array(z.string()).optional(),
  templateKey: z.string().max(60).optional(),
  max: z.coerce.number().int().min(1).max(QUEUE_HARD_MAX).optional(),
  preview: z.boolean().optional(),
});

export async function buildCohort(tenantId: number, opts: z.infer<typeof cohortSchema>) {
  const country = (opts.country ?? 'GB').toUpperCase().slice(0, 2);
  const industries = (opts.industries && opts.industries.length)
    ? opts.industries : ['cleaning', 'dental', 'plumb', 'electric'];
  const max = Math.min(opts.max ?? QUEUE_DEFAULT_MAX, QUEUE_HARD_MAX);

  const indLike = industries.map(() => '(c.category_primary LIKE ? OR c.category_secondary LIKE ? OR c.name LIKE ?)').join(' OR ');
  const indParams: any[] = [];
  for (const i of industries) { const w = `%${i}%`; indParams.push(w, w, w); }

  const sql = `
    SELECT cp.id AS cp_id, cp.value AS email, cp.role_type, cp.verification_score, cp.source_url,
           c.id AS company_id, c.name AS company_name, c.canonical_domain AS website, c.country, c.city,
           cpf.fit_score AS fit_score
    FROM contact_points cp
    JOIN companies c ON c.id = cp.company_id
    LEFT JOIN company_product_fit cpf ON cpf.company_id = c.id AND cpf.product_key='clients_help'
    WHERE cp.type='email' AND cp.status='verified' AND cp.value IS NOT NULL AND cp.value <> ''
      AND (? = '' OR c.country = ?)
      AND (${indLike})
      AND cp.value NOT IN (SELECT email FROM suppressions WHERE tenant_id = ?)
      AND LOWER(cp.value) NOT IN (SELECT normalized_value FROM global_contact_suppression WHERE type='email')
      AND cp.email_domain NOT IN (SELECT normalized_value FROM global_contact_suppression WHERE type='domain')
      AND cp.value NOT IN (SELECT email FROM manual_outreach_queue WHERE tenant_id = ?)
    GROUP BY cp.id
    ORDER BY (cpf.fit_score IS NULL) ASC, cpf.fit_score DESC, cp.verification_score DESC
    LIMIT ?`;
  const params = [country, country, ...indParams, tenantId, tenantId, max];
  const rows = await query(sql, params);
  return { rows, country, industries, max };
}

manualOutreachRouter.post('/cohort/preview', async (req, res) => {
  const p = cohortSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'invalid_body', detail: p.error.issues });
  const { rows, country, industries, max } = await buildCohort(req.auth!.tenantId!, p.data);
  res.json({
    preset: 'Zoho manual bridge — 20 leads',
    filters: { country, industries, verifiedOnly: true, excludeSuppressed: true, max },
    matched: rows.length,
    sample: rows.slice(0, 20),
    note: 'Preview only. Nothing was queued, subscribed, or sent.',
  });
});

manualOutreachRouter.post('/cohort/build', requireWriteAccess, async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const p = cohortSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'invalid_body', detail: p.error.issues });

  // Enforce hard queue cap across existing + new.
  const [{ open }] = await query(
    `SELECT COUNT(*) AS open FROM manual_outreach_queue WHERE tenant_id=? AND status IN ('pending_review','approved')`, [tenantId],
  );
  const room = QUEUE_HARD_MAX - Number(open);
  if (room <= 0) return res.status(409).json({ error: 'queue_full', detail: `Open queue already at hard max ${QUEUE_HARD_MAX}. Process items first.` });

  await ensureTemplates(tenantId);
  const templateKey = p.data.templateKey ?? 'clients_help_chat';
  const [tpl] = await query('SELECT subject, body, approved FROM manual_outreach_templates WHERE tenant_id=? AND template_key=? LIMIT 1', [tenantId, templateKey]);

  const want = Math.min(p.data.max ?? QUEUE_DEFAULT_MAX, room);
  const { rows } = await buildCohort(tenantId, { ...p.data, max: want });

  let inserted = 0;
  for (const r of rows) {
    const vars = { company: r.company_name || 'your business', sender_name: '{{sender_name}}', sender_address: '{{sender_address}}' };
    const draft = tpl ? renderTemplate(tpl, vars) : { subject: '', body: '' };
    const suppressed = await isEmailSuppressed(tenantId, r.email);
    try {
      await query(
        `INSERT INTO manual_outreach_queue
          (tenant_id, contact_point_id, company_id, company_name, website, email, reason, source_url,
           template_key, draft_subject, draft_body, safety_status, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_review')`,
        [tenantId, r.cp_id, r.company_id, r.company_name, r.website, r.email,
         `Verified ${r.role_type ?? 'contact'} · ${r.city ?? ''} ${r.country ?? ''}`.trim(),
         r.source_url, templateKey, draft.subject, draft.body,
         suppressed ? 'suppressed' : 'ok'],
      );
      inserted++;
    } catch (e: any) {
      if (e?.code !== 'ER_DUP_ENTRY') throw e; // already queued — skip silently
    }
  }
  // Assignment engine — distribute freshly-queued items across healthy mailboxes
  // (no send; just sets mailbox_id). Preserves same mailbox per contact/company.
  let assigned = 0;
  const strategy = (p.data as any).assignStrategy as AssignStrategy | undefined;
  const unassigned = await query(
    `SELECT id, email, company_id FROM manual_outreach_queue
     WHERE tenant_id=? AND mailbox_id IS NULL AND status='pending_review'`, [tenantId],
  );
  if (unassigned.length) {
    const mailboxes = await query("SELECT * FROM sender_identities WHERE tenant_id=? AND status='active'", [tenantId]);
    if (mailboxes.length) {
      const providers = await query('SELECT * FROM sending_providers WHERE tenant_id=?', [tenantId]);
      const providerById = new Map<number, any>(providers.map((pr: any) => [pr.id, pr]));
      for (const m of mailboxes) await rollMailboxCounters(m);
      const { byEmail, byCompany } = await priorMailboxMaps(tenantId);
      const items: AssignItem[] = unassigned.map((it: any) => ({
        key: it.id, email: it.email, companyId: it.company_id ?? null,
        recipientDomain: (it.email || '').split('@')[1] ?? null,
      }));
      const results = assignMailboxes(items, mailboxes, {
        strategy: strategy ?? 'healthiest_first', providerById, priorByCompany: byCompany, priorByEmail: byEmail,
      });
      for (const r of results) {
        if (r.mailboxId) { await query('UPDATE manual_outreach_queue SET mailbox_id=? WHERE id=? AND tenant_id=?', [r.mailboxId, r.key, tenantId]); assigned++; }
      }
    }
  }
  await audit(req, 'manual_queue.build', { type: 'manual_queue' }, { inserted, assigned, templateKey, templateApproved: !!tpl?.approved });
  res.json({
    inserted, assigned, requested: want, templateKey, templateApproved: !!tpl?.approved,
    warning: tpl?.approved ? null : 'Template not yet approved — approve it before sending.',
    note: 'Items added as pending_review. Nothing subscribed or sent.',
  });
});

// ── Queue management ─────────────────────────────────────────────────────────
manualOutreachRouter.get('/queue', async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  const rows = status
    ? await query('SELECT * FROM manual_outreach_queue WHERE tenant_id=? AND status=? ORDER BY id DESC LIMIT 200', [tenantId, status])
    : await query('SELECT * FROM manual_outreach_queue WHERE tenant_id=? ORDER BY id DESC LIMIT 200', [tenantId]);
  const [counts] = await query(
    `SELECT
       SUM(status='pending_review') pending_review, SUM(status='approved') approved,
       SUM(status='sent_manual') sent_manual, SUM(status='sent_smtp') sent_smtp,
       SUM(status='skipped') skipped, SUM(status='do_not_contact') do_not_contact
     FROM manual_outreach_queue WHERE tenant_id=?`, [tenantId],
  );
  res.json({ items: rows, counts, limits: { defaultMax: QUEUE_DEFAULT_MAX, hardMax: QUEUE_HARD_MAX } });
});

const addItemSchema = z.object({
  email: z.string().email(),
  companyName: z.string().max(255).optional(),
  website: z.string().max(255).optional(),
  reason: z.string().max(500).optional(),
  sourceUrl: z.string().max(500).optional(),
  templateKey: z.string().max(60).optional(),
  draftSubject: z.string().max(255).optional(),
  draftBody: z.string().max(8000).optional(),
});
manualOutreachRouter.post('/queue', requireWriteAccess, async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const p = addItemSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'invalid_body', detail: p.error.issues });
  const [{ open }] = await query(
    `SELECT COUNT(*) AS open FROM manual_outreach_queue WHERE tenant_id=? AND status IN ('pending_review','approved')`, [tenantId],
  );
  if (Number(open) >= QUEUE_HARD_MAX) return res.status(409).json({ error: 'queue_full', detail: `Hard max ${QUEUE_HARD_MAX}.` });
  const suppressed = await isEmailSuppressed(tenantId, p.data.email);
  try {
    const r = await query(
      `INSERT INTO manual_outreach_queue
        (tenant_id, company_name, website, email, reason, source_url, template_key, draft_subject, draft_body, safety_status, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_review')`,
      [tenantId, p.data.companyName ?? null, p.data.website ?? null, p.data.email.toLowerCase(),
       p.data.reason ?? null, p.data.sourceUrl ?? null, p.data.templateKey ?? null,
       p.data.draftSubject ?? null, p.data.draftBody ?? null, suppressed ? 'suppressed' : 'ok'],
    );
    await audit(req, 'manual_queue.add', { type: 'manual_queue', id: Number(r.insertId) }, { email: p.data.email });
    res.status(201).json({ id: Number(r.insertId), safety_status: suppressed ? 'suppressed' : 'ok' });
  } catch (e: any) {
    if (e?.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'already_queued' });
    throw e;
  }
});

const queuePatch = z.object({
  action: z.enum(['approve', 'unapprove', 'skip', 'do_not_contact']).optional(),
  draftSubject: z.string().max(255).optional(),
  draftBody: z.string().max(8000).optional(),
});
manualOutreachRouter.patch('/queue/:id', requireWriteAccess, async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const id = parseInt(req.params.id, 10);
  const p = queuePatch.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'invalid_body', detail: p.error.issues });
  const [item] = await query('SELECT * FROM manual_outreach_queue WHERE id=? AND tenant_id=? LIMIT 1', [id, tenantId]);
  if (!item) return res.status(404).json({ error: 'not_found' });

  const sets: string[] = []; const vals: any[] = [];
  if (p.data.draftSubject !== undefined) { sets.push('draft_subject=?'); vals.push(p.data.draftSubject); }
  if (p.data.draftBody !== undefined) { sets.push('draft_body=?'); vals.push(p.data.draftBody); }
  if (p.data.action === 'approve') {
    if (item.safety_status === 'suppressed' || item.safety_status === 'blocked')
      return res.status(409).json({ error: 'cannot_approve_suppressed' });
    sets.push("status='approved'", 'approved_at=?'); vals.push(new Date());
  } else if (p.data.action === 'unapprove') {
    sets.push("status='pending_review'", 'approved_at=NULL');
  } else if (p.data.action === 'skip') {
    sets.push("status='skipped'");
  } else if (p.data.action === 'do_not_contact') {
    sets.push("status='do_not_contact'");
  }
  if (!sets.length) return res.json({ ok: true, unchanged: true });
  vals.push(id);
  await query(`UPDATE manual_outreach_queue SET ${sets.join(', ')} WHERE id=?`, vals);

  // do_not_contact also suppresses + flags the warehouse contact point.
  if (p.data.action === 'do_not_contact') {
    await addSuppression(tenantId, item.email, 'manual');
    await query("UPDATE contact_points SET status='do_not_contact' WHERE value=?", [item.email]);
    await audit(req, 'manual_queue.do_not_contact', { type: 'manual_queue', id }, { email: item.email });
  } else {
    await audit(req, 'manual_queue.update', { type: 'manual_queue', id }, { action: p.data.action ?? 'edit' });
  }
  res.json({ ok: true });
});

manualOutreachRouter.delete('/queue/:id', requireWriteAccess, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const [item] = await query('SELECT id FROM manual_outreach_queue WHERE id=? AND tenant_id=? LIMIT 1', [id, req.auth!.tenantId]);
  if (!item) return res.status(404).json({ error: 'not_found' });
  await query('DELETE FROM manual_outreach_queue WHERE id=?', [id]);
  res.json({ ok: true });
});

// Shared pre-send gate evaluation (used by send + copy-mode UI).
async function evaluateSendGate(tenantId: number, item: any) {
  const blockers: string[] = [];
  if (item.status !== 'approved') blockers.push('not_approved');
  if (!hasOptOut(item.draft_body)) blockers.push('no_opt_out_line');
  if (await isEmailSuppressed(tenantId, item.email)) blockers.push('suppressed');
  if (['suppressed', 'blocked'].includes(item.safety_status)) blockers.push('safety_blocked');
  // Content safety: empty subject/body, leftover {{macros}}, <<<REPLACE>>>, broken
  // grammar — previously only the drip worker checked these; the portal one-by-one
  // send bypassed them entirely and could ship broken drafts.
  blockers.push(...contentBlockers(item.draft_subject, item.draft_body));
  // Tenant kill-switch — honoured here (was only respected by the drip worker).
  const paused = await query(
    'SELECT outreach_paused FROM tenant_safety_settings WHERE tenant_id=? AND outreach_paused=1 LIMIT 1',
    [tenantId],
  );
  if (paused.length) blockers.push('outreach_paused');

  // Mailbox / daily cap — use the queue item's assigned mailbox if set.
  let mailbox: any = null;
  if (item.mailbox_id) {
    mailbox = await mailboxWithCounters(tenantId, item.mailbox_id);
  }
  if (!mailbox) {
    const [provider] = await query(`SELECT id FROM sending_providers WHERE tenant_id=? AND provider_type='zoho_smtp_imap' LIMIT 1`, [tenantId]);
    if (provider) {
      const [mb] = await query('SELECT * FROM sender_identities WHERE tenant_id=? AND provider_id=? LIMIT 1', [tenantId, provider.id]);
      if (mb) mailbox = await mailboxWithCounters(tenantId, mb.id);
    }
  }
  // Build connector to check SMTP capability via mailbox runtime (DB-stored secrets).
  let conn: MailboxConn | null = null;
  if (mailbox) {
    conn = await mailboxConn(tenantId, mailbox);
    if (mailbox.status !== 'active') blockers.push('mailbox_not_active');
    // Use sent_today (the authoritative per-mailbox daily total, bumped on every
    // send). Summing manual_sent_today + sent_today double-counted manual sends
    // and halved the effective cap.
    const used = Number(mailbox.sent_today || 0);
    if (used >= Number(mailbox.daily_send_limit)) blockers.push('daily_limit_reached');
  }
  return { blockers, smtpConfigured: !!(conn?.smtpConfigured), mailbox };
}

// ── SMTP one-by-one send (REAL send — only when Zoho creds configured + gated) ─
manualOutreachRouter.post('/queue/:id/send', requireWriteAccess, async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const id = parseInt(req.params.id, 10);
  const [item] = await query('SELECT * FROM manual_outreach_queue WHERE id=? AND tenant_id=? LIMIT 1', [id, tenantId]);
  if (!item) return res.status(404).json({ error: 'not_found' });
  if (item.status === 'sent_manual' || item.status === 'sent_smtp') return res.status(409).json({ error: 'already_sent' });

  // Claim-lock: prevents a concurrent double-submit from sending the same item
  // twice (the status re-check + update below is not otherwise atomic).
  const lockKey = `lock:manualsend:${tenantId}:${id}`;
  const claimed = await redis.set(lockKey, '1', 'EX', 120, 'NX');
  if (!claimed) return res.status(409).json({ error: 'already_sending' });
  try {

  const gate = await evaluateSendGate(tenantId, item);
  if (!gate.smtpConfigured) {
    return res.status(412).json({ error: 'smtp_not_configured', detail: 'Zoho SMTP credentials absent. Use copy-to-Zoho instead.', copyMode: true });
  }
  if (gate.blockers.length) return res.status(412).json({ error: 'send_blocked', blockers: gate.blockers });

  // Build MailboxConn for the mailbox assigned to this queue item and send.
  let conn: MailboxConn | null = null;
  if (item.mailbox_id) {
    const [mb] = await query('SELECT * FROM sender_identities WHERE id=? AND tenant_id=? LIMIT 1', [item.mailbox_id, tenantId]);
    if (mb) conn = await mailboxConn(tenantId, mb);
  }
  // Fallback: use the gate's mailbox (first Zoho provider mailbox).
  if (!conn && gate.mailbox) conn = await mailboxConn(tenantId, gate.mailbox);
  if (!conn) return res.status(412).json({ error: 'smtp_not_configured', detail: 'No mailbox connector available.' });

  const sendResult = await rtSendFromMailbox(conn, {
    from: '', to: item.email,
    subject: item.draft_subject || '(no subject)', text: item.draft_body || '',
  });
  if (!sendResult.ok) {
    return res.status(502).json({ error: 'send_failed', detail: sendResult.detail });
  }

  await query("UPDATE manual_outreach_queue SET status='sent_smtp', sent_at=NOW(), sent_method='smtp' WHERE id=?", [id]);
  if (gate.mailbox) await query('UPDATE sender_identities SET manual_sent_today=manual_sent_today+1, smtp_sent_today=smtp_sent_today+1, sent_today=sent_today+1, last_sent_at=NOW() WHERE id=?', [gate.mailbox.id]);
  await recordTouchpoint({
    tenantId, contactPointId: item.contact_point_id, companyId: item.company_id, queueItemId: id,
    mailboxId: item.mailbox_id ?? gate.mailbox?.id ?? null, email: item.email, channel: 'email',
    direction: 'outbound', touchType: 'first_touch', subject: item.draft_subject, body: item.draft_body,
    status: 'sent_smtp', sentAt: new Date(),
  });
  await audit(req, 'manual_outreach.sent_smtp', { type: 'manual_queue', id }, { email: item.email, method: 'zoho_smtp' });
  res.json({ ok: true, sent: true, method: 'zoho_smtp' });
  } finally {
    await redis.del(lockKey).catch(() => {});
  }
});

// Copy-to-Zoho: return rendered subject/body/recipient for manual paste.
manualOutreachRouter.get('/queue/:id/copy', async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const id = parseInt(req.params.id, 10);
  const [item] = await query('SELECT * FROM manual_outreach_queue WHERE id=? AND tenant_id=? LIMIT 1', [id, tenantId]);
  if (!item) return res.status(404).json({ error: 'not_found' });
  const gate = await evaluateSendGate(tenantId, item);
  res.json({
    recipient: item.email, subject: item.draft_subject, body: item.draft_body,
    company: item.company_name, reason: item.reason, sourceUrl: item.source_url,
    gate: { blockers: gate.blockers, smtpConfigured: gate.smtpConfigured },
    note: 'Paste into Zoho webmail manually, then mark as sent.',
  });
});

// Mark sent manually (operator pasted into Zoho webmail). NOT system-sent. No fake events.
manualOutreachRouter.post('/queue/:id/mark-sent-manual', requireWriteAccess, async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const id = parseInt(req.params.id, 10);
  const [item] = await query('SELECT * FROM manual_outreach_queue WHERE id=? AND tenant_id=? LIMIT 1', [id, tenantId]);
  if (!item) return res.status(404).json({ error: 'not_found' });
  if (item.status === 'sent_manual' || item.status === 'sent_smtp') return res.status(409).json({ error: 'already_sent' });
  if (await isEmailSuppressed(tenantId, item.email)) return res.status(412).json({ error: 'suppressed' });

  await query("UPDATE manual_outreach_queue SET status='sent_manual', sent_at=NOW(), sent_method='manual' WHERE id=?", [id]);
  // Increment manual daily count on the Zoho mailbox if present.
  const [provider] = await query(`SELECT id FROM sending_providers WHERE tenant_id=? AND provider_type='zoho_smtp_imap' LIMIT 1`, [tenantId]);
  if (provider) {
    const [mb] = await query('SELECT id FROM sender_identities WHERE tenant_id=? AND provider_id=? LIMIT 1', [tenantId, provider.id]);
    if (mb) { await mailboxWithCounters(tenantId, mb.id); await query('UPDATE sender_identities SET manual_sent_today=manual_sent_today+1, sent_today=sent_today+1, last_sent_at=NOW() WHERE id=?', [mb.id]); }
  }
  await recordTouchpoint({
    tenantId, contactPointId: item.contact_point_id, companyId: item.company_id, queueItemId: id,
    mailboxId: item.mailbox_id ?? null, email: item.email, channel: 'manual_zoho',
    direction: 'outbound', touchType: 'first_touch', subject: item.draft_subject, body: item.draft_body,
    status: 'sent_manual', sentAt: new Date(),
  });
  await audit(req, 'manual_outreach.sent_manual', { type: 'manual_queue', id }, { email: item.email, method: 'zoho_copy_paste' });
  res.json({ ok: true, marked: 'sent_manual' });
});

// ── Reply inbox (IMAP) ───────────────────────────────────────────────────────
manualOutreachRouter.get('/replies', async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const rows = await query('SELECT * FROM inbox_replies WHERE tenant_id=? ORDER BY received_at DESC, id DESC LIMIT 200', [tenantId]);
  res.json({ replies: rows });
});

// Import recent replies via IMAP across ALL inbound-enabled mailboxes (any provider).
// Disabled per-mailbox until operator turns IMAP reading on. Read-only; no delete/move.
manualOutreachRouter.post('/replies/import', requireWriteAccess, async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const boxes = await inboundMailboxes(tenantId);
  if (!boxes.length) return res.status(412).json({ error: 'no_inbound_mailbox', detail: 'Enable IMAP on a mailbox first (Warmup tab → Enable IMAP), and set its provider IMAP env vars.' });

  let imported = 0, suppressedAuto = 0, fetched = 0;
  const perBox: any[] = [];
  for (const mb of boxes) {
    const conn = await mailboxConn(tenantId, mb);
    if (!conn) { perBox.push({ mailboxId: mb.id, error: 'no_provider' }); continue; }
    if (!conn.imapConfigured) { perBox.push({ mailboxId: mb.id, error: 'imap_not_configured' }); continue; }
    const startAt = mb.imap_start_at ? new Date(mb.imap_start_at) : null;
    const r = await rtFetchReplies(conn, { sinceUid: mb.imap_last_uid ?? null, startAt, limit: 50 });
    if (!r.ok && r.replies.length === 0) { perBox.push({ mailboxId: mb.id, error: r.detail }); continue; }
    for (const rep of r.replies) {
      fetched++;
      const cls = classifyReply(rep.subject, rep.snippet, rep.fromEmail);
      let cpId: number | null = null, companyId: number | null = null;
      if (rep.fromEmail) {
        const [cp] = await query('SELECT id, company_id FROM contact_points WHERE value=? LIMIT 1', [rep.fromEmail]);
        if (cp) { cpId = cp.id; companyId = cp.company_id; }
      }
      // Link to the originating queue item, if any.
      let queueItemId: number | null = null;
      if (rep.fromEmail) {
        const [qi] = await query('SELECT id FROM manual_outreach_queue WHERE tenant_id=? AND email=? ORDER BY id DESC LIMIT 1', [tenantId, rep.fromEmail]);
        if (qi) queueItemId = qi.id;
      }
      // Bounce parsing — extract the real failed recipient from full parsed body.
      let bounceResult: BounceParseResult = { failedRecipientEmail: null, bounceCategory: null, confidence: 0, evidence: null };
      if (cls.classification === 'bounce_like' || isBounceSender(rep.fromEmail)) {
        const bodyForParse = rep.rawBody ?? rep.snippet;
        bounceResult = parseBounceContent(rep.subject, bodyForParse);
      }
      try {
        const insertFields = `(tenant_id, mailbox_id, message_id, from_email, from_name, subject, body_snippet, received_at,
             classification, classification_source, confidence, classification_reason,
             contact_point_id, company_id, queue_item_id, failed_recipient, bounce_category, bounce_confidence)`;
        const insertVals = `(?, ?, ?, ?, ?, ?, ?, ?, ?, 'rule', ?, ?, ?, ?, ?, ?, ?, ?)`;
        await query(
          `INSERT INTO inbox_replies ${insertFields} VALUES ${insertVals}`,
          [tenantId, mb.id, rep.messageId, rep.fromEmail, rep.fromName, rep.subject, rep.snippet,
           rep.receivedAt, cls.classification, cls.confidence, cls.reason, cpId, companyId, queueItemId,
           bounceResult.failedRecipientEmail, bounceResult.bounceCategory, bounceResult.confidence],
        );
        imported++;
        // Mailbox reply metrics + ledger (inbound touchpoint).
        const isNeg = ['not_interested', 'do_not_contact', 'unsubscribe'].includes(cls.classification);
        await query(
          `UPDATE sender_identities SET replies_today=replies_today+1, last_reply_at=NOW(),
             interested_today=interested_today+? , negative_today=negative_today+? ,
             bounce_like_today=bounce_like_today+? , unsubscribes_today=unsubscribes_today+?
           WHERE id=?`,
          [cls.classification === 'interested' ? 1 : 0, isNeg ? 1 : 0,
           cls.classification === 'bounce_like' ? 1 : 0, cls.classification === 'unsubscribe' ? 1 : 0, mb.id],
        );
        await recordTouchpoint({
          tenantId, contactPointId: cpId, companyId, queueItemId, mailboxId: mb.id,
          email: rep.fromEmail, channel: 'email', direction: 'inbound', touchType: 'reply',
          subject: rep.subject, status: 'replied', repliedAt: rep.receivedAt ?? new Date(),
          metadata: { classification: cls.classification, confidence: cls.confidence, bounce: bounceResult },
        });
        // Reply received → stop pending follow-ups for that contact (sequence safety).
        if (rep.fromEmail) {
          const c = await query(
            "UPDATE manual_followup_tasks SET status='cancelled' WHERE tenant_id=? AND email=? AND status IN ('pending','ready')",
            [tenantId, rep.fromEmail],
          );
          if (c.affectedRows) await audit(req, 'followup.cancelled_due_reply', { type: 'followup' }, { email: rep.fromEmail, cancelled: c.affectedRows });
        }
        // Bounce processing: auto-suppress ONLY for definitive invalid_mailbox at high confidence.
        // Does NOT suppress: temporary, mailbox_full, network, policy, spam, domain_not_found, unknown.
        if (cls.classification === 'bounce_like' && bounceResult.failedRecipientEmail && !isMailerDaemon(bounceResult.failedRecipientEmail)) {
          if (shouldAutoSuppressBounce(bounceResult)) {
            const failedEmail = bounceResult.failedRecipientEmail.toLowerCase();
            await addSuppression(tenantId, failedEmail, 'bounce_hard');
            await query(
              `INSERT IGNORE INTO global_contact_suppression (type, normalized_value, reason, source)
               VALUES ('email', ?, 'hard_bounce', 'reply_import_bounce')`,
              [failedEmail],
            );
            await query("UPDATE contact_points SET status='bounced' WHERE value=?", [failedEmail]);
            await query(
              "UPDATE manual_outreach_queue SET safety_status='suppressed', status='do_not_contact' WHERE tenant_id=? AND email=? AND status IN ('pending_review','approved')",
              [tenantId, failedEmail],
            );
            // Cancel the FAILED recipient's follow-ups (the generic cancel above keys
            // on rep.fromEmail = mailer-daemon on a bounce). Mirrors the CLI importer.
            await query(
              "UPDATE manual_followup_tasks SET status='cancelled' WHERE tenant_id=? AND email=? AND status IN ('pending','ready')",
              [tenantId, failedEmail],
            );
            suppressedAuto++;
          }
        }
        // High-confidence explicit opt-out → auto-suppress (the ONLY automatic action for non-bounces).
        if (['do_not_contact', 'unsubscribe'].includes(cls.classification) && cls.confidence >= 0.9 && rep.fromEmail) {
          await suppressEverywhere(tenantId, rep.fromEmail, 'unsubscribe');
          suppressedAuto++;
        }
      } catch (e: any) {
        if (e?.code !== 'ER_DUP_ENTRY') throw e; // dedup by message-id
      }
    }
    await query('UPDATE sender_identities SET imap_last_uid=?, imap_last_checked_at=NOW() WHERE id=?', [r.maxUid, mb.id]);
    perBox.push({ mailboxId: mb.id, fetched: r.replies.length });
  }
  await audit(req, 'inbox.import', { type: 'mailbox' }, { imported, suppressedAuto, fetched, mailboxes: boxes.length });
  res.json({ imported, fetched, suppressedAuto, perBox, note: 'No messages deleted or moved. Auto-suppress only on explicit high-confidence opt-out/unsubscribe.' });
});

const REPLY_CLASSES = ['interested', 'not_interested', 'do_not_contact', 'unsubscribe',
  'wrong_person', 'out_of_office', 'bounce_like', 'auto_reply', 'unknown'] as const;
const replyPatch = z.object({
  classification: z.enum(REPLY_CLASSES).optional(),
  handled: z.boolean().optional(),
});
manualOutreachRouter.patch('/replies/:id', requireWriteAccess, async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const id = parseInt(req.params.id, 10);
  const p = replyPatch.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'invalid_body', detail: p.error.issues });
  const [row] = await query('SELECT id FROM inbox_replies WHERE id=? AND tenant_id=? LIMIT 1', [id, tenantId]);
  if (!row) return res.status(404).json({ error: 'not_found' });
  const sets: string[] = []; const vals: any[] = [];
  if (p.data.classification !== undefined) { sets.push('classification=?', "classification_source='manual'"); vals.push(p.data.classification); }
  if (p.data.handled !== undefined) { sets.push('handled=?'); vals.push(p.data.handled ? 1 : 0); }
  if (!sets.length) return res.json({ ok: true, unchanged: true });
  vals.push(id);
  await query(`UPDATE inbox_replies SET ${sets.join(', ')} WHERE id=?`, vals);
  await audit(req, 'inbox.reclassify', { type: 'inbox_reply', id }, { ...p.data });
  res.json({ ok: true });
});

// One-click suppress from a reply.
manualOutreachRouter.post('/replies/:id/suppress', requireWriteAccess, async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const id = parseInt(req.params.id, 10);
  const [row] = await query('SELECT * FROM inbox_replies WHERE id=? AND tenant_id=? LIMIT 1', [id, tenantId]);
  if (!row) return res.status(404).json({ error: 'not_found' });
  if (!row.from_email) return res.status(412).json({ error: 'no_sender_email' });
  await suppressEverywhere(tenantId, row.from_email, 'unsubscribe');
  await query("UPDATE inbox_replies SET classification='do_not_contact', handled=1 WHERE id=?", [id]);
  await audit(req, 'inbox.suppress', { type: 'inbox_reply', id }, { email: row.from_email });
  res.json({ ok: true, suppressed: row.from_email });
});

// Reply inbox 2.0 — threaded view grouped by company/contact, with the linked
// queue item + last outbound message + classification/confidence/reason.
manualOutreachRouter.get('/replies/threads', async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const replies = await query(
    `SELECT r.*, q.draft_subject AS outbound_subject, q.draft_body AS outbound_body,
            q.sent_at AS outbound_sent_at, q.status AS queue_status, q.company_name AS queue_company
     FROM inbox_replies r
     LEFT JOIN manual_outreach_queue q ON q.id = r.queue_item_id
     WHERE r.tenant_id=? ORDER BY r.received_at DESC, r.id DESC LIMIT 300`, [tenantId],
  );
  // Group by company_id (fallback: from_email).
  const threads = new Map<string, any>();
  for (const r of replies) {
    const key = r.company_id ? `c:${r.company_id}` : `e:${r.from_email ?? r.id}`;
    if (!threads.has(key)) {
      threads.set(key, {
        key, companyId: r.company_id, contactEmail: r.from_email,
        company: r.queue_company ?? null, replies: [],
        lastOutbound: r.outbound_subject ? { subject: r.outbound_subject, body: r.outbound_body, sentAt: r.outbound_sent_at, queueStatus: r.queue_status } : null,
      });
    }
    const t = threads.get(key);
    t.replies.push({
      id: r.id, subject: r.subject, snippet: r.body_snippet, receivedAt: r.received_at,
      classification: r.classification, source: r.classification_source,
      confidence: r.confidence, reason: r.classification_reason, handled: !!r.handled,
      queueItemId: r.queue_item_id,
    });
    if (!t.lastOutbound && r.outbound_subject) t.lastOutbound = { subject: r.outbound_subject, body: r.outbound_body, sentAt: r.outbound_sent_at, queueStatus: r.queue_status };
  }
  res.json({ threads: Array.from(threads.values()) });
});

// One-click: create a follow-up task from a reply's contact (after operator review).
manualOutreachRouter.post('/replies/:id/create-followup', requireWriteAccess, async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const id = parseInt(req.params.id, 10);
  const [row] = await query('SELECT * FROM inbox_replies WHERE id=? AND tenant_id=? LIMIT 1', [id, tenantId]);
  if (!row) return res.status(404).json({ error: 'not_found' });
  if (!row.from_email) return res.status(412).json({ error: 'no_sender_email' });
  const r = await createFollowupForEmail(tenantId, row.from_email, { contactPointId: row.contact_point_id, companyId: row.company_id, queueItemId: row.queue_item_id, step: 1 });
  await query('UPDATE inbox_replies SET handled=1 WHERE id=?', [id]);
  await audit(req, 'inbox.create_followup', { type: 'inbox_reply', id }, { email: row.from_email, followupId: r.id });
  res.json({ ok: true, followup: r });
});

// ── Suppression: one-click + CSV export/import ───────────────────────────────
async function suppressEverywhere(tenantId: number, email: string, reason: 'unsubscribe' | 'manual') {
  const e = email.toLowerCase();
  await addSuppression(tenantId, e, reason);
  await query(
    `INSERT IGNORE INTO global_contact_suppression (type, normalized_value, reason, source)
     VALUES ('email', ?, ?, 'manual_outreach')`,
    [e, reason === 'unsubscribe' ? 'unsubscribe' : 'do_not_contact'],
  );
  await query("UPDATE contact_points SET status='do_not_contact' WHERE value=?", [e]);
  await query("UPDATE manual_outreach_queue SET safety_status='suppressed' WHERE tenant_id=? AND email=? AND status IN ('pending_review','approved')", [tenantId, e]);
}

manualOutreachRouter.post('/suppress', requireWriteAccess, async (req, res) => {
  const schema = z.object({ email: z.string().email(), reason: z.enum(['unsubscribe', 'manual']).optional() });
  const p = schema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'invalid_body', detail: p.error.issues });
  await suppressEverywhere(req.auth!.tenantId!, p.data.email, p.data.reason ?? 'unsubscribe');
  await audit(req, 'manual_outreach.suppress', { type: 'suppression' }, { email: p.data.email });
  res.json({ ok: true, suppressed: p.data.email.toLowerCase() });
});

manualOutreachRouter.get('/suppression/export.csv', async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const tenantRows = await query('SELECT email, reason, created_at FROM suppressions WHERE tenant_id=?', [tenantId]);
  const globalRows = await query("SELECT normalized_value AS email, reason, created_at FROM global_contact_suppression WHERE type='email'", []);
  const lines = ['email,reason,scope,created_at'];
  for (const r of tenantRows) lines.push(`${r.email},${r.reason},tenant,${r.created_at?.toISOString?.() ?? r.created_at}`);
  for (const r of globalRows) lines.push(`${r.email},${r.reason},global,${r.created_at?.toISOString?.() ?? r.created_at}`);
  res.setHeader('content-type', 'text/csv');
  res.setHeader('content-disposition', 'attachment; filename="suppression.csv"');
  res.send(lines.join('\n'));
});

manualOutreachRouter.post('/suppression/import', requireWriteAccess, async (req, res) => {
  const schema = z.object({ csv: z.string().max(2_000_000) });
  const p = schema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'invalid_body' });
  const lines = p.data.csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let imported = 0, skipped = 0;
  for (const line of lines) {
    const email = line.split(',')[0].trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { skipped++; continue; }
    await suppressEverywhere(req.auth!.tenantId!, email, 'unsubscribe');
    imported++;
  }
  await audit(req, 'manual_outreach.suppression_import', { type: 'suppression' }, { imported, skipped });
  res.json({ imported, skipped });
});

// ── Warmup dashboard ─────────────────────────────────────────────────────────
manualOutreachRouter.get('/warmup', async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const mailboxes = await query(
    `SELECT si.id, si.from_email, si.status, si.daily_send_limit, si.sent_today, si.manual_sent_today,
            si.last_sent_at, si.warmup_stage, si.created_at, si.provider_id, sp.provider_type
     FROM sender_identities si
     LEFT JOIN sending_providers sp ON sp.id=si.provider_id
     WHERE si.tenant_id=? ORDER BY si.id ASC`, [tenantId],
  );
  const today = new Date().toISOString().slice(0, 10);
  const out = [];
  for (const m of mailboxes) {
    const created = m.created_at ? new Date(m.created_at) : new Date();
    const dayIndex = Math.max(1, Math.floor((Date.now() - created.getTime()) / 86400000) + 1);
    const todayManual = m.manual_counters_day && new Date(m.manual_counters_day).toISOString().slice(0, 10) === today ? Number(m.manual_sent_today) : 0;
    const sentToday = todayManual + Number(m.sent_today || 0);

    // Replies today / interested / negative / bounce-like from inbox_replies.
    const [r] = await query(
      `SELECT
         SUM(DATE(received_at)=CURDATE()) replies_today,
         SUM(DATE(received_at)=CURDATE() AND classification='interested') interested_today,
         SUM(DATE(received_at)=CURDATE() AND classification IN ('not_interested','do_not_contact','unsubscribe')) negative_today,
         SUM(DATE(received_at)=CURDATE() AND classification='bounce_like') bounce_today
       FROM inbox_replies WHERE tenant_id=? AND mailbox_id=?`, [tenantId, m.id],
    );
    // Today's sends split by method (from queue audit of actual sends).
    const [qsplit] = await query(
      `SELECT SUM(sent_method='smtp') smtp_today, SUM(sent_method='manual') manual_today
       FROM manual_outreach_queue WHERE tenant_id=? AND DATE(sent_at)=CURDATE()`, [tenantId],
    );
    const recommendedTomorrow = recommendedLimit(dayIndex + 1);
    const limit = Number(m.daily_send_limit);
    let health: 'safe' | 'warning' | 'danger' = 'safe';
    let reason = 'within limits';
    if (Number(r?.bounce_today || 0) > 0 || Number(r?.negative_today || 0) >= 2) { health = 'warning'; reason = 'bounce/negative replies present'; }
    if (Number(r?.bounce_today || 0) >= 3) { health = 'danger'; reason = '3+ bounce-like replies today'; }
    if (m.status !== 'active') { health = 'danger'; reason = `mailbox ${m.status}`; }

    out.push({
      mailboxId: m.id, provider: m.provider_type ?? 'unknown', email: m.from_email, status: m.status,
      dayIndex, dailyLimit: limit, sentToday, remainingToday: Math.max(0, limit - sentToday),
      manualSentToday: Number(m.manual_sent_today || 0), smtpSentToday: Number(qsplit?.smtp_today || 0),
      copySentToday: Number(qsplit?.manual_today || 0),
      repliesToday: Number(r?.replies_today || 0), interestedToday: Number(r?.interested_today || 0),
      negativeToday: Number(r?.negative_today || 0), bounceLikeToday: Number(r?.bounce_today || 0),
      lastSentAt: m.last_sent_at, recommendedLimitTomorrow: recommendedTomorrow, health, reason,
    });
  }
  res.json({
    mailboxes: out,
    schedule: { day1: 5, days2_3: 10, days4_7: 15, afterWeek1: 20 },
    note: 'Recommendation only. No automatic increase. Owner confirms healthy metrics before raising.',
  });
});

// Enable/disable IMAP reading + set start time on a mailbox.
const mbPatch = z.object({
  imapEnabled: z.boolean().optional(),
  imapStartAt: z.string().optional(),
  dailySendLimit: z.coerce.number().int().min(1).max(20).optional(),
  status: z.enum(['active', 'paused', 'disabled']).optional(),
});
manualOutreachRouter.patch('/mailbox/:id', requireWriteAccess, async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const id = parseInt(req.params.id, 10);
  const p = mbPatch.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'invalid_body', detail: p.error.issues });
  const [row] = await query('SELECT id FROM sender_identities WHERE id=? AND tenant_id=? LIMIT 1', [id, tenantId]);
  if (!row) return res.status(404).json({ error: 'not_found' });
  const sets: string[] = []; const vals: any[] = [];
  if (p.data.imapEnabled !== undefined) {
    sets.push('imap_enabled=?'); vals.push(p.data.imapEnabled ? 1 : 0);
    if (p.data.imapEnabled) { sets.push('imap_start_at=COALESCE(imap_start_at, NOW())'); }
  }
  if (p.data.imapStartAt !== undefined) { sets.push('imap_start_at=?'); vals.push(new Date(p.data.imapStartAt)); }
  if (p.data.dailySendLimit !== undefined) { sets.push('daily_send_limit=?'); vals.push(p.data.dailySendLimit); }
  if (p.data.status !== undefined) { sets.push('status=?'); vals.push(p.data.status); }
  if (!sets.length) return res.json({ ok: true, unchanged: true });
  vals.push(id);
  await query(`UPDATE sender_identities SET ${sets.join(', ')} WHERE id=?`, vals);
  await audit(req, 'mailbox.update', { type: 'mailbox', id }, { ...p.data });
  res.json({ ok: true });
});

// ── Safe follow-up queue (Phase 22) ─────────────────────────────────────────
// Follow-ups are TASKS, reviewed and sent BY HAND. No bulk send, no scheduler.
const FOLLOWUP_DUE_DAYS: Record<number, number> = { 1: 3, 2: 8 }; // conservative lower bound
const FOLLOWUP_TEMPLATE_KEY: Record<number, string> = { 1: 'clients_help_followup_1', 2: 'clients_help_followup_2' };

// The tenant's primary outreach mailbox (sender_identity) with fresh counters.
async function primaryMailbox(tenantId: number): Promise<any | null> {
  const [mb] = await query(
    "SELECT * FROM sender_identities WHERE tenant_id=? AND purpose='cold_outreach' ORDER BY id ASC LIMIT 1", [tenantId],
  );
  if (!mb) { const [any0] = await query('SELECT * FROM sender_identities WHERE tenant_id=? ORDER BY id ASC LIMIT 1', [tenantId]); return any0 ?? null; }
  return mb;
}

// Evaluate the hard blockers for a follow-up before it may be sent.
async function evaluateFollowupBlockers(tenantId: number, t: { email: string; body?: string | null }): Promise<string[]> {
  const blockers: string[] = [];
  const e = t.email.toLowerCase();
  // Any reply already received from this contact → stop the sequence.
  const [rep] = await query(
    `SELECT
       SUM(1) total,
       SUM(classification='bounce_like') bounce,
       SUM(classification IN('do_not_contact','unsubscribe')) optout
     FROM inbox_replies WHERE tenant_id=? AND from_email=?`, [tenantId, e],
  );
  if (Number(rep?.total || 0) > 0) blockers.push('reply_already_received');
  if (Number(rep?.bounce || 0) > 0) blockers.push('bounce_like_reply');
  if (Number(rep?.optout || 0) > 0) blockers.push('do_not_contact');
  if (await isEmailSuppressed(tenantId, e)) blockers.push('suppressed');
  // Queue item marked do_not_contact.
  const [qi] = await query("SELECT 1 FROM manual_outreach_queue WHERE tenant_id=? AND email=? AND status='do_not_contact' LIMIT 1", [tenantId, e]);
  if (qi) blockers.push('queue_do_not_contact');
  if (!hasOptOut(t.body)) blockers.push('opt_out_line_missing');
  // Mailbox state + daily cap.
  const mb = await primaryMailbox(tenantId);
  if (!mb) { blockers.push('no_mailbox'); }
  else {
    const m = await mailboxWithCounters(tenantId, mb.id);
    if (m.status !== 'active') blockers.push('mailbox_disabled_or_paused');
    if (Number(m.manual_sent_today) + Number(m.sent_today || 0) >= Number(m.daily_send_limit)) blockers.push('daily_limit_reached');
  }
  return blockers;
}

// Create a single follow-up task (NOT a send) for an email/contact.
async function createFollowupForEmail(
  tenantId: number, email: string,
  opts: { contactPointId?: number | null; companyId?: number | null; queueItemId?: number | null; step?: number; referenceAt?: Date | null },
): Promise<any> {
  const e = email.toLowerCase();
  const step = opts.step ?? 1;
  await ensureTemplates(tenantId);
  const tplKey = FOLLOWUP_TEMPLATE_KEY[step] ?? FOLLOWUP_TEMPLATE_KEY[1];
  const [tpl] = await query('SELECT subject, body FROM manual_outreach_templates WHERE tenant_id=? AND template_key=? LIMIT 1', [tenantId, tplKey]);
  // Company name for variable fill.
  let companyName: string | null = null;
  if (opts.queueItemId) { const [q] = await query('SELECT company_name FROM manual_outreach_queue WHERE id=? LIMIT 1', [opts.queueItemId]); companyName = q?.company_name ?? null; }
  if (!companyName && opts.companyId) { const [c] = await query('SELECT name FROM companies WHERE id=? LIMIT 1', [opts.companyId]); companyName = c?.name ?? null; }
  const vars = { company: companyName || 'your business', sender_name: '{{sender_name}}', sender_address: '{{sender_address}}' };
  const draft = tpl ? renderTemplate(tpl, vars) : { subject: '', body: '' };
  // due_at = reference time + step delay.
  const ref = opts.referenceAt ? new Date(opts.referenceAt) : new Date();
  const due = new Date(ref.getTime() + (FOLLOWUP_DUE_DAYS[step] ?? 3) * 86400000);
  const mb = await primaryMailbox(tenantId);
  const blockers = await evaluateFollowupBlockers(tenantId, { email: e, body: draft.body });
  const status = blockers.length ? 'blocked' : (due <= new Date() ? 'ready' : 'pending');
  try {
    const r = await query(
      `INSERT INTO manual_followup_tasks
        (tenant_id, queue_item_id, contact_point_id, company_id, mailbox_id, email, company_name,
         due_at, status, followup_step, subject, body, blockers_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [tenantId, opts.queueItemId ?? null, opts.contactPointId ?? null, opts.companyId ?? null,
       mb?.id ?? null, e, companyName, due, status, step, draft.subject, draft.body,
       blockers.length ? JSON.stringify(blockers) : null],
    );
    return { id: Number(r.insertId), step, status, dueAt: due, blockers };
  } catch (e2: any) {
    if (e2?.code === 'ER_DUP_ENTRY') {
      const [ex] = await query('SELECT id, status FROM manual_followup_tasks WHERE tenant_id=? AND email=? AND followup_step=? LIMIT 1', [tenantId, e, step]);
      return { id: ex?.id, step, status: ex?.status, blockers, duplicate: true };
    }
    throw e2;
  }
}

// Create a follow-up from a sent queue item (or raw email).
const followupCreateSchema = z.object({
  queueItemId: z.coerce.number().int().optional(),
  email: z.string().email().optional(),
  step: z.coerce.number().int().min(1).max(2).optional(),
});
manualOutreachRouter.post('/followups', requireWriteAccess, async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const p = followupCreateSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'invalid_body', detail: p.error.issues });
  let email = p.data.email?.toLowerCase() ?? null;
  let opts: any = { step: p.data.step ?? 1 };
  if (p.data.queueItemId) {
    const [q] = await query('SELECT * FROM manual_outreach_queue WHERE id=? AND tenant_id=? LIMIT 1', [p.data.queueItemId, tenantId]);
    if (!q) return res.status(404).json({ error: 'queue_item_not_found' });
    email = q.email; opts = { ...opts, contactPointId: q.contact_point_id, companyId: q.company_id, queueItemId: q.id, referenceAt: q.sent_at };
  }
  if (!email) return res.status(400).json({ error: 'email_or_queue_item_required' });
  const r = await createFollowupForEmail(tenantId, email, opts);
  await audit(req, 'followup.create', { type: 'followup', id: r.id }, { email, step: opts.step });
  res.status(201).json(r);
});

// Generate follow-up tasks for sent queue items that don't have one yet (creates
// TASKS only — never sends). Operator-triggered, capped.
manualOutreachRouter.post('/followups/generate', requireWriteAccess, async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const sent = await query(
    `SELECT q.* FROM manual_outreach_queue q
     WHERE q.tenant_id=? AND q.status IN('sent_manual','sent_smtp')
       AND NOT EXISTS (SELECT 1 FROM manual_followup_tasks f WHERE f.tenant_id=q.tenant_id AND f.email=q.email AND f.followup_step=1)
     ORDER BY q.sent_at ASC LIMIT 50`, [tenantId],
  );
  let created = 0, blocked = 0;
  for (const q of sent) {
    const r = await createFollowupForEmail(tenantId, q.email, { contactPointId: q.contact_point_id, companyId: q.company_id, queueItemId: q.id, step: 1, referenceAt: q.sent_at });
    if (r.duplicate) continue;
    created++;
    if (r.status === 'blocked') blocked++;
  }
  await audit(req, 'followup.generate', { type: 'followup' }, { created, blocked, scanned: sent.length });
  res.json({ created, blocked, scanned: sent.length, note: 'Tasks only. Nothing sent. Review each before sending.' });
});

// List follow-ups grouped: due today / upcoming / blocked / sent / skipped.
manualOutreachRouter.get('/followups', async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const rows = await query('SELECT * FROM manual_followup_tasks WHERE tenant_id=? ORDER BY due_at ASC, id ASC LIMIT 300', [tenantId]);
  const now = Date.now();
  const groups: any = { dueToday: [], upcoming: [], blocked: [], sent: [], skipped: [], cancelled: [] };
  for (const r of rows) {
    if (r.status === 'sent_manually') groups.sent.push(r);
    else if (r.status === 'skipped') groups.skipped.push(r);
    else if (r.status === 'cancelled') groups.cancelled.push(r);
    else if (r.status === 'blocked') groups.blocked.push(r);
    else {
      const due = r.due_at ? new Date(r.due_at).getTime() : now;
      if (due <= now + 86400000) groups.dueToday.push(r);
      else groups.upcoming.push(r);
    }
  }
  res.json({ groups, counts: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, (v as any[]).length])),
    timing: { step1Days: '3-4', step2Days: '7-10', maxFollowups: 2 } });
});

// Re-evaluate a follow-up's blockers + render copy for manual send.
manualOutreachRouter.get('/followups/:id/copy', async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const id = parseInt(req.params.id, 10);
  const [t] = await query('SELECT * FROM manual_followup_tasks WHERE id=? AND tenant_id=? LIMIT 1', [id, tenantId]);
  if (!t) return res.status(404).json({ error: 'not_found' });
  const blockers = await evaluateFollowupBlockers(tenantId, { email: t.email, body: t.body });
  // Persist refreshed blockers + status.
  const status = blockers.length ? 'blocked' : (t.status === 'pending' || t.status === 'ready' ? 'copied' : t.status);
  await query('UPDATE manual_followup_tasks SET blockers_json=?, status=? WHERE id=?',
    [blockers.length ? JSON.stringify(blockers) : null, status, id]);
  res.json({ recipient: t.email, subject: t.subject, body: t.body, step: t.followup_step,
    blockers, note: 'Paste into your mailbox manually, then mark as sent.' });
});

manualOutreachRouter.post('/followups/:id/mark-sent', requireWriteAccess, async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const id = parseInt(req.params.id, 10);
  const [t] = await query('SELECT * FROM manual_followup_tasks WHERE id=? AND tenant_id=? LIMIT 1', [id, tenantId]);
  if (!t) return res.status(404).json({ error: 'not_found' });
  if (t.status === 'sent_manually') return res.status(409).json({ error: 'already_sent' });
  const blockers = await evaluateFollowupBlockers(tenantId, { email: t.email, body: t.body });
  if (blockers.length) return res.status(412).json({ error: 'send_blocked', blockers });
  await query("UPDATE manual_followup_tasks SET status='sent_manually', sent_at=NOW() WHERE id=?", [id]);
  // Count against the mailbox manual cap.
  if (t.mailbox_id) { await mailboxWithCounters(tenantId, t.mailbox_id); await query('UPDATE sender_identities SET manual_sent_today=manual_sent_today+1, sent_today=sent_today+1, last_sent_at=NOW() WHERE id=?', [t.mailbox_id]); }
  await recordTouchpoint({
    tenantId, contactPointId: t.contact_point_id, companyId: t.company_id, queueItemId: t.queue_item_id,
    followupTaskId: id, mailboxId: t.mailbox_id, email: t.email, channel: 'manual_zoho',
    direction: 'outbound', touchType: t.followup_step >= 2 ? 'followup_2' : 'followup_1',
    subject: t.subject, body: t.body, status: 'sent_manual', sentAt: new Date(),
  });
  await audit(req, 'followup.mark_sent', { type: 'followup', id }, { email: t.email, step: t.followup_step });
  res.json({ ok: true, marked: 'sent_manually' });
});

manualOutreachRouter.post('/followups/:id/skip', requireWriteAccess, async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const id = parseInt(req.params.id, 10);
  const [t] = await query('SELECT id FROM manual_followup_tasks WHERE id=? AND tenant_id=? LIMIT 1', [id, tenantId]);
  if (!t) return res.status(404).json({ error: 'not_found' });
  await query("UPDATE manual_followup_tasks SET status='skipped' WHERE id=?", [id]);
  await audit(req, 'followup.skip', { type: 'followup', id }, {});
  res.json({ ok: true });
});

manualOutreachRouter.post('/followups/:id/suppress', requireWriteAccess, async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const id = parseInt(req.params.id, 10);
  const [t] = await query('SELECT * FROM manual_followup_tasks WHERE id=? AND tenant_id=? LIMIT 1', [id, tenantId]);
  if (!t) return res.status(404).json({ error: 'not_found' });
  await suppressEverywhere(tenantId, t.email, 'unsubscribe');
  // Cancel the whole sequence for this contact.
  await query("UPDATE manual_followup_tasks SET status='cancelled', blockers_json=JSON_ARRAY('suppressed') WHERE tenant_id=? AND email=? AND status IN('pending','ready','blocked','copied')", [tenantId, t.email]);
  await audit(req, 'followup.suppress', { type: 'followup', id }, { email: t.email });
  res.json({ ok: true, suppressed: t.email });
});

// Cancel the whole sequence for this contact.
manualOutreachRouter.post('/followups/:id/cancel', requireWriteAccess, async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const id = parseInt(req.params.id, 10);
  const [t] = await query('SELECT * FROM manual_followup_tasks WHERE id=? AND tenant_id=? LIMIT 1', [id, tenantId]);
  if (!t) return res.status(404).json({ error: 'not_found' });
  await query("UPDATE manual_followup_tasks SET status='cancelled' WHERE tenant_id=? AND email=? AND status IN('pending','ready','blocked','copied')", [tenantId, t.email]);
  await audit(req, 'followup.cancel', { type: 'followup', id }, { email: t.email });
  res.json({ ok: true, cancelled: t.email });
});

// ── "Why is this contact blocked?" debug (Phase 22 — suppression-first) ───────
manualOutreachRouter.get('/why-blocked', async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const email = typeof req.query.email === 'string' ? req.query.email.toLowerCase().trim() : '';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'invalid_email' });
  const domain = email.split('@')[1] ?? '';
  const reasons: string[] = [];
  if (!email) reasons.push('missing_email');
  const [g] = await query("SELECT type FROM global_contact_suppression WHERE (type='email' AND normalized_value=?) OR (type='domain' AND normalized_value=?) LIMIT 1", [email, domain]);
  if (g) reasons.push(g.type === 'domain' ? 'global_domain_suppression' : 'global_suppression');
  const [s] = await query('SELECT reason FROM suppressions WHERE tenant_id=? AND email=? LIMIT 1', [tenantId, email]);
  if (s) reasons.push(`tenant_suppression:${s.reason}`);
  const [cp] = await query('SELECT status FROM contact_points WHERE value=? LIMIT 1', [email]);
  if (cp) {
    if (cp.status === 'do_not_contact') reasons.push('do_not_contact');
    if (cp.status === 'invalid') reasons.push('invalid');
    if (cp.status === 'risky') reasons.push('risky');
    if (cp.status === 'bounced') reasons.push('bounced');
  }
  const [rep] = await query("SELECT SUM(1) t, SUM(classification IN('do_not_contact','unsubscribe')) o, SUM(classification='bounce_like') b FROM inbox_replies WHERE tenant_id=? AND from_email=?", [tenantId, email]);
  if (Number(rep?.t || 0) > 0) reasons.push('reply_already_received');
  if (Number(rep?.o || 0) > 0) reasons.push('reply_opt_out');
  if (Number(rep?.b || 0) > 0) reasons.push('bounced');
  // Mailbox / domain limits.
  const mb = await primaryMailbox(tenantId);
  if (!mb) reasons.push('provider_not_ready');
  else {
    const m = await mailboxWithCounters(tenantId, mb.id);
    if (m.status !== 'active') reasons.push('mailbox_paused');
    if (Number(m.manual_sent_today) + Number(m.sent_today || 0) >= Number(m.daily_send_limit)) reasons.push('mailbox_limit_reached');
  }
  const [cancelled] = await query("SELECT 1 FROM manual_followup_tasks WHERE tenant_id=? AND email=? AND status='cancelled' LIMIT 1", [tenantId, email]);
  if (cancelled) reasons.push('sequence_cancelled');
  res.json({ email, blocked: reasons.length > 0, reasons,
    note: reasons.length ? 'Contact is blocked for the reasons above.' : 'No blockers found — contact appears contactable (still requires manual approval).' });
});

// ── Today's Outreach dashboard (Phase 22) ────────────────────────────────────
manualOutreachRouter.get('/today', async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  // Allowed/sent today across mailboxes (manual sends counted on sender_identities).
  const boxes = await query('SELECT * FROM sender_identities WHERE tenant_id=?', [tenantId]);
  let allowed = 0, sentToday = 0; const mailboxHealth: any[] = [];
  const today = new Date().toISOString().slice(0, 10);
  for (const mb0 of boxes) {
    const mb = await mailboxWithCounters(tenantId, mb0.id);
    const used = Number(mb.manual_sent_today) + Number(mb.sent_today || 0);
    allowed += Number(mb.daily_send_limit);
    sentToday += used;
    let health: 'safe' | 'warning' | 'danger' = 'safe';
    if (mb.status !== 'active') health = 'danger';
    else if (used >= Number(mb.daily_send_limit)) health = 'warning';
    mailboxHealth.push({ mailboxId: mb.id, email: mb.from_email, status: mb.status, used, limit: Number(mb.daily_send_limit), health });
  }
  const remaining = Math.max(0, allowed - sentToday);
  // Replies today by class.
  const [r] = await query(
    `SELECT
       SUM(DATE(received_at)=CURDATE()) total,
       SUM(DATE(received_at)=CURDATE() AND classification='interested') interested,
       SUM(DATE(received_at)=CURDATE() AND classification IN('not_interested','do_not_contact','unsubscribe')) negative,
       SUM(DATE(received_at)=CURDATE() AND classification='bounce_like') bounce
     FROM inbox_replies WHERE tenant_id=?`, [tenantId],
  );
  // Suppressions today.
  const [sup] = await query('SELECT SUM(DATE(created_at)=CURDATE()) c FROM suppressions WHERE tenant_id=?', [tenantId]);
  // Follow-ups due today.
  const [fu] = await query("SELECT SUM(status IN('pending','ready') AND due_at<=NOW()+INTERVAL 1 DAY) due, SUM(status='blocked') blocked FROM manual_followup_tasks WHERE tenant_id=?", [tenantId]);
  // Queue ready / blocked.
  const [q] = await query("SELECT SUM(status='approved') ready, SUM(status='pending_review') pending, SUM(safety_status IN('suppressed','blocked')) blocked FROM manual_outreach_queue WHERE tenant_id=?", [tenantId]);

  // Next recommended action (single, deterministic).
  let next = 'All clear. Build a small cohort (max 20) when ready.';
  if (Number(r?.interested || 0) > 0) next = `Reply to ${r.interested} interested lead(s) in the Replies tab.`;
  else if (Number(fu?.due || 0) > 0) next = `Send ${fu.due} follow-up(s) due today (Follow-ups tab).`;
  else if (Number(q?.ready || 0) > 0 && remaining > 0) next = `Send ${Math.min(Number(q.ready), remaining)} approved item(s) today (Queue tab).`;
  else if (Number(q?.pending || 0) > 0) next = `Review ${q.pending} pending queue item(s) and approve.`;
  else if (remaining === 0 && allowed > 0) next = 'Daily limit reached. Stop sending until tomorrow.';

  res.json({
    allowedToday: allowed, sentManuallyToday: sentToday, remainingToday: remaining,
    repliesToday: Number(r?.total || 0), interestedReplies: Number(r?.interested || 0),
    negativeReplies: Number(r?.negative || 0), bounceLikeToday: Number(r?.bounce || 0),
    suppressionsToday: Number(sup?.c || 0),
    followupsDueToday: Number(fu?.due || 0), followupsBlocked: Number(fu?.blocked || 0),
    queueReady: Number(q?.ready || 0), queuePending: Number(q?.pending || 0), queueBlocked: Number(q?.blocked || 0),
    mailboxHealth, nextRecommendedAction: next,
  });
});

// ── Overview ─────────────────────────────────────────────────────────────────
manualOutreachRouter.get('/status', async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const p = zohoPresence();
  const [q] = await query(
    `SELECT
       SUM(status='pending_review') pending_review, SUM(status='approved') approved,
       SUM(status IN ('sent_manual','sent_smtp')) sent, SUM(status='do_not_contact') do_not_contact
     FROM manual_outreach_queue WHERE tenant_id=?`, [tenantId],
  );
  const [tmpl] = await query('SELECT SUM(approved=1) approved, COUNT(*) total FROM manual_outreach_templates WHERE tenant_id=?', [tenantId]);
  const [repl] = await query('SELECT COUNT(*) total, SUM(handled=0) unhandled FROM inbox_replies WHERE tenant_id=?', [tenantId]);
  res.json({
    bridgeStatus: zohoBridgeStatus(p),
    smtpConfigured: p.smtpConfigured, imapConfigured: p.imapConfigured,
    copyModeAvailable: true,
    queue: q, templates: tmpl, replies: repl,
    realWorldSends: { systemSmtp: 0, note: 'App only sends if operator configured Zoho creds and clicked send. Mailhog still default for campaigns.' },
  });
});

// ── Drip scheduler control (Phase 22G) ───────────────────────────────────────
// Arm/disarm automatic time-distributed sending of APPROVED queue items. Disabled
// by default. Each mailbox sends hourly_per_mailbox/hour, daily_per_mailbox/day,
// spaced by min_interval_min, inside [window_start_hour, window_end_hour) UTC.
async function loadDrip(tenantId: number) {
  let [s] = await query('SELECT * FROM outreach_drip_settings WHERE tenant_id=? LIMIT 1', [tenantId]);
  if (!s) {
    await query('INSERT INTO outreach_drip_settings (tenant_id) VALUES (?) ON DUPLICATE KEY UPDATE tenant_id=tenant_id', [tenantId]);
    [s] = await query('SELECT * FROM outreach_drip_settings WHERE tenant_id=? LIMIT 1', [tenantId]);
  }
  return s;
}

manualOutreachRouter.get('/drip', async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const s = await loadDrip(tenantId);
  // Live snapshot: approved-and-assigned backlog, sent today, per active mailbox.
  const [agg] = await query(
    `SELECT
       SUM(CASE WHEN status='approved' AND mailbox_id IS NOT NULL THEN 1 ELSE 0 END) AS ready,
       SUM(CASE WHEN status='approved' AND mailbox_id IS NULL THEN 1 ELSE 0 END) AS unassigned,
       SUM(CASE WHEN status IN ('sent_smtp','sent_manual') AND DATE(sent_at)=UTC_DATE() THEN 1 ELSE 0 END) AS sent_today
     FROM manual_outreach_queue WHERE tenant_id=?`, [tenantId]);
  const mailboxes = await query(
    `SELECT id, from_email, status, daily_send_limit, hourly_send_limit,
       (SELECT COUNT(*) FROM manual_outreach_queue q WHERE q.mailbox_id=m.id AND q.status IN ('sent_smtp','sent_manual') AND DATE(q.sent_at)=UTC_DATE()) AS sent_today,
       (SELECT COUNT(*) FROM manual_outreach_queue q WHERE q.mailbox_id=m.id AND q.status='approved') AS approved_assigned
     FROM sender_identities m WHERE m.tenant_id=? AND m.status='active' AND m.outbound_enabled=1`, [tenantId]);
  res.json({
    settings: {
      enabled: !!s.enabled, daily_per_mailbox: s.daily_per_mailbox, hourly_per_mailbox: s.hourly_per_mailbox,
      min_interval_min: s.min_interval_min, window_start_hour: s.window_start_hour, window_end_hour: s.window_end_hour,
      enabled_at: s.enabled_at, last_tick_at: s.last_tick_at, sent_total: s.sent_total,
    },
    snapshot: {
      ready: Number(agg?.ready ?? 0), unassigned: Number(agg?.unassigned ?? 0), sent_today: Number(agg?.sent_today ?? 0),
      active_mailboxes: mailboxes.length, mailboxes,
    },
    note: 'Drip sends REAL email from active mailboxes. Disabled until enabled=true. Per-item gates (approved + opt-out + not suppressed) always apply.',
  });
});

const dripSchema = z.object({
  enabled: z.boolean().optional(),
  daily_per_mailbox: z.number().int().min(1).max(200).optional(),
  hourly_per_mailbox: z.number().int().min(1).max(60).optional(),
  min_interval_min: z.number().int().min(0).max(720).optional(),
  window_start_hour: z.number().int().min(0).max(23).optional(),
  window_end_hour: z.number().int().min(1).max(24).optional(),
  confirm: z.boolean().optional(),
});
manualOutreachRouter.post('/drip', requireWriteAccess, async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const p = dripSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'invalid_body', detail: p.error.issues });
  const d = p.data;
  await loadDrip(tenantId);
  // Enabling REAL automatic sending requires explicit confirm:true.
  if (d.enabled === true && d.confirm !== true) {
    return res.status(412).json({ error: 'confirm_required', detail: 'Enabling drip starts REAL automatic sending. Pass confirm:true.' });
  }
  const sets: string[] = []; const vals: any[] = [];
  for (const k of ['daily_per_mailbox', 'hourly_per_mailbox', 'min_interval_min', 'window_start_hour', 'window_end_hour'] as const) {
    if (d[k] !== undefined) { sets.push(`${k}=?`); vals.push(d[k]); }
  }
  if (d.enabled !== undefined) {
    sets.push('enabled=?'); vals.push(d.enabled ? 1 : 0);
    if (d.enabled) { sets.push('enabled_at=NOW()'); }
  }
  if (sets.length) { vals.push(tenantId); await query(`UPDATE outreach_drip_settings SET ${sets.join(', ')} WHERE tenant_id=?`, vals); }
  await audit(req, d.enabled === true ? 'drip.enable' : d.enabled === false ? 'drip.disable' : 'drip.config',
    { type: 'drip', id: tenantId }, { ...d, confirm: undefined });
  const s = await loadDrip(tenantId);
  res.json({ ok: true, enabled: !!s.enabled, settings: s });
});
