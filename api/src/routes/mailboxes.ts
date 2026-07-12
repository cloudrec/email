import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { authMiddleware, requireTenant, requireWriteAccess } from '../middleware/auth.js';
import { audit } from '../middleware/audit.js';
import {
  resolveProvider, testSmtp as rtTestSmtp, testImap as rtTestImap, type ProviderRow,
} from '../services/mailboxRuntime.js';
import { setSecret, storedRefs } from '../services/secretsVault.js';
import {
  suggestEnvRefs, envSnippet, rollMailboxCounters, computeHealth, recommendNextLimit,
  mailboxBlockers, dailyRemaining, fleetStats, assignMailboxes, priorMailboxMaps,
  parseMailboxCsv, formatMailboxCsv, MAILBOX_CSV_COLUMNS, isValidEmail,
  NEW_MAILBOX_DAILY, NEW_MAILBOX_HOURLY, type AssignStrategy, type AssignItem,
} from '../services/mailboxFleet.js';

// Phase 22D — Multi-mailbox orchestrator + fleet manager.
// Mounted at /mailboxes. Manages reusable PROVIDER PROFILES (sending_providers)
// + MAILBOX ACCOUNTS (sender_identities). Secrets NEVER stored/echoed — only
// env-var NAMES. NO send endpoint here; tests verify connection only.

export const mailboxesRouter = Router();
mailboxesRouter.use(authMiddleware, requireTenant);

// ── Helpers ──────────────────────────────────────────────────────────────────
async function loadProvider(tenantId: number, id: number): Promise<any | null> {
  const [p] = await query('SELECT * FROM sending_providers WHERE id=? AND tenant_id=? LIMIT 1', [id, tenantId]);
  return p ?? null;
}

// Build a ProviderRow for the runtime where MAILBOX refs override profile refs.
function mailboxProviderRow(mailbox: any, provider: any): ProviderRow {
  return {
    id: provider?.id ?? 0,
    provider_type: provider?.provider_type ?? 'generic_smtp_imap',
    name: provider?.name ?? null,
    smtp_host: provider?.smtp_host ?? null,
    smtp_port: provider?.smtp_port ?? null,
    smtp_secure: provider?.smtp_secure ?? null,
    imap_host: provider?.imap_host ?? null,
    imap_port: provider?.imap_port ?? null,
    imap_secure: provider?.imap_secure ?? null,
    smtp_user_ref: mailbox.smtp_user_ref || provider?.smtp_user_ref || provider?.username_ref || null,
    smtp_secret_ref: mailbox.smtp_secret_ref || provider?.smtp_secret_ref || provider?.secret_ref || null,
    imap_user_ref: mailbox.imap_user_ref || provider?.imap_user_ref || null,
    imap_secret_ref: mailbox.imap_secret_ref || provider?.imap_secret_ref || null,
    inbound_enabled: mailbox.inbound_enabled,
    outbound_enabled: mailbox.outbound_enabled,
  };
}

function mailboxView(m: any, provider?: any) {
  const refs = {
    smtp_user_ref: m.smtp_user_ref, smtp_secret_ref: m.smtp_secret_ref,
    imap_user_ref: m.imap_user_ref, imap_secret_ref: m.imap_secret_ref,
  };
  return {
    id: m.id,
    email: m.from_email,
    display_name: m.display_name,
    purpose: m.purpose,
    status: m.status,
    outbound_enabled: !!m.outbound_enabled,
    inbound_enabled: !!m.inbound_enabled,
    provider_profile_id: m.provider_id,
    provider_profile_name: provider?.name ?? null,
    domain_id: m.domain_id,
    daily_send_limit: m.daily_send_limit,
    hourly_send_limit: m.hourly_send_limit,
    warmup_stage: m.warmup_stage,
    health_status: computeHealth(m),
    daily_remaining: dailyRemaining(m),
    sent_today: m.sent_today, smtp_sent_today: m.smtp_sent_today, manual_sent_today: m.manual_sent_today,
    replies_today: m.replies_today, interested_today: m.interested_today, negative_today: m.negative_today,
    bounce_like_today: m.bounce_like_today, complaints_today: m.complaints_today, unsubscribes_today: m.unsubscribes_today,
    last_smtp_test_at: m.last_smtp_test_at, last_imap_test_at: m.last_imap_test_at,
    last_sent_at: m.last_sent_at, last_reply_at: m.last_reply_at, last_error: m.last_error,
    paused_reason: m.paused_reason,
    env_refs: refs,
    blockers: mailboxBlockers(m, provider),
    created_at: m.created_at,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// PART 2 — PROVIDER PROFILES
// ══════════════════════════════════════════════════════════════════════════════
mailboxesRouter.get('/providers', async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const rows = await query('SELECT * FROM sending_providers WHERE tenant_id=? ORDER BY id ASC', [tenantId]);
  res.json({
    profiles: rows.map((p: any) => {
      const conn = resolveProvider(p as ProviderRow);
      return {
        id: p.id, name: p.name, provider_type: p.provider_type, status: p.status,
        smtp_host: p.smtp_host, smtp_port: p.smtp_port, smtp_secure: !!p.smtp_secure,
        imap_host: p.imap_host, imap_port: p.imap_port, imap_secure: !!p.imap_secure,
        default_from_name: p.default_from_name,
        default_daily_limit: p.default_daily_limit, default_hourly_limit: p.default_hourly_limit,
        inbound_enabled: !!p.inbound_enabled, outbound_enabled: !!p.outbound_enabled,
        env_refs: {
          smtp_user_ref: p.smtp_user_ref, smtp_secret_ref: p.smtp_secret_ref,
          imap_user_ref: p.imap_user_ref, imap_secret_ref: p.imap_secret_ref,
        },
        smtp_configured: conn.smtpConfigured, imap_configured: conn.imapConfigured,
      };
    }),
  });
});

const providerSchema = z.object({
  name: z.string().min(1).max(120),
  provider_type: z.enum([
    'zoho_smtp_imap', 'generic_smtp_imap', 'gmail_workspace_later',
    'microsoft_365_later', 'self_hosted_smtp_imap_later',
  ]).default('generic_smtp_imap'),
  smtp_host: z.string().max(255).optional(),
  smtp_port: z.number().int().optional(),
  smtp_secure: z.boolean().optional(),
  imap_host: z.string().max(255).optional(),
  imap_port: z.number().int().optional(),
  imap_secure: z.boolean().optional(),
  default_from_name: z.string().max(160).optional(),
  default_daily_limit: z.number().int().min(1).max(500).optional(),
  default_hourly_limit: z.number().int().min(1).max(200).optional(),
  smtp_user_ref: z.string().max(120).optional(),
  smtp_secret_ref: z.string().max(120).optional(),
  imap_user_ref: z.string().max(120).optional(),
  imap_secret_ref: z.string().max(120).optional(),
});

mailboxesRouter.post('/providers', requireWriteAccess, async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const p = providerSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'invalid', detail: p.error.flatten() });
  const d = p.data;
  const r = await query(
    `INSERT INTO sending_providers
      (tenant_id, provider_type, name, default_from_name, smtp_host, smtp_port, smtp_secure,
       imap_host, imap_port, imap_secure, smtp_user_ref, smtp_secret_ref, imap_user_ref, imap_secret_ref,
       inbound_enabled, outbound_enabled, default_daily_limit, default_hourly_limit, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, 'active')`,
    [tenantId, d.provider_type, d.name, d.default_from_name ?? null,
     d.smtp_host ?? null, d.smtp_port ?? 587, d.smtp_secure ? 1 : 0,
     d.imap_host ?? null, d.imap_port ?? 993, d.imap_secure === false ? 0 : 1,
     d.smtp_user_ref ?? null, d.smtp_secret_ref ?? null, d.imap_user_ref ?? null, d.imap_secret_ref ?? null,
     d.default_daily_limit ?? NEW_MAILBOX_DAILY, d.default_hourly_limit ?? NEW_MAILBOX_HOURLY],
  );
  await audit(req, 'provider_profile.create', { type: 'sending_provider', id: r.insertId }, { name: d.name, type: d.provider_type });
  res.json({ ok: true, id: Number(r.insertId) });
});

mailboxesRouter.patch('/providers/:id', requireWriteAccess, async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const id = Number(req.params.id);
  const prov = await loadProvider(tenantId, id);
  if (!prov) return res.status(404).json({ error: 'not_found' });
  const d = providerSchema.partial().safeParse(req.body);
  if (!d.success) return res.status(400).json({ error: 'invalid', detail: d.error.flatten() });
  const f = d.data;
  const sets: string[] = []; const vals: any[] = [];
  const map: Record<string, any> = {
    name: f.name, default_from_name: f.default_from_name, smtp_host: f.smtp_host,
    smtp_port: f.smtp_port, imap_host: f.imap_host, imap_port: f.imap_port,
    smtp_user_ref: f.smtp_user_ref, smtp_secret_ref: f.smtp_secret_ref,
    imap_user_ref: f.imap_user_ref, imap_secret_ref: f.imap_secret_ref,
    default_daily_limit: f.default_daily_limit, default_hourly_limit: f.default_hourly_limit,
  };
  for (const [k, v] of Object.entries(map)) if (v !== undefined) { sets.push(`${k}=?`); vals.push(v); }
  if (f.smtp_secure !== undefined) { sets.push('smtp_secure=?'); vals.push(f.smtp_secure ? 1 : 0); }
  if (f.imap_secure !== undefined) { sets.push('imap_secure=?'); vals.push(f.imap_secure ? 1 : 0); }
  if (!sets.length) return res.json({ ok: true, unchanged: true });
  vals.push(id, tenantId);
  await query(`UPDATE sending_providers SET ${sets.join(', ')} WHERE id=? AND tenant_id=?`, vals);
  await audit(req, 'provider_profile.update', { type: 'sending_provider', id }, { fields: Object.keys(map).filter((k) => map[k] !== undefined) });
  res.json({ ok: true });
});

// Seed the shared Zoho EU profile (idempotent — one per tenant).
mailboxesRouter.post('/providers/seed-zoho-eu', requireWriteAccess, async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const [existing] = await query(
    `SELECT id FROM sending_providers WHERE tenant_id=? AND provider_type='zoho_smtp_imap' AND name='Zoho EU' LIMIT 1`,
    [tenantId],
  );
  if (existing) return res.json({ ok: true, id: existing.id, alreadyExists: true });
  const r = await query(
    `INSERT INTO sending_providers
      (tenant_id, provider_type, name, smtp_host, smtp_port, smtp_secure,
       imap_host, imap_port, imap_secure, inbound_enabled, outbound_enabled,
       default_daily_limit, default_hourly_limit, status)
     VALUES (?, 'zoho_smtp_imap', 'Zoho EU', 'smtp.zoho.eu', 587, 0,
       'imap.zoho.eu', 993, 1, 1, 1, 5, 2, 'active')`,
    [tenantId],
  );
  await audit(req, 'provider_profile.create', { type: 'sending_provider', id: r.insertId }, { name: 'Zoho EU', seed: true });
  res.json({ ok: true, id: Number(r.insertId) });
});

mailboxesRouter.post('/providers/:id/disable', requireWriteAccess, async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const id = Number(req.params.id);
  const prov = await loadProvider(tenantId, id);
  if (!prov) return res.status(404).json({ error: 'not_found' });
  await query('UPDATE sending_providers SET status=? WHERE id=? AND tenant_id=?', [req.body?.enable ? 'active' : 'disabled', id, tenantId]);
  await audit(req, 'provider_profile.update', { type: 'sending_provider', id }, { status: req.body?.enable ? 'active' : 'disabled' });
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// PART 3/4 — MAILBOX ACCOUNTS
// ══════════════════════════════════════════════════════════════════════════════
mailboxesRouter.get('/', async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const mailboxes = await query('SELECT * FROM sender_identities WHERE tenant_id=? ORDER BY id ASC', [tenantId]);
  const providers = await query('SELECT * FROM sending_providers WHERE tenant_id=?', [tenantId]);
  const provById = new Map<number, any>(providers.map((p: any) => [p.id, p]));
  for (const m of mailboxes) await rollMailboxCounters(m);
  // Which mailboxes already have UI-entered (DB) credentials stored.
  const allRefs = mailboxes.flatMap((m: any) => [m.smtp_user_ref, m.smtp_secret_ref, m.imap_user_ref, m.imap_secret_ref]).filter(Boolean);
  const stored = await storedRefs(tenantId, allRefs);
  res.json({ mailboxes: mailboxes.map((m: any) => ({
    ...mailboxView(m, m.provider_id ? provById.get(m.provider_id) : undefined),
    creds_stored: { smtp: stored.has(m.smtp_secret_ref), imap: stored.has(m.imap_secret_ref) },
  })) });
});

mailboxesRouter.get('/fleet', async (req, res) => {
  res.json(await fleetStats(req.auth!.tenantId!));
});

// ── Credentials entry from the UI (no .env editing) ──────────────────────────
// Stores SMTP/IMAP user+password ENCRYPTED in mailbox_secrets under the
// mailbox's env-var ref NAMES. Secrets are write-only — never returned. After
// saving, the operator clicks Test SMTP/IMAP then Activate, all from the UI.
const credsSchema = z.object({
  smtp_user: z.string().max(255).optional(),
  smtp_password: z.string().max(512).optional(),
  imap_user: z.string().max(255).optional(),
  imap_password: z.string().max(512).optional(),
  imap_same_as_smtp: z.boolean().optional(),
});
mailboxesRouter.put('/:id/credentials', requireWriteAccess, async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const id = Number(req.params.id);
  const p = credsSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'invalid', detail: p.error.flatten() });
  const [m] = await query('SELECT smtp_user_ref, smtp_secret_ref, imap_user_ref, imap_secret_ref FROM sender_identities WHERE id=? AND tenant_id=? LIMIT 1', [id, tenantId]);
  if (!m) return res.status(404).json({ error: 'not_found' });
  const d = p.data;
  const iu = d.imap_same_as_smtp ? d.smtp_user : d.imap_user;
  const ip = d.imap_same_as_smtp ? d.smtp_password : d.imap_password;
  const saved: string[] = [];
  if (d.smtp_user)     { await setSecret(tenantId, m.smtp_user_ref, d.smtp_user); saved.push('smtp_user'); }
  if (d.smtp_password) { await setSecret(tenantId, m.smtp_secret_ref, d.smtp_password); saved.push('smtp_password'); }
  if (iu)              { await setSecret(tenantId, m.imap_user_ref, iu); saved.push('imap_user'); }
  if (ip)              { await setSecret(tenantId, m.imap_secret_ref, ip); saved.push('imap_password'); }
  // audit records WHICH fields were set, never the values.
  await audit(req, 'mailbox.credentials_set', { type: 'sender_identity', id }, { fields: saved });
  res.json({ ok: true, saved, note: 'Credentials encrypted and stored. Now run Test SMTP / Test IMAP, then Activate.' });
});

const mailboxSchema = z.object({
  email: z.string().email(),
  display_name: z.string().max(160).optional(),
  provider_profile_id: z.number().int(),
  domain_id: z.number().int().nullable().optional(),
  purpose: z.enum(['cold_outreach', 'internal_test', 'transactional', 'support', 'main']).default('cold_outreach'),
  daily_send_limit: z.number().int().min(1).max(500).optional(),
  hourly_send_limit: z.number().int().min(1).max(200).optional(),
  outbound_enabled: z.boolean().optional(),
  inbound_enabled: z.boolean().optional(),
  smtp_user_ref: z.string().max(120).optional(),
  smtp_secret_ref: z.string().max(120).optional(),
  imap_user_ref: z.string().max(120).optional(),
  imap_secret_ref: z.string().max(120).optional(),
});

mailboxesRouter.post('/', requireWriteAccess, async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const p = mailboxSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'invalid', detail: p.error.flatten() });
  const d = p.data;
  const prov = await loadProvider(tenantId, d.provider_profile_id);
  if (!prov) return res.status(400).json({ error: 'provider_profile_not_found' });
  const [dup] = await query('SELECT id FROM sender_identities WHERE tenant_id=? AND from_email=? LIMIT 1', [tenantId, d.email.toLowerCase()]);
  if (dup) return res.status(409).json({ error: 'duplicate_mailbox', id: dup.id });
  const refs = suggestEnvRefs(d.email);
  const r = await query(
    `INSERT INTO sender_identities
      (tenant_id, provider_id, domain_id, from_email, from_name, display_name, purpose, status,
       outbound_enabled, inbound_enabled, imap_enabled, smtp_user_ref, smtp_secret_ref, imap_user_ref, imap_secret_ref,
       daily_send_limit, hourly_send_limit, warmup_stage, health_status, counters_day)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'unknown', CURDATE())`,
    [tenantId, d.provider_profile_id, d.domain_id ?? null, d.email.toLowerCase(),
     // from_name is NOT NULL — never pass null; fall back to display name then email local-part.
     d.display_name ?? d.email.split('@')[0], d.display_name ?? null, d.purpose,
     d.outbound_enabled === false ? 0 : 1, d.inbound_enabled ? 1 : 0, d.inbound_enabled ? 1 : 0,
     d.smtp_user_ref ?? refs.smtpUser, d.smtp_secret_ref ?? refs.smtpSecret,
     d.imap_user_ref ?? refs.imapUser, d.imap_secret_ref ?? refs.imapSecret,
     d.daily_send_limit ?? prov.default_daily_limit ?? NEW_MAILBOX_DAILY,
     d.hourly_send_limit ?? prov.default_hourly_limit ?? NEW_MAILBOX_HOURLY],
  );
  await audit(req, 'mailbox.create', { type: 'sender_identity', id: r.insertId }, { email: d.email, purpose: d.purpose });
  res.json({ ok: true, id: Number(r.insertId), env_refs: refs, env_snippet: envSnippet(d.email) });
});

mailboxesRouter.get('/:id', async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const id = Number(req.params.id);
  const [m] = await query('SELECT * FROM sender_identities WHERE id=? AND tenant_id=? LIMIT 1', [id, tenantId]);
  if (!m) return res.status(404).json({ error: 'not_found' });
  await rollMailboxCounters(m);
  const prov = m.provider_id ? await loadProvider(tenantId, m.provider_id) : null;
  const conn = prov ? resolveProvider(mailboxProviderRow(m, prov)) : null;
  res.json({
    mailbox: mailboxView(m, prov),
    env_snippet: envSnippet(m.from_email, m),
    credential_presence: conn ? {
      smtp_user_present: conn.smtpUserPresent, smtp_secret_present: conn.smtpSecretPresent,
      imap_user_present: conn.imapUserPresent, imap_secret_present: conn.imapSecretPresent,
      smtp_configured: conn.smtpConfigured, imap_configured: conn.imapConfigured,
    } : null,
    ramp: recommendNextLimit(m),
  });
});

mailboxesRouter.patch('/:id', requireWriteAccess, async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const id = Number(req.params.id);
  const [m] = await query('SELECT id FROM sender_identities WHERE id=? AND tenant_id=? LIMIT 1', [id, tenantId]);
  if (!m) return res.status(404).json({ error: 'not_found' });
  const d = mailboxSchema.partial().omit({ email: true }).safeParse(req.body);
  if (!d.success) return res.status(400).json({ error: 'invalid', detail: d.error.flatten() });
  const f = d.data;
  const sets: string[] = []; const vals: any[] = [];
  const direct: Record<string, any> = {
    display_name: f.display_name, purpose: f.purpose, domain_id: f.domain_id,
    smtp_user_ref: f.smtp_user_ref, smtp_secret_ref: f.smtp_secret_ref,
    imap_user_ref: f.imap_user_ref, imap_secret_ref: f.imap_secret_ref,
  };
  for (const [k, v] of Object.entries(direct)) if (v !== undefined) { sets.push(`${k}=?`); vals.push(v); }
  if (f.outbound_enabled !== undefined) { sets.push('outbound_enabled=?'); vals.push(f.outbound_enabled ? 1 : 0); }
  if (f.inbound_enabled !== undefined) { sets.push('inbound_enabled=?', 'imap_enabled=?'); vals.push(f.inbound_enabled ? 1 : 0, f.inbound_enabled ? 1 : 0); }
  // Limit changes go through /set-limit (audited). Ignore here.
  if (!sets.length) return res.json({ ok: true, unchanged: true });
  vals.push(id, tenantId);
  await query(`UPDATE sender_identities SET ${sets.join(', ')} WHERE id=? AND tenant_id=?`, vals);
  await audit(req, 'mailbox.update', { type: 'sender_identity', id }, { fields: sets.map((s) => s.split('=')[0]) });
  res.json({ ok: true });
});

// ── PART 5 — env ref helper ──────────────────────────────────────────────────
mailboxesRouter.get('/:id/env-snippet', async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const id = Number(req.params.id);
  const [m] = await query('SELECT from_email, smtp_user_ref, smtp_secret_ref, imap_user_ref, imap_secret_ref FROM sender_identities WHERE id=? AND tenant_id=? LIMIT 1', [id, tenantId]);
  if (!m) return res.status(404).json({ error: 'not_found' });
  const refs = {
    smtpUser: m.smtp_user_ref, smtpSecret: m.smtp_secret_ref,
    imapUser: m.imap_user_ref, imapSecret: m.imap_secret_ref,
  };
  res.json({
    email: m.from_email,
    env_refs: { smtp_user_ref: m.smtp_user_ref, smtp_secret_ref: m.smtp_secret_ref, imap_user_ref: m.imap_user_ref, imap_secret_ref: m.imap_secret_ref },
    suggested: suggestEnvRefs(m.from_email),
    snippet: envSnippet(m.from_email, m),
    note: 'Add these to .env with real values, then restart api+worker. This never returns existing values.',
  });
});

// ── PART 7 — testing ─────────────────────────────────────────────────────────
async function runMailboxTest(tenantId: number, id: number, kind: 'smtp' | 'imap') {
  const [m] = await query('SELECT * FROM sender_identities WHERE id=? AND tenant_id=? LIMIT 1', [id, tenantId]);
  if (!m) return { ok: false, status: 404 as const, body: { error: 'not_found' } };
  const prov = m.provider_id ? await loadProvider(tenantId, m.provider_id) : null;
  if (!prov) return { ok: false, status: 400 as const, body: { error: 'no_provider_profile' } };
  const conn = resolveProvider(mailboxProviderRow(m, prov));
  const result = kind === 'smtp' ? await rtTestSmtp(conn) : await rtTestImap(conn);
  const col = kind === 'smtp' ? 'last_smtp_test_at' : 'last_imap_test_at';
  const lastErr = result.ok ? null : result.detail.slice(0, 500);
  // Only stamp the success timestamp on a PASSING test — the activation gate
  // relies on this marker, so a failed/not_configured test must NOT set it.
  if (result.ok) {
    await query(`UPDATE sender_identities SET ${col}=NOW(), last_error=NULL WHERE id=?`, [id]);
  } else {
    await query(`UPDATE sender_identities SET last_error=? WHERE id=?`, [lastErr, id]);
  }
  return { ok: true as const, status: 200 as const, body: { mailbox_id: id, kind, ...result } };
}

mailboxesRouter.post('/:id/test-smtp', requireWriteAccess, async (req, res) => {
  const r = await runMailboxTest(req.auth!.tenantId!, Number(req.params.id), 'smtp');
  if (r.ok) await audit(req, 'mailbox.test_smtp', { type: 'sender_identity', id: req.params.id }, { ok: (r.body as any).ok, detail: (r.body as any).detail });
  res.status(r.status).json(r.body);
});

mailboxesRouter.post('/:id/test-imap', requireWriteAccess, async (req, res) => {
  const r = await runMailboxTest(req.auth!.tenantId!, Number(req.params.id), 'imap');
  if (r.ok) await audit(req, 'mailbox.test_imap', { type: 'sender_identity', id: req.params.id }, { ok: (r.body as any).ok, detail: (r.body as any).detail });
  res.status(r.status).json(r.body);
});

// Batch test — max 10 per run, sequential (don't hammer provider).
mailboxesRouter.post('/test-batch', requireWriteAccess, async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const schema = z.object({ ids: z.array(z.number().int()).min(1).max(10), kind: z.enum(['smtp', 'imap']) });
  const p = schema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'invalid_or_too_many', max: 10 });
  const results: any[] = [];
  for (const id of p.data.ids) {
    const r = await runMailboxTest(tenantId, id, p.data.kind);
    results.push(r.ok ? r.body : { mailbox_id: id, ...r.body });
  }
  await audit(req, `mailbox.test_${p.data.kind}`, { type: 'sender_identity' }, { batch: p.data.ids.length });
  res.json({ results });
});

// ── activate / pause / disable ───────────────────────────────────────────────
mailboxesRouter.post('/:id/activate', requireWriteAccess, async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const id = Number(req.params.id);
  const [m] = await query('SELECT * FROM sender_identities WHERE id=? AND tenant_id=? LIMIT 1', [id, tenantId]);
  if (!m) return res.status(404).json({ error: 'not_found' });
  const blockers: string[] = [];
  // Activation gate: outbound requires successful SMTP test; inbound requires IMAP test.
  if (m.outbound_enabled && !m.last_smtp_test_at) blockers.push('smtp_test_required');
  if (m.outbound_enabled && m.last_error && !m.last_smtp_test_at) blockers.push('smtp_test_failed');
  if (m.inbound_enabled && !m.last_imap_test_at) blockers.push('imap_test_required');
  if ((m.purpose === 'main' || m.purpose === 'transactional')) blockers.push('main_or_transactional_no_cold_override');
  if (blockers.length && !req.body?.force) {
    return res.status(412).json({ error: 'activation_blocked', blockers });
  }
  await query("UPDATE sender_identities SET status='active', paused_reason=NULL WHERE id=? AND tenant_id=?", [id, tenantId]);
  await audit(req, 'mailbox.activate', { type: 'sender_identity', id }, { forced: !!req.body?.force, blockers });
  res.json({ ok: true });
});

mailboxesRouter.post('/:id/pause', requireWriteAccess, async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const id = Number(req.params.id);
  const reason = String(req.body?.reason ?? 'operator_paused').slice(0, 255);
  const u = await query("UPDATE sender_identities SET status='paused', paused_reason=? WHERE id=? AND tenant_id=?", [reason, id, tenantId]);
  if (!u.affectedRows) return res.status(404).json({ error: 'not_found' });
  await audit(req, 'mailbox.pause', { type: 'sender_identity', id }, { reason });
  res.json({ ok: true });
});

mailboxesRouter.post('/:id/disable', requireWriteAccess, async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const id = Number(req.params.id);
  const u = await query("UPDATE sender_identities SET status='disabled' WHERE id=? AND tenant_id=?", [id, tenantId]);
  if (!u.affectedRows) return res.status(404).json({ error: 'not_found' });
  await audit(req, 'mailbox.disable', { type: 'sender_identity', id }, {});
  res.json({ ok: true });
});

// Delete a mailbox. Blocked if a campaign references it (hard FK). Cleans up its
// vault secrets and nulls soft references in manual-outreach/touchpoint tables.
mailboxesRouter.delete('/:id', requireWriteAccess, async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const id = Number(req.params.id);
  const [m] = await query('SELECT * FROM sender_identities WHERE id=? AND tenant_id=? LIMIT 1', [id, tenantId]);
  if (!m) return res.status(404).json({ error: 'not_found' });
  const [camp] = await query('SELECT COUNT(*) AS n FROM campaigns WHERE sender_identity_id=?', [id]);
  if (Number(camp?.n ?? 0) > 0) {
    return res.status(409).json({ error: 'referenced_by_campaign', detail: 'A campaign uses this mailbox. Reassign or remove that campaign first.', count: Number(camp.n) });
  }
  // Best-effort: null soft references (no FK) so nothing points at a dead id.
  for (const tbl of ['manual_outreach_queue', 'inbox_replies', 'outreach_touchpoints']) {
    try { await query(`UPDATE ${tbl} SET mailbox_id=NULL WHERE mailbox_id=?`, [id]); } catch { /* table/col may not exist */ }
  }
  // Remove this mailbox's stored secrets from the vault.
  const refs = [m.smtp_user_ref, m.smtp_secret_ref, m.imap_user_ref, m.imap_secret_ref].filter(Boolean);
  if (refs.length) {
    try { await query(`DELETE FROM mailbox_secrets WHERE tenant_id=? AND ref_name IN (${refs.map(() => '?').join(',')})`, [tenantId, ...refs]); } catch { /* vault optional */ }
  }
  await query('DELETE FROM sender_identities WHERE id=? AND tenant_id=?', [id, tenantId]);
  await audit(req, 'mailbox.delete', { type: 'sender_identity', id }, { email: m.from_email });
  res.json({ ok: true, deleted: id });
});

// ── PART 13 — limit / ramp ───────────────────────────────────────────────────
mailboxesRouter.get('/:id/ramp', async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const [m] = await query('SELECT * FROM sender_identities WHERE id=? AND tenant_id=? LIMIT 1', [Number(req.params.id), tenantId]);
  if (!m) return res.status(404).json({ error: 'not_found' });
  await rollMailboxCounters(m);
  res.json({ current_daily: m.daily_send_limit, current_hourly: m.hourly_send_limit, health: computeHealth(m), ...recommendNextLimit(m) });
});

mailboxesRouter.post('/:id/set-limit', requireWriteAccess, async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const id = Number(req.params.id);
  const schema = z.object({ daily: z.number().int().min(1).max(500).optional(), hourly: z.number().int().min(1).max(200).optional() });
  const p = schema.safeParse(req.body);
  if (!p.success || (p.data.daily === undefined && p.data.hourly === undefined)) return res.status(400).json({ error: 'invalid' });
  const [m] = await query('SELECT daily_send_limit, hourly_send_limit FROM sender_identities WHERE id=? AND tenant_id=? LIMIT 1', [id, tenantId]);
  if (!m) return res.status(404).json({ error: 'not_found' });
  const sets: string[] = []; const vals: any[] = [];
  if (p.data.daily !== undefined) { sets.push('daily_send_limit=?'); vals.push(p.data.daily); }
  if (p.data.hourly !== undefined) { sets.push('hourly_send_limit=?'); vals.push(p.data.hourly); }
  vals.push(id, tenantId);
  await query(`UPDATE sender_identities SET ${sets.join(', ')} WHERE id=? AND tenant_id=?`, vals);
  await audit(req, 'mailbox.limit_change', { type: 'sender_identity', id },
    { from: { daily: m.daily_send_limit, hourly: m.hourly_send_limit }, to: { daily: p.data.daily, hourly: p.data.hourly } });
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// PART 6 — CSV import / export + bulk env snippet
// ══════════════════════════════════════════════════════════════════════════════
mailboxesRouter.get('/export/csv', async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const mailboxes = await query('SELECT * FROM sender_identities WHERE tenant_id=? ORDER BY id ASC', [tenantId]);
  const providers = await query('SELECT id, name FROM sending_providers WHERE tenant_id=?', [tenantId]);
  const provById = new Map<number, any>(providers.map((p: any) => [p.id, p]));
  const rows = mailboxes.map((m: any) => ({
    email: m.from_email, display_name: m.display_name,
    provider_profile_name: m.provider_id ? provById.get(m.provider_id)?.name ?? '' : '',
    provider_profile_id: m.provider_id ?? '',
    purpose: m.purpose, daily_send_limit: m.daily_send_limit, hourly_send_limit: m.hourly_send_limit,
    outbound_enabled: m.outbound_enabled ? 'true' : 'false', inbound_enabled: m.inbound_enabled ? 'true' : 'false',
    smtp_user_ref: m.smtp_user_ref, smtp_secret_ref: m.smtp_secret_ref,
    imap_user_ref: m.imap_user_ref, imap_secret_ref: m.imap_secret_ref,
  }));
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', 'attachment; filename="mailboxes.csv"');
  res.send(formatMailboxCsv(rows));
});

mailboxesRouter.post('/import/csv', requireWriteAccess, async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const text = String(req.body?.csv ?? '');
  if (!text.trim()) return res.status(400).json({ error: 'empty_csv', columns: MAILBOX_CSV_COLUMNS });
  const rows = parseMailboxCsv(text);
  if (rows.length > 500) return res.status(400).json({ error: 'too_many_rows', max: 500 });
  const providers = await query('SELECT id, name FROM sending_providers WHERE tenant_id=?', [tenantId]);
  const provByName = new Map<string, number>(providers.map((p: any) => [String(p.name).toLowerCase(), p.id]));
  const provIds = new Set<number>(providers.map((p: any) => p.id));
  const existing = new Set<string>(
    (await query('SELECT from_email FROM sender_identities WHERE tenant_id=?', [tenantId])).map((r: any) => String(r.from_email).toLowerCase()),
  );
  const results: any[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const email = (row.email || '').trim().toLowerCase();
    const line = i + 2;
    if (!isValidEmail(email)) { results.push({ line, email, ok: false, error: 'invalid_email' }); continue; }
    if (existing.has(email) || seen.has(email)) { results.push({ line, email, ok: false, error: 'duplicate' }); continue; }
    let provId = Number(row.provider_profile_id) || 0;
    if (!provId && row.provider_profile_name) provId = provByName.get(row.provider_profile_name.trim().toLowerCase()) ?? 0;
    if (!provId || !provIds.has(provId)) { results.push({ line, email, ok: false, error: 'provider_profile_not_found' }); continue; }
    const refs = suggestEnvRefs(email);
    const purpose = ['cold_outreach', 'internal_test', 'transactional', 'support', 'main'].includes(row.purpose) ? row.purpose : 'cold_outreach';
    const daily = Math.min(Math.max(Number(row.daily_send_limit) || NEW_MAILBOX_DAILY, 1), 500);
    const hourly = Math.min(Math.max(Number(row.hourly_send_limit) || NEW_MAILBOX_HOURLY, 1), 200);
    const inbound = /^(1|true|yes)$/i.test(row.inbound_enabled || '');
    const outbound = row.outbound_enabled === '' ? true : /^(1|true|yes)$/i.test(row.outbound_enabled || '');
    try {
      const r = await query(
        `INSERT INTO sender_identities
          (tenant_id, provider_id, from_email, display_name, from_name, purpose, status,
           outbound_enabled, inbound_enabled, imap_enabled, smtp_user_ref, smtp_secret_ref, imap_user_ref, imap_secret_ref,
           daily_send_limit, hourly_send_limit, warmup_stage, health_status, counters_day)
         VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'unknown', CURDATE())`,
        [tenantId, provId, email, row.display_name || null, row.display_name || email.split('@')[0], purpose,
         outbound ? 1 : 0, inbound ? 1 : 0, inbound ? 1 : 0,
         row.smtp_user_ref || refs.smtpUser, row.smtp_secret_ref || refs.smtpSecret,
         row.imap_user_ref || refs.imapUser, row.imap_secret_ref || refs.imapSecret, daily, hourly],
      );
      seen.add(email);
      results.push({ line, email, ok: true, id: Number(r.insertId), status: 'draft' });
    } catch (e: any) {
      results.push({ line, email, ok: false, error: e?.code ?? 'insert_failed' });
    }
  }
  const created = results.filter((r) => r.ok).length;
  await audit(req, 'mailbox.create', { type: 'sender_identity' }, { import: true, created, total: rows.length });
  res.json({ created, total: rows.length, results });
});

mailboxesRouter.post('/bulk-env-snippet', async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
  const where = ids.length ? 'AND id IN (' + ids.map(() => '?').join(',') + ')' : "AND status='draft'";
  const rows = await query(
    `SELECT from_email, smtp_user_ref, smtp_secret_ref, imap_user_ref, imap_secret_ref
     FROM sender_identities WHERE tenant_id=? ${where} ORDER BY id ASC`,
    ids.length ? [tenantId, ...ids] : [tenantId],
  );
  const snippet = rows.map((m: any) => envSnippet(m.from_email, m)).join('\n\n');
  res.json({ count: rows.length, snippet, note: 'Empty values only. Fill in .env, then restart api+worker, then test.' });
});

// ══════════════════════════════════════════════════════════════════════════════
// PART 8 — ASSIGNMENT ENGINE (dry-run capable)
// ══════════════════════════════════════════════════════════════════════════════
mailboxesRouter.post('/assign-queue', requireWriteAccess, async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const schema = z.object({
    strategy: z.enum(['healthiest_first', 'least_used_today', 'round_robin', 'fixed_mailbox']).default('healthiest_first'),
    fixedMailboxId: z.number().int().nullable().optional(),
    queueItemIds: z.array(z.number().int()).max(500).optional(),
    dryRun: z.boolean().default(true),
  });
  const p = schema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'invalid', detail: p.error.flatten() });
  const { strategy, fixedMailboxId, queueItemIds, dryRun } = p.data;

  // Load queue items needing assignment (or specific ids).
  const where = queueItemIds?.length
    ? 'AND id IN (' + queueItemIds.map(() => '?').join(',') + ')'
    : "AND status IN ('pending_review','approved')";
  const items = await query(
    `SELECT id, email, company_id FROM manual_outreach_queue WHERE tenant_id=? ${where}`,
    queueItemIds?.length ? [tenantId, ...queueItemIds] : [tenantId],
  );
  if (!items.length) return res.json({ assigned: 0, results: [], note: 'no queue items to assign' });

  const mailboxes = await query('SELECT * FROM sender_identities WHERE tenant_id=?', [tenantId]);
  const providers = await query('SELECT * FROM sending_providers WHERE tenant_id=?', [tenantId]);
  const providerById = new Map<number, any>(providers.map((p: any) => [p.id, p]));
  for (const m of mailboxes) await rollMailboxCounters(m);
  const { byEmail, byCompany } = await priorMailboxMaps(tenantId);

  const assignItems: AssignItem[] = items.map((it: any) => ({
    key: it.id, email: it.email, companyId: it.company_id ?? null,
    recipientDomain: (it.email || '').split('@')[1] ?? null,
  }));
  const results = assignMailboxes(assignItems, mailboxes, {
    strategy: strategy as AssignStrategy, fixedMailboxId, providerById,
    priorByCompany: byCompany, priorByEmail: byEmail,
  });

  let assigned = 0;
  if (!dryRun) {
    for (const r of results) {
      if (r.mailboxId) {
        await query('UPDATE manual_outreach_queue SET mailbox_id=? WHERE id=? AND tenant_id=?', [r.mailboxId, r.key, tenantId]);
        await audit(req, 'queue.assign', { type: 'manual_outreach_queue', id: r.key }, { mailbox_id: r.mailboxId, strategy });
        assigned++;
      }
    }
  } else {
    assigned = results.filter((r) => r.mailboxId).length;
  }
  res.json({ dryRun, strategy, total: results.length, assigned, blocked: results.length - assigned, results });
});

// Reassign one queue item to a specific mailbox (manual override).
mailboxesRouter.post('/queue/:id/reassign', requireWriteAccess, async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const id = Number(req.params.id);
  const mailboxId = Number(req.body?.mailbox_id);
  if (!mailboxId) return res.status(400).json({ error: 'mailbox_id_required' });
  const [m] = await query('SELECT * FROM sender_identities WHERE id=? AND tenant_id=? LIMIT 1', [mailboxId, tenantId]);
  if (!m) return res.status(404).json({ error: 'mailbox_not_found' });
  const prov = m.provider_id ? await loadProvider(tenantId, m.provider_id) : null;
  const blockers = mailboxBlockers(m, prov);
  if (blockers.length && !req.body?.force) return res.status(412).json({ error: 'mailbox_not_eligible', blockers });
  const u = await query('UPDATE manual_outreach_queue SET mailbox_id=? WHERE id=? AND tenant_id=?', [mailboxId, id, tenantId]);
  if (!u.affectedRows) return res.status(404).json({ error: 'queue_item_not_found' });
  await audit(req, 'queue.reassign', { type: 'manual_outreach_queue', id }, { mailbox_id: mailboxId, forced: !!req.body?.force });
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// PART 9 — TOUCH LEDGER (read)
// ══════════════════════════════════════════════════════════════════════════════
mailboxesRouter.get('/touchpoints/list', async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const cond: string[] = ['tenant_id=?']; const vals: any[] = [tenantId];
  if (req.query.email) { cond.push('email=?'); vals.push(String(req.query.email).toLowerCase()); }
  if (req.query.company_id) { cond.push('company_id=?'); vals.push(Number(req.query.company_id)); }
  if (req.query.mailbox_id) { cond.push('mailbox_id=?'); vals.push(Number(req.query.mailbox_id)); }
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const rows = await query(
    `SELECT * FROM outreach_touchpoints WHERE ${cond.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
    [...vals, limit],
  );
  res.json({ touchpoints: rows });
});
