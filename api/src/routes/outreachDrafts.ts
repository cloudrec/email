import { Router } from 'express';
import { z } from 'zod';
import { query, withConn } from '../db.js';
import { authMiddleware, requireTenant, requireWriteAccess } from '../middleware/auth.js';
import { audit } from '../middleware/audit.js';
import { redis } from '../redis.js';
import { getProvider } from '../services/aiAdapter.js';
import './_registerAi.js';

export const outreachDraftsRouter = Router();
outreachDraftsRouter.use(authMiddleware, requireTenant);

const generateSchema = z.object({
  analysisResultId: z.number().int().positive(),
  productProfileId: z.number().int().positive(),
  leadId: z.number().int().positive().optional(),
  language: z.enum(['en','ru','uk']).default('en'),
  tone: z.enum(['neutral','friendly','professional','short_direct']).default('neutral'),
  provider: z.string().max(40).default('internal'),
  tenantNote: z.string().max(1000).optional(),
});

outreachDraftsRouter.post('/generate', requireWriteAccess, async (req, res) => {
  const parsed = generateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', detail: parsed.error.flatten() });
  const p = parsed.data;

  const results = await query(
    `SELECT * FROM website_analysis_results WHERE id=? AND tenant_id=? LIMIT 1`,
    [p.analysisResultId, req.auth!.tenantId],
  );
  if (!results.length) return res.status(404).json({ error: 'analysis_result_not_found' });
  const result = results[0];

  const profiles = await query(
    'SELECT * FROM tenant_product_profiles WHERE id=? AND tenant_id=? LIMIT 1',
    [p.productProfileId, req.auth!.tenantId],
  );
  if (!profiles.length) return res.status(404).json({ error: 'profile_not_found' });
  const profile = profiles[0];

  const provider = getProvider(p.provider);
  const gen = await provider.generate({
    facts: {
      domain: '',
      companyName: result.company_name,
      industry: result.industry,
      businessType: result.business_type,
      offeringSummary: result.offering_summary,
      painPoints: parseJson(result.pain_points, []),
      pageTitles: parseJson(result.page_titles, []),
      sourceUrls: parseJson(result.source_urls, []),
      languageDetected: (result.language_detected ?? 'other') as any,
    },
    product: {
      name: profile.name,
      productUrl: profile.product_url,
      description: profile.description,
      targetCustomer: profile.target_customer,
      keyBenefits: parseJson(profile.key_benefits, []),
      allowedClaims: parseJson(profile.allowed_claims, []),
      forbiddenClaims: parseJson(profile.forbidden_claims, []),
      preferredTone: profile.preferred_tone,
      defaultLanguage: profile.default_language,
    },
    language: p.language,
    tone: p.tone,
    tenantNote: p.tenantNote,
  });

  // Create draft + first version atomically.
  const draftId = await withConn(async (c) => {
    await c.beginTransaction();
    try {
      const d = await c.query(
        `INSERT INTO outreach_drafts
           (tenant_id, product_profile_id, analysis_result_id, lead_id, status,
            approval_required, language, tone, created_by)
         VALUES (?, ?, ?, ?, 'pending_review', 1, ?, ?, ?)`,
        [
          req.auth!.tenantId, p.productProfileId, p.analysisResultId, p.leadId ?? null,
          p.language, p.tone, req.auth!.userId,
        ],
      );
      const did = Number(d.insertId);
      const v = await c.query(
        `INSERT INTO outreach_draft_versions
           (tenant_id, draft_id, version_no, generator, subject_options, email_short, email_long,
            follow_up, personalization_points, risks_or_uncertainties, confidence_score, cited_facts,
            ai_prompt_hash, created_by)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          req.auth!.tenantId, did, gen.generator,
          JSON.stringify(gen.subject_options), gen.email_short, gen.email_long, gen.follow_up,
          JSON.stringify(gen.personalization_points), JSON.stringify(gen.risks_or_uncertainties),
          gen.confidence_score, JSON.stringify(gen.cited_facts), gen.ai_prompt_hash, req.auth!.userId,
        ],
      );
      const vid = Number(v.insertId);
      await c.query('UPDATE outreach_drafts SET current_version_id=? WHERE id=?', [vid, did]);
      await c.query(
        `INSERT INTO outreach_approval_events
           (tenant_id, draft_id, draft_version_id, event, actor_user_id, metadata)
         VALUES (?, ?, ?, 'generated', ?, ?)`,
        [req.auth!.tenantId, did, vid, req.auth!.userId, JSON.stringify({ generator: gen.generator, confidence: gen.confidence_score })],
      );
      await c.commit();
      return did;
    } catch (e) {
      await c.rollback();
      throw e;
    }
  });

  await audit(req, 'outreach.draft.generate', { type: 'outreach_draft', id: draftId }, {
    generator: gen.generator, confidence: gen.confidence_score, language: p.language, tone: p.tone,
  });
  res.status(201).json({ draftId, generation: gen });
});

outreachDraftsRouter.get('/', async (req, res) => {
  const status = req.query.status as string | undefined;
  const where = ['d.tenant_id=?'];
  const params: any[] = [req.auth!.tenantId];
  if (status) { where.push('d.status=?'); params.push(status); }

  const rows = await query(
    `SELECT d.id, d.status, d.language, d.tone, d.lead_id, d.product_profile_id, d.analysis_result_id,
            d.approved_at, d.approved_by, d.rejected_at, d.rejected_by, d.rejection_reason,
            d.test_sent_at, d.test_sent_to, d.campaign_id, d.created_at, d.updated_at,
            v.version_no, v.confidence_score, v.subject_options
     FROM outreach_drafts d
     LEFT JOIN outreach_draft_versions v ON v.id = d.current_version_id
     WHERE ${where.join(' AND ')}
     ORDER BY d.created_at DESC LIMIT 200`,
    params,
  );
  res.json({ drafts: rows });
});

outreachDraftsRouter.get('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const rows = await query(
    `SELECT d.*, v.subject_options, v.email_short, v.email_long, v.follow_up,
            v.personalization_points, v.risks_or_uncertainties, v.confidence_score, v.cited_facts,
            v.version_no, v.generator
     FROM outreach_drafts d
     LEFT JOIN outreach_draft_versions v ON v.id = d.current_version_id
     WHERE d.id=? AND d.tenant_id=? LIMIT 1`,
    [id, req.auth!.tenantId],
  );
  if (!rows.length) return res.status(404).json({ error: 'not_found' });
  const events = await query(
    `SELECT id, event, actor_user_id, recipient_email, reason, metadata, occurred_at
     FROM outreach_approval_events
     WHERE draft_id=? AND tenant_id=? ORDER BY occurred_at ASC`,
    [id, req.auth!.tenantId],
  );
  res.json({ draft: rows[0], events });
});

const patchSchema = z.object({
  subjectOptions: z.array(z.string().min(1).max(500)).max(10).optional(),
  emailShort: z.string().max(20000).optional(),
  emailLong: z.string().max(50000).optional(),
  followUp: z.string().max(20000).nullable().optional(),
});

outreachDraftsRouter.patch('/:id', requireWriteAccess, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });

  const drafts = await query(
    `SELECT d.*, v.* FROM outreach_drafts d
     LEFT JOIN outreach_draft_versions v ON v.id = d.current_version_id
     WHERE d.id=? AND d.tenant_id=? LIMIT 1`,
    [id, req.auth!.tenantId],
  );
  if (!drafts.length) return res.status(404).json({ error: 'not_found' });
  if (drafts[0].status === 'sent') return res.status(409).json({ error: 'cannot_edit_sent_draft' });

  const head = drafts[0];
  const next = {
    subject_options: parsed.data.subjectOptions !== undefined
      ? JSON.stringify(parsed.data.subjectOptions)
      : head.subject_options,
    email_short: parsed.data.emailShort ?? head.email_short,
    email_long:  parsed.data.emailLong  ?? head.email_long,
    follow_up:   parsed.data.followUp !== undefined ? parsed.data.followUp : head.follow_up,
  };

  await withConn(async (c) => {
    await c.beginTransaction();
    try {
      const maxV = await c.query('SELECT COALESCE(MAX(version_no), 0) AS m FROM outreach_draft_versions WHERE draft_id=?', [id]);
      const nextV = Number(maxV[0].m) + 1;
      const v = await c.query(
        `INSERT INTO outreach_draft_versions
           (tenant_id, draft_id, version_no, generator, subject_options, email_short, email_long,
            follow_up, personalization_points, risks_or_uncertainties, confidence_score, cited_facts,
            created_by)
         VALUES (?, ?, ?, 'human_edit', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          req.auth!.tenantId, id, nextV, next.subject_options, next.email_short, next.email_long,
          next.follow_up, head.personalization_points, head.risks_or_uncertainties,
          head.confidence_score, head.cited_facts, req.auth!.userId,
        ],
      );
      const vid = Number(v.insertId);
      await c.query("UPDATE outreach_drafts SET current_version_id=?, status='pending_review' WHERE id=?", [vid, id]);
      await c.query(
        `INSERT INTO outreach_approval_events (tenant_id, draft_id, draft_version_id, event, actor_user_id)
         VALUES (?, ?, ?, 'edited', ?)`,
        [req.auth!.tenantId, id, vid, req.auth!.userId],
      );
      await c.commit();
    } catch (e) { await c.rollback(); throw e; }
  });

  await audit(req, 'outreach.draft.edit', { type: 'outreach_draft', id });
  res.json({ ok: true });
});

outreachDraftsRouter.post('/:id/approve', requireWriteAccess, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const drafts = await query(
    'SELECT id, status, current_version_id, lead_id, campaign_id FROM outreach_drafts WHERE id=? AND tenant_id=? LIMIT 1',
    [id, req.auth!.tenantId],
  );
  if (!drafts.length) return res.status(404).json({ error: 'not_found' });
  if (drafts[0].status === 'sent') return res.status(409).json({ error: 'already_sent' });

  await query(
    `UPDATE outreach_drafts
       SET status='approved', approved_at=NOW(), approved_by=?
     WHERE id=? AND tenant_id=?`,
    [req.auth!.userId, id, req.auth!.tenantId],
  );
  await query(
    `INSERT INTO outreach_approval_events
       (tenant_id, draft_id, draft_version_id, event, actor_user_id, lead_id, campaign_id)
     VALUES (?, ?, ?, 'approved', ?, ?, ?)`,
    [req.auth!.tenantId, id, drafts[0].current_version_id, req.auth!.userId, drafts[0].lead_id, drafts[0].campaign_id],
  );
  await audit(req, 'outreach.draft.approve', { type: 'outreach_draft', id });
  res.json({ ok: true, status: 'approved' });
});

const rejectSchema = z.object({ reason: z.string().max(1000).optional() });

outreachDraftsRouter.post('/:id/reject', requireWriteAccess, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const parsed = rejectSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });

  const drafts = await query(
    'SELECT id, current_version_id FROM outreach_drafts WHERE id=? AND tenant_id=? LIMIT 1',
    [id, req.auth!.tenantId],
  );
  if (!drafts.length) return res.status(404).json({ error: 'not_found' });

  await query(
    `UPDATE outreach_drafts SET status='rejected', rejected_at=NOW(), rejected_by=?, rejection_reason=?
     WHERE id=? AND tenant_id=?`,
    [req.auth!.userId, parsed.data.reason ?? null, id, req.auth!.tenantId],
  );
  await query(
    `INSERT INTO outreach_approval_events
       (tenant_id, draft_id, draft_version_id, event, actor_user_id, reason)
     VALUES (?, ?, ?, 'rejected', ?, ?)`,
    [req.auth!.tenantId, id, drafts[0].current_version_id, req.auth!.userId, parsed.data.reason ?? null],
  );
  await audit(req, 'outreach.draft.reject', { type: 'outreach_draft', id }, { reason: parsed.data.reason });
  res.json({ ok: true, status: 'rejected' });
});

const testSchema = z.object({ to: z.string().email() });

outreachDraftsRouter.post('/:id/send-test', requireWriteAccess, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const parsed = testSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });

  const drafts = await query(
    `SELECT d.id, d.status, d.current_version_id, v.subject_options, v.email_short
     FROM outreach_drafts d
     JOIN outreach_draft_versions v ON v.id = d.current_version_id
     WHERE d.id=? AND d.tenant_id=? LIMIT 1`,
    [id, req.auth!.tenantId],
  );
  if (!drafts.length) return res.status(404).json({ error: 'not_found' });

  // Queue test send via existing test stream consumed by worker.
  await redis.xadd(
    'send:test-outreach', '*',
    'draftId', String(id),
    'tenantId', String(req.auth!.tenantId),
    'to', parsed.data.to,
  );
  await query(
    `UPDATE outreach_drafts SET status='sent_test', test_sent_at=NOW(), test_sent_to=? WHERE id=? AND tenant_id=?`,
    [parsed.data.to, id, req.auth!.tenantId],
  );
  await query(
    `INSERT INTO outreach_approval_events
       (tenant_id, draft_id, draft_version_id, event, actor_user_id, recipient_email)
     VALUES (?, ?, ?, 'test_sent', ?, ?)`,
    [req.auth!.tenantId, id, drafts[0].current_version_id, req.auth!.userId, parsed.data.to],
  );
  await audit(req, 'outreach.draft.send_test', { type: 'outreach_draft', id }, { to: parsed.data.to });
  res.json({ ok: true, queued: true });
});

function parseJson<T>(value: any, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value as T;
  try { return JSON.parse(value); } catch { return fallback; }
}
