import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { authMiddleware, requireTenant, requireWriteAccess } from '../middleware/auth.js';
import { audit } from '../middleware/audit.js';

export const listsRouter = Router();
listsRouter.use(authMiddleware, requireTenant);

listsRouter.get('/', async (req, res) => {
  const rows = await query(
    `SELECT id, name, description, contact_count, created_at
     FROM lists WHERE tenant_id=? ORDER BY created_at DESC LIMIT 200`,
    [req.auth!.tenantId],
  );
  res.json({ lists: rows });
});

listsRouter.get('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const [lst] = await query(
    'SELECT id, name, description, contact_count, created_at FROM lists WHERE id=? AND tenant_id=? LIMIT 1',
    [id, req.auth!.tenantId],
  );
  if (!lst) return res.status(404).json({ error: 'not_found' });

  const contacts = await query(
    `SELECT c.id, c.email, c.first_name, c.last_name, c.status
     FROM list_contacts lc JOIN contacts c ON c.id=lc.contact_id
     WHERE lc.list_id=? AND c.tenant_id=?
     ORDER BY lc.created_at DESC LIMIT 200`,
    [id, req.auth!.tenantId],
  );
  res.json({ list: lst, contacts });
});

const createSchema = z.object({
  name:        z.string().min(1).max(160),
  description: z.string().max(500).optional(),
});

listsRouter.post('/', requireWriteAccess, async (req, res) => {
  const p = createSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'invalid_body' });
  const r = await query(
    'INSERT INTO lists (tenant_id, name, description) VALUES (?, ?, ?)',
    [req.auth!.tenantId, p.data.name, p.data.description ?? null],
  );
  const id = Number(r.insertId);
  await audit(req, 'list.create', { type: 'list', id });
  res.status(201).json({ id, name: p.data.name });
});

// Build list from warehouse contact_points — applies all suppression filters
const warehouseImportSchema = z.object({
  name:          z.string().min(1).max(160),
  industry:      z.string().max(80).optional(),
  country:       z.string().max(2).optional(),
  productFit:    z.string().max(80).optional(),
  contactType:   z.enum(['email','phone','telegram','whatsapp']).default('email'),
  minScore:      z.coerce.number().min(0).max(100).default(0),
  limit:         z.coerce.number().int().min(1).max(5000).default(500),
  dryRun:        z.boolean().default(false),
});

listsRouter.post('/from-warehouse', requireWriteAccess, async (req, res) => {
  const p = warehouseImportSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'invalid_body', detail: p.error.issues });

  // Build filters
  const wheres: string[] = [
    "cp.type=?",
    "cp.status NOT IN ('do_not_contact','legal_deleted','bounced','complained','unsubscribed','suppressed')",
    "co.status NOT IN ('suppressed','legal_deleted')",
    "NOT EXISTS (SELECT 1 FROM global_contact_suppression gcs WHERE gcs.type=cp.type AND gcs.normalized_value=cp.normalized_value)",
  ];
  const params: any[] = [p.data.contactType];

  if (p.data.country) {
    wheres.push('co.country=?');
    params.push(p.data.country);
  }
  if (p.data.industry) {
    wheres.push(`EXISTS (SELECT 1 FROM company_industries ci2 JOIN industry_taxonomy it2 ON it2.id=ci2.industry_id WHERE ci2.company_id=co.id AND it2.slug=?)`);
    params.push(p.data.industry);
  }
  if (p.data.productFit) {
    wheres.push(`EXISTS (SELECT 1 FROM company_product_fit cpf WHERE cpf.company_id=co.id AND cpf.product_key=? AND cpf.status='good_fit')`);
    params.push(p.data.productFit);
  }
  if (p.data.minScore > 0) {
    wheres.push('cp.verification_score >= ?');
    params.push(p.data.minScore);
  }

  const where = wheres.join(' AND ');

  // Count eligible
  const [countRow] = await query(
    `SELECT COUNT(*) AS c FROM contact_points cp JOIN companies co ON co.id=cp.company_id WHERE ${where}`,
    params,
  );
  const eligible = Number(countRow.c);

  if (p.data.dryRun) {
    return res.json({
      dryRun: true, eligible, wouldImport: Math.min(eligible, p.data.limit),
      filters: { industry: p.data.industry, country: p.data.country, productFit: p.data.productFit },
    });
  }

  // Fetch eligible contact points
  const points = await query(
    `SELECT cp.id AS cpId, cp.normalized_value AS email, co.name AS company_name, co.canonical_domain
     FROM contact_points cp JOIN companies co ON co.id=cp.company_id
     WHERE ${where} ORDER BY cp.last_seen_at DESC LIMIT ?`,
    [...params, p.data.limit],
  );

  if (!points.length) return res.json({ ok: true, listId: null, imported: 0, message: 'No eligible contacts found.' });

  // Create list
  const listR = await query(
    'INSERT INTO lists (tenant_id, name, description) VALUES (?, ?, ?)',
    [req.auth!.tenantId, p.data.name, `Built from warehouse. Industry: ${p.data.industry ?? 'any'}, Country: ${p.data.country ?? 'any'}, Fit: ${p.data.productFit ?? 'any'}`],
  );
  const listId = Number(listR.insertId);

  // Import contacts — find or create in contacts table, then add to list
  let imported = 0;
  let blocked = 0;
  for (const pt of points) {
    try {
      // Upsert into contacts table (pending status — never auto-subscribed)
      const cr = await query(
        `INSERT INTO contacts (tenant_id, email, status, source_url)
         VALUES (?, ?, 'pending', ?)
         ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`,
        [req.auth!.tenantId, pt.email, `warehouse:${pt.canonical_domain}`],
      );
      const contactId = Number(cr.insertId);

      // Check suppression on contacts table
      const [existing] = await query(
        "SELECT id, status FROM contacts WHERE id=? LIMIT 1",
        [contactId],
      );
      if (existing && ['unsubscribed','bounced','complained','suppressed'].includes(existing.status)) {
        blocked++;
        continue;
      }

      await query(
        'INSERT IGNORE INTO list_contacts (list_id, contact_id) VALUES (?, ?)',
        [listId, contactId],
      );
      imported++;
    } catch {
      blocked++;
    }
  }

  await query('UPDATE lists SET contact_count=? WHERE id=?', [imported, listId]);
  await audit(req, 'list.create_from_warehouse', { type: 'list', id: listId }, { imported, blocked, eligible });

  res.status(201).json({
    ok: true, listId, name: p.data.name,
    imported, blocked, eligible,
    note: 'Contacts imported as PENDING. They will not be sent to until subscribed or included in an approved campaign.',
  });
});

listsRouter.delete('/:id', requireWriteAccess, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await query('DELETE FROM lists WHERE id=? AND tenant_id=?', [id, req.auth!.tenantId]);
  if (!r.affectedRows) return res.status(404).json({ error: 'not_found' });
  await audit(req, 'list.delete', { type: 'list', id });
  res.json({ ok: true });
});
