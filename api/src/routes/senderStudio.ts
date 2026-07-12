import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { authMiddleware, requireTenant, requireWriteAccess } from '../middleware/auth.js';
import { audit } from '../middleware/audit.js';
import {
  CATEGORIES, VAR_LABELS, DEMO_VARS, validateTemplate, renderPreview, variablesUsed,
  sanitizeHtml, blocksToHtml, blocksToPlainText, plainTextToHtml, wrapEmailHtml,
  defaultFooter, DEFAULT_COLD_FOOTER, DEFAULT_UNSUBSCRIBE_FOOTER, type Block,
} from '../services/senderStudio.js';

// Phase 22C — Sender Studio.
// Create / edit / preview / validate / approve / version email templates BEFORE
// any real sending. NO send endpoint lives here. Tenant-isolated throughout.

export const senderStudioRouter = Router();
senderStudioRouter.use(authMiddleware, requireTenant);

const EDITOR_MODES = ['plain', 'html', 'visual_lite'] as const;
const LANGS = ['en', 'ru', 'uk'] as const;
const STATUSES = ['draft', 'approved', 'archived'] as const;

// Columns Sender Studio reads from manual_outreach_templates.
const TPL_COLS = `id, template_key, name, angle, subject, preheader, body, html_body,
  blocks_json, category, language, status, editor_mode, use_case, safety_status,
  version, approved, approved_at, approved_by, created_at, updated_at`;

// ── Clients.Help pack (Part 11) — seeded UNAPPROVED, idempotent ──────────────
const SHARED_COLD_FOOTER = `\n\nBest,\n{{sender_name}}\n{{sender_company}}\n\nIf this is not relevant, reply "no" and I won't contact you again.\n\nBusiness address: {{business_address}}`;

const CH_PACK = [
  {
    template_key: 'ch_first_touch_no_ps', name: 'Clients.Help first-touch — no P.S.',
    category: 'cold_first_touch', angle: 'first_touch',
    subject: 'Enquiries from the {{company}} website',
    intro: `Hi,\n\nI came across {{company}} while looking at {{service}} around {{city}}. Many small firms quietly lose website enquiries that arrive after hours — nobody is there to reply, so the visitor moves on.\n\nWe run Clients.Help: it catches those website chats and missed enquiries and forwards them to you as a normal message. Nothing to install, no long contract.\n\nWorth a quick look?`,
    ps: '',
  },
  {
    template_key: 'ch_first_touch_ps', name: 'Clients.Help first-touch — with remote IT P.S.',
    category: 'remote_it_ps', angle: 'first_touch_ps',
    subject: 'Enquiries from the {{company}} website',
    intro: `Hi,\n\nI came across {{company}} while looking at {{service}} around {{city}}. Many small firms quietly lose website enquiries that arrive after hours — nobody is there to reply, so the visitor moves on.\n\nWe run Clients.Help: it catches those website chats and missed enquiries and forwards them to you as a normal message. Nothing to install, no long contract.\n\nWorth a quick look?`,
    ps: '\n\nP.S. We also help businesses remotely with website, WordPress, automation, and small IT tasks when needed.',
  },
  {
    template_key: 'ch_followup_1_no_ps', name: 'Clients.Help follow-up 1 — no P.S.',
    category: 'cold_followup', angle: 'followup',
    subject: 'Re: Enquiries from the {{company}} website',
    intro: `Hi,\n\nJust floating this back up in case it slipped past. The idea is simple: catch the enquiries {{company}} currently misses outside hours and get them to you straight away.\n\nHappy to send a one-line example of how it would look for you.`,
    ps: '',
  },
  {
    template_key: 'ch_followup_1_ps', name: 'Clients.Help follow-up 1 — with remote IT P.S.',
    category: 'remote_it_ps', angle: 'followup_ps',
    subject: 'Re: Enquiries from the {{company}} website',
    intro: `Hi,\n\nJust floating this back up in case it slipped past. The idea is simple: catch the enquiries {{company}} currently misses outside hours and get them to you straight away.\n\nHappy to send a one-line example of how it would look for you.`,
    ps: '\n\nP.S. We also help businesses remotely with website, WordPress, automation, and small IT tasks when needed.',
  },
  {
    template_key: 'ch_followup_2_final', name: 'Clients.Help follow-up 2 — short final check',
    category: 'cold_followup', angle: 'followup_final',
    subject: 'Last note re {{company}}',
    intro: `Hi,\n\nI'll leave it here so I'm not cluttering your inbox. If catching missed website enquiries for {{company}} ever becomes a priority, just reply and I'll set it up in a few minutes.\n\nEither way, thanks for your time.`,
    ps: '',
  },
  {
    template_key: 'ch_wrong_person', name: 'Wrong person / referral request',
    category: 'clients_help_sales', angle: 'routing',
    subject: 'Right person at {{company}}?',
    intro: `Hi,\n\nApologies if this lands in the wrong inbox. I'm trying to reach whoever handles new enquiries and bookings at {{company}}.\n\nIf that's not you, could you point me the right way?`,
    ps: '',
  },
  {
    template_key: 'ch_interested_reply', name: 'Interested reply — response draft',
    category: 'clients_help_sales', angle: 'reply_interested',
    subject: 'Re: Enquiries from the {{company}} website',
    intro: `Hi,\n\nGreat to hear from you. In short: Clients.Help sits quietly on the {{company}} website, catches chats and after-hours enquiries, and forwards them to you as a normal message — email or Telegram, your choice.\n\nWould a quick 10-minute call this week suit, or shall I send a short setup link you can try yourself?`,
    ps: '',
  },
  {
    template_key: 'ch_not_now', name: 'Not now / permission to follow up later',
    category: 'clients_help_sales', angle: 'reply_not_now',
    subject: 'Re: Enquiries from the {{company}} website',
    intro: `Hi,\n\nUnderstood, and thanks for the honest reply. I won't keep emailing.\n\nWould it be alright if I checked back once in a few months, in case after-hours enquiries become more of a thing for {{company}}? If not, just say the word.`,
    ps: '',
  },
];

async function ensureClientsHelpPack(tenantId: number) {
  const existing = await query('SELECT template_key FROM manual_outreach_templates WHERE tenant_id=?', [tenantId]);
  const have = new Set(existing.map((r: any) => r.template_key));
  for (const t of CH_PACK) {
    if (have.has(t.template_key)) continue;
    const body = `${t.intro}${SHARED_COLD_FOOTER}${t.ps}`;
    const html = wrapEmailHtml(plainTextToHtml(body));
    await query(
      `INSERT INTO manual_outreach_templates
        (tenant_id, template_key, name, angle, subject, preheader, body, html_body,
         category, language, status, editor_mode, use_case, approved, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'en', 'draft', 'plain', ?, 0, 1)`,
      [tenantId, t.template_key, t.name, t.angle, t.subject, null, body, html,
       t.category, `Clients.Help outreach — ${t.angle}`],
    );
  }
}

// ── Meta (categories, variables, footers, editor modes) ──────────────────────
senderStudioRouter.get('/meta', (_req, res) => {
  res.json({
    categories: CATEGORIES,
    editorModes: EDITOR_MODES,
    languages: LANGS,
    statuses: STATUSES,
    variables: Object.entries(VAR_LABELS).map(([key, label]) => ({ key, label, demo: DEMO_VARS[key] ?? null })),
    footers: { cold: DEFAULT_COLD_FOOTER, unsubscribe: DEFAULT_UNSUBSCRIBE_FOOTER },
    note: 'Variables are shown as <<< REPLACE: Label >>> in the UI and stored as {{key}} internally.',
  });
});

// Footer suggestion for a category.
senderStudioRouter.get('/footer', (req, res) => {
  const category = typeof req.query.category === 'string' ? req.query.category : 'generic_service';
  res.json({ category, footer: defaultFooter(category) });
});

// ── List templates (with validation + badges) ────────────────────────────────
senderStudioRouter.get('/templates', async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  await ensureClientsHelpPack(tenantId);
  const includeArchived = req.query.includeArchived === '1';
  const rows = await query(
    `SELECT ${TPL_COLS} FROM manual_outreach_templates WHERE tenant_id=? ${includeArchived ? '' : "AND status<>'archived'"} ORDER BY id ASC`,
    [tenantId],
  );
  const out = rows.map((r: any) => {
    const v = validateTemplate(r);
    return {
      ...r,
      validation: { status: v.status, canApprove: v.canApprove, badges: v.badges, issueCount: v.issues.length },
      statusBadge: r.status === 'archived' ? 'Archived' : r.approved ? 'Approved' : r.version > 1 ? 'Draft version' : 'Unapproved',
    };
  });
  res.json({ templates: out, total: out.length });
});

// ── Get single template (full validation + variables) ────────────────────────
senderStudioRouter.get('/templates/:id', async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const id = parseInt(req.params.id, 10);
  const [t] = await query(`SELECT ${TPL_COLS} FROM manual_outreach_templates WHERE id=? AND tenant_id=? LIMIT 1`, [id, tenantId]);
  if (!t) return res.status(404).json({ error: 'not_found' });
  res.json({ template: t, validation: validateTemplate(t), variables: variablesUsed(t) });
});

// ── Create template ──────────────────────────────────────────────────────────
const createSchema = z.object({
  name: z.string().min(1).max(160),
  subject: z.string().max(255).default(''),
  preheader: z.string().max(255).optional(),
  body: z.string().max(20000).default(''),
  htmlBody: z.string().max(60000).optional(),
  blocks: z.array(z.any()).optional(),
  category: z.enum(CATEGORIES).default('generic_service'),
  language: z.enum(LANGS).default('en'),
  editorMode: z.enum(EDITOR_MODES).default('plain'),
  useCase: z.string().max(255).optional(),
  templateKey: z.string().max(60).optional(),
});

function slugKey(name: string): string {
  return 'ss_' + name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50) + '_' + Math.random().toString(36).slice(2, 6);
}

senderStudioRouter.post('/templates', requireWriteAccess, async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const p = createSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'invalid_body', detail: p.error.issues });
  const d = p.data;
  // Derive bodies from editor mode.
  let body = d.body, html = d.htmlBody ?? null, blocksJson: string | null = null;
  if (d.editorMode === 'visual_lite' && d.blocks) {
    blocksJson = JSON.stringify(d.blocks as Block[]);
    html = wrapEmailHtml(blocksToHtml(d.blocks as Block[]), d.preheader);
    if (!body) body = blocksToPlainText(d.blocks as Block[]);
  } else if (d.editorMode === 'html' && html) {
    html = sanitizeHtml(html);
  }
  const key = d.templateKey || slugKey(d.name);
  try {
    const r = await query(
      `INSERT INTO manual_outreach_templates
        (tenant_id, template_key, name, subject, preheader, body, html_body, blocks_json,
         category, language, status, editor_mode, use_case, approved, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, 0, 1)`,
      [tenantId, key, d.name, d.subject, d.preheader ?? null, body, html, blocksJson,
       d.category, d.language, d.editorMode, d.useCase ?? null],
    );
    await audit(req, 'sender_studio.create', { type: 'manual_template', id: Number(r.insertId) }, { name: d.name, category: d.category });
    res.status(201).json({ id: Number(r.insertId), templateKey: key });
  } catch (e: any) {
    if (e?.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'duplicate_key' });
    throw e;
  }
});

// ── Edit template (versioning: editing an APPROVED template snapshots the old
//    approved version and drops the live row back to draft/unapproved) ─────────
const editSchema = z.object({
  name: z.string().min(1).max(160).optional(),
  subject: z.string().max(255).optional(),
  preheader: z.string().max(255).nullable().optional(),
  body: z.string().max(20000).optional(),
  htmlBody: z.string().max(60000).nullable().optional(),
  blocks: z.array(z.any()).nullable().optional(),
  category: z.enum(CATEGORIES).optional(),
  language: z.enum(LANGS).optional(),
  editorMode: z.enum(EDITOR_MODES).optional(),
  useCase: z.string().max(255).nullable().optional(),
});

async function snapshotVersion(tenantId: number, t: any, approvalStatus: string, userId: number | null) {
  await query(
    `INSERT INTO manual_outreach_template_versions
      (tenant_id, template_id, version_number, name, subject, preheader, body, html_body,
       blocks_json, category, language, editor_mode, approval_status, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [tenantId, t.id, t.version, t.name, t.subject, t.preheader, t.body, t.html_body,
     t.blocks_json, t.category, t.language, t.editor_mode, approvalStatus, userId],
  ).catch((e: any) => { if (e?.code !== 'ER_DUP_ENTRY') throw e; });
}

senderStudioRouter.patch('/templates/:id', requireWriteAccess, async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const id = parseInt(req.params.id, 10);
  const p = editSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'invalid_body', detail: p.error.issues });
  const [t] = await query(`SELECT ${TPL_COLS} FROM manual_outreach_templates WHERE id=? AND tenant_id=? LIMIT 1`, [id, tenantId]);
  if (!t) return res.status(404).json({ error: 'not_found' });
  if (t.status === 'archived') return res.status(409).json({ error: 'archived', detail: 'Unarchive before editing.' });

  const d = p.data;
  const wasApproved = !!t.approved;
  let versioned = false;
  // If editing an approved template, keep the approved version as history.
  if (wasApproved) {
    await snapshotVersion(tenantId, t, 'approved', req.auth!.userId ?? null);
    versioned = true;
  }

  const sets: string[] = []; const vals: any[] = [];
  const set = (col: string, val: any) => { sets.push(`${col}=?`); vals.push(val); };
  if (d.name !== undefined) set('name', d.name);
  if (d.subject !== undefined) set('subject', d.subject);
  if (d.preheader !== undefined) set('preheader', d.preheader);
  if (d.category !== undefined) set('category', d.category);
  if (d.language !== undefined) set('language', d.language);
  if (d.useCase !== undefined) set('use_case', d.useCase);
  if (d.editorMode !== undefined) set('editor_mode', d.editorMode);

  // Body / html / blocks coherence.
  const mode = d.editorMode ?? t.editor_mode;
  if (d.blocks !== undefined || mode === 'visual_lite') {
    const blocks = (d.blocks ?? (t.blocks_json ? JSON.parse(t.blocks_json) : [])) as Block[];
    if (d.blocks !== undefined) set('blocks_json', d.blocks ? JSON.stringify(d.blocks) : null);
    if (mode === 'visual_lite') {
      set('html_body', wrapEmailHtml(blocksToHtml(blocks), d.preheader ?? t.preheader));
      if (d.body === undefined) set('body', blocksToPlainText(blocks));
    }
  }
  if (d.body !== undefined) set('body', d.body);
  if (d.htmlBody !== undefined) set('html_body', d.htmlBody ? sanitizeHtml(d.htmlBody) : null);

  // Edits to an approved template revert it to an unapproved draft + bump version.
  if (wasApproved) {
    set('approved', 0); set('approved_at', null); set('approved_by', null);
    set('status', 'draft'); set('version', Number(t.version) + 1);
  }
  if (!sets.length) return res.json({ ok: true, unchanged: true });
  vals.push(id);
  await query(`UPDATE manual_outreach_templates SET ${sets.join(', ')} WHERE id=?`, vals);
  await audit(req, 'sender_studio.edit', { type: 'manual_template', id }, { fields: Object.keys(d), versioned });
  res.json({ ok: true, versioned, revertedToDraft: wasApproved, newVersion: wasApproved ? Number(t.version) + 1 : t.version });
});

// ── Duplicate ────────────────────────────────────────────────────────────────
senderStudioRouter.post('/templates/:id/duplicate', requireWriteAccess, async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const id = parseInt(req.params.id, 10);
  const [t] = await query(`SELECT ${TPL_COLS} FROM manual_outreach_templates WHERE id=? AND tenant_id=? LIMIT 1`, [id, tenantId]);
  if (!t) return res.status(404).json({ error: 'not_found' });
  const key = slugKey(t.name + ' copy');
  const r = await query(
    `INSERT INTO manual_outreach_templates
      (tenant_id, template_key, name, angle, subject, preheader, body, html_body, blocks_json,
       category, language, status, editor_mode, use_case, approved, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, 0, 1)`,
    [tenantId, key, `${t.name} (copy)`, t.angle, t.subject, t.preheader, t.body, t.html_body, t.blocks_json,
     t.category, t.language, t.editor_mode, t.use_case],
  );
  await audit(req, 'sender_studio.duplicate', { type: 'manual_template', id: Number(r.insertId) }, { from: id });
  res.status(201).json({ id: Number(r.insertId), templateKey: key });
});

// ── Archive / unarchive ──────────────────────────────────────────────────────
senderStudioRouter.post('/templates/:id/archive', requireWriteAccess, async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const id = parseInt(req.params.id, 10);
  const [t] = await query('SELECT id FROM manual_outreach_templates WHERE id=? AND tenant_id=? LIMIT 1', [id, tenantId]);
  if (!t) return res.status(404).json({ error: 'not_found' });
  await query("UPDATE manual_outreach_templates SET status='archived', approved=0, approved_at=NULL WHERE id=?", [id]);
  await audit(req, 'sender_studio.archive', { type: 'manual_template', id }, {});
  res.json({ ok: true, status: 'archived' });
});

senderStudioRouter.post('/templates/:id/unarchive', requireWriteAccess, async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const id = parseInt(req.params.id, 10);
  const [t] = await query('SELECT id FROM manual_outreach_templates WHERE id=? AND tenant_id=? LIMIT 1', [id, tenantId]);
  if (!t) return res.status(404).json({ error: 'not_found' });
  await query("UPDATE manual_outreach_templates SET status='draft' WHERE id=?", [id]);
  await audit(req, 'sender_studio.unarchive', { type: 'manual_template', id }, {});
  res.json({ ok: true, status: 'draft' });
});

// ── Approve / unapprove (approval BLOCKED on critical validation issues) ──────
senderStudioRouter.post('/templates/:id/approve', requireWriteAccess, async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const id = parseInt(req.params.id, 10);
  const [t] = await query(`SELECT ${TPL_COLS} FROM manual_outreach_templates WHERE id=? AND tenant_id=? LIMIT 1`, [id, tenantId]);
  if (!t) return res.status(404).json({ error: 'not_found' });
  if (t.status === 'archived') return res.status(409).json({ error: 'archived' });
  const v = validateTemplate(t);
  if (!v.canApprove) {
    return res.status(412).json({ error: 'approval_blocked', blockers: v.issues.filter((i) => i.level === 'block'), status: v.status });
  }
  await query(
    "UPDATE manual_outreach_templates SET approved=1, status='approved', approved_at=NOW(), approved_by=?, safety_status=? WHERE id=?",
    [req.auth!.userId ?? null, v.status, id],
  );
  await snapshotVersion(tenantId, t, 'approved', req.auth!.userId ?? null);
  await audit(req, 'sender_studio.approve', { type: 'manual_template', id }, { status: v.status, warnings: v.issues.filter((i) => i.level === 'warn').length });
  res.json({ ok: true, approved: true, status: v.status, warnings: v.issues.filter((i) => i.level === 'warn') });
});

senderStudioRouter.post('/templates/:id/unapprove', requireWriteAccess, async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const id = parseInt(req.params.id, 10);
  const [t] = await query('SELECT id FROM manual_outreach_templates WHERE id=? AND tenant_id=? LIMIT 1', [id, tenantId]);
  if (!t) return res.status(404).json({ error: 'not_found' });
  await query("UPDATE manual_outreach_templates SET approved=0, status='draft', approved_at=NULL, approved_by=NULL WHERE id=?", [id]);
  await audit(req, 'sender_studio.unapprove', { type: 'manual_template', id }, {});
  res.json({ ok: true, approved: false });
});

// ── Validate (saved template) ────────────────────────────────────────────────
senderStudioRouter.get('/templates/:id/validate', async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const id = parseInt(req.params.id, 10);
  const [t] = await query(`SELECT ${TPL_COLS} FROM manual_outreach_templates WHERE id=? AND tenant_id=? LIMIT 1`, [id, tenantId]);
  if (!t) return res.status(404).json({ error: 'not_found' });
  res.json(validateTemplate(t));
});

// ── Ad-hoc validate (live editor, nothing saved) ─────────────────────────────
const adhocSchema = z.object({
  subject: z.string().max(255).optional(),
  preheader: z.string().max(255).optional(),
  body: z.string().max(20000).optional(),
  htmlBody: z.string().max(60000).optional(),
  blocks: z.array(z.any()).optional(),
  category: z.enum(CATEGORIES).optional(),
  editorMode: z.enum(EDITOR_MODES).optional(),
});
senderStudioRouter.post('/validate', async (req, res) => {
  const p = adhocSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'invalid_body', detail: p.error.issues });
  const d = p.data;
  let html = d.htmlBody ?? null, body = d.body ?? '';
  if (d.editorMode === 'visual_lite' && d.blocks) {
    html = wrapEmailHtml(blocksToHtml(d.blocks as Block[]), d.preheader);
    if (!body) body = blocksToPlainText(d.blocks as Block[]);
  }
  res.json(validateTemplate({ subject: d.subject, preheader: d.preheader, body, html_body: html, category: d.category, editor_mode: d.editorMode }));
});

// ── Ad-hoc preview (live editor) ─────────────────────────────────────────────
senderStudioRouter.post('/preview', async (req, res) => {
  const p = adhocSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'invalid_body', detail: p.error.issues });
  const d = p.data;
  const dataMode = req.query.data === 'human' ? 'human' : 'variable';
  const blocksJson = d.blocks ? JSON.stringify(d.blocks) : null;
  const out = renderPreview(
    { subject: d.subject, preheader: d.preheader, body: d.body, html_body: d.htmlBody ?? null, blocks_json: blocksJson, editor_mode: d.editorMode },
    dataMode,
  );
  res.json({ dataMode, ...out });
});

// ── Preview a saved template (desktop/mobile/dark all use same HTML; client
//    sizes the viewport. plain + html source modes return raw) ────────────────
senderStudioRouter.get('/templates/:id/preview', async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const id = parseInt(req.params.id, 10);
  const [t] = await query(`SELECT ${TPL_COLS} FROM manual_outreach_templates WHERE id=? AND tenant_id=? LIMIT 1`, [id, tenantId]);
  if (!t) return res.status(404).json({ error: 'not_found' });
  const dataMode = req.query.data === 'human' ? 'human' : 'variable';
  const out = renderPreview(t, dataMode);
  res.json({
    dataMode,
    subject: out.subject, preheader: out.preheader,
    html: out.html, text: out.text,
    fromName: '{{sender_name}}',
    variables: variablesUsed(t),
    validation: validateTemplate(t),
  });
});

// ── Versions ─────────────────────────────────────────────────────────────────
senderStudioRouter.get('/templates/:id/versions', async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const id = parseInt(req.params.id, 10);
  const [t] = await query('SELECT id, version FROM manual_outreach_templates WHERE id=? AND tenant_id=? LIMIT 1', [id, tenantId]);
  if (!t) return res.status(404).json({ error: 'not_found' });
  const rows = await query(
    `SELECT id, version_number, name, subject, approval_status, created_by, created_at
     FROM manual_outreach_template_versions WHERE tenant_id=? AND template_id=? ORDER BY version_number DESC`,
    [tenantId, id],
  );
  res.json({ currentVersion: t.version, versions: rows });
});

// ── Export ───────────────────────────────────────────────────────────────────
senderStudioRouter.get('/templates/:id/export', async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const id = parseInt(req.params.id, 10);
  const fmt = typeof req.query.format === 'string' ? req.query.format : 'json';
  const [t] = await query(`SELECT ${TPL_COLS} FROM manual_outreach_templates WHERE id=? AND tenant_id=? LIMIT 1`, [id, tenantId]);
  if (!t) return res.status(404).json({ error: 'not_found' });
  if (fmt === 'html') {
    const out = renderPreview(t, 'variable');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="${t.template_key}.html"`);
    return res.send(out.html);
  }
  if (fmt === 'txt') {
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="${t.template_key}.txt"`);
    return res.send(`Subject: ${t.subject}\n\n${t.body}`);
  }
  const json = {
    name: t.name, subject: t.subject, preheader: t.preheader, body: t.body,
    htmlBody: t.html_body, blocks: t.blocks_json ? JSON.parse(t.blocks_json) : null,
    category: t.category, language: t.language, editorMode: t.editor_mode, useCase: t.use_case,
    exportedAt: new Date().toISOString(), source: 'emails.cheap/sender-studio',
  };
  res.setHeader('content-type', 'application/json');
  res.setHeader('content-disposition', `attachment; filename="${t.template_key}.json"`);
  res.send(JSON.stringify(json, null, 2));
});

// ── Import (JSON) — always lands as a new UNAPPROVED draft; HTML sanitised ────
const importSchema = z.object({
  name: z.string().min(1).max(160),
  subject: z.string().max(255).default(''),
  preheader: z.string().max(255).optional(),
  body: z.string().max(20000).default(''),
  htmlBody: z.string().max(60000).optional(),
  blocks: z.array(z.any()).optional(),
  category: z.enum(CATEGORIES).default('generic_service'),
  language: z.enum(LANGS).default('en'),
  editorMode: z.enum(EDITOR_MODES).default('plain'),
  useCase: z.string().max(255).optional(),
});
senderStudioRouter.post('/import', requireWriteAccess, async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const p = importSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'invalid_body', detail: p.error.issues });
  const d = p.data;
  const html = d.htmlBody ? sanitizeHtml(d.htmlBody) : null;
  const blocksJson = d.blocks ? JSON.stringify(d.blocks) : null;
  const key = slugKey('import ' + d.name);
  const r = await query(
    `INSERT INTO manual_outreach_templates
      (tenant_id, template_key, name, subject, preheader, body, html_body, blocks_json,
       category, language, status, editor_mode, use_case, approved, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, 0, 1)`,
    [tenantId, key, d.name, d.subject, d.preheader ?? null, d.body, html, blocksJson,
     d.category, d.language, d.editorMode, d.useCase ?? null],
  );
  await audit(req, 'sender_studio.import', { type: 'manual_template', id: Number(r.insertId) }, { name: d.name });
  res.status(201).json({ id: Number(r.insertId), templateKey: key, sanitized: !!d.htmlBody, note: 'Imported as UNAPPROVED draft. HTML was sanitised.' });
});

// Seed/refresh the Clients.Help pack on demand.
senderStudioRouter.post('/seed-clients-help', requireWriteAccess, async (req, res) => {
  await ensureClientsHelpPack(req.auth!.tenantId!);
  await audit(req, 'sender_studio.seed_pack', { type: 'manual_template' }, { pack: 'clients_help' });
  res.json({ ok: true, note: 'Clients.Help pack ensured (all UNAPPROVED).' });
});
