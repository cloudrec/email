import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { authMiddleware, requireTenant, requireWriteAccess } from '../middleware/auth.js';
import { audit } from '../middleware/audit.js';
import { addSuppression, isSuppressedGlobal } from '../services/suppression.js';

export const contactsRouter = Router();
contactsRouter.use(authMiddleware, requireTenant);

// Per-contact detail for the admin UI (TZ §17 Contacts): source, relevance reason,
// status, suppression, and campaign history. Read-only aggregation over existing tables;
// writes nothing. All lookups are scoped to the caller's tenant via the contact row.
contactsRouter.get('/:id/detail', async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const id = parseInt(req.params.id, 10);
  const [contact] = await query(
    `SELECT id, email, first_name, last_name, status, language, country, tags,
            consent_source, last_event_at, created_at,
            unsubscribed_at, bounced_at, complained_at
       FROM contacts WHERE id=? AND tenant_id=? LIMIT 1`, [id, tenantId]);
  if (!contact) return res.status(404).json({ error: 'not_found' });
  const email = String(contact.email);

  // Suppression (tenant + global), with the reason if present.
  const suppressed = await isSuppressedGlobal(tenantId, email);
  const [supRow] = await query(
    `SELECT reason, created_at FROM suppressions WHERE tenant_id=? AND email=? LIMIT 1`, [tenantId, email]);
  const [gsupRow] = await query(
    `SELECT reason, created_at FROM global_contact_suppression
      WHERE type='email' AND normalized_value=? LIMIT 1`, [email.toLowerCase()]);

  // Source + relevance reason from the most recent outreach-queue entry for this email.
  const [queueRow] = await query(
    `SELECT reason, source_url, company_name, status, safety_status
       FROM manual_outreach_queue WHERE tenant_id=? AND email=? ORDER BY id DESC LIMIT 1`,
    [tenantId, email]);

  // Campaign history: broadcast events + per-contact outreach touchpoints.
  const broadcastEvents = await query(
    `SELECT ce.campaign_id, c.name AS campaign_name, ce.event_type, ce.occurred_at
       FROM campaign_events ce LEFT JOIN campaigns c ON c.id = ce.campaign_id
      WHERE ce.tenant_id=? AND (ce.contact_id=? OR ce.email=?)
      ORDER BY ce.occurred_at DESC LIMIT 50`, [tenantId, id, email]);
  const touchpoints = await query(
    `SELECT campaign_id, channel, direction, touch_type, status, subject, created_at
       FROM outreach_touchpoints
      WHERE tenant_id=? AND (contact_id=? OR email=?)
      ORDER BY created_at DESC LIMIT 50`, [tenantId, id, email]);

  res.json({
    contact,
    source: {
      consentSource: contact.consent_source ?? null,
      tags: contact.tags ?? null,
      sourceUrl: queueRow?.source_url ?? null,
      company: queueRow?.company_name ?? null,
    },
    relevanceReason: queueRow?.reason ?? null,
    suppression: {
      suppressed,
      reason: supRow?.reason ?? gsupRow?.reason ?? null,
      at: supRow?.created_at ?? gsupRow?.created_at ?? null,
      scope: supRow ? 'tenant' : gsupRow ? 'global' : null,
    },
    campaignHistory: { broadcastEvents, touchpoints },
  });
});

contactsRouter.get('/', async (req, res) => {
  const limit = Math.min(500, parseInt((req.query.limit as string) ?? '100', 10));
  const offset = parseInt((req.query.offset as string) ?? '0', 10);
  const status = req.query.status as string | undefined;

  const where = ['tenant_id=?'];
  const params: any[] = [req.auth!.tenantId];
  if (status) { where.push('status=?'); params.push(status); }

  params.push(limit, offset);
  const rows = await query(
    `SELECT id, email, first_name, last_name, status, language, country, tags, last_event_at, created_at
     FROM contacts WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    params,
  );
  res.json({ contacts: rows });
});

const createSchema = z.object({
  email: z.string().email().max(255),
  firstName: z.string().max(120).optional(),
  lastName: z.string().max(120).optional(),
  language: z.enum(['en', 'ru', 'uk']).optional(),
  country: z.string().length(2).optional(),
  tags: z.array(z.string().max(60)).max(50).optional(),
  consentSource: z.string().max(120).optional(),
});

contactsRouter.post('/', requireWriteAccess, async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });
  const c = parsed.data;
  const email = c.email.toLowerCase();

  const r = await query(
    `INSERT INTO contacts
       (tenant_id, email, first_name, last_name, language, country, tags, consent_source, consent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       first_name=VALUES(first_name), last_name=VALUES(last_name),
       language=COALESCE(VALUES(language), language),
       country=COALESCE(VALUES(country), country),
       tags=VALUES(tags)`,
    [
      req.auth!.tenantId,
      email,
      c.firstName ?? null,
      c.lastName ?? null,
      c.language ?? null,
      c.country ?? null,
      c.tags ? JSON.stringify(c.tags) : null,
      c.consentSource ?? 'api',
    ],
  );
  await audit(req, 'contact.upsert', { type: 'contact', id: email });
  res.status(201).json({ id: Number(r.insertId), email });
});

const importSchema = z.object({
  contacts: z.array(createSchema).min(1).max(5000),
});

contactsRouter.post('/import', requireWriteAccess, async (req, res) => {
  const parsed = importSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });

  let inserted = 0;
  for (const c of parsed.data.contacts) {
    const email = c.email.toLowerCase();
    await query(
      `INSERT IGNORE INTO contacts
         (tenant_id, email, first_name, last_name, language, country, tags, consent_source, consent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        req.auth!.tenantId, email,
        c.firstName ?? null, c.lastName ?? null,
        c.language ?? null, c.country ?? null,
        c.tags ? JSON.stringify(c.tags) : null,
        c.consentSource ?? 'import',
      ],
    );
    inserted++;
  }
  await audit(req, 'contact.import', undefined, { count: inserted });
  res.json({ inserted });
});

// Explicit activation of contacts imported from Lead Discovery.
// Safety: lead-discovered contacts arrive in `pending` and cannot be sent
// until the tenant explicitly activates them. This route is the confirmation.
const activateSchema = z.object({
  contactIds: z.array(z.number().int().positive()).min(1).max(5000),
  confirmCompliance: z.literal(true),
});

contactsRouter.post('/activate-pending', requireWriteAccess, async (req, res) => {
  const parsed = activateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body_or_missing_compliance_confirm' });

  const placeholders = parsed.data.contactIds.map(() => '?').join(',');
  const r = await query(
    `UPDATE contacts SET status='subscribed', consent_at=NOW()
     WHERE tenant_id=? AND id IN (${placeholders}) AND status='pending'`,
    [req.auth!.tenantId, ...parsed.data.contactIds],
  );
  await audit(req, 'contact.activate_pending', undefined, { count: r.affectedRows, confirmCompliance: true });
  res.json({ activated: r.affectedRows });
});

contactsRouter.post('/:id/unsubscribe', requireWriteAccess, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const rows = await query(
    'SELECT email FROM contacts WHERE id=? AND tenant_id=? LIMIT 1',
    [id, req.auth!.tenantId],
  );
  if (!rows.length) return res.status(404).json({ error: 'not_found' });
  await addSuppression(req.auth!.tenantId!, rows[0].email, 'unsubscribe');
  await audit(req, 'contact.unsubscribe', { type: 'contact', id });
  res.json({ ok: true });
});

contactsRouter.delete('/:id', requireWriteAccess, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await query('DELETE FROM contacts WHERE id=? AND tenant_id=?', [id, req.auth!.tenantId]);
  if (!r.affectedRows) return res.status(404).json({ error: 'not_found' });
  await audit(req, 'contact.delete', { type: 'contact', id });
  res.json({ ok: true });
});
