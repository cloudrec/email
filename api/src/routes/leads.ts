import { Router } from 'express';
import { z } from 'zod';
import { query, withConn } from '../db.js';
import { authMiddleware, requireTenant, requireWriteAccess } from '../middleware/auth.js';
import { audit } from '../middleware/audit.js';
import { redis } from '../redis.js';
import {
  getLeadLimits, incrementUsage,
  checkLeadsRoom, checkSourcesRoom, checkVerificationsRoom, checkExportAllowed,
} from '../services/leadLimits.js';
import { verifyEmail, recordVerification } from '../services/leadVerify.js';

export const leadsRouter = Router();
leadsRouter.use(authMiddleware, requireTenant);

// ---------- Limits + usage ----------
leadsRouter.get('/limits', async (req, res) => {
  res.json(await getLeadLimits(req.auth!.tenantId!));
});

// ---------- Lead sources ----------
const sourceCreate = z.object({
  url: z.string().url().max(2000),
  label: z.string().max(200).optional(),
});

leadsRouter.post('/sources', requireWriteAccess, async (req, res) => {
  const parsed = sourceCreate.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });

  const limits = await getLeadLimits(req.auth!.tenantId!);
  const check = checkSourcesRoom(limits, 1);
  if (!check.ok) return res.status(402).json({ error: check.reason, remaining: check.remaining });

  let host: string;
  try { host = new URL(parsed.data.url).hostname.toLowerCase(); }
  catch { return res.status(400).json({ error: 'invalid_url' }); }

  const r = await query(
    `INSERT INTO lead_sources (tenant_id, url, domain, label, added_by)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE label = COALESCE(VALUES(label), label), status='active'`,
    [req.auth!.tenantId, parsed.data.url, host, parsed.data.label ?? null, req.auth!.userId],
  );
  await incrementUsage(req.auth!.tenantId!, 'sources_added');
  await audit(req, 'lead.source.create', { type: 'lead_source', id: Number(r.insertId) }, { url: parsed.data.url });
  res.status(201).json({ id: Number(r.insertId), url: parsed.data.url, domain: host });
});

leadsRouter.get('/sources', async (req, res) => {
  const rows = await query(
    `SELECT id, url, domain, label, status, robots_allowed, last_crawled_at, created_at
     FROM lead_sources WHERE tenant_id=? ORDER BY created_at DESC LIMIT 500`,
    [req.auth!.tenantId],
  );
  res.json({ sources: rows });
});

leadsRouter.delete('/sources/:id', requireWriteAccess, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await query(
    "UPDATE lead_sources SET status='removed' WHERE id=? AND tenant_id=?",
    [id, req.auth!.tenantId],
  );
  if (!r.affectedRows) return res.status(404).json({ error: 'not_found' });
  await audit(req, 'lead.source.delete', { type: 'lead_source', id });
  res.json({ ok: true });
});

// ---------- Discovery jobs ----------
const jobCreate = z.object({
  sourceId: z.number().int().positive(),
  maxPages: z.number().int().min(1).max(20).default(5),
});

leadsRouter.post('/discovery-jobs', requireWriteAccess, async (req, res) => {
  const parsed = jobCreate.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });

  const limits = await getLeadLimits(req.auth!.tenantId!);
  if (!limits.enabled) return res.status(402).json({ error: 'lead_discovery_disabled' });
  const room = checkLeadsRoom(limits, 1);
  if (!room.ok) return res.status(402).json({ error: room.reason, remaining: room.remaining });

  const owns = await query(
    "SELECT id FROM lead_sources WHERE id=? AND tenant_id=? AND status='active' LIMIT 1",
    [parsed.data.sourceId, req.auth!.tenantId],
  );
  if (!owns.length) return res.status(404).json({ error: 'source_not_found' });

  const r = await query(
    `INSERT INTO discovery_jobs (tenant_id, source_id, max_pages, triggered_by)
     VALUES (?, ?, ?, ?)`,
    [req.auth!.tenantId, parsed.data.sourceId, parsed.data.maxPages, req.auth!.userId],
  );
  const id = Number(r.insertId);
  await redis.xadd('jobs:lead-discovery', '*', 'jobId', String(id), 'tenantId', String(req.auth!.tenantId));
  await audit(req, 'lead.job.create', { type: 'discovery_job', id }, { sourceId: parsed.data.sourceId, maxPages: parsed.data.maxPages });
  res.status(201).json({ id, status: 'queued' });
});

leadsRouter.get('/discovery-jobs', async (req, res) => {
  const rows = await query(
    `SELECT j.id, j.source_id, s.url AS source_url, s.domain AS source_domain,
            j.status, j.max_pages, j.pages_fetched, j.leads_found, j.leads_new,
            j.error, j.started_at, j.finished_at, j.created_at
     FROM discovery_jobs j
     LEFT JOIN lead_sources s ON s.id = j.source_id
     WHERE j.tenant_id=? ORDER BY j.created_at DESC LIMIT 200`,
    [req.auth!.tenantId],
  );
  res.json({ jobs: rows });
});

leadsRouter.post('/discovery-jobs/:id/cancel', requireWriteAccess, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await query(
    "UPDATE discovery_jobs SET status='canceled', finished_at=NOW() WHERE id=? AND tenant_id=? AND status IN ('queued','running')",
    [id, req.auth!.tenantId],
  );
  if (!r.affectedRows) return res.status(409).json({ error: 'cannot_cancel' });
  await audit(req, 'lead.job.cancel', { type: 'discovery_job', id });
  res.json({ ok: true });
});

// ---------- Leads list ----------
leadsRouter.get('/', async (req, res) => {
  // Clamp to finite, non-negative — `?limit=abc`/`?offset=-5` would otherwise bind
  // NaN/negative into LIMIT ? OFFSET ? and throw a SQL error (500).
  const limitRaw = Number(req.query.limit); const offsetRaw = Number(req.query.offset);
  const limit = Math.min(500, Math.max(1, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 100));
  const offset = Math.max(0, Number.isFinite(offsetRaw) ? Math.floor(offsetRaw) : 0);
  const status = req.query.status as string | undefined;
  const sourceId = req.query.sourceId ? parseInt(req.query.sourceId as string, 10) : null;

  const where = ['tenant_id=?'];
  const params: any[] = [req.auth!.tenantId];
  if (status)   { where.push('status=?');     params.push(status); }
  if (sourceId) { where.push('source_id=?');  params.push(sourceId); }
  params.push(limit, offset);

  const rows = await query(
    `SELECT id, email, email_domain, company_domain, source_url, page_title,
            context_snippet, role_hint, status, verification_score, last_verified_at,
            discovered_at, imported_at, imported_contact_id
     FROM discovered_leads WHERE ${where.join(' AND ')}
     ORDER BY discovered_at DESC LIMIT ? OFFSET ?`,
    params,
  );
  res.json({ leads: rows });
});

const patchLead = z.object({
  status: z.enum(['discovered','verified','invalid','risky','duplicate','suppressed','unsubscribed']).optional(),
  notes: z.string().max(1000).optional(),
});

leadsRouter.patch('/:id', requireWriteAccess, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const parsed = patchLead.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });

  const fields: string[] = [];
  const params: any[] = [];
  if (parsed.data.status) { fields.push('status=?'); params.push(parsed.data.status); }
  if (parsed.data.notes !== undefined) { fields.push('notes=?'); params.push(parsed.data.notes); }
  if (!fields.length) return res.status(400).json({ error: 'no_changes' });
  params.push(id, req.auth!.tenantId);

  const r = await query(
    `UPDATE discovered_leads SET ${fields.join(', ')} WHERE id=? AND tenant_id=?`,
    params,
  );
  if (!r.affectedRows) return res.status(404).json({ error: 'not_found' });
  await audit(req, 'lead.update', { type: 'lead', id }, parsed.data);
  res.json({ ok: true });
});

// ---------- Verification ----------
const verifyReq = z.object({
  leadIds: z.array(z.number().int().positive()).min(1).max(200),
});

leadsRouter.post('/verify', requireWriteAccess, async (req, res) => {
  const parsed = verifyReq.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });

  const limits = await getLeadLimits(req.auth!.tenantId!);
  const room = checkVerificationsRoom(limits, parsed.data.leadIds.length);
  if (!room.ok) return res.status(402).json({ error: room.reason, remaining: room.remaining });

  const placeholders = parsed.data.leadIds.map(() => '?').join(',');
  const rows = await query(
    `SELECT id, email FROM discovered_leads WHERE tenant_id=? AND id IN (${placeholders})`,
    [req.auth!.tenantId, ...parsed.data.leadIds],
  );

  const results: Array<{ leadId: number; email: string; result: string; score: number }> = [];
  for (const r of rows) {
    const v = await verifyEmail(r.email);
    await recordVerification(req.auth!.tenantId!, r.id, v);
    results.push({ leadId: r.id, email: r.email, result: v.result, score: v.score });
  }
  await incrementUsage(req.auth!.tenantId!, 'verifications', rows.length);
  await audit(req, 'lead.verify', undefined, { count: rows.length });
  res.json({ results });
});

// ---------- Import to contacts ----------
// Safety cap: default 500/batch (env-tunable). NO mass-subscribe path —
// imported contacts are always PENDING. Recommended first list <= 100.
const IMPORT_BATCH_CAP = Math.max(1, parseInt(process.env.IMPORT_BATCH_CAP ?? '500', 10));
const importReq = z.object({
  leadIds: z.array(z.number().int().positive()).min(1).max(IMPORT_BATCH_CAP),
  listId: z.number().int().positive().optional(),
  requireVerified: z.boolean().default(true),
});

leadsRouter.post('/import-to-contacts', requireWriteAccess, async (req, res) => {
  const parsed = importReq.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });

  const limits = await getLeadLimits(req.auth!.tenantId!);
  const xc = checkExportAllowed(limits);
  if (!xc.ok) return res.status(402).json({ error: xc.reason });

  if (parsed.data.listId) {
    const owns = await query(
      'SELECT id FROM lists WHERE id=? AND tenant_id=? LIMIT 1',
      [parsed.data.listId, req.auth!.tenantId],
    );
    if (!owns.length) return res.status(404).json({ error: 'list_not_found' });
  }

  const placeholders = parsed.data.leadIds.map(() => '?').join(',');
  // requireVerified=true → only verified. Either way, NEVER import known-bad
  // statuses (invalid/risky/suppressed/unsubscribed).
  const statusFilter = parsed.data.requireVerified
    ? "AND status='verified'"
    : "AND status NOT IN ('invalid','risky','suppressed','unsubscribed')";
  const leads = await query(
    `SELECT id, email, source_url, status FROM discovered_leads
     WHERE tenant_id=? AND id IN (${placeholders}) ${statusFilter}
       AND imported_contact_id IS NULL`,
    [req.auth!.tenantId, ...parsed.data.leadIds],
  );

  const jobRes = await query(
    `INSERT INTO lead_import_jobs
       (tenant_id, list_id, requested_count, status, started_at, triggered_by)
     VALUES (?, ?, ?, 'running', NOW(), ?)`,
    [req.auth!.tenantId, parsed.data.listId ?? null, parsed.data.leadIds.length, req.auth!.userId],
  );
  const jobId = Number(jobRes.insertId);

  let imported = 0;
  let skipped = 0;
  try {
    await withConn(async (c) => {
    for (const l of leads) {
      // Skip if suppressed: tenant suppressions OR global suppression
      // (email or sending domain) OR global do_not_contact.
      const email = l.email.toLowerCase();
      const emailDomain = email.split('@')[1] ?? '';
      const sup = await c.query(
        `SELECT 1 FROM suppressions WHERE tenant_id=? AND email=?
         UNION SELECT 1 FROM global_contact_suppression
           WHERE (type='email' AND normalized_value=?) OR (type='domain' AND normalized_value=?)
         LIMIT 1`,
        [req.auth!.tenantId, email, email, emailDomain],
      );
      if (sup.length) {
        await c.query("UPDATE discovered_leads SET status='suppressed' WHERE id=?", [l.id]);
        skipped++;
        continue;
      }

      // Insert contact in PENDING status (safety: no auto-mass-send).
      const ins = await c.query(
        `INSERT INTO contacts
           (tenant_id, email, status, consent_source, source_url, source_lead_id, consent_at)
         VALUES (?, ?, 'pending', 'lead_discovery', ?, ?, NULL)
         ON DUPLICATE KEY UPDATE
           source_url=COALESCE(VALUES(source_url), source_url),
           source_lead_id=COALESCE(VALUES(source_lead_id), source_lead_id)`,
        [req.auth!.tenantId, l.email.toLowerCase(), l.source_url, l.id],
      );
      let contactId: number;
      if (ins.insertId) {
        contactId = Number(ins.insertId);
      } else {
        const found = (await c.query('SELECT id FROM contacts WHERE tenant_id=? AND email=? LIMIT 1',
              [req.auth!.tenantId, l.email.toLowerCase()]))[0];
        if (!found) { skipped++; continue; }  // row vanished mid-race — don't deref undefined
        contactId = Number(found.id);
      }

      if (parsed.data.listId) {
        await c.query(
          'INSERT IGNORE INTO list_contacts (list_id, contact_id) VALUES (?, ?)',
          [parsed.data.listId, contactId],
        );
      }
      await c.query(
        "UPDATE discovered_leads SET status='imported', imported_at=NOW(), imported_contact_id=? WHERE id=?",
        [contactId, l.id],
      );
      imported++;
    }
  });
  } catch (e: any) {
    // Don't leave the job stuck in 'running' — mark it failed, then rethrow so
    // express-async-errors returns a 500.
    await query(
      "UPDATE lead_import_jobs SET status='failed', finished_at=NOW(), imported_count=?, skipped_count=? WHERE id=?",
      [imported, skipped, jobId],
    ).catch(() => {});
    throw e;
  }

  await query(
    `UPDATE lead_import_jobs SET status='succeeded', finished_at=NOW(),
       imported_count=?, skipped_count=? WHERE id=?`,
    [imported, skipped, jobId],
  );
  await incrementUsage(req.auth!.tenantId!, 'exports', imported);
  await audit(req, 'lead.import', { type: 'lead_import_job', id: jobId }, { imported, skipped, listId: parsed.data.listId ?? null });

  res.json({ jobId, imported, skipped, contactsStatus: 'pending', notice: 'Imported contacts are PENDING and not sendable until campaign approval per spec safety gate.' });
});

leadsRouter.get('/import-jobs', async (req, res) => {
  const rows = await query(
    `SELECT id, list_id, requested_count, imported_count, skipped_count, status, error, started_at, finished_at, created_at
     FROM lead_import_jobs WHERE tenant_id=? ORDER BY created_at DESC LIMIT 100`,
    [req.auth!.tenantId],
  );
  res.json({ jobs: rows });
});
