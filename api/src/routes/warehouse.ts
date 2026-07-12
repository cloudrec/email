import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { authMiddleware, requireTenant, requireSuperAdmin, requireWriteAccess } from '../middleware/auth.js';
import { audit } from '../middleware/audit.js';
import { ingestUrl, backfillAll } from '../services/leadWarehouse.js';
import {
  fitLabelFromScore, fitScore100, buildFitReasons, productLabel, parseLeadQuery,
} from '../services/leadIntel.js';

export const warehouseRouter = Router();
warehouseRouter.use(authMiddleware, requireTenant);

// ── Shared company filter builder (used by /companies and /search) ───────────
interface CompanyFilters {
  industry?: string;
  country?: string;
  city?: string;
  status?: string;
  productFit?: string;     // "key" or "key:status"
  hasWebsite?: boolean;
  hasEmail?: boolean;
  pains?: string[];        // detected_pains tokens to require (ANY of)
  minScore?: number;       // 0..1 best fit
  q?: string;
}

function buildCompanyWheres(f: CompanyFilters): { where: string; params: any[] } {
  const wheres: string[] = ["c.status != 'legal_deleted'"];
  const params: any[] = [];

  if (f.country) { wheres.push('c.country=?'); params.push(f.country); }
  if (f.city)    { wheres.push('c.city LIKE ?'); params.push(`%${f.city}%`); }
  if (f.status)  { wheres.push('c.status=?'); params.push(f.status); }
  if (f.q)       { wheres.push('(c.canonical_domain LIKE ? OR c.name LIKE ?)'); params.push(`%${f.q}%`, `%${f.q}%`); }
  if (f.industry) {
    wheres.push('EXISTS (SELECT 1 FROM company_industries ci2 JOIN industry_taxonomy it2 ON it2.id=ci2.industry_id WHERE ci2.company_id=c.id AND it2.slug=?)');
    params.push(f.industry);
  }
  if (f.productFit) {
    const [pk, ps] = f.productFit.split(':');
    wheres.push('EXISTS (SELECT 1 FROM company_product_fit cpf WHERE cpf.company_id=c.id AND cpf.product_key=? AND cpf.status=?)');
    params.push(pk, ps ?? 'good_fit');
  }
  if (f.hasWebsite === true) {
    wheres.push("EXISTS (SELECT 1 FROM company_websites cw WHERE cw.company_id=c.id AND cw.status='active')");
  } else if (f.hasWebsite === false) {
    wheres.push("NOT EXISTS (SELECT 1 FROM company_websites cw WHERE cw.company_id=c.id AND cw.status='active')");
  }
  if (f.hasEmail === true) {
    wheres.push("EXISTS (SELECT 1 FROM contact_points cp WHERE cp.company_id=c.id AND cp.type='email' AND cp.status NOT IN ('do_not_contact','legal_deleted'))");
  } else if (f.hasEmail === false) {
    wheres.push("NOT EXISTS (SELECT 1 FROM contact_points cp WHERE cp.company_id=c.id AND cp.type='email' AND cp.status NOT IN ('do_not_contact','legal_deleted'))");
  }
  if (f.pains && f.pains.length) {
    const ors = f.pains.map(() => 'cpf2.detected_pains_json LIKE ?');
    wheres.push(`EXISTS (SELECT 1 FROM company_product_fit cpf2 WHERE cpf2.company_id=c.id AND (${ors.join(' OR ')}))`);
    for (const p of f.pains) params.push(`%"${p}"%`);
  }
  if (f.minScore != null) {
    wheres.push('EXISTS (SELECT 1 FROM company_product_fit cpf3 WHERE cpf3.company_id=c.id AND cpf3.fit_score >= ?)');
    params.push(f.minScore);
  }

  return { where: wheres.join(' AND '), params };
}

const COMPANY_SELECT = `c.id, c.canonical_domain, c.name, c.country, c.city, c.category_primary, c.category_secondary,
        c.status, c.source_count, c.first_seen_at, c.last_seen_at,
        (SELECT COUNT(*) FROM contact_points cp WHERE cp.company_id=c.id AND cp.status NOT IN ('do_not_contact','legal_deleted')) AS contact_count,
        (SELECT COUNT(*) FROM contact_points cp WHERE cp.company_id=c.id AND cp.type='email' AND cp.status NOT IN ('do_not_contact','legal_deleted')) AS email_count,
        (SELECT COUNT(*) FROM company_websites cw WHERE cw.company_id=c.id AND cw.status='active') AS website_count,
        (SELECT GROUP_CONCAT(it.slug ORDER BY ci.is_primary DESC, ci.confidence DESC SEPARATOR ',') FROM company_industries ci JOIN industry_taxonomy it ON it.id=ci.industry_id WHERE ci.company_id=c.id LIMIT 5) AS industries,
        (SELECT fit_score FROM company_product_fit cpf WHERE cpf.company_id=c.id ORDER BY cpf.fit_score DESC LIMIT 1) AS best_fit_score,
        (SELECT product_key FROM company_product_fit cpf WHERE cpf.company_id=c.id ORDER BY cpf.fit_score DESC LIMIT 1) AS best_fit_product,
        (SELECT fit_reason FROM company_product_fit cpf WHERE cpf.company_id=c.id ORDER BY cpf.fit_score DESC LIMIT 1) AS best_fit_reason,
        (SELECT detected_pains_json FROM company_product_fit cpf WHERE cpf.company_id=c.id ORDER BY cpf.fit_score DESC LIMIT 1) AS best_fit_pains`;

// Decorate a raw company row with fit label / 0-100 score / readable reasons.
function decorateCompany(row: any) {
  const score = row.best_fit_score != null ? Number(row.best_fit_score) : null;
  return {
    ...row,
    best_fit_score: score,
    fit_score_100: fitScore100(score),
    fit_label: fitLabelFromScore(score),
    fit_product_label: productLabel(row.best_fit_product),
    fit_reasons: buildFitReasons({
      productKey: row.best_fit_product,
      fitScore: score,
      fitReason: row.best_fit_reason,
      detectedPains: row.best_fit_pains,
      hasEmail: Number(row.email_count) > 0,
      hasWebsite: Number(row.website_count) > 0,
      industrySlugs: row.industries ? String(row.industries).split(',') : [],
    }),
  };
}

// ── GET /warehouse/industries ──────────────────────────────────────────────
warehouseRouter.get('/industries', async (_req, res) => {
  const rows = await query(
    `SELECT id, parent_id, slug, name_en, name_ru, name_uk FROM industry_taxonomy ORDER BY parent_id IS NULL DESC, slug ASC`,
    [],
  );
  res.json({ industries: rows });
});

// ── GET /warehouse/stats ───────────────────────────────────────────────────
warehouseRouter.get('/stats', async (req, res) => {
  const [coRow] = await query('SELECT COUNT(*) AS c FROM companies WHERE status != \'legal_deleted\'', []);
  const [cwRow] = await query('SELECT COUNT(*) AS c FROM company_websites WHERE status = \'active\'', []);
  const [cpRow] = await query('SELECT COUNT(*) AS c FROM contact_points WHERE status NOT IN (\'do_not_contact\',\'legal_deleted\')', []);
  const [emailRow] = await query('SELECT COUNT(*) AS c FROM contact_points WHERE type=\'email\' AND status NOT IN (\'do_not_contact\',\'legal_deleted\')', []);
  const [gcsRow] = await query('SELECT COUNT(*) AS c FROM global_contact_suppression', []);
  const [itRow] = await query('SELECT COUNT(*) AS c FROM industry_taxonomy', []);
  const [fitRow] = await query('SELECT COUNT(*) AS c FROM company_product_fit WHERE status IN (\'good_fit\',\'weak_fit\')', []);
  res.json({
    companies: Number(coRow.c),
    websites: Number(cwRow.c),
    contactPoints: Number(cpRow.c),
    emails: Number(emailRow.c),
    globalSuppressions: Number(gcsRow.c),
    industryTaxonomyEntries: Number(itRow.c),
    productFitsScored: Number(fitRow.c),
  });
});

// ── GET /warehouse/companies ───────────────────────────────────────────────
const companyQuerySchema = z.object({
  page:       z.coerce.number().int().min(1).default(1),
  limit:      z.coerce.number().int().min(1).max(200).default(50),
  industry:   z.string().max(80).optional(),
  country:    z.string().max(2).optional(),
  city:       z.string().max(100).optional(),
  status:     z.string().max(30).optional(),
  productFit: z.string().max(40).optional(),
  hasWebsite: z.enum(['true', 'false']).optional(),
  hasEmail:   z.enum(['true', 'false']).optional(),
  minScore:   z.coerce.number().min(0).max(1).optional(),
  sort:       z.enum(['recent', 'fit']).default('recent'),
  q:          z.string().max(200).optional(),
});

async function runCompanyQuery(f: CompanyFilters, page: number, limit: number, sort: 'recent' | 'fit') {
  const { where, params } = buildCompanyWheres(f);
  const offset = (page - 1) * limit;
  const [countRow] = await query(`SELECT COUNT(*) AS c FROM companies c WHERE ${where}`, params);
  const order = sort === 'fit'
    ? 'best_fit_score DESC, c.last_seen_at DESC'
    : 'c.last_seen_at DESC';
  const rows = await query(
    `SELECT ${COMPANY_SELECT} FROM companies c WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  return { total: Number(countRow.c), companies: rows.map(decorateCompany) };
}

warehouseRouter.get('/companies', async (req, res) => {
  const p = companyQuerySchema.safeParse(req.query);
  if (!p.success) return res.status(400).json({ error: 'invalid_query' });
  const { page, limit, sort, hasWebsite, hasEmail, ...rest } = p.data;
  const filters: CompanyFilters = {
    ...rest,
    hasWebsite: hasWebsite === undefined ? undefined : hasWebsite === 'true',
    hasEmail:   hasEmail === undefined ? undefined : hasEmail === 'true',
  };
  const result = await runCompanyQuery(filters, page, limit, sort);
  res.json({ ...result, page, limit });
});

// ── POST /warehouse/search — natural-language lead search ────────────────────
const searchSchema = z.object({
  q:     z.string().max(500).default(''),
  page:  z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

warehouseRouter.post('/search', async (req, res) => {
  const p = searchSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'invalid_body' });
  const parsed = parseLeadQuery(p.data.q);
  const result = await runCompanyQuery(parsed.filters, p.data.page, p.data.limit, 'fit');
  res.json({
    ...result,
    page: p.data.page,
    limit: p.data.limit,
    query: p.data.q,
    interpreted: parsed.interpreted,
    filters: parsed.filters,
    parser: parsed.parser,
  });
});

// ── GET /warehouse/companies/:id ───────────────────────────────────────────
warehouseRouter.get('/companies/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'invalid_id' });

  const [company] = await query(
    `SELECT c.*,
      (SELECT GROUP_CONCAT(it.slug ORDER BY ci.is_primary DESC SEPARATOR ',') FROM company_industries ci JOIN industry_taxonomy it ON it.id=ci.industry_id WHERE ci.company_id=c.id) AS industry_slugs
     FROM companies c WHERE c.id=? AND c.status != 'legal_deleted' LIMIT 1`,
    [id],
  );
  if (!company) return res.status(404).json({ error: 'not_found' });

  const websites = await query(
    'SELECT id, url, domain, page_title, status, source_provider, first_seen_at, analyzed_at FROM company_websites WHERE company_id=? ORDER BY first_seen_at DESC LIMIT 50',
    [id],
  );
  const contacts = await query(
    `SELECT cp.id, cp.type, cp.value, cp.normalized_value, cp.email_domain, cp.role_type,
            cp.status, cp.verification_score, cp.source_url, cp.first_seen_at, cp.last_seen_at,
            (SELECT preference_status FROM contact_product_preferences cpp WHERE cpp.contact_point_id=cp.id ORDER BY cpp.updated_at DESC LIMIT 1) AS latest_preference
     FROM contact_points cp WHERE cp.company_id=? ORDER BY cp.first_seen_at DESC LIMIT 100`,
    [id],
  );
  const fits = await query(
    'SELECT product_key, fit_score, confidence, status, fit_reason, detected_pains_json, recommended_angle FROM company_product_fit WHERE company_id=? ORDER BY fit_score DESC',
    [id],
  );
  const industries = await query(
    `SELECT it.slug, it.name_en, it.name_ru, it.name_uk, ci.confidence, ci.source, ci.is_primary
     FROM company_industries ci JOIN industry_taxonomy it ON it.id=ci.industry_id WHERE ci.company_id=? ORDER BY ci.is_primary DESC, ci.confidence DESC`,
    [id],
  );

  // Operator notes (tenant-scoped)
  const notes = await query(
    `SELECT id, note, status, created_by_user_id, created_at
     FROM tenant_contact_notes WHERE tenant_id=? AND company_id=? ORDER BY created_at DESC LIMIT 50`,
    [req.auth!.tenantId, id],
  );

  // Source history (recent warehouse events)
  const events = await query(
    `SELECT event_type, metadata_json, created_at FROM lead_warehouse_events
     WHERE company_id=? ORDER BY created_at DESC LIMIT 30`,
    [id],
  );

  // Drafts linked to this company's domain (via website analysis jobs on this domain)
  const drafts = await query(
    `SELECT od.id, od.status, od.language, od.tone, od.created_at, od.test_sent_at
     FROM outreach_drafts od
     JOIN website_analysis_jobs waj ON waj.id = (
       SELECT job_id FROM website_analysis_results war WHERE war.id = od.analysis_result_id)
     WHERE od.tenant_id=? AND waj.target_domain=?
     ORDER BY od.created_at DESC LIMIT 20`,
    [req.auth!.tenantId, company.canonical_domain],
  ).catch(() => []);

  // Build "why this company is a match" from the best fit row + signals
  const bestFit = fits[0] ?? null;
  const emailCount = contacts.filter((c: any) => c.type === 'email').length;
  const whyMatch = buildFitReasons({
    productKey: bestFit?.product_key,
    fitScore: bestFit ? Number(bestFit.fit_score) : null,
    fitReason: bestFit?.fit_reason,
    detectedPains: bestFit?.detected_pains_json,
    hasEmail: emailCount > 0,
    hasWebsite: websites.some((w: any) => w.status === 'active'),
    industrySlugs: industries.map((i: any) => i.slug),
  });
  const fitSummary = bestFit ? {
    product_key: bestFit.product_key,
    product_label: productLabel(bestFit.product_key),
    fit_score_100: fitScore100(Number(bestFit.fit_score)),
    fit_label: fitLabelFromScore(Number(bestFit.fit_score)),
  } : null;

  // Safety status snapshot
  const [supp] = await query(
    `SELECT COUNT(*) AS c FROM contact_points cp
     WHERE cp.company_id=? AND cp.status IN ('do_not_contact','bounced','complained','unsubscribed','legal_deleted')`,
    [id],
  );
  const safety = {
    suppressed_contacts: Number(supp.c),
    sendable: false, // Warehouse contacts are never directly sendable (must go via reviewed list)
    note: 'Warehouse contacts are not addressable. Build a reviewed list to contact.',
  };

  res.json({ company, websites, contacts, fits, industries, notes, events, drafts, whyMatch, fitSummary, safety });
});

// ── POST /warehouse/companies/:id/note ───────────────────────────────────────
const noteSchema = z.object({
  note:   z.string().min(1).max(4000),
  status: z.string().max(60).optional(),
});

warehouseRouter.post('/companies/:id/note', requireWriteAccess, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const p = noteSchema.safeParse(req.body);
  if (!p.success || !id) return res.status(400).json({ error: 'invalid_body' });
  const [co] = await query("SELECT id FROM companies WHERE id=? AND status!='legal_deleted' LIMIT 1", [id]);
  if (!co) return res.status(404).json({ error: 'not_found' });
  const r = await query(
    `INSERT INTO tenant_contact_notes (tenant_id, company_id, note, status, created_by_user_id)
     VALUES (?, ?, ?, ?, ?)`,
    [req.auth!.tenantId, id, p.data.note, p.data.status ?? null, req.auth!.userId],
  );
  res.status(201).json({ ok: true, id: Number(r.insertId) });
});

// ── GET /warehouse/contacts ────────────────────────────────────────────────
const contactQuerySchema = z.object({
  page:         z.coerce.number().int().min(1).default(1),
  limit:        z.coerce.number().int().min(1).max(200).default(50),
  type:         z.string().max(30).optional(),
  status:       z.string().max(30).optional(),
  industry:     z.string().max(80).optional(),
  country:      z.string().max(2).optional(),
  productPref:  z.string().max(100).optional(),
  q:            z.string().max(200).optional(),
});

warehouseRouter.get('/contacts', async (req, res) => {
  const p = contactQuerySchema.safeParse(req.query);
  if (!p.success) return res.status(400).json({ error: 'invalid_query' });
  const { page, limit, type, status, industry, country, productPref, q } = p.data;
  const offset = (page - 1) * limit;

  const wheres: string[] = ["cp.status NOT IN ('do_not_contact','legal_deleted')"];
  const params: any[] = [];

  if (type)   { wheres.push('cp.type=?'); params.push(type); }
  if (status) { wheres.push('cp.status=?'); params.push(status); }
  if (country){ wheres.push('co.country=?'); params.push(country); }
  if (q)      { wheres.push('(cp.normalized_value LIKE ? OR co.name LIKE ? OR co.canonical_domain LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (industry) {
    wheres.push('EXISTS (SELECT 1 FROM company_industries ci2 JOIN industry_taxonomy it2 ON it2.id=ci2.industry_id WHERE ci2.company_id=co.id AND it2.slug=?)');
    params.push(industry);
  }
  if (productPref) {
    const [pk, ps] = productPref.split(':');
    wheres.push('EXISTS (SELECT 1 FROM contact_product_preferences cpp WHERE cpp.contact_point_id=cp.id AND cpp.product_key=? AND cpp.preference_status=?)');
    params.push(pk, ps ?? 'interested');
  }

  const where = wheres.join(' AND ');
  const [countRow] = await query(
    `SELECT COUNT(*) AS c FROM contact_points cp JOIN companies co ON co.id=cp.company_id WHERE ${where}`,
    params,
  );
  const rows = await query(
    `SELECT cp.id, cp.type, cp.value, cp.normalized_value, cp.email_domain, cp.role_type,
            cp.status, cp.verification_score, cp.source_url, cp.first_seen_at, cp.last_seen_at,
            co.id AS company_id, co.canonical_domain, co.name AS company_name,
            co.country, co.city, co.category_primary,
            EXISTS (SELECT 1 FROM global_contact_suppression gcs WHERE gcs.type=cp.type AND gcs.normalized_value=cp.normalized_value) AS globally_suppressed
     FROM contact_points cp
     JOIN companies co ON co.id=cp.company_id
     WHERE ${where}
     ORDER BY cp.last_seen_at DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  res.json({ total: Number(countRow.c), page, limit, contacts: rows });
});

// ── POST /warehouse/contacts/:id/preference ────────────────────────────────
const preferenceSchema = z.object({
  productKey:        z.string().max(100),
  preferenceStatus:  z.enum(['unknown','interested','not_interested','maybe_later','requested_info','rejected_offer','customer']),
  note:              z.string().max(1000).optional(),
});

warehouseRouter.post('/contacts/:id/preference', requireWriteAccess, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const p = preferenceSchema.safeParse(req.body);
  if (!p.success || !id) return res.status(400).json({ error: 'invalid_body' });

  const [cp] = await query('SELECT id, company_id FROM contact_points WHERE id=? LIMIT 1', [id]);
  if (!cp) return res.status(404).json({ error: 'not_found' });

  await query(
    `INSERT INTO contact_product_preferences (contact_point_id, company_id, product_key, preference_status, source, note, last_interaction_at)
     VALUES (?, ?, ?, ?, 'manual', ?, NOW())
     ON DUPLICATE KEY UPDATE preference_status=VALUES(preference_status), note=COALESCE(VALUES(note),note), last_interaction_at=NOW()`,
    [id, cp.company_id, p.data.productKey, p.data.preferenceStatus, p.data.note ?? null],
  );
  res.json({ ok: true });
});

// ── POST /warehouse/contacts/:id/global-status ─────────────────────────────
const globalStatusSchema = z.object({
  status:   z.enum(['do_not_contact','suppressed','unsubscribed','complained','bounced','legal_deleted']),
  reason:   z.string().max(200).optional(),
  confirm:  z.literal(true),
});

warehouseRouter.post('/contacts/:id/global-status', requireWriteAccess, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const p = globalStatusSchema.safeParse(req.body);
  if (!p.success || !id) return res.status(400).json({ error: 'invalid_body_or_missing_confirm' });

  const [cp] = await query('SELECT id, type, normalized_value FROM contact_points WHERE id=? LIMIT 1', [id]);
  if (!cp) return res.status(404).json({ error: 'not_found' });

  await query('UPDATE contact_points SET status=? WHERE id=?', [p.data.status, id]);

  // Add to global suppression for dangerous statuses
  const suppressionReasons: Record<string, string> = {
    do_not_contact: 'do_not_contact',
    unsubscribed:   'unsubscribe',
    complained:     'complaint',
    bounced:        'hard_bounce',
    legal_deleted:  'legal_request',
  };
  const gcsReason = suppressionReasons[p.data.status];
  if (gcsReason) {
    await query(
      `INSERT IGNORE INTO global_contact_suppression (type, normalized_value, reason, created_by_user_id)
       VALUES (?, ?, ?, ?)`,
      [cp.type, cp.normalized_value, gcsReason, req.auth!.userId],
    );
  }

  await query(
    'INSERT INTO lead_warehouse_events (company_id, contact_point_id, event_type, metadata_json) SELECT company_id, id, ?, ? FROM contact_points WHERE id=?',
    [`contact.status.${p.data.status}`, JSON.stringify({ reason: p.data.reason ?? null, by: req.auth!.userId }), id],
  );

  res.json({ ok: true, status: p.data.status });
});

// ── POST /warehouse/companies/:id/industry ─────────────────────────────────
const industryAssignSchema = z.object({
  slug:       z.string().max(80),
  isPrimary:  z.boolean().default(false),
  confidence: z.number().min(0).max(1).default(0.9),
});

warehouseRouter.post('/companies/:id/industry', requireWriteAccess, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const p = industryAssignSchema.safeParse(req.body);
  if (!p.success || !id) return res.status(400).json({ error: 'invalid_body' });

  const [co] = await query("SELECT id FROM companies WHERE id=? AND status != 'legal_deleted' LIMIT 1", [id]);
  if (!co) return res.status(404).json({ error: 'not_found' });

  const [ind] = await query('SELECT id FROM industry_taxonomy WHERE slug=? LIMIT 1', [p.data.slug]);
  if (!ind) return res.status(404).json({ error: 'industry_not_found' });

  await query(
    `INSERT INTO company_industries (company_id, industry_id, confidence, source, is_primary)
     VALUES (?, ?, ?, 'manual', ?)
     ON DUPLICATE KEY UPDATE confidence=VALUES(confidence), source='manual', is_primary=VALUES(is_primary)`,
    [id, ind.id, p.data.confidence, p.data.isPrimary ? 1 : 0],
  );
  if (p.data.isPrimary) {
    await query('UPDATE companies SET category_primary=? WHERE id=?', [p.data.slug, id]);
  }
  res.json({ ok: true });
});

// ── GET /warehouse/review-queue ──────────────────────────────────────────────
// Companies ready for review, drafts awaiting review, contacts ready for
// activation. NOTHING here sends — it is a triage surface only.
warehouseRouter.get('/review-queue', async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const limit = Math.min(parseInt((req.query.limit as string) ?? '25', 10) || 25, 100);

  // Companies "ready for review": good/excellent fit + has email + has website,
  // not yet suppressed. High-intent leads an operator should look at first.
  const companiesRows = await query(
    `SELECT ${COMPANY_SELECT} FROM companies c
     WHERE c.status!='legal_deleted'
       AND EXISTS (SELECT 1 FROM company_product_fit cpf WHERE cpf.company_id=c.id AND cpf.fit_score >= 0.6)
       AND EXISTS (SELECT 1 FROM contact_points cp WHERE cp.company_id=c.id AND cp.type='email' AND cp.status NOT IN ('do_not_contact','legal_deleted'))
       AND EXISTS (SELECT 1 FROM company_websites cw WHERE cw.company_id=c.id AND cw.status='active')
     ORDER BY best_fit_score DESC, c.last_seen_at DESC
     LIMIT ?`,
    [limit],
  );

  const drafts = await query(
    `SELECT od.id, od.status, od.language, od.tone, od.created_at,
            waj.target_domain
     FROM outreach_drafts od
     LEFT JOIN website_analysis_results war ON war.id = od.analysis_result_id
     LEFT JOIN website_analysis_jobs waj ON waj.id = war.job_id
     WHERE od.tenant_id=? AND od.status IN ('draft','pending_review')
     ORDER BY od.created_at DESC LIMIT ?`,
    [tenantId, limit],
  ).catch(() => []);

  // Contacts "ready for activation": pending contacts with an email.
  const contactsReady = await query(
    `SELECT ct.id, ct.email, ct.status, ct.created_at,
            (SELECT GROUP_CONCAT(l.name SEPARATOR ', ') FROM list_contacts lc JOIN lists l ON l.id=lc.list_id WHERE lc.contact_id=ct.id) AS lists
     FROM contacts ct
     WHERE ct.tenant_id=? AND ct.status='pending'
     ORDER BY ct.created_at DESC LIMIT ?`,
    [tenantId, limit],
  ).catch(() => []);

  const [coCount]    = await query(`SELECT COUNT(*) AS c FROM companies c WHERE c.status!='legal_deleted' AND EXISTS (SELECT 1 FROM company_product_fit cpf WHERE cpf.company_id=c.id AND cpf.fit_score >= 0.6) AND EXISTS (SELECT 1 FROM contact_points cp WHERE cp.company_id=c.id AND cp.type='email' AND cp.status NOT IN ('do_not_contact','legal_deleted'))`, []);
  const [draftCount] = await query(`SELECT COUNT(*) AS c FROM outreach_drafts WHERE tenant_id=? AND status IN ('draft','pending_review')`, [tenantId]).then(r => r).catch(() => [{ c: 0 }]);
  const [ctCount]    = await query(`SELECT COUNT(*) AS c FROM contacts WHERE tenant_id=? AND status='pending' AND email IS NOT NULL`, [tenantId]).catch(() => [{ c: 0 }]);

  res.json({
    safety: 'review_only_no_send',
    counts: {
      companiesReady: Number(coCount.c),
      draftsToReview: Number(draftCount?.c ?? 0),
      contactsToActivate: Number(ctCount?.c ?? 0),
    },
    companies: companiesRows.map(decorateCompany),
    drafts,
    contacts: contactsReady,
  });
});

// ── GET /warehouse/analytics ─────────────────────────────────────────────────
// Usage analytics for the current tenant (super-admin sees acting tenant).
// Values that are not tracked yet are returned as null with a clear key.
warehouseRouter.get('/analytics', async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const num = async (sql: string, params: any[] = []) => {
    try { const [r] = await query(sql, params); return Number(r?.c ?? 0); } catch { return null; }
  };

  const searchesRun        = await num(`SELECT COUNT(*) AS c FROM search_provider_usage WHERE tenant_id=?`, [tenantId]);
  const collectorSources   = await num(`SELECT COALESCE(SUM(sources_crawled),0) AS c FROM collector_campaign_stats WHERE tenant_id=?`, [tenantId]);
  const contactsImported   = await num(`SELECT COUNT(*) AS c FROM contacts WHERE tenant_id=?`, [tenantId]);
  const contactsRevealed   = await num(`SELECT COUNT(*) AS c FROM contact_points cp JOIN companies co ON co.id=cp.company_id WHERE cp.type='email'`, []);
  const draftsGenerated    = await num(`SELECT COUNT(*) AS c FROM outreach_drafts WHERE tenant_id=?`, [tenantId]);
  const draftsApproved     = await num(`SELECT COUNT(*) AS c FROM outreach_drafts WHERE tenant_id=? AND status='approved'`, [tenantId]);
  const testSends          = await num(`SELECT COUNT(*) AS c FROM outreach_drafts WHERE tenant_id=? AND test_sent_at IS NOT NULL`, [tenantId]);
  const campaignsScheduled = await num(`SELECT COUNT(*) AS c FROM campaigns WHERE tenant_id=?`, [tenantId]);

  res.json({
    tenantId,
    metrics: {
      searchesRun,
      collectorSourcesProcessed: collectorSources,
      contactsRevealed,
      contactsImported,
      draftsGenerated,
      draftsApproved,
      testSends,
      campaignsScheduled,
      // Not tracked with a dedicated counter yet — surfaced as null, not zero.
      exports: null,
      campaignsBlockedByPreflight: null,
    },
    notes: 'exports and preflight-block counters are not yet instrumented.',
  });
});

// ── GET /warehouse/limits ────────────────────────────────────────────────────
// Internal pricing hooks ONLY. No public prices, no enforcement yet — exposes
// the limit/usage shape so future plans can be wired without schema churn.
warehouseRouter.get('/limits', async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const safe = async (sql: string, params: any[] = []) => {
    try { const [r] = await query(sql, params); return Number(r?.c ?? 0); } catch { return null; }
  };
  const usage = {
    contactsImported: await safe(`SELECT COUNT(*) AS c FROM contacts WHERE tenant_id=?`, [tenantId]),
    lists:            await safe(`SELECT COUNT(*) AS c FROM lists WHERE tenant_id=?`, [tenantId]),
    senderIdentities: await safe(`SELECT COUNT(*) AS c FROM sender_identities WHERE tenant_id=?`, [tenantId]),
    activeCollectors: await safe(`SELECT COUNT(*) AS c FROM collector_campaigns WHERE tenant_id=? AND status='active'`, [tenantId]),
  };
  res.json({
    tenantId,
    publicPricing: false,
    // null limit == unlimited / not enforced. Plans can later set integers here.
    limits: {
      contactCredits:  null,
      exportCredits:   null,
      activeProjects:  null,
      mailboxes:       null,
      agents:          null,
    },
    usage,
    note: 'Pricing hooks only. No prices, no enforcement. For future plan wiring.',
  });
});

// ── POST /warehouse/rebuild-from-existing-data ─────────────────────────────
warehouseRouter.post('/rebuild-from-existing-data', requireWriteAccess, async (req, res) => {
  // Non-blocking: start in background, return job started
  const tenantId = req.auth!.isSuperAdmin ? (req.query.tenantId ? parseInt(req.query.tenantId as string, 10) : undefined) : req.auth!.tenantId!;
  backfillAll(tenantId).catch((e) => {
    require('../logger.js').logger.error({ err: e.message }, 'warehouse rebuild error');
  });
  res.json({ ok: true, message: 'Rebuild started in background. Check stats endpoint for progress.' });
});

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 18 — COMPLIANT SENDING STRATEGY: Cohort Builder + ESP Export
// (Parts 3,4,7,8). These endpoints read the Warehouse (contact_points) and
// produce small, operator-controlled, suppression-safe exports. They NEVER
// send mail, subscribe contacts, or touch SMTP.
// ═══════════════════════════════════════════════════════════════════════════

// Free / personal mailbox domains — excluded from B2B cold cohorts.
const FREE_DOMAINS = [
  'gmail.com','googlemail.com','yahoo.com','yahoo.co.uk','ymail.com','hotmail.com',
  'hotmail.co.uk','outlook.com','live.com','msn.com','aol.com','icloud.com','me.com',
  'mac.com','protonmail.com','proton.me','gmx.com','gmx.net','mail.com','mail.ru',
  'yandex.com','yandex.ru','zoho.com','tutanota.com','web.de','t-online.de',
];
const FREE_LIST_SQL = FREE_DOMAINS.map((d) => `'${d}'`).join(',');

// Hard eligibility for export/cohort: email, verified, not suppressed anywhere,
// company healthy, not a free/personal mailbox. Takes ONE param: tenantId.
const ELIGIBLE_SQL = `(
  cp.type='email' AND cp.status='verified'
  AND co.status NOT IN ('suppressed','legal_deleted')
  AND NOT EXISTS (SELECT 1 FROM global_contact_suppression g
    WHERE (g.type='email' AND g.normalized_value=cp.normalized_value)
       OR (g.type='domain' AND g.normalized_value=cp.email_domain))
  AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.tenant_id=? AND s.email=cp.normalized_value)
  AND cp.email_domain NOT IN (${FREE_LIST_SQL})
)`;

const cohortFilterSchema = z.object({
  industry:       z.string().max(80).optional(),
  country:        z.string().max(2).optional(),
  city:           z.string().max(100).optional(),
  productFit:     z.string().max(60).optional(),   // "key" or "key:status"
  roleType:       z.string().max(40).optional(),
  sourceProvider: z.string().max(60).optional(),
  hasWebsite:     z.boolean().optional(),
  minScore:       z.coerce.number().int().min(0).max(100).optional(),
  maxAgeDays:     z.coerce.number().int().min(1).max(3650).optional(),
});
type CohortFilter = z.infer<typeof cohortFilterSchema>;

// User-chosen filters (NOT the safety eligibility — that is ELIGIBLE_SQL).
function buildCohortUserWheres(f: CohortFilter): { where: string; params: any[] } {
  const wheres: string[] = ["cp.type='email'", "co.status != 'legal_deleted'"];
  const params: any[] = [];
  if (f.country)  { wheres.push('co.country=?'); params.push(f.country); }
  if (f.city)     { wheres.push('co.city LIKE ?'); params.push(`%${f.city}%`); }
  if (f.roleType) { wheres.push('cp.role_type=?'); params.push(f.roleType); }
  if (f.minScore != null) { wheres.push('cp.verification_score >= ?'); params.push(f.minScore); }
  if (f.maxAgeDays != null) { wheres.push('cp.first_seen_at >= (NOW() - INTERVAL ? DAY)'); params.push(f.maxAgeDays); }
  if (f.industry) {
    wheres.push('EXISTS (SELECT 1 FROM company_industries ci JOIN industry_taxonomy it ON it.id=ci.industry_id WHERE ci.company_id=co.id AND it.slug=?)');
    params.push(f.industry);
  }
  if (f.productFit) {
    const [pk, ps] = f.productFit.split(':');
    wheres.push('EXISTS (SELECT 1 FROM company_product_fit cpf WHERE cpf.company_id=co.id AND cpf.product_key=? AND cpf.status=?)');
    params.push(pk, ps ?? 'good_fit');
  }
  if (f.sourceProvider) {
    wheres.push('EXISTS (SELECT 1 FROM company_websites cw WHERE cw.company_id=co.id AND cw.source_provider=?)');
    params.push(f.sourceProvider);
  }
  if (f.hasWebsite === true)  wheres.push("EXISTS (SELECT 1 FROM company_websites cw WHERE cw.company_id=co.id AND cw.status='active')");
  if (f.hasWebsite === false) wheres.push("NOT EXISTS (SELECT 1 FROM company_websites cw WHERE cw.company_id=co.id AND cw.status='active')");
  return { where: wheres.join(' AND '), params };
}

// Canonical export record select (used by preview-sample, export, bounce-check).
const COHORT_ROW_SELECT = `cp.id, cp.normalized_value AS email, cp.email_domain, cp.role_type,
  cp.status AS verification_status, cp.verification_score, cp.source_url, cp.first_seen_at,
  co.name AS company_name, co.country, co.city, co.canonical_domain,
  (SELECT it.slug FROM company_industries ci JOIN industry_taxonomy it ON it.id=ci.industry_id WHERE ci.company_id=co.id ORDER BY ci.is_primary DESC, ci.confidence DESC LIMIT 1) AS industry,
  (SELECT cw.url FROM company_websites cw WHERE cw.company_id=co.id AND cw.status='active' ORDER BY cw.first_seen_at DESC LIMIT 1) AS website,
  (SELECT cw.source_provider FROM company_websites cw WHERE cw.company_id=co.id ORDER BY cw.first_seen_at DESC LIMIT 1) AS source_provider,
  (SELECT cpf.product_key FROM company_product_fit cpf WHERE cpf.company_id=co.id ORDER BY cpf.fit_score DESC LIMIT 1) AS product_fit,
  (SELECT cpf.fit_reason FROM company_product_fit cpf WHERE cpf.company_id=co.id ORDER BY cpf.fit_score DESC LIMIT 1) AS fit_reason,
  (SELECT cpf.recommended_angle FROM company_product_fit cpf WHERE cpf.company_id=co.id ORDER BY cpf.fit_score DESC LIMIT 1) AS recommended_angle`;

function csvCell(v: any): string {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(headers: string[], rows: Array<Record<string, any>>): string {
  return [headers.join(','), ...rows.map((r) => headers.map((h) => csvCell(r[h])).join(','))].join('\r\n');
}

const OPT_OUT_NOTE = 'Cold B2B outreach: you MUST include a working unsubscribe link and a physical postal address (CAN-SPAM / GDPR). Stop on complaints/bounces.';

// ── POST /warehouse/cohorts/preview ─────────────────────────────────────────
// Operator-controlled cohort preview. Returns matched/eligible/blocked counts,
// blocked-reason breakdown, breakdowns, and a 20-row sample. No export, no send.
warehouseRouter.post('/cohorts/preview', async (req, res) => {
  const p = cohortFilterSchema.safeParse(req.body ?? {});
  if (!p.success) return res.status(400).json({ error: 'invalid_filters' });
  const tenantId = req.auth!.tenantId!;
  const { where, params } = buildCohortUserWheres(p.data);

  // matched + eligible + per-reason blocked, single aggregate pass.
  // SELECT-clause subqueries take tenantId params first, then WHERE params.
  const [agg] = await query(
    `SELECT
       COUNT(*) AS matched,
       SUM(CASE WHEN ${ELIGIBLE_SQL} THEN 1 ELSE 0 END) AS eligible,
       SUM(CASE WHEN EXISTS (SELECT 1 FROM global_contact_suppression g WHERE (g.type='email' AND g.normalized_value=cp.normalized_value) OR (g.type='domain' AND g.normalized_value=cp.email_domain)) THEN 1 ELSE 0 END) AS blk_global,
       SUM(CASE WHEN EXISTS (SELECT 1 FROM suppressions s WHERE s.tenant_id=? AND s.email=cp.normalized_value) THEN 1 ELSE 0 END) AS blk_tenant_supp,
       SUM(CASE WHEN cp.status <> 'verified' THEN 1 ELSE 0 END) AS blk_not_verified,
       SUM(CASE WHEN cp.email_domain IN (${FREE_LIST_SQL}) THEN 1 ELSE 0 END) AS blk_free,
       SUM(CASE WHEN co.status IN ('suppressed','legal_deleted') THEN 1 ELSE 0 END) AS blk_company
     FROM contact_points cp JOIN companies co ON co.id=cp.company_id
     WHERE ${where}`,
    [tenantId, tenantId, ...params],
  );

  const sample = await query(
    `SELECT ${COHORT_ROW_SELECT}
     FROM contact_points cp JOIN companies co ON co.id=cp.company_id
     WHERE ${where} AND ${ELIGIBLE_SQL}
     ORDER BY cp.verification_score DESC, cp.last_seen_at DESC LIMIT 20`,
    [...params, tenantId],
  );

  const breakdown = async (col: string) => query(
    `SELECT ${col} AS k, COUNT(*) AS c
     FROM contact_points cp JOIN companies co ON co.id=cp.company_id
     WHERE ${where} AND ${ELIGIBLE_SQL}
     GROUP BY ${col} ORDER BY c DESC LIMIT 25`,
    [...params, tenantId],
  );
  const byCountry  = await breakdown('co.country');
  const byRole     = await breakdown('cp.role_type');
  const byIndustry = await query(
    `SELECT (SELECT it.slug FROM company_industries ci JOIN industry_taxonomy it ON it.id=ci.industry_id WHERE ci.company_id=co.id ORDER BY ci.is_primary DESC LIMIT 1) AS k, COUNT(*) AS c
     FROM contact_points cp JOIN companies co ON co.id=cp.company_id
     WHERE ${where} AND ${ELIGIBLE_SQL} GROUP BY k ORDER BY c DESC LIMIT 25`,
    [...params, tenantId],
  );
  const bySource = await query(
    `SELECT (SELECT cw.source_provider FROM company_websites cw WHERE cw.company_id=co.id ORDER BY cw.first_seen_at DESC LIMIT 1) AS k, COUNT(*) AS c
     FROM contact_points cp JOIN companies co ON co.id=cp.company_id
     WHERE ${where} AND ${ELIGIBLE_SQL} GROUP BY k ORDER BY c DESC LIMIT 25`,
    [...params, tenantId],
  );

  const matched  = Number(agg.matched);
  const eligible = Number(agg.eligible);
  res.json({
    safety: 'preview_only_no_send',
    matched,
    eligible,
    blocked: matched - eligible,
    blockedReasons: {
      globally_suppressed: Number(agg.blk_global),
      tenant_suppressed:   Number(agg.blk_tenant_supp),
      not_verified:        Number(agg.blk_not_verified),
      free_or_disposable:  Number(agg.blk_free),
      company_suppressed:  Number(agg.blk_company),
    },
    recommendedFirstExport: Math.min(100, eligible),
    maxExport: 500,
    breakdowns: { byCountry, byRole, byIndustry, bySource },
    sample,
  });
});

// ── ESP export field mapping (Part 4) ───────────────────────────────────────
function canonicalRecord(r: any): Record<string, any> {
  return {
    email: r.email,
    company_name: r.company_name ?? '',
    website: r.website ?? (r.canonical_domain ? `https://${r.canonical_domain}` : ''),
    country: r.country ?? '',
    city: r.city ?? '',
    industry: r.industry ?? '',
    product_fit: r.product_fit ?? '',
    fit_reason: r.fit_reason ?? '',
    source_url: r.source_url ?? '',
    first_seen_at: r.first_seen_at ? new Date(r.first_seen_at).toISOString() : '',
    verification_status: r.verification_status ?? '',
    role_type: r.role_type ?? '',
    recommended_angle: r.recommended_angle ?? '',
    opt_out_required: OPT_OUT_NOTE,
    do_not_contact: 'no',
  };
}

const EXPORT_FORMATS: Record<string, { headers: string[]; map: (c: any) => Record<string, any> }> = {
  csv: {
    headers: ['email','company_name','website','country','city','industry','product_fit','fit_reason','source_url','first_seen_at','verification_status','role_type','recommended_angle','opt_out_required','do_not_contact'],
    map: (c) => c,
  },
  instantly: {
    headers: ['email','first_name','last_name','company_name','website','country','city','industry','personalization','opt_out_note'],
    map: (c) => ({ email: c.email, first_name: '', last_name: '', company_name: c.company_name, website: c.website, country: c.country, city: c.city, industry: c.industry, personalization: c.recommended_angle || c.fit_reason, opt_out_note: c.opt_out_required }),
  },
  smartlead: {
    headers: ['email','first_name','last_name','company_name','company_url','country','city','industry','custom_angle','opt_out'],
    map: (c) => ({ email: c.email, first_name: '', last_name: '', company_name: c.company_name, company_url: c.website, country: c.country, city: c.city, industry: c.industry, custom_angle: c.recommended_angle || c.fit_reason, opt_out: c.opt_out_required }),
  },
  lemlist: {
    headers: ['email','companyName','website','country','city','industry','icebreaker','optOut'],
    map: (c) => ({ email: c.email, companyName: c.company_name, website: c.website, country: c.country, city: c.city, industry: c.industry, icebreaker: c.recommended_angle || c.fit_reason, optOut: c.opt_out_required }),
  },
};

// ── POST /warehouse/cohorts/export ──────────────────────────────────────────
// Hard caps + mandatory compliance acknowledgement. Emits a cohort.export audit
// event. Returns CSV as a download. Only eligible (verified/suppression-safe)
// rows are included. There is deliberately NO "export all" path.
const cohortExportSchema = cohortFilterSchema.extend({
  format: z.enum(['csv','instantly','smartlead','lemlist']).default('csv'),
  limit:  z.coerce.number().int().min(1).max(500).default(100),
  acknowledge: z.literal(true),
});

warehouseRouter.post('/cohorts/export', requireWriteAccess, async (req, res) => {
  const p = cohortExportSchema.safeParse(req.body ?? {});
  if (!p.success) {
    return res.status(400).json({ error: 'invalid_or_unacknowledged', detail: 'You must set acknowledge=true and a valid format/limit (max 500).' });
  }
  const tenantId = req.auth!.tenantId!;
  const { format, limit, acknowledge, ...filters } = p.data;
  const { where, params } = buildCohortUserWheres(filters);

  const rows = await query(
    `SELECT ${COHORT_ROW_SELECT}
     FROM contact_points cp JOIN companies co ON co.id=cp.company_id
     WHERE ${where} AND ${ELIGIBLE_SQL}
     ORDER BY cp.verification_score DESC, cp.last_seen_at DESC LIMIT ?`,
    [...params, tenantId, limit],
  );

  const fmt = EXPORT_FORMATS[format];
  const records = rows.map((r: any) => fmt.map(canonicalRecord(r)));
  const csv = toCsv(fmt.headers, records);

  await audit(req, 'cohort.export', { type: 'cohort', id: format }, {
    filters, format, count: rows.length, limit,
  });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="cohort_${format}_${rows.length}.csv"`);
  res.send(csv);
});

// ── GET /warehouse/suppression-export ───────────────────────────────────────
// Suppression list for upload to the ESP (so the ESP never mails these).
warehouseRouter.get('/suppression-export', async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const global = await query(
    `SELECT normalized_value AS email, reason, 'global' AS scope FROM global_contact_suppression WHERE type='email'`,
    [],
  );
  const tenant = await query(
    `SELECT email, reason, 'tenant' AS scope FROM suppressions WHERE tenant_id=?`,
    [tenantId],
  );
  const contactsSupp = await query(
    `SELECT email, status AS reason, 'contact' AS scope FROM contacts
     WHERE tenant_id=? AND status IN ('unsubscribed','bounced','complained')`,
    [tenantId],
  );
  const all = [...global, ...tenant, ...contactsSupp];
  const csv = toCsv(['email','reason','scope'], all);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="suppression_${all.length}.csv"`);
  res.send(csv);
});

// ── POST /warehouse/bounce-check/export ─────────────────────────────────────
// Build a "verify externally" CSV (email, company, domain, source) for an
// external bounce checker (ZeroBounce/NeverBounce). No paid API is called.
const bounceExportSchema = cohortFilterSchema.extend({
  limit: z.coerce.number().int().min(1).max(5000).default(1000),
});
warehouseRouter.post('/bounce-check/export', requireWriteAccess, async (req, res) => {
  const p = bounceExportSchema.safeParse(req.body ?? {});
  if (!p.success) return res.status(400).json({ error: 'invalid_filters' });
  const tenantId = req.auth!.tenantId!;
  const { limit, ...filters } = p.data;
  const { where, params } = buildCohortUserWheres(filters);
  const rows = await query(
    `SELECT ${COHORT_ROW_SELECT}
     FROM contact_points cp JOIN companies co ON co.id=cp.company_id
     WHERE ${where} AND ${ELIGIBLE_SQL}
     ORDER BY cp.last_seen_at DESC LIMIT ?`,
    [...params, tenantId, limit],
  );
  const records = rows.map((r: any) => ({ email: r.email, company: r.company_name ?? '', domain: r.email_domain ?? '', source: r.source_url ?? '' }));
  await query(
    `INSERT INTO bounce_check_batches (tenant_id, direction, row_count, created_by_user_id) VALUES (?, 'export', ?, ?)`,
    [tenantId, rows.length, req.auth!.userId],
  );
  await audit(req, 'bounce_check.export', { type: 'bounce_check' }, { filters, count: rows.length });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="bounce_check_${rows.length}.csv"`);
  res.send(toCsv(['email','company','domain','source'], records));
});

// ── POST /warehouse/bounce-check/import ─────────────────────────────────────
// Re-import external bounce-checker results and map to warehouse statuses.
//   deliverable -> keep verified (+score 100)   undeliverable -> invalid
//   risky/catch_all -> risky (only if confirmRisky)   unknown -> no change
const bounceImportSchema = z.object({
  results: z.array(z.object({
    email:  z.string().email(),
    result: z.enum(['deliverable','undeliverable','risky','catch_all','unknown']),
  })).min(1).max(20000),
  confirmRisky: z.boolean().default(false),
});
warehouseRouter.post('/bounce-check/import', requireWriteAccess, async (req, res) => {
  const p = bounceImportSchema.safeParse(req.body ?? {});
  if (!p.success) return res.status(400).json({ error: 'invalid_body' });
  const tenantId = req.auth!.tenantId!;
  let deliverable = 0, undeliverable = 0, risky = 0, unknown = 0;

  for (const r of p.data.results) {
    const email = r.email.toLowerCase();
    if (r.result === 'deliverable') {
      await query("UPDATE contact_points SET status='verified', verification_score=100, verified_at=NOW() WHERE type='email' AND normalized_value=? AND status='verified'", [email]);
      deliverable++;
    } else if (r.result === 'undeliverable') {
      await query("UPDATE contact_points SET status='invalid' WHERE type='email' AND normalized_value=?", [email]);
      undeliverable++;
    } else if (r.result === 'risky' || r.result === 'catch_all') {
      if (p.data.confirmRisky) {
        await query("UPDATE contact_points SET status='risky' WHERE type='email' AND normalized_value=?", [email]);
      }
      risky++;
    } else {
      unknown++;
    }
  }
  await query(
    `INSERT INTO bounce_check_batches (tenant_id, direction, row_count, deliverable, undeliverable, risky, unknown, created_by_user_id)
     VALUES (?, 'import', ?, ?, ?, ?, ?, ?)`,
    [tenantId, p.data.results.length, deliverable, undeliverable, risky, unknown, req.auth!.userId],
  );
  await audit(req, 'bounce_check.import', { type: 'bounce_check' }, { count: p.data.results.length, deliverable, undeliverable, risky, unknown });
  res.json({ ok: true, processed: p.data.results.length, deliverable, undeliverable, risky, unknown, riskyApplied: p.data.confirmRisky });
});

// ── Non-email channel queue (Part 8) ────────────────────────────────────────
// For high-risk cold data, create MANUAL tasks (contact form / Telegram /
// WhatsApp / manual review). Nothing is auto-submitted — tasks only.
const taskCreateSchema = z.object({
  channel: z.enum(['contact_form','telegram','whatsapp','manual_review','website_form']),
  companyId:        z.number().int().positive().optional(),
  contactPointId:   z.number().int().positive().optional(),
  targetValue:      z.string().max(500).optional(),
  note:             z.string().max(1000).optional(),
});
warehouseRouter.post('/outreach-tasks', requireWriteAccess, async (req, res) => {
  const p = taskCreateSchema.safeParse(req.body ?? {});
  if (!p.success) return res.status(400).json({ error: 'invalid_body' });
  const r = await query(
    `INSERT INTO outreach_tasks (tenant_id, company_id, contact_point_id, channel, target_value, note, created_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [req.auth!.tenantId, p.data.companyId ?? null, p.data.contactPointId ?? null, p.data.channel, p.data.targetValue ?? null, p.data.note ?? null, req.auth!.userId],
  );
  await audit(req, 'outreach_task.create', { type: 'outreach_task', id: Number(r.insertId) }, { channel: p.data.channel });
  res.status(201).json({ id: Number(r.insertId), status: 'open', note: 'Manual task created. Nothing is auto-submitted.' });
});
warehouseRouter.get('/outreach-tasks', async (req, res) => {
  const status = (req.query.status as string) || undefined;
  const wheres = ['t.tenant_id=?']; const params: any[] = [req.auth!.tenantId];
  if (status) { wheres.push('t.status=?'); params.push(status); }
  const rows = await query(
    `SELECT t.id, t.channel, t.status, t.target_value, t.note, t.company_id, t.contact_point_id,
            co.name AS company_name, t.created_at, t.updated_at
     FROM outreach_tasks t LEFT JOIN companies co ON co.id=t.company_id
     WHERE ${wheres.join(' AND ')} ORDER BY t.created_at DESC LIMIT 500`,
    params,
  );
  res.json({ tasks: rows });
});
warehouseRouter.patch('/outreach-tasks/:id', requireWriteAccess, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const p = z.object({ status: z.enum(['open','in_progress','done','skipped']) }).safeParse(req.body ?? {});
  if (!p.success || !id) return res.status(400).json({ error: 'invalid_body' });
  const r = await query('UPDATE outreach_tasks SET status=? WHERE id=? AND tenant_id=?', [p.data.status, id, req.auth!.tenantId]);
  if (!r.affectedRows) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true, status: p.data.status });
});

// ── Admin routes ───────────────────────────────────────────────────────────
export const warehouseAdminRouter = Router();
warehouseAdminRouter.use(authMiddleware, requireSuperAdmin);

warehouseAdminRouter.post('/reclassify', async (_req, res) => {
  backfillAll().catch(() => {});
  res.json({ ok: true, message: 'Global reclassification started.' });
});

warehouseAdminRouter.get('/quality-report', async (_req, res) => {
  const [noIndustry] = await query('SELECT COUNT(*) AS c FROM companies WHERE category_primary IS NULL', []);
  const [noContact]  = await query('SELECT COUNT(*) AS c FROM companies WHERE id NOT IN (SELECT DISTINCT company_id FROM contact_points)', []);
  const [suppressed] = await query('SELECT COUNT(*) AS c FROM global_contact_suppression', []);
  const [badStatus]  = await query('SELECT COUNT(*) AS c FROM contact_points WHERE status IN (\'do_not_contact\',\'bounced\',\'complained\')', []);
  const industryDist = await query(
    `SELECT it.slug, it.name_en, COUNT(DISTINCT ci.company_id) AS company_count
     FROM company_industries ci JOIN industry_taxonomy it ON it.id=ci.industry_id
     WHERE ci.is_primary=1 GROUP BY ci.industry_id ORDER BY company_count DESC LIMIT 30`,
    [],
  );
  const fitDist = await query(
    `SELECT product_key, status, COUNT(*) AS cnt FROM company_product_fit GROUP BY product_key, status ORDER BY product_key, cnt DESC`,
    [],
  );
  res.json({
    companiesWithoutIndustry: Number(noIndustry.c),
    companiesWithoutContact: Number(noContact.c),
    globalSuppressions: Number(suppressed.c),
    badStatusContacts: Number(badStatus.c),
    industryDistribution: industryDist,
    productFitDistribution: fitDist,
  });
});
