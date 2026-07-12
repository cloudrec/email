import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { authMiddleware, requireTenant, requireWriteAccess } from '../middleware/auth.js';
import { audit } from '../middleware/audit.js';
import { redis } from '../redis.js';

export const websiteAnalysisRouter = Router();
websiteAnalysisRouter.use(authMiddleware, requireTenant);

const jobSchema = z.object({
  targetUrl: z.string().url().max(2000),
  leadId: z.number().int().positive().optional(),
  productProfileId: z.number().int().positive().optional(),
  language: z.enum(['en','ru','uk']).default('en'),
});

websiteAnalysisRouter.post('/jobs', requireWriteAccess, async (req, res) => {
  const parsed = jobSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });
  const p = parsed.data;

  let host: string;
  try { host = new URL(p.targetUrl).hostname.toLowerCase(); }
  catch { return res.status(400).json({ error: 'invalid_url' }); }

  if (p.leadId) {
    const owns = await query('SELECT id FROM discovered_leads WHERE id=? AND tenant_id=? LIMIT 1', [p.leadId, req.auth!.tenantId]);
    if (!owns.length) return res.status(404).json({ error: 'lead_not_found' });
  }
  if (p.productProfileId) {
    const owns = await query('SELECT id FROM tenant_product_profiles WHERE id=? AND tenant_id=? LIMIT 1', [p.productProfileId, req.auth!.tenantId]);
    if (!owns.length) return res.status(404).json({ error: 'profile_not_found' });
  }

  const r = await query(
    `INSERT INTO website_analysis_jobs
       (tenant_id, product_profile_id, target_url, target_domain, lead_id, language, triggered_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [req.auth!.tenantId, p.productProfileId ?? null, p.targetUrl, host, p.leadId ?? null, p.language, req.auth!.userId],
  );
  const id = Number(r.insertId);
  await redis.xadd('jobs:website-analysis', '*', 'jobId', String(id), 'tenantId', String(req.auth!.tenantId));
  await audit(req, 'website_analysis.job.create', { type: 'website_analysis_job', id }, { targetUrl: p.targetUrl });
  res.status(201).json({ id, status: 'queued' });
});

websiteAnalysisRouter.get('/jobs', async (req, res) => {
  const rows = await query(
    `SELECT id, target_url, target_domain, lead_id, language, status, pages_fetched, error,
            started_at, finished_at, created_at
     FROM website_analysis_jobs WHERE tenant_id=? ORDER BY created_at DESC LIMIT 200`,
    [req.auth!.tenantId],
  );
  res.json({ jobs: rows });
});

websiteAnalysisRouter.get('/results/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const rows = await query(
    `SELECT r.*, j.target_url, j.target_domain, j.language
     FROM website_analysis_results r
     JOIN website_analysis_jobs j ON j.id = r.job_id
     WHERE r.id=? AND r.tenant_id=? LIMIT 1`,
    [id, req.auth!.tenantId],
  );
  if (!rows.length) return res.status(404).json({ error: 'not_found' });
  res.json(rows[0]);
});

websiteAnalysisRouter.get('/results-by-job/:jobId', async (req, res) => {
  const jobId = parseInt(req.params.jobId, 10);
  const rows = await query(
    `SELECT r.*, j.target_url, j.target_domain
     FROM website_analysis_results r
     JOIN website_analysis_jobs j ON j.id = r.job_id
     WHERE r.job_id=? AND r.tenant_id=? LIMIT 1`,
    [jobId, req.auth!.tenantId],
  );
  if (!rows.length) return res.status(404).json({ error: 'not_found' });
  res.json(rows[0]);
});
