import { Router } from 'express';
import argon2 from 'argon2';
import { v4 as uuid } from 'uuid';
import { z } from 'zod';
import { query, withConn } from '../db.js';
import { signToken, authMiddleware } from '../middleware/auth.js';
import { config } from '../config.js';

export const authRouter = Router();

const registerSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(10).max(200),
  fullName: z.string().max(160).optional(),
  tenantName: z.string().min(2).max(160),
  locale: z.enum(['en', 'ru', 'uk']).optional(),
});

authRouter.post('/register', async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', detail: parsed.error.flatten() });
  const { email, password, fullName, tenantName, locale } = parsed.data;

  const existing = await query('SELECT id FROM users WHERE email=? LIMIT 1', [email.toLowerCase()]);
  if (existing.length) return res.status(409).json({ error: 'email_in_use' });

  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

  const result = await withConn(async (c) => {
    await c.beginTransaction();
    try {
      const u = await c.query(
        'INSERT INTO users (uuid, email, password_hash, full_name, locale) VALUES (?, ?, ?, ?, ?)',
        [uuid(), email.toLowerCase(), passwordHash, fullName ?? null, locale ?? config.defaultLocale],
      );
      const userId = Number(u.insertId);

      const slugBase = tenantName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'tenant';
      const slug = `${slugBase}-${Date.now().toString(36)}`;
      const t = await c.query(
        `INSERT INTO tenants (uuid, slug, name, status, default_locale, trial_ends_at)
         VALUES (?, ?, ?, 'trial', ?, DATE_ADD(NOW(), INTERVAL ${config.billing.trialDays} DAY))`,
        [uuid(), slug, tenantName, locale ?? config.defaultLocale],
      );
      const tenantId = Number(t.insertId);

      await c.query(
        "INSERT INTO tenant_users (tenant_id, user_id, role, accepted_at) VALUES (?, ?, 'tenant_owner', NOW())",
        [tenantId, userId],
      );
      await c.commit();
      return { userId, tenantId };
    } catch (e) {
      await c.rollback();
      throw e;
    }
  });

  const token = signToken({ sub: result.userId, tenant: result.tenantId });
  res.status(201).json({ token, userId: result.userId, tenantId: result.tenantId });
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  tenantId: z.number().int().positive().optional(),
});

authRouter.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });
  const { email, password } = parsed.data;

  const rows = await query(
    'SELECT id, password_hash, status, is_super_admin FROM users WHERE email=? LIMIT 1',
    [email.toLowerCase()],
  );
  if (!rows.length) return res.status(401).json({ error: 'invalid_credentials' });
  const u = rows[0];
  if (u.status !== 'active') return res.status(403).json({ error: 'user_inactive' });

  const ok = await argon2.verify(u.password_hash, password);
  if (!ok) return res.status(401).json({ error: 'invalid_credentials' });

  const memberships = await query(
    `SELECT tu.tenant_id, tu.role, t.name, t.slug, t.status
     FROM tenant_users tu JOIN tenants t ON t.id = tu.tenant_id
     WHERE tu.user_id=? AND t.status NOT IN ('deleted_soft','deleted_hard')`,
    [u.id],
  );

  const chosen = parsed.data.tenantId
    ? memberships.find((m: any) => m.tenant_id === parsed.data.tenantId)
    : memberships[0];

  const token = signToken({ sub: u.id, tenant: chosen?.tenant_id ?? null });
  await query('UPDATE users SET last_login_at=NOW() WHERE id=?', [u.id]);

  res.json({
    token,
    userId: u.id,
    isSuperAdmin: !!u.is_super_admin,
    tenants: memberships,
    activeTenantId: chosen?.tenant_id ?? null,
  });
});

authRouter.get('/me', authMiddleware, async (req, res) => {
  if (!req.auth) return res.status(401).json({ error: 'unauthorized' });
  const rows = await query(
    'SELECT id, email, full_name, locale, is_super_admin, last_login_at FROM users WHERE id=? LIMIT 1',
    [req.auth.userId],
  );
  if (!rows.length) return res.status(404).json({ error: 'not_found' });
  const u = rows[0];
  res.json({ ...req.auth, email: u.email, fullName: u.full_name, locale: u.locale, lastLoginAt: u.last_login_at });
});

const patchMeSchema = z.object({
  fullName: z.string().max(160).optional(),
  locale:   z.enum(['en', 'ru', 'uk']).optional(),
  currentPassword: z.string().min(1).optional(),
  newPassword:     z.string().min(10).max(200).optional(),
});

authRouter.patch('/me', authMiddleware, async (req, res) => {
  if (!req.auth) return res.status(401).json({ error: 'unauthorized' });
  const parsed = patchMeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', detail: parsed.error.flatten() });
  const p = parsed.data;

  const rows = await query('SELECT id, password_hash FROM users WHERE id=? LIMIT 1', [req.auth.userId]);
  if (!rows.length) return res.status(404).json({ error: 'not_found' });
  const u = rows[0];

  const fields: string[] = [];
  const params: any[] = [];

  if (p.fullName !== undefined) { fields.push('full_name=?'); params.push(p.fullName); }
  if (p.locale !== undefined)   { fields.push('locale=?');    params.push(p.locale); }

  if (p.newPassword !== undefined) {
    if (!p.currentPassword) return res.status(400).json({ error: 'current_password_required' });
    const ok = await argon2.verify(u.password_hash, p.currentPassword);
    if (!ok) return res.status(401).json({ error: 'invalid_current_password' });
    const hash = await argon2.hash(p.newPassword, { type: argon2.argon2id });
    fields.push('password_hash=?');
    params.push(hash);
  }

  if (!fields.length) return res.status(400).json({ error: 'no_changes' });
  params.push(req.auth.userId);
  await query(`UPDATE users SET ${fields.join(', ')} WHERE id=?`, params);
  res.json({ ok: true });
});
