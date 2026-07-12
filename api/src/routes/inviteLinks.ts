import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { authMiddleware, requireTenant, requireWriteAccess } from '../middleware/auth.js';
import { audit } from '../middleware/audit.js';
import { generateInviteToken } from '../services/inviteToken.js';
import { config } from '../config.js';

export const inviteLinksRouter = Router();
inviteLinksRouter.use(authMiddleware, requireTenant);

async function getSafetySettings(tenantId: number): Promise<any> {
  const rows = await query('SELECT * FROM tenant_safety_settings WHERE tenant_id=? LIMIT 1', [tenantId]);
  if (rows.length) return rows[0];
  await query('INSERT IGNORE INTO tenant_safety_settings (tenant_id) VALUES (?)', [tenantId]);
  return (await query('SELECT * FROM tenant_safety_settings WHERE tenant_id=? LIMIT 1', [tenantId]))[0];
}

function publicLinkUrl(token: string, customDomain?: string | null): string {
  if (customDomain) return `https://${customDomain}/i/${token}`;
  // Default: brand subdomain (go.<platform>) first; fall back to platform itself.
  // We don't probe DNS — we just return both options.
  return `https://go.${config.platformDomain}/i/${token}`;
}

function fallbackLinkUrl(token: string): string {
  return `https://${config.platformDomain}/i/${token}`;
}

const createSchema = z.object({
  leadId: z.number().int().positive().nullable().optional(),
  contactId: z.number().int().positive().nullable().optional(),
  outreachDraftId: z.number().int().positive().nullable().optional(),
  campaignId: z.number().int().positive().nullable().optional(),
  trackingDomainId: z.number().int().positive().nullable().optional(),
  destinationUrl: z.string().url().max(2000),
  landingMode: z.enum(['redirect', 'personal_page']).default('redirect'),
  expiresAt: z.string().datetime().nullable().optional(),
});

inviteLinksRouter.get('/', async (req, res) => {
  const rows = await query(
    `SELECT il.*, td.domain AS tracking_domain
     FROM invite_links il
     LEFT JOIN tracking_domains td ON td.id = il.tracking_domain_id
     WHERE il.tenant_id=? ORDER BY il.created_at DESC LIMIT 500`,
    [req.auth!.tenantId],
  );
  const out = rows.map((r: any) => ({
    ...r,
    public_url: publicLinkUrl(r.token, r.tracking_domain),
    fallback_url: fallbackLinkUrl(r.token),
  }));
  res.json({ links: out });
});

inviteLinksRouter.post('/', requireWriteAccess, async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', detail: parsed.error.flatten() });
  const p = parsed.data;

  const s = await getSafetySettings(req.auth!.tenantId!);
  if (!s.invite_links_enabled) return res.status(402).json({ error: 'invite_links_disabled' });

  // Daily limit
  const today = await query(
    `SELECT COUNT(*) AS c FROM invite_links WHERE tenant_id=? AND created_at >= CURDATE()`,
    [req.auth!.tenantId],
  );
  if (Number(today[0].c) >= s.max_invite_links_per_day) {
    await query(
      `INSERT INTO tenant_risk_events (tenant_id, event_type, severity, reason)
       VALUES (?, 'invite_link.daily_limit_hit', 'warning', ?)`,
      [req.auth!.tenantId, `Limit ${s.max_invite_links_per_day}/day reached`],
    );
    return res.status(429).json({ error: 'daily_limit_reached', limit: s.max_invite_links_per_day });
  }

  // Cross-check: if leadId given, must belong to tenant. Same for contact/draft/campaign/td.
  const own = async (table: string, id: number | null | undefined) => {
    if (!id) return true;
    const r = await query(`SELECT id FROM ${table} WHERE id=? AND tenant_id=? LIMIT 1`, [id, req.auth!.tenantId]);
    return !!r.length;
  };
  if (!(await own('discovered_leads', p.leadId))) return res.status(404).json({ error: 'lead_not_found' });
  if (!(await own('contacts', p.contactId))) return res.status(404).json({ error: 'contact_not_found' });
  if (!(await own('outreach_drafts', p.outreachDraftId))) return res.status(404).json({ error: 'draft_not_found' });
  if (!(await own('campaigns', p.campaignId))) return res.status(404).json({ error: 'campaign_not_found' });
  if (!(await own('tracking_domains', p.trackingDomainId))) return res.status(404).json({ error: 'tracking_domain_not_found' });

  // Suppression check at create-time: if lead/contact already suppressed/unsubscribed,
  // create link in 'suppressed'/'unsubscribed' state — visible but never redirects.
  let initialStatus: 'active' | 'suppressed' | 'unsubscribed' = 'active';
  if (p.contactId) {
    const c = (await query('SELECT email, status FROM contacts WHERE id=? AND tenant_id=?',
      [p.contactId, req.auth!.tenantId]))[0];
    if (c) {
      const sup = await query('SELECT 1 FROM suppressions WHERE tenant_id=? AND email=? LIMIT 1', [req.auth!.tenantId, c.email]);
      if (sup.length) initialStatus = 'suppressed';
      else if (c.status === 'unsubscribed') initialStatus = 'unsubscribed';
    }
  }

  // Generate unique token (retry on collision)
  let token = '';
  for (let i = 0; i < 5; i++) {
    const candidate = generateInviteToken();
    const r = await query('SELECT 1 FROM invite_links WHERE token=? LIMIT 1', [candidate]);
    if (!r.length) { token = candidate; break; }
  }
  if (!token) return res.status(500).json({ error: 'token_generation_failed' });

  const ins = await query(
    `INSERT INTO invite_links
       (tenant_id, lead_id, contact_id, outreach_draft_id, campaign_id, tracking_domain_id,
        token, destination_url, landing_mode, status, expires_at, created_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      req.auth!.tenantId, p.leadId ?? null, p.contactId ?? null, p.outreachDraftId ?? null,
      p.campaignId ?? null, p.trackingDomainId ?? null,
      token, p.destinationUrl, p.landingMode, initialStatus, p.expiresAt ? new Date(p.expiresAt) : null,
      req.auth!.userId,
    ],
  );
  const id = Number(ins.insertId);
  await audit(req, 'invite_link.create', { type: 'invite_link', id }, { initial_status: initialStatus });

  // Lookup tracking domain for branded URL
  let td: string | null = null;
  if (p.trackingDomainId) {
    const tdRow = (await query('SELECT domain, status FROM tracking_domains WHERE id=? AND tenant_id=? LIMIT 1',
      [p.trackingDomainId, req.auth!.tenantId]))[0];
    if (tdRow && tdRow.status === 'verified') td = tdRow.domain;
  }

  res.status(201).json({
    id, token, status: initialStatus,
    public_url: publicLinkUrl(token, td),
    fallback_url: fallbackLinkUrl(token),
    placeholder: '{{invite_link}}',
  });
});

const patchSchema = z.object({
  destinationUrl: z.string().url().max(2000).optional(),
  landingMode: z.enum(['redirect', 'personal_page']).optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  trackingDomainId: z.number().int().positive().nullable().optional(),
});

inviteLinksRouter.patch('/:id', requireWriteAccess, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });

  const owns = await query('SELECT id FROM invite_links WHERE id=? AND tenant_id=? LIMIT 1', [id, req.auth!.tenantId]);
  if (!owns.length) return res.status(404).json({ error: 'not_found' });

  const fields: string[] = []; const params: any[] = [];
  if (parsed.data.destinationUrl   !== undefined) { fields.push('destination_url=?');   params.push(parsed.data.destinationUrl); }
  if (parsed.data.landingMode      !== undefined) { fields.push('landing_mode=?');      params.push(parsed.data.landingMode); }
  if (parsed.data.expiresAt        !== undefined) { fields.push('expires_at=?');        params.push(parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null); }
  if (parsed.data.trackingDomainId !== undefined) { fields.push('tracking_domain_id=?'); params.push(parsed.data.trackingDomainId); }
  if (!fields.length) return res.status(400).json({ error: 'no_changes' });
  params.push(id, req.auth!.tenantId);
  await query(`UPDATE invite_links SET ${fields.join(', ')} WHERE id=? AND tenant_id=?`, params);
  await audit(req, 'invite_link.update', { type: 'invite_link', id });
  res.json({ ok: true });
});

inviteLinksRouter.post('/:id/pause', requireWriteAccess, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await query(
    "UPDATE invite_links SET status='paused' WHERE id=? AND tenant_id=? AND status='active'",
    [id, req.auth!.tenantId],
  );
  if (!r.affectedRows) return res.status(409).json({ error: 'cannot_pause' });
  await audit(req, 'invite_link.pause', { type: 'invite_link', id });
  res.json({ ok: true });
});

inviteLinksRouter.post('/:id/resume', requireWriteAccess, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  // Only resume if status is paused. Never resurrect suppressed/unsubscribed/disabled.
  const r = await query(
    "UPDATE invite_links SET status='active' WHERE id=? AND tenant_id=? AND status='paused'",
    [id, req.auth!.tenantId],
  );
  if (!r.affectedRows) return res.status(409).json({ error: 'cannot_resume' });
  await audit(req, 'invite_link.resume', { type: 'invite_link', id });
  res.json({ ok: true });
});

inviteLinksRouter.get('/:id/clicks', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const owns = await query('SELECT id FROM invite_links WHERE id=? AND tenant_id=? LIMIT 1', [id, req.auth!.tenantId]);
  if (!owns.length) return res.status(404).json({ error: 'not_found' });
  const rows = await query(
    `SELECT id, clicked_at, country, referrer, bot_score, metadata_json
     FROM invite_link_clicks WHERE invite_link_id=? AND tenant_id=?
     ORDER BY clicked_at DESC LIMIT 500`,
    [id, req.auth!.tenantId],
  );
  res.json({ clicks: rows });
});
