import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { authMiddleware, requireTenant, requireWriteAccess } from '../middleware/auth.js';
import { audit } from '../middleware/audit.js';

export const senderIdentitiesRouter = Router();
senderIdentitiesRouter.use(authMiddleware, requireTenant);

senderIdentitiesRouter.get('/', async (req, res) => {
  const rows = await query(
    `SELECT si.id, si.from_email, si.from_name, si.display_name, si.reply_to, si.is_default,
            si.purpose, si.status, si.daily_send_limit, si.hourly_send_limit,
            si.sent_today, si.bounced_today, si.complained_today, si.unsubscribed_today,
            si.last_sent_at, si.warmup_stage, si.paused_reason, si.provider_id,
            si.domain_id, d.domain, d.status AS domain_status
     FROM sender_identities si
     LEFT JOIN domains d ON d.id=si.domain_id
     WHERE si.tenant_id=? ORDER BY si.is_default DESC, si.id ASC`,
    [req.auth!.tenantId],
  );
  res.json({ identities: rows });
});

const createSchema = z.object({
  fromEmail:  z.string().email().max(255),
  fromName:   z.string().min(1).max(160),
  displayName: z.string().max(160).optional(),
  domainId:   z.number().int().positive(),
  providerId: z.number().int().positive().optional(),
  purpose:    z.enum(['main', 'cold_outreach', 'transactional']).default('cold_outreach'),
  replyTo:    z.string().email().max(255).optional(),
  isDefault:  z.boolean().default(false),
});

senderIdentitiesRouter.post('/', requireWriteAccess, async (req, res) => {
  const p = createSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'invalid_body', detail: p.error.issues });

  const [dom] = await query(
    'SELECT id, status, purpose FROM domains WHERE id=? AND tenant_id=? LIMIT 1',
    [p.data.domainId, req.auth!.tenantId],
  );
  if (!dom) return res.status(404).json({ error: 'domain_not_found' });

  if (p.data.providerId) {
    const [pv] = await query('SELECT id FROM sending_providers WHERE id=? AND tenant_id=? LIMIT 1', [p.data.providerId, req.auth!.tenantId]);
    if (!pv) return res.status(400).json({ error: 'provider_not_found' });
  }

  // New cold mailbox starts at 10/day, 3/hour. Admin raises manually after healthy metrics.
  const daily = p.data.purpose === 'cold_outreach' ? 10 : 100;
  const hourly = Math.max(1, Math.ceil(daily / 4));

  if (p.data.isDefault) {
    await query('UPDATE sender_identities SET is_default=0 WHERE tenant_id=?', [req.auth!.tenantId]);
  }

  const r = await query(
    `INSERT INTO sender_identities
       (tenant_id, domain_id, provider_id, from_email, from_name, display_name, reply_to,
        is_default, purpose, status, daily_send_limit, hourly_send_limit)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    [req.auth!.tenantId, p.data.domainId, p.data.providerId ?? null,
     p.data.fromEmail, p.data.fromName, p.data.displayName ?? null, p.data.replyTo ?? null,
     p.data.isDefault ? 1 : 0, p.data.purpose, daily, hourly],
  );
  const id = Number(r.insertId);
  await audit(req, 'sender_identity.create', { type: 'sender_identity', id }, { purpose: p.data.purpose, daily });
  res.status(201).json({ id, domainStatus: dom.status, dailySendLimit: daily });
});

// PATCH — adjust limits/status/purpose. Limit raises are an explicit admin action.
const patchSchema = z.object({
  displayName: z.string().max(160).optional(),
  purpose: z.enum(['main', 'cold_outreach', 'transactional']).optional(),
  status: z.enum(['active', 'paused', 'disabled']).optional(),
  dailySendLimit: z.coerce.number().int().min(0).max(100000).optional(),
  hourlySendLimit: z.coerce.number().int().min(0).max(100000).optional(),
  providerId: z.number().int().positive().nullable().optional(),
});

senderIdentitiesRouter.patch('/:id', requireWriteAccess, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const p = patchSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'invalid_body', detail: p.error.issues });
  const [row] = await query('SELECT id FROM sender_identities WHERE id=? AND tenant_id=? LIMIT 1', [id, req.auth!.tenantId]);
  if (!row) return res.status(404).json({ error: 'not_found' });

  // A provider carries SMTP relay host + credential refs. Verify any newly set
  // provider belongs to this tenant, mirroring the POST path — otherwise a tenant
  // could point its identity at another tenant's relay and originate mail through it.
  if (p.data.providerId != null) {
    const [pv] = await query('SELECT id FROM sending_providers WHERE id=? AND tenant_id=? LIMIT 1', [p.data.providerId, req.auth!.tenantId]);
    if (!pv) return res.status(400).json({ error: 'provider_not_found' });
  }

  const map: Record<string, string> = {
    displayName: 'display_name', purpose: 'purpose', status: 'status',
    dailySendLimit: 'daily_send_limit', hourlySendLimit: 'hourly_send_limit', providerId: 'provider_id',
  };
  const sets: string[] = [];
  const vals: any[] = [];
  for (const [k, col] of Object.entries(map)) {
    const v = (p.data as any)[k];
    if (v === undefined) continue;
    sets.push(`${col}=?`);
    vals.push(v);
  }
  // Clear paused_reason when reactivating.
  if (p.data.status === 'active') sets.push("paused_reason=NULL");
  if (!sets.length) return res.json({ ok: true, unchanged: true });
  vals.push(id);
  await query(`UPDATE sender_identities SET ${sets.join(', ')} WHERE id=?`, vals);
  await audit(req, 'sender_identity.update', { type: 'sender_identity', id }, { fields: Object.keys(p.data) });
  res.json({ ok: true });
});

senderIdentitiesRouter.delete('/:id', requireWriteAccess, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await query(
    'DELETE FROM sender_identities WHERE id=? AND tenant_id=?',
    [id, req.auth!.tenantId],
  );
  if (!r.affectedRows) return res.status(404).json({ error: 'not_found' });
  await audit(req, 'sender_identity.delete', { type: 'sender_identity', id });
  res.json({ ok: true });
});
