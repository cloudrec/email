import { Router } from 'express';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { query } from '../db.js';
import { authMiddleware, requireSuperAdmin } from '../middleware/auth.js';
import { audit } from '../middleware/audit.js';

export const tenantsRouter = Router();
tenantsRouter.use(authMiddleware);

// Super-admin: list/search tenants
tenantsRouter.get('/', requireSuperAdmin, async (req, res) => {
  const q = (req.query.q as string | undefined)?.trim();
  const limit = Math.min(200, parseInt((req.query.limit as string) ?? '50', 10));
  const offset = parseInt((req.query.offset as string) ?? '0', 10);

  const where = q ? 'WHERE name LIKE ? OR slug LIKE ?' : '';
  const params = q ? [`%${q}%`, `%${q}%`, limit, offset] : [limit, offset];
  const rows = await query(
    `SELECT id, uuid, slug, name, status, plan_id, default_locale, trial_ends_at, created_at
     FROM tenants ${where}
     ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    params,
  );
  res.json({ tenants: rows });
});

const createSchema = z.object({
  name: z.string().min(2).max(160),
  ownerEmail: z.string().email(),
  planCode: z.string().default('starter'),
  locale: z.enum(['en', 'ru', 'uk']).default('en'),
});

tenantsRouter.post('/', requireSuperAdmin, async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });
  const { name, ownerEmail, planCode, locale } = parsed.data;

  const plans = await query('SELECT id FROM plans WHERE code=? LIMIT 1', [planCode]);
  if (!plans.length) return res.status(400).json({ error: 'unknown_plan' });
  const users = await query('SELECT id FROM users WHERE email=? LIMIT 1', [ownerEmail.toLowerCase()]);
  if (!users.length) return res.status(400).json({ error: 'owner_user_missing' });

  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60)}-${Date.now().toString(36)}`;
  const t = await query(
    "INSERT INTO tenants (uuid, slug, name, status, plan_id, default_locale) VALUES (?, ?, ?, 'trial', ?, ?)",
    [uuid(), slug, name, plans[0].id, locale],
  );
  const tenantId = Number(t.insertId);
  await query(
    "INSERT INTO tenant_users (tenant_id, user_id, role, accepted_at) VALUES (?, ?, 'tenant_owner', NOW())",
    [tenantId, users[0].id],
  );

  await audit(req, 'tenant.create', { type: 'tenant', id: tenantId }, { name, ownerEmail, planCode });
  res.status(201).json({ id: tenantId, slug });
});

tenantsRouter.post('/:id/suspend', requireSuperAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const reason = (req.body?.reason as string | undefined)?.slice(0, 255) ?? 'admin_action';
  await query(
    "UPDATE tenants SET status='suspended', suspended_at=NOW(), suspended_reason=? WHERE id=?",
    [reason, id],
  );
  await audit(req, 'tenant.suspend', { type: 'tenant', id }, { reason });
  res.json({ ok: true });
});

tenantsRouter.post('/:id/activate', requireSuperAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await query(
    "UPDATE tenants SET status='active', suspended_at=NULL, suspended_reason=NULL WHERE id=?",
    [id],
  );
  await audit(req, 'tenant.activate', { type: 'tenant', id });
  res.json({ ok: true });
});

tenantsRouter.post('/:id/cancel', requireSuperAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await query("UPDATE tenants SET status='canceled' WHERE id=?", [id]);
  await audit(req, 'tenant.cancel', { type: 'tenant', id });
  res.json({ ok: true });
});

// Super-admin: per-tenant Lead Discovery toggle + limit overrides
const leadCtrlSchema = z.object({
  enabled: z.boolean().optional(),
  overrideMaxDiscoveredLeadsMonth: z.number().int().nonnegative().nullable().optional(),
  overrideMaxSourceDomainsMonth: z.number().int().nonnegative().nullable().optional(),
  overrideMaxVerificationChecksMonth: z.number().int().nonnegative().nullable().optional(),
});

tenantsRouter.patch('/:id/lead-discovery', requireSuperAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const parsed = leadCtrlSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });
  const p = parsed.data;

  const fields: string[] = [];
  const params: any[] = [];
  if (p.enabled !== undefined) {
    fields.push('lead_discovery_enabled=?');
    params.push(p.enabled ? 1 : 0);
  }
  if (p.overrideMaxDiscoveredLeadsMonth !== undefined) {
    fields.push('override_max_discovered_leads_month=?');
    params.push(p.overrideMaxDiscoveredLeadsMonth);
  }
  if (p.overrideMaxSourceDomainsMonth !== undefined) {
    fields.push('override_max_source_domains_month=?');
    params.push(p.overrideMaxSourceDomainsMonth);
  }
  if (p.overrideMaxVerificationChecksMonth !== undefined) {
    fields.push('override_max_verification_checks_month=?');
    params.push(p.overrideMaxVerificationChecksMonth);
  }
  if (!fields.length) return res.status(400).json({ error: 'no_changes' });
  params.push(id);

  const r = await query(`UPDATE tenants SET ${fields.join(', ')} WHERE id=?`, params);
  if (!r.affectedRows) return res.status(404).json({ error: 'not_found' });
  await audit(req, 'tenant.lead_discovery.update', { type: 'tenant', id }, p);
  res.json({ ok: true });
});

tenantsRouter.get('/:id', requireSuperAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const t = await query('SELECT * FROM tenants WHERE id=? LIMIT 1', [id]);
  if (!t.length) return res.status(404).json({ error: 'not_found' });
  const users = await query(
    `SELECT u.id, u.email, u.full_name, tu.role, tu.accepted_at
     FROM tenant_users tu JOIN users u ON u.id=tu.user_id WHERE tu.tenant_id=?`,
    [id],
  );
  res.json({ tenant: t[0], users });
});
