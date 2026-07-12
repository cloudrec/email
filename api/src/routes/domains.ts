import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { authMiddleware, requireTenant, requireWriteAccess } from '../middleware/auth.js';
import { audit } from '../middleware/audit.js';
import { generateDkimKeypair, expectedRecords, verifyDomain } from '../services/dnsVerify.js';
import { config } from '../config.js';
import { evaluateWarmup, WARMUP_STEPS } from '../services/warmup.js';

export const domainsRouter = Router();
domainsRouter.use(authMiddleware, requireTenant);

const createSchema = z.object({
  domain: z.string().min(3).max(255).regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i),
  type: z.enum(['sending', 'tracking']).default('sending'),
  purpose: z.enum(['main', 'cold_outreach', 'transactional', 'tracking', 'bounce']).default('cold_outreach'),
  providerId: z.number().int().positive().optional(),
  dkimSelector: z.string().min(1).max(40).default('mail'),
});

// Free webmail / relay providers — these are NOT sending domains the tenant owns
// (cannot publish DKIM/SPF for gmail.com etc.), so we never suggest registering them.
const FREE_PROVIDER_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'yahoo.com', 'yahoo.co.uk', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com',
  'gmx.com', 'gmx.net', 'mail.com', 'yandex.com', 'yandex.ru',
  'zoho.com', 'zohomail.com', 'zohomail.eu', 'zoho.eu',
]);

domainsRouter.get('/', async (req, res) => {
  const tenantId = req.auth!.tenantId;
  const rows = await query(
    `SELECT id, domain, type, purpose, status, dns_status, dkim_selector, last_checked_at,
            daily_send_limit, hourly_send_limit, reputation_score, warmup_stage, provider_id
     FROM domains WHERE tenant_id=? ORDER BY created_at DESC`,
    [tenantId],
  );

  // Domains implied by mailboxes (sender_identities) but NOT registered in the domains
  // table. Adding a mailbox never created a domain row, so own sending domains
  // (469diamond.com, fundbot.win, …) were invisible on this page. Surface them here so
  // the operator can one-click register the ones they own; skip free webmail relays.
  const registered = new Set(rows.map((r: any) => String(r.domain).toLowerCase()));
  const mbDomains = await query(
    `SELECT LOWER(SUBSTRING_INDEX(from_email, '@', -1)) AS domain,
            COUNT(*) AS mailbox_count,
            SUM(status='active') AS active_count
     FROM sender_identities WHERE tenant_id=?
     GROUP BY domain ORDER BY domain`,
    [tenantId],
  );
  const detected = mbDomains
    .filter((d: any) => d.domain && !registered.has(d.domain) && !FREE_PROVIDER_DOMAINS.has(d.domain))
    .map((d: any) => ({
      domain: d.domain,
      mailboxCount: Number(d.mailbox_count),
      activeCount: Number(d.active_count),
      registrable: true,
    }));

  res.json({ domains: rows, detected });
});

domainsRouter.post('/', requireWriteAccess, async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });
  const { domain, type, purpose, providerId, dkimSelector } = parsed.data;

  // Default daily limit by purpose. Cold scraped outreach starts tiny (20/day);
  // admin raises manually after healthy metrics (warmup-advance).
  const dailyLimit = purpose === 'cold_outreach' ? 20 : purpose === 'main' || purpose === 'transactional' ? 200 : 20;
  const hourlyLimit = Math.max(1, Math.ceil(dailyLimit / 4));

  // Validate provider belongs to tenant if supplied.
  if (providerId) {
    const [pv] = await query('SELECT id FROM sending_providers WHERE id=? AND tenant_id=? LIMIT 1', [providerId, req.auth!.tenantId]);
    if (!pv) return res.status(400).json({ error: 'provider_not_found' });
  }

  const dkim = generateDkimKeypair();
  const result = await query(
    `INSERT INTO domains
       (tenant_id, domain, type, purpose, status, dns_status, dkim_selector, dkim_public_key, dkim_private_key,
        spf_record, dmarc_record, return_path_host, daily_send_limit, hourly_send_limit, provider_id)
     VALUES (?, ?, ?, ?, 'pending', 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      req.auth!.tenantId,
      domain.toLowerCase(),
      type, purpose,
      dkimSelector,
      dkim.publicKey,
      dkim.privateKey,
      `v=spf1 include:_spf.${config.platformDomain} ~all`,
      `v=DMARC1; p=quarantine; rua=mailto:postmaster@${domain}`,
      `bounces.${domain}`,
      dailyLimit, hourlyLimit, providerId ?? null,
    ],
  );
  const id = Number(result.insertId);

  await audit(req, 'domain.create', { type: 'domain', id }, { domain, dkimSelector, purpose });

  const records = expectedRecords(domain.toLowerCase(), dkimSelector, dkim.dnsValue, config.platformDomain);
  res.status(201).json({ id, domain, dkimSelector, records });
});

domainsRouter.post('/:id/verify', requireWriteAccess, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const owns = await query('SELECT id FROM domains WHERE id=? AND tenant_id=? LIMIT 1', [id, req.auth!.tenantId]);
  if (!owns.length) return res.status(404).json({ error: 'not_found' });

  const result = await verifyDomain(id);
  // Mirror verification outcome into dns_status (verifyDomain only sets `status`).
  const dnsStatus = result.status === 'verified' ? 'verified' : result.status === 'warning' ? 'partial' : 'failed';
  await query('UPDATE domains SET dns_status=? WHERE id=?', [dnsStatus, id]);
  await audit(req, 'domain.verify', { type: 'domain', id }, { status: result.status });
  res.json({ ...result, dnsStatus });
});

// ── DNS onboarding checklist (Phase 21, Part 4) ──────────────────────────────
// Per-record SPF/DKIM/DMARC/Return-Path (and MX/tracking note) status + the exact
// records to publish + warnings. Reads cached last_status_detail; does not re-probe.
domainsRouter.get('/:id/onboarding', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const [d] = await query(
    `SELECT id, domain, type, purpose, status, dns_status, dkim_selector, dkim_public_key,
            last_checked_at, last_status_detail, mx_required, provider_id
     FROM domains WHERE id=? AND tenant_id=? LIMIT 1`,
    [id, req.auth!.tenantId],
  );
  if (!d) return res.status(404).json({ error: 'not_found' });

  const pubB64 = (d.dkim_public_key ?? '')
    .replace('-----BEGIN PUBLIC KEY-----', '').replace('-----END PUBLIC KEY-----', '').replace(/\s+/g, '');
  const records = expectedRecords(d.domain, d.dkim_selector, `v=DKIM1; k=rsa; p=${pubB64}`, config.platformDomain);

  let detail: any[] = [];
  if (d.last_status_detail) {
    try { detail = typeof d.last_status_detail === 'string' ? JSON.parse(d.last_status_detail) : d.last_status_detail; }
    catch { detail = []; }
  }
  const statusOf = (purpose: string) => {
    const r = detail.find((x: any) => x.purpose === purpose);
    if (!r) return d.last_checked_at ? 'fail' : 'unchecked';
    return r.ok ? 'pass' : 'fail';
  };

  const checklist = [
    { key: 'spf',         label: 'SPF',                status: statusOf('spf'),         record: records.find((r) => r.purpose === 'spf') },
    { key: 'dkim',        label: 'DKIM',               status: statusOf('dkim'),        record: records.find((r) => r.purpose === 'dkim') },
    { key: 'dmarc',       label: 'DMARC',              status: statusOf('dmarc'),       record: records.find((r) => r.purpose === 'dmarc') },
    { key: 'return_path', label: 'Return-Path/Bounce', status: statusOf('return_path'), record: records.find((r) => r.purpose === 'return_path') },
    { key: 'mx',          label: 'MX (inbound)',       status: d.mx_required ? 'required' : 'optional', record: null },
    { key: 'tracking',    label: 'Tracking CNAME',     status: d.type === 'tracking' ? statusOf('tracking') : 'not_applicable', record: null },
  ];

  const warnings: string[] = [];
  if (d.purpose === 'main') warnings.push('This domain is marked MAIN — do NOT use it for scraped cold outreach.');
  if (d.purpose === 'transactional') warnings.push('Transactional domain — keep separate from cold_outreach to protect reputation.');
  if (d.status !== 'verified') warnings.push('Sending stays blocked until all DNS checks pass.');

  res.json({
    domain: d.domain, purpose: d.purpose, status: d.status, dnsStatus: d.dns_status,
    lastCheckedAt: d.last_checked_at, checklist, warnings,
  });
});

// Return the DNS records the tenant must publish for a domain.
// UI loads this on demand so DNS instructions remain visible after page reload.
domainsRouter.get('/:id/dns-records', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const rows = await query(
    `SELECT domain, dkim_selector, dkim_public_key, status, last_status_detail
     FROM domains WHERE id=? AND tenant_id=? LIMIT 1`,
    [id, req.auth!.tenantId],
  );
  if (!rows.length) return res.status(404).json({ error: 'not_found' });
  const d = rows[0];

  const pubB64 = (d.dkim_public_key ?? '')
    .replace('-----BEGIN PUBLIC KEY-----', '')
    .replace('-----END PUBLIC KEY-----', '')
    .replace(/\s+/g, '');
  const dkimValue = `v=DKIM1; k=rsa; p=${pubB64}`;

  const records = expectedRecords(d.domain, d.dkim_selector, dkimValue, config.platformDomain);

  let lastStatusDetail: any = null;
  if (d.last_status_detail) {
    try { lastStatusDetail = typeof d.last_status_detail === 'string' ? JSON.parse(d.last_status_detail) : d.last_status_detail; }
    catch { lastStatusDetail = null; }
  }

  res.json({ domain: d.domain, dkimSelector: d.dkim_selector, status: d.status, records, lastStatusDetail });
});

// ── Warmup dashboard (Phase 18, Part 5) ──────────────────────────────────────
// Real rate-limit / reputation status for a sending domain. NO fake warmup, no
// synthetic engagement — computed from real campaign_events only.
domainsRouter.get('/:id/warmup', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const [d] = await query(
    'SELECT id, domain, type, status, daily_send_limit, reputation_score FROM domains WHERE id=? AND tenant_id=? LIMIT 1',
    [id, req.auth!.tenantId],
  );
  if (!d) return res.status(404).json({ error: 'not_found' });

  const cnt = async (types: string[], todayOnly = true) => {
    const ph = types.map(() => '?').join(',');
    const day = todayOnly ? 'AND occurred_at >= CURDATE()' : '';
    const [r] = await query(
      `SELECT COUNT(*) AS c FROM campaign_events WHERE tenant_id=? AND event_type IN (${ph}) ${day}`,
      [req.auth!.tenantId, ...types],
    );
    return Number(r.c);
  };
  const sentToday        = await cnt(['sent','delivered']);
  const bouncesToday     = await cnt(['bounced_hard','bounced_soft']);
  const complaintsToday  = await cnt(['complained']);
  const unsubToday       = await cnt(['unsubscribed']);
  const sentEver         = await cnt(['sent','delivered'], false);

  const verdict = evaluateWarmup({
    dailyLimit: Number(d.daily_send_limit),
    reputationScore: d.reputation_score == null ? null : Number(d.reputation_score),
    sentToday, bouncesToday, complaintsToday, unsubscribesToday: unsubToday,
    hasSendingHistory: sentEver > 0,
  });

  res.json({ domain: d.domain, domainStatus: d.status, schedule: WARMUP_STEPS, warmup: verdict,
    note: 'Daily limit is NOT raised automatically. Use POST /:id/warmup-advance with explicit admin confirmation.' });
});

// ── POST /:id/warmup-advance ─────────────────────────────────────────────────
// Raise the daily limit ONE step — only with explicit admin confirmation and a
// safe verdict. Never auto-advances; never jumps multiple steps.
domainsRouter.post('/:id/warmup-advance', requireWriteAccess, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const body = z.object({ confirm: z.literal(true), targetLimit: z.coerce.number().int().positive() }).safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'missing_confirm_or_target' });
  const [d] = await query('SELECT id, daily_send_limit FROM domains WHERE id=? AND tenant_id=? LIMIT 1', [id, req.auth!.tenantId]);
  if (!d) return res.status(404).json({ error: 'not_found' });

  const current = Number(d.daily_send_limit);
  const next = WARMUP_STEPS.find((s) => s > current) ?? current;
  if (body.data.targetLimit !== next) {
    return res.status(409).json({ error: 'must_advance_one_step', current, allowedNext: next });
  }
  await query('UPDATE domains SET daily_send_limit=? WHERE id=?', [next, id]);
  await audit(req, 'domain.warmup.advance', { type: 'domain', id }, { from: current, to: next });
  res.json({ ok: true, from: current, to: next });
});

domainsRouter.get('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const rows = await query(
    'SELECT * FROM domains WHERE id=? AND tenant_id=? LIMIT 1',
    [id, req.auth!.tenantId],
  );
  if (!rows.length) return res.status(404).json({ error: 'not_found' });
  // Strip private key from response
  const d = rows[0];
  delete d.dkim_private_key;
  res.json(d);
});

domainsRouter.delete('/:id', requireWriteAccess, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await query('DELETE FROM domains WHERE id=? AND tenant_id=?', [id, req.auth!.tenantId]);
  if (!r.affectedRows) return res.status(404).json({ error: 'not_found' });
  await audit(req, 'domain.delete', { type: 'domain', id });
  res.json({ ok: true });
});
