import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { authMiddleware, requireTenant, requireWriteAccess } from '../middleware/auth.js';
import { audit } from '../middleware/audit.js';

export const productProfilesRouter = Router();
productProfilesRouter.use(authMiddleware, requireTenant);

const profileSchema = z.object({
  name: z.string().min(2).max(200),
  productUrl: z.string().url().max(500).nullable().optional(),
  description: z.string().min(10).max(2000),
  targetCustomer: z.string().max(1000).nullable().optional(),
  keyBenefits: z.array(z.string().min(1).max(300)).max(20).default([]),
  allowedClaims: z.array(z.string().min(1).max(300)).max(40).default([]),
  forbiddenClaims: z.array(z.string().min(1).max(300)).max(40).default([]),
  preferredTone: z.enum(['neutral','friendly','professional','short_direct']).default('neutral'),
  defaultLanguage: z.enum(['en','ru','uk']).default('en'),
  isDefault: z.boolean().default(false),
});

productProfilesRouter.get('/', async (req, res) => {
  const rows = await query(
    `SELECT id, name, product_url, description, target_customer, key_benefits, allowed_claims,
            forbidden_claims, preferred_tone, default_language, is_active, is_default, created_at, updated_at
     FROM tenant_product_profiles WHERE tenant_id=? AND is_active=1 ORDER BY is_default DESC, created_at DESC`,
    [req.auth!.tenantId],
  );
  res.json({ profiles: rows });
});

productProfilesRouter.post('/', requireWriteAccess, async (req, res) => {
  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', detail: parsed.error.flatten() });
  const p = parsed.data;

  if (p.isDefault) {
    await query('UPDATE tenant_product_profiles SET is_default=0 WHERE tenant_id=?', [req.auth!.tenantId]);
  }
  const r = await query(
    `INSERT INTO tenant_product_profiles
       (tenant_id, name, product_url, description, target_customer, key_benefits, allowed_claims,
        forbidden_claims, preferred_tone, default_language, is_default, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      req.auth!.tenantId, p.name, p.productUrl ?? null, p.description, p.targetCustomer ?? null,
      JSON.stringify(p.keyBenefits), JSON.stringify(p.allowedClaims), JSON.stringify(p.forbiddenClaims),
      p.preferredTone, p.defaultLanguage, p.isDefault ? 1 : 0, req.auth!.userId,
    ],
  );
  await audit(req, 'product_profile.create', { type: 'product_profile', id: Number(r.insertId) });
  res.status(201).json({ id: Number(r.insertId) });
});

productProfilesRouter.patch('/:id', requireWriteAccess, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const parsed = profileSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });
  const p = parsed.data;

  const owns = await query('SELECT id FROM tenant_product_profiles WHERE id=? AND tenant_id=? LIMIT 1', [id, req.auth!.tenantId]);
  if (!owns.length) return res.status(404).json({ error: 'not_found' });

  const fields: string[] = [];
  const params: any[] = [];
  if (p.name !== undefined)            { fields.push('name=?');             params.push(p.name); }
  if (p.productUrl !== undefined)      { fields.push('product_url=?');      params.push(p.productUrl); }
  if (p.description !== undefined)     { fields.push('description=?');      params.push(p.description); }
  if (p.targetCustomer !== undefined)  { fields.push('target_customer=?');  params.push(p.targetCustomer); }
  if (p.keyBenefits !== undefined)     { fields.push('key_benefits=?');     params.push(JSON.stringify(p.keyBenefits)); }
  if (p.allowedClaims !== undefined)   { fields.push('allowed_claims=?');   params.push(JSON.stringify(p.allowedClaims)); }
  if (p.forbiddenClaims !== undefined) { fields.push('forbidden_claims=?'); params.push(JSON.stringify(p.forbiddenClaims)); }
  if (p.preferredTone !== undefined)   { fields.push('preferred_tone=?');   params.push(p.preferredTone); }
  if (p.defaultLanguage !== undefined) { fields.push('default_language=?'); params.push(p.defaultLanguage); }
  if (p.isDefault === true) {
    await query('UPDATE tenant_product_profiles SET is_default=0 WHERE tenant_id=?', [req.auth!.tenantId]);
    fields.push('is_default=1');
  }
  if (!fields.length) return res.status(400).json({ error: 'no_changes' });
  params.push(id, req.auth!.tenantId);
  await query(`UPDATE tenant_product_profiles SET ${fields.join(', ')} WHERE id=? AND tenant_id=?`, params);
  await audit(req, 'product_profile.update', { type: 'product_profile', id });
  res.json({ ok: true });
});

productProfilesRouter.delete('/:id', requireWriteAccess, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await query(
    'UPDATE tenant_product_profiles SET is_active=0 WHERE id=? AND tenant_id=?',
    [id, req.auth!.tenantId],
  );
  if (!r.affectedRows) return res.status(404).json({ error: 'not_found' });
  await audit(req, 'product_profile.delete', { type: 'product_profile', id });
  res.json({ ok: true });
});
