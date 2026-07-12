import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { authMiddleware, requireSuperAdmin } from '../middleware/auth.js';
import { audit } from '../middleware/audit.js';

export const adminSafetyRouter = Router();
adminSafetyRouter.use(authMiddleware, requireSuperAdmin);

adminSafetyRouter.get('/tenant-safety', async (_req, res) => {
  const rows = await query(
    `SELECT t.id, t.name, t.slug, t.status,
            COALESCE(s.invite_links_enabled, 1)             AS invite_links_enabled,
            COALESCE(s.custom_tracking_domains_enabled, 0)  AS custom_tracking_domains_enabled,
            COALESCE(s.max_invite_links_per_day, 500)       AS max_invite_links_per_day,
            COALESCE(s.max_clicks_per_minute, 120)          AS max_clicks_per_minute,
            COALESCE(s.max_redirects_per_minute, 120)       AS max_redirects_per_minute,
            COALESCE(s.auto_disable_on_abuse, 1)            AS auto_disable_on_abuse,
            COALESCE(s.require_manual_draft_approval, 1)    AS require_manual_draft_approval,
            COALESCE(s.outreach_paused, 0)                  AS outreach_paused,
            s.outreach_paused_reason
     FROM tenants t
     LEFT JOIN tenant_safety_settings s ON s.tenant_id = t.id
     ORDER BY t.created_at DESC LIMIT 500`,
  );
  res.json({ tenants: rows });
});

const patchSchema = z.object({
  inviteLinksEnabled:           z.boolean().optional(),
  customTrackingDomainsEnabled: z.boolean().optional(),
  maxInviteLinksPerDay:         z.number().int().min(0).max(100000).optional(),
  maxClicksPerMinute:           z.number().int().min(0).max(100000).optional(),
  maxRedirectsPerMinute:        z.number().int().min(0).max(100000).optional(),
  autoDisableOnAbuse:           z.boolean().optional(),
  requireManualDraftApproval:   z.boolean().optional(),
});

adminSafetyRouter.patch('/tenant-safety/:tenantId', async (req, res) => {
  const tenantId = parseInt(req.params.tenantId, 10);
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });
  const p = parsed.data;
  await query('INSERT IGNORE INTO tenant_safety_settings (tenant_id) VALUES (?)', [tenantId]);

  const fields: string[] = []; const params: any[] = [];
  if (p.inviteLinksEnabled           !== undefined) { fields.push('invite_links_enabled=?');            params.push(p.inviteLinksEnabled ? 1 : 0); }
  if (p.customTrackingDomainsEnabled !== undefined) { fields.push('custom_tracking_domains_enabled=?'); params.push(p.customTrackingDomainsEnabled ? 1 : 0); }
  if (p.maxInviteLinksPerDay         !== undefined) { fields.push('max_invite_links_per_day=?');        params.push(p.maxInviteLinksPerDay); }
  if (p.maxClicksPerMinute           !== undefined) { fields.push('max_clicks_per_minute=?');           params.push(p.maxClicksPerMinute); }
  if (p.maxRedirectsPerMinute        !== undefined) { fields.push('max_redirects_per_minute=?');        params.push(p.maxRedirectsPerMinute); }
  if (p.autoDisableOnAbuse           !== undefined) { fields.push('auto_disable_on_abuse=?');           params.push(p.autoDisableOnAbuse ? 1 : 0); }
  if (p.requireManualDraftApproval   !== undefined) { fields.push('require_manual_draft_approval=?');   params.push(p.requireManualDraftApproval ? 1 : 0); }
  if (!fields.length) return res.status(400).json({ error: 'no_changes' });
  params.push(tenantId);
  await query(`UPDATE tenant_safety_settings SET ${fields.join(', ')} WHERE tenant_id=?`, params);
  await audit(req, 'tenant_safety.update', { type: 'tenant', id: tenantId }, p);
  res.json({ ok: true });
});

adminSafetyRouter.get('/risk-events', async (req, res) => {
  const tenantId = req.query.tenantId ? parseInt(req.query.tenantId as string, 10) : null;
  const sev = req.query.severity as string | undefined;
  const where: string[] = []; const params: any[] = [];
  if (tenantId) { where.push('tenant_id=?'); params.push(tenantId); }
  if (sev) { where.push('severity=?'); params.push(sev); }
  const sql = `SELECT id, tenant_id, event_type, severity, reason, metadata_json, created_at
               FROM tenant_risk_events ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY created_at DESC LIMIT 500`;
  res.json({ events: await query(sql, params) });
});

adminSafetyRouter.post('/tenants/:tenantId/pause-outreach', async (req, res) => {
  const tenantId = parseInt(req.params.tenantId, 10);
  const reason = (req.body?.reason as string | undefined)?.slice(0, 255) ?? null;
  await query('INSERT IGNORE INTO tenant_safety_settings (tenant_id) VALUES (?)', [tenantId]);
  await query(
    'UPDATE tenant_safety_settings SET outreach_paused=1, outreach_paused_reason=? WHERE tenant_id=?',
    [reason, tenantId],
  );
  await query(
    `INSERT INTO tenant_risk_events (tenant_id, event_type, severity, reason)
     VALUES (?, 'outreach.paused', 'warning', ?)`,
    [tenantId, reason],
  );
  await audit(req, 'tenant.outreach_pause', { type: 'tenant', id: tenantId }, { reason });
  res.json({ ok: true });
});

adminSafetyRouter.post('/tenants/:tenantId/resume-outreach', async (req, res) => {
  const tenantId = parseInt(req.params.tenantId, 10);
  await query(
    'UPDATE tenant_safety_settings SET outreach_paused=0, outreach_paused_reason=NULL WHERE tenant_id=?',
    [tenantId],
  );
  await query(
    `INSERT INTO tenant_risk_events (tenant_id, event_type, severity, reason)
     VALUES (?, 'outreach.resumed', 'info', NULL)`,
    [tenantId],
  );
  await audit(req, 'tenant.outreach_resume', { type: 'tenant', id: tenantId });
  res.json({ ok: true });
});
