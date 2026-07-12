import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { authMiddleware, requireTenant, requireWriteAccess } from '../middleware/auth.js';
import { audit } from '../middleware/audit.js';
import {
  SEED_TEMPLATES, SAFETY_WARNINGS, MAX_SUBMISSIONS_PER_SOURCE_PER_DAY, MAX_TASKS_PER_DAY,
  MAX_DISCOVERY_PER_RUN, MAX_IMPORT_ROWS,
  dedupeKey, renderPartnerMessage, parseImportText, rowToTarget,
  getDailyCounts, bumpDaily, recordPartnerTouch, seedSourceAndTemplates,
} from '../services/partnerOutreach.js';

// Phase 22G — Partner Directory Contact-Form Outreach Queue (mounted /partner-outreach).
// Operator-controlled, NON-EMAIL outreach. NOTHING here sends email or submits any
// web form automatically. No login/captcha/rate-limit bypass. No hidden-API abuse.
// One task = one company contact form; the operator copies the message and submits
// it manually, then marks it submitted. Tenant-isolated. No secrets stored.
export const partnerOutreachRouter = Router();
partnerOutreachRouter.use(authMiddleware, requireTenant);

const TARGET_STATUS = ['new','selected','queued','contacted','replied','interested','not_interested','do_not_contact','skipped','blocked'] as const;
const TASK_STATUS = ['pending_review','ready','opened','copied','submitted_manually','replied','skipped','blocked','do_not_contact'] as const;
const SUPPRESSED_TARGET = new Set(['do_not_contact', 'skipped', 'blocked']);

function jb(v: any): any { if (v == null) return null; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return null; } }
function tid(req: any): number { return req.auth.tenantId; }

async function loadTarget(tenantId: number, id: number): Promise<any | null> {
  const [r] = await query('SELECT * FROM partner_directory_targets WHERE id=? AND tenant_id=? LIMIT 1', [id, tenantId]);
  return r ?? null;
}
async function loadTask(tenantId: number, id: number): Promise<any | null> {
  const [r] = await query('SELECT * FROM partner_contact_tasks WHERE id=? AND tenant_id=? LIMIT 1', [id, tenantId]);
  return r ?? null;
}

// ── Overview / safety ────────────────────────────────────────────────────────
partnerOutreachRouter.get('/status', async (req, res) => {
  const tenantId = tid(req);
  const [sources] = await query('SELECT COUNT(*) n FROM partner_directory_sources WHERE tenant_id=?', [tenantId]);
  const [targets] = await query('SELECT COUNT(*) n FROM partner_directory_targets WHERE tenant_id=?', [tenantId]);
  const [tasks] = await query('SELECT COUNT(*) n FROM partner_contact_tasks WHERE tenant_id=?', [tenantId]);
  res.json({
    sources: Number(sources?.n ?? 0),
    targets: Number(targets?.n ?? 0),
    tasks: Number(tasks?.n ?? 0),
    limits: {
      max_submissions_per_source_per_day: MAX_SUBMISSIONS_PER_SOURCE_PER_DAY,
      max_tasks_per_day: MAX_TASKS_PER_DAY,
      max_discovery_per_run: MAX_DISCOVERY_PER_RUN,
      max_import_rows: MAX_IMPORT_ROWS,
    },
    warnings: SAFETY_WARNINGS,
    automatic_form_submission: false,
    real_emails_sent: 0,
  });
});

partnerOutreachRouter.post('/seed', requireWriteAccess, async (req, res) => {
  const tenantId = tid(req);
  const r = await seedSourceAndTemplates(tenantId);
  await audit(req, 'partner.seed', { type: 'partner_source', id: r.source_id }, r);
  res.json({ ok: true, ...r });
});

// ── Sources ──────────────────────────────────────────────────────────────────
partnerOutreachRouter.get('/sources', async (req, res) => {
  const rows = await query('SELECT * FROM partner_directory_sources WHERE tenant_id=? ORDER BY id DESC', [tid(req)]);
  res.json({ sources: rows });
});

const sourceSchema = z.object({
  name: z.string().min(1).max(200),
  source_url: z.string().max(1000).optional().nullable(),
  platform: z.enum(['ziftone', 'manual', 'other']).default('manual'),
  status: z.enum(['active', 'disabled', 'needs_review']).default('active'),
  notes: z.string().max(2000).optional().nullable(),
});
partnerOutreachRouter.post('/sources', requireWriteAccess, async (req, res) => {
  const p = sourceSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'invalid', detail: p.error.flatten() });
  const d = p.data;
  const r = await query(
    'INSERT INTO partner_directory_sources (tenant_id, name, source_url, platform, status, notes) VALUES (?, ?, ?, ?, ?, ?)',
    [tid(req), d.name, d.source_url ?? null, d.platform, d.status, d.notes ?? null],
  );
  await audit(req, 'partner.source.create', { type: 'partner_source', id: Number(r.insertId) }, { name: d.name });
  const [row] = await query('SELECT * FROM partner_directory_sources WHERE id=?', [Number(r.insertId)]);
  res.json({ source: row });
});

partnerOutreachRouter.patch('/sources/:id', requireWriteAccess, async (req, res) => {
  const id = Number(req.params.id);
  const [src] = await query('SELECT id FROM partner_directory_sources WHERE id=? AND tenant_id=?', [id, tid(req)]);
  if (!src) return res.status(404).json({ error: 'not_found' });
  const p = sourceSchema.partial().safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'invalid' });
  const fields: string[] = []; const vals: any[] = [];
  for (const [k, v] of Object.entries(p.data)) { fields.push(`${k}=?`); vals.push(v); }
  if (fields.length) { vals.push(id, tid(req)); await query(`UPDATE partner_directory_sources SET ${fields.join(',')} WHERE id=? AND tenant_id=?`, vals); }
  const [row] = await query('SELECT * FROM partner_directory_sources WHERE id=?', [id]);
  res.json({ source: row });
});

// ── Targets ────────────────────────────────────────────────────────────────
partnerOutreachRouter.get('/targets', async (req, res) => {
  const tenantId = tid(req);
  const where: string[] = ['tenant_id=?']; const vals: any[] = [tenantId];
  if (req.query.status) { where.push('status=?'); vals.push(String(req.query.status)); }
  if (req.query.source_id) { where.push('source_id=?'); vals.push(Number(req.query.source_id)); }
  // Clamp to a positive integer: ?limit=-1 / 1.5 would otherwise produce
  // `LIMIT -1` / `LIMIT 1.5` — a MariaDB syntax error and a failed request.
  const limit = Math.max(1, Math.min(Math.floor(Number(req.query.limit)) || 200, 500));
  const rows = await query(
    `SELECT * FROM partner_directory_targets WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${limit}`, vals,
  );
  res.json({ targets: rows.map((r: any) => ({ ...r, raw_metadata: jb(r.raw_metadata_json), raw_metadata_json: undefined })) });
});

// Insert one target with dedupe; returns {created, target|duplicate}.
async function insertTarget(tenantId: number, sourceId: number | null, fields: ReturnType<typeof rowToTarget>, notes?: string | null) {
  const key = dedupeKey(fields);
  const [dup] = await query('SELECT id, company_name, status FROM partner_directory_targets WHERE tenant_id=? AND dedupe_key=? LIMIT 1', [tenantId, key]);
  if (dup) return { created: false, target: dup };
  const r = await query(
    `INSERT INTO partner_directory_targets
      (tenant_id, source_id, company_name, profile_url, website_url, category, country, description,
       contact_button_present, contact_form_url, notes, dedupe_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [tenantId, sourceId, fields.company_name, fields.profile_url, fields.website_url, fields.category,
     fields.country, fields.description, fields.contact_button_present ? 1 : 0, fields.contact_form_url, notes ?? null, key],
  );
  const [row] = await query('SELECT * FROM partner_directory_targets WHERE id=?', [Number(r.insertId)]);
  return { created: true, target: row };
}

const importSchema = z.object({
  source_id: z.number().int().optional().nullable(),
  text: z.string().max(200000).optional(),
  rows: z.array(z.record(z.string())).optional(),
  dryRun: z.boolean().default(true),
  confirm: z.boolean().default(false),
});
partnerOutreachRouter.post('/targets/import', requireWriteAccess, async (req, res) => {
  const tenantId = tid(req);
  const p = importSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'invalid', detail: p.error.flatten() });
  const d = p.data;
  let parsed: Array<Record<string, string>> = d.rows ?? (d.text ? parseImportText(d.text) : []);
  if (!parsed.length) return res.status(400).json({ error: 'no_rows' });
  const truncated = parsed.length > MAX_IMPORT_ROWS;
  if (truncated) parsed = parsed.slice(0, MAX_IMPORT_ROWS);
  const mapped = parsed.map(rowToTarget);

  // dry-run preview only — saves nothing, requires explicit confirm to persist.
  if (d.dryRun || !d.confirm) {
    const preview = mapped.map((m) => ({ ...m, dedupe_key: dedupeKey(m) }));
    return res.json({ dryRun: true, parsed: preview.length, truncated, max_import_rows: MAX_IMPORT_ROWS, sample: preview.slice(0, 20), note: 'Set dryRun:false and confirm:true to save.' });
  }
  let created = 0, duplicates = 0;
  for (const m of mapped) {
    const r = await insertTarget(tenantId, d.source_id ?? null, m);
    if (r.created) created++; else duplicates++;
  }
  await audit(req, 'partner.targets.import', { type: 'partner_source', id: d.source_id ?? undefined }, { created, duplicates });
  res.json({ ok: true, created, duplicates, truncated });
});

const singleTargetSchema = z.object({
  source_id: z.number().int().optional().nullable(),
  company_name: z.string().min(1).max(300),
  profile_url: z.string().max(1000).optional().nullable(),
  website_url: z.string().max(1000).optional().nullable(),
  category: z.string().max(150).optional().nullable(),
  country: z.string().max(120).optional().nullable(),
  description: z.string().max(2000).optional().nullable(),
  contact_button_present: z.boolean().optional(),
  contact_form_url: z.string().max(1000).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
});
partnerOutreachRouter.post('/targets', requireWriteAccess, async (req, res) => {
  const p = singleTargetSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'invalid', detail: p.error.flatten() });
  const d = p.data;
  const r = await insertTarget(tid(req), d.source_id ?? null, rowToTarget(d as any), d.notes);
  if (!r.created) return res.status(409).json({ error: 'duplicate_company', target: r.target });
  await audit(req, 'partner.target.create', { type: 'partner_target', id: r.target.id }, { company: d.company_name });
  res.json({ target: r.target });
});

partnerOutreachRouter.patch('/targets/:id', requireWriteAccess, async (req, res) => {
  const tenantId = tid(req); const id = Number(req.params.id);
  const target = await loadTarget(tenantId, id);
  if (!target) return res.status(404).json({ error: 'not_found' });
  const schema = z.object({ status: z.enum(TARGET_STATUS).optional(), notes: z.string().max(2000).optional().nullable() });
  const p = schema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'invalid' });
  const fields: string[] = []; const vals: any[] = [];
  if (p.data.status) { fields.push('status=?'); vals.push(p.data.status); }
  if (p.data.notes !== undefined) { fields.push('notes=?'); vals.push(p.data.notes); }
  if (fields.length) { vals.push(id, tenantId); await query(`UPDATE partner_directory_targets SET ${fields.join(',')} WHERE id=? AND tenant_id=?`, vals); }
  // PART 8: when a reply/status is marked, write a manual_note/inbound touchpoint.
  if (p.data.status && ['replied', 'interested', 'not_interested', 'do_not_contact'].includes(p.data.status)) {
    const inbound = p.data.status === 'replied' || p.data.status === 'interested';
    await recordPartnerTouch({
      tenantId, companyId: target.company_id ?? null, targetId: id,
      status: inbound ? 'replied' : 'skipped',
      direction: inbound ? 'inbound' : 'outbound',
      touchType: inbound ? 'reply' : 'manual_note',
    });
    // stop follow-ups: cancel any non-terminal tasks for this target when not interested.
    if (p.data.status === 'not_interested' || p.data.status === 'do_not_contact') {
      const newTaskStatus = p.data.status === 'do_not_contact' ? 'do_not_contact' : 'skipped';
      await query(
        `UPDATE partner_contact_tasks SET status=? WHERE tenant_id=? AND target_id=? AND status IN ('pending_review','ready','opened','copied')`,
        [newTaskStatus, tenantId, id],
      );
    }
  }
  const [row] = await query('SELECT * FROM partner_directory_targets WHERE id=?', [id]);
  await audit(req, 'partner.target.update', { type: 'partner_target', id }, p.data);
  res.json({ target: row });
});

// Suppress / do-not-contact a company (PART 9 — never contact again).
partnerOutreachRouter.post('/targets/:id/do-not-contact', requireWriteAccess, async (req, res) => {
  const tenantId = tid(req); const id = Number(req.params.id);
  const target = await loadTarget(tenantId, id);
  if (!target) return res.status(404).json({ error: 'not_found' });
  await query("UPDATE partner_directory_targets SET status='do_not_contact' WHERE id=? AND tenant_id=?", [id, tenantId]);
  await query("UPDATE partner_contact_tasks SET status='do_not_contact' WHERE tenant_id=? AND target_id=? AND status NOT IN ('submitted_manually','replied')", [tenantId, id]);
  await recordPartnerTouch({ tenantId, companyId: target.company_id ?? null, targetId: id, status: 'blocked', touchType: 'manual_note' });
  await audit(req, 'partner.target.do_not_contact', { type: 'partner_target', id }, {});
  res.json({ ok: true });
});

// ── Browser-assisted discovery (PART 4) — LIMITED ────────────────────────────
// No headless browser is installed and the Intuit/ZiftOne directory is a
// login-gated SPA. We refuse to bypass login/captcha or call hidden APIs, so
// automated discovery is intentionally unavailable. Manual import is the path.
partnerOutreachRouter.post('/discover', requireWriteAccess, async (req, res) => {
  res.status(200).json({
    available: false,
    limited: true,
    reason: 'browser_discovery_unavailable',
    detail: 'No headless browser is installed and the directory is login/captcha gated. We do not bypass login, captcha, or hidden APIs.',
    guidance: 'Use manual import: paste a CSV, profile/website URLs, or visible directory card data. For ZiftOne, export or copy visible listings from your own logged-in session.',
    max_discovery_per_run: MAX_DISCOVERY_PER_RUN,
  });
});

// ── Templates ────────────────────────────────────────────────────────────────
partnerOutreachRouter.get('/templates', async (req, res) => {
  let rows = await query('SELECT * FROM partner_message_templates WHERE tenant_id=? ORDER BY is_seed DESC, id ASC', [tid(req)]);
  if (!rows.length) { await seedSourceAndTemplates(tid(req)); rows = await query('SELECT * FROM partner_message_templates WHERE tenant_id=? ORDER BY is_seed DESC, id ASC', [tid(req)]); }
  res.json({ templates: rows });
});

const tmplSchema = z.object({
  template_key: z.string().min(1).max(120).optional(),
  name: z.string().min(1).max(200),
  use_case: z.string().max(120).optional().nullable(),
  subject: z.string().max(300).optional().nullable(),
  body: z.string().min(1),
});
partnerOutreachRouter.post('/templates', requireWriteAccess, async (req, res) => {
  const p = tmplSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'invalid', detail: p.error.flatten() });
  const d = p.data;
  const key = d.template_key || `custom_${Date.now()}`;
  try {
    const r = await query(
      'INSERT INTO partner_message_templates (tenant_id, template_key, name, use_case, subject, body, is_seed) VALUES (?, ?, ?, ?, ?, ?, 0)',
      [tid(req), key, d.name, d.use_case ?? null, d.subject ?? null, d.body],
    );
    const [row] = await query('SELECT * FROM partner_message_templates WHERE id=?', [Number(r.insertId)]);
    res.json({ template: row });
  } catch (e: any) {
    if (String(e?.code) === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'duplicate_key' });
    throw e;
  }
});

partnerOutreachRouter.patch('/templates/:id', requireWriteAccess, async (req, res) => {
  const id = Number(req.params.id);
  const [t] = await query('SELECT id FROM partner_message_templates WHERE id=? AND tenant_id=?', [id, tid(req)]);
  if (!t) return res.status(404).json({ error: 'not_found' });
  const p = tmplSchema.partial().safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'invalid' });
  const fields: string[] = []; const vals: any[] = [];
  for (const [k, v] of Object.entries(p.data)) { if (k === 'template_key') continue; fields.push(`${k}=?`); vals.push(v); }
  if (fields.length) { vals.push(id, tid(req)); await query(`UPDATE partner_message_templates SET ${fields.join(',')} WHERE id=? AND tenant_id=?`, vals); }
  const [row] = await query('SELECT * FROM partner_message_templates WHERE id=?', [id]);
  res.json({ template: row });
});

partnerOutreachRouter.post('/templates/:id/render', async (req, res) => {
  const id = Number(req.params.id);
  const [tpl] = await query('SELECT * FROM partner_message_templates WHERE id=? AND tenant_id=?', [id, tid(req)]);
  if (!tpl) return res.status(404).json({ error: 'not_found' });
  const vars = (req.body?.vars && typeof req.body.vars === 'object') ? req.body.vars : {};
  res.json({ rendered: renderPartnerMessage(tpl, vars) });
});

// ── Tasks (contact-form queue) ───────────────────────────────────────────────
partnerOutreachRouter.get('/tasks', async (req, res) => {
  const tenantId = tid(req);
  const where: string[] = ['t.tenant_id=?']; const vals: any[] = [tenantId];
  if (req.query.status) { where.push('t.status=?'); vals.push(String(req.query.status)); }
  const limit = Math.max(1, Math.min(Math.floor(Number(req.query.limit)) || 200, 500));
  const rows = await query(
    `SELECT t.*, g.company_name, g.profile_url, g.website_url, g.status AS target_status
     FROM partner_contact_tasks t JOIN partner_directory_targets g ON g.id = t.target_id
     WHERE ${where.join(' AND ')} ORDER BY t.id DESC LIMIT ${limit}`, vals,
  );
  res.json({ tasks: rows.map((r: any) => ({ ...r, blockers: jb(r.blockers_json) ?? [], blockers_json: undefined })) });
});

const createTasksSchema = z.object({
  target_ids: z.array(z.number().int()).min(1).max(MAX_TASKS_PER_DAY),
  template_id: z.number().int().optional(),
  vars: z.record(z.string()).default({}),
  subject_override: z.string().max(300).optional().nullable(),
  due_at: z.string().optional().nullable(),
  assigned_to: z.string().max(200).optional().nullable(),
});
partnerOutreachRouter.post('/tasks', requireWriteAccess, async (req, res) => {
  const tenantId = tid(req);
  const p = createTasksSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'invalid', detail: p.error.flatten() });
  const d = p.data;

  // PART 9: cap tasks created per day.
  const { tasks_created } = await getDailyCounts(tenantId, null);
  const remaining = MAX_TASKS_PER_DAY - tasks_created;
  if (remaining <= 0) return res.status(429).json({ error: 'daily_task_limit', max: MAX_TASKS_PER_DAY, created_today: tasks_created });

  let tpl: any = null;
  if (d.template_id) [tpl] = await query('SELECT * FROM partner_message_templates WHERE id=? AND tenant_id=?', [d.template_id, tenantId]);

  const created: any[] = []; const skipped: any[] = [];
  for (const targetId of d.target_ids) {
    if (created.length >= remaining) { skipped.push({ target_id: targetId, reason: 'daily_task_limit' }); continue; }
    const target = await loadTarget(tenantId, targetId);
    if (!target) { skipped.push({ target_id: targetId, reason: 'not_found' }); continue; }
    if (SUPPRESSED_TARGET.has(target.status) || target.status === 'do_not_contact') { skipped.push({ target_id: targetId, reason: `target_${target.status}` }); continue; }
    // no duplicate contact: skip if an open/contacted task already exists.
    const [existing] = await query(
      "SELECT id FROM partner_contact_tasks WHERE tenant_id=? AND target_id=? AND status NOT IN ('skipped','blocked','do_not_contact') LIMIT 1",
      [tenantId, targetId],
    );
    if (existing) { skipped.push({ target_id: targetId, reason: 'task_exists' }); continue; }

    const baseVars = {
      company_name: target.company_name,
      website_project: d.vars['website_project'] ?? d.vars['website___project'] ?? '',
      ...d.vars,
    };
    const rendered = tpl ? renderPartnerMessage(tpl, baseVars) : { subject: d.subject_override ?? '', body: '' };
    const subject = d.subject_override ?? rendered.subject;
    const body = rendered.body || '(no message — edit before sending)';
    const blockers: string[] = [];
    if (!body.trim() || body.includes('<<< REPLACE:')) blockers.push('message_has_unfilled_placeholders');
    if (!target.contact_form_url && !target.profile_url && !target.website_url) blockers.push('no_contact_url');
    const status = blockers.length ? 'pending_review' : 'ready';

    const r = await query(
      `INSERT INTO partner_contact_tasks
        (tenant_id, target_id, status, message_subject, message_body, contact_form_url, blockers_json, assigned_to, due_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [tenantId, targetId, status, subject || null, body, target.contact_form_url ?? target.profile_url ?? target.website_url ?? null,
       blockers.length ? JSON.stringify(blockers) : null, d.assigned_to ?? null, d.due_at ?? null],
    );
    await query("UPDATE partner_directory_targets SET status='queued' WHERE id=? AND tenant_id=? AND status IN ('new','selected')", [targetId, tenantId]);
    await bumpDaily(tenantId, null, 'tasks_created', 1);
    const [row] = await query('SELECT * FROM partner_contact_tasks WHERE id=?', [Number(r.insertId)]);
    created.push(row);
  }
  await audit(req, 'partner.tasks.create', { type: 'partner', id: undefined }, { created: created.length, skipped: skipped.length });
  res.json({ created, skipped, created_count: created.length });
});

partnerOutreachRouter.patch('/tasks/:id', requireWriteAccess, async (req, res) => {
  const tenantId = tid(req); const id = Number(req.params.id);
  const task = await loadTask(tenantId, id);
  if (!task) return res.status(404).json({ error: 'not_found' });
  const schema = z.object({
    status: z.enum(TASK_STATUS).optional(),
    message_subject: z.string().max(300).optional().nullable(),
    message_body: z.string().optional(),
    assigned_to: z.string().max(200).optional().nullable(),
    due_at: z.string().optional().nullable(),
  });
  const p = schema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'invalid' });
  const fields: string[] = []; const vals: any[] = [];
  for (const [k, v] of Object.entries(p.data)) { fields.push(`${k}=?`); vals.push(v); }
  if (fields.length) { vals.push(id, tenantId); await query(`UPDATE partner_contact_tasks SET ${fields.join(',')} WHERE id=? AND tenant_id=?`, vals); }
  const [row] = await query('SELECT * FROM partner_contact_tasks WHERE id=?', [id]);
  res.json({ task: row });
});

// Open the contact form (mark opened). No submission happens here.
partnerOutreachRouter.post('/tasks/:id/open', requireWriteAccess, async (req, res) => {
  const tenantId = tid(req); const id = Number(req.params.id);
  const task = await loadTask(tenantId, id);
  if (!task) return res.status(404).json({ error: 'not_found' });
  if (['ready', 'pending_review'].includes(task.status)) await query("UPDATE partner_contact_tasks SET status='opened' WHERE id=? AND tenant_id=?", [id, tenantId]);
  res.json({ ok: true, contact_form_url: task.contact_form_url });
});

// Copy the message (mark copied + write a 'copied' touchpoint). Still no submit.
partnerOutreachRouter.post('/tasks/:id/copy', requireWriteAccess, async (req, res) => {
  const tenantId = tid(req); const id = Number(req.params.id);
  const task = await loadTask(tenantId, id);
  if (!task) return res.status(404).json({ error: 'not_found' });
  const target = await loadTarget(tenantId, task.target_id);
  if (['ready', 'pending_review', 'opened'].includes(task.status)) await query("UPDATE partner_contact_tasks SET status='copied' WHERE id=? AND tenant_id=?", [id, tenantId]);
  await recordPartnerTouch({
    tenantId, companyId: target?.company_id ?? null, targetId: task.target_id, taskId: id,
    status: 'copied', subject: task.message_subject, body: task.message_body,
  });
  await audit(req, 'partner.task.copy', { type: 'partner_task', id }, {});
  res.json({ ok: true, subject: task.message_subject, body: task.message_body, contact_form_url: task.contact_form_url });
});

// Mark submitted MANUALLY by the operator (rate-limited per source per day).
partnerOutreachRouter.post('/tasks/:id/mark-submitted', requireWriteAccess, async (req, res) => {
  const tenantId = tid(req); const id = Number(req.params.id);
  const task = await loadTask(tenantId, id);
  if (!task) return res.status(404).json({ error: 'not_found' });
  const target = await loadTarget(tenantId, task.target_id);
  if (target && (target.status === 'do_not_contact' || target.status === 'blocked')) return res.status(412).json({ error: 'target_suppressed' });
  const sourceId = target?.source_id ?? null;
  const { submissions } = await getDailyCounts(tenantId, sourceId);
  if (submissions >= MAX_SUBMISSIONS_PER_SOURCE_PER_DAY) {
    return res.status(429).json({ error: 'daily_submission_limit', max: MAX_SUBMISSIONS_PER_SOURCE_PER_DAY, submitted_today: submissions });
  }
  await query("UPDATE partner_contact_tasks SET status='submitted_manually', submitted_at=NOW() WHERE id=? AND tenant_id=?", [id, tenantId]);
  await query(
    "UPDATE partner_directory_targets SET status='contacted', last_contacted_at=NOW(), contact_attempt_count=contact_attempt_count+1 WHERE id=? AND tenant_id=?",
    [task.target_id, tenantId],
  );
  await bumpDaily(tenantId, sourceId, 'submissions', 1);
  await recordPartnerTouch({
    tenantId, companyId: target?.company_id ?? null, targetId: task.target_id, taskId: id,
    status: 'sent_manual', subject: task.message_subject, body: task.message_body,
  });
  await audit(req, 'partner.task.submitted_manually', { type: 'partner_task', id }, { source_id: sourceId });
  res.json({ ok: true });
});

partnerOutreachRouter.post('/tasks/:id/skip', requireWriteAccess, async (req, res) => {
  const tenantId = tid(req); const id = Number(req.params.id);
  const task = await loadTask(tenantId, id);
  if (!task) return res.status(404).json({ error: 'not_found' });
  await query("UPDATE partner_contact_tasks SET status='skipped' WHERE id=? AND tenant_id=?", [id, tenantId]);
  await query("UPDATE partner_directory_targets SET status='skipped' WHERE id=? AND tenant_id=? AND status IN ('queued','new','selected')", [task.target_id, tenantId]);
  res.json({ ok: true });
});

partnerOutreachRouter.post('/tasks/:id/do-not-contact', requireWriteAccess, async (req, res) => {
  const tenantId = tid(req); const id = Number(req.params.id);
  const task = await loadTask(tenantId, id);
  if (!task) return res.status(404).json({ error: 'not_found' });
  await query("UPDATE partner_contact_tasks SET status='do_not_contact' WHERE id=? AND tenant_id=?", [id, tenantId]);
  await query("UPDATE partner_directory_targets SET status='do_not_contact' WHERE id=? AND tenant_id=?", [task.target_id, tenantId]);
  const target = await loadTarget(tenantId, task.target_id);
  await recordPartnerTouch({ tenantId, companyId: target?.company_id ?? null, targetId: task.target_id, taskId: id, status: 'blocked', touchType: 'manual_note' });
  await audit(req, 'partner.task.do_not_contact', { type: 'partner_task', id }, {});
  res.json({ ok: true });
});

// Mark a reply to a contacted task (inbound touchpoint, stop follow-ups).
partnerOutreachRouter.post('/tasks/:id/reply', requireWriteAccess, async (req, res) => {
  const tenantId = tid(req); const id = Number(req.params.id);
  const task = await loadTask(tenantId, id);
  if (!task) return res.status(404).json({ error: 'not_found' });
  const outcome = z.enum(['replied', 'interested', 'not_interested']).safeParse(req.body?.outcome);
  const o = outcome.success ? outcome.data : 'replied';
  await query("UPDATE partner_contact_tasks SET status='replied' WHERE id=? AND tenant_id=?", [id, tenantId]);
  await query('UPDATE partner_directory_targets SET status=? WHERE id=? AND tenant_id=?', [o, task.target_id, tenantId]);
  const target = await loadTarget(tenantId, task.target_id);
  await recordPartnerTouch({
    tenantId, companyId: target?.company_id ?? null, targetId: task.target_id, taskId: id,
    status: 'replied', direction: 'inbound', touchType: 'reply',
  });
  res.json({ ok: true });
});

// ── Today (operator dashboard) ───────────────────────────────────────────────
partnerOutreachRouter.get('/today', async (req, res) => {
  const tenantId = tid(req);
  const targetStatus = await query('SELECT status, COUNT(*) n FROM partner_directory_targets WHERE tenant_id=? GROUP BY status', [tenantId]);
  const taskStatus = await query('SELECT status, COUNT(*) n FROM partner_contact_tasks WHERE tenant_id=? GROUP BY status', [tenantId]);
  const { tasks_created } = await getDailyCounts(tenantId, null);
  const subsRows = await query(
    "SELECT COALESCE(SUM(submissions),0) n FROM partner_outreach_daily WHERE tenant_id=? AND ymd=DATE_FORMAT(UTC_DATE(),'%Y-%m-%d')",
    [tenantId],
  );
  const ready = (taskStatus.find((r: any) => r.status === 'ready')?.n) ?? 0;
  const pending = (taskStatus.find((r: any) => r.status === 'pending_review')?.n) ?? 0;
  let nextAction = 'Import partner companies, then create contact-form tasks.';
  if (Number(ready) > 0) nextAction = `${ready} task(s) ready — open the form, copy the message, submit manually, then mark submitted.`;
  else if (Number(pending) > 0) nextAction = `${pending} task(s) need review (unfilled placeholders or missing contact URL).`;
  res.json({
    targets_by_status: Object.fromEntries(targetStatus.map((r: any) => [r.status, Number(r.n)])),
    tasks_by_status: Object.fromEntries(taskStatus.map((r: any) => [r.status, Number(r.n)])),
    tasks_created_today: Number(tasks_created),
    submissions_today: Number(subsRows[0]?.n ?? 0),
    limits: { max_tasks_per_day: MAX_TASKS_PER_DAY, max_submissions_per_source_per_day: MAX_SUBMISSIONS_PER_SOURCE_PER_DAY },
    next_action: nextAction,
    warnings: SAFETY_WARNINGS,
  });
});
