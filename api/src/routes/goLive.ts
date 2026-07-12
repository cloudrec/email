import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { authMiddleware, requireTenant, requireWriteAccess } from '../middleware/auth.js';
import { audit } from '../middleware/audit.js';
import { config } from '../config.js';
import {
  buildCohort, ensureTemplates, isEmailSuppressed, renderTemplate,
  QUEUE_DEFAULT_MAX, QUEUE_HARD_MAX, DEFAULT_DAILY,
} from './manualOutreach.js';
import {
  assignMailboxes, priorMailboxMaps, rollMailboxCounters,
  type AssignItem,
} from '../services/mailboxFleet.js';

// ═══════════════════════════════════════════════════════════════════════════
// Phase 22E — Go-Live Wizard / First Outreach Control Center.
// Operator-first, guided first launch. Read/triage + ONE safe queue builder.
// HARD RULES (never crossed here):
//   · NO real send, NO production SMTP toggle, NO campaign scheduling.
//   · NO mass subscribe, NO mass export, NO "send all" button.
//   · Lead step = SELECT EXISTING Warehouse contact_points ONLY.
//     NO Tavily / OSM / Google Maps / collector / scraper / enrichment here.
//   · create-first-queue makes ≤20 pending_review items from EXISTING eligible
//     contact_points, assigns mailboxes, sends nothing, subscribes nobody.
// ═══════════════════════════════════════════════════════════════════════════

export const goLiveRouter = Router();
goLiveRouter.use(authMiddleware, requireTenant);

const GO_LIVE_FIRST_SELECTION = 20;     // recommended first selection from Warehouse
const GO_LIVE_DAY1_CAP = 5;             // recommended day-1 manual sends total
const CLIENTS_HELP_INDUSTRIES = ['cleaning', 'dental', 'plumb', 'electric', 'salon', 'wordpress'];

// True production SMTP = a real host that is NOT mailhog and NOT empty.
function smtpState() {
  const host = (config.smtp.host || '').toLowerCase();
  const isMailhog = host === '' || host === 'mailhog' || host.includes('mailhog');
  return {
    host: host || '(unset)',
    productionReady: !isMailhog && !!config.smtp.fromAddress,
    mode: isMailhog ? 'test_only_mailhog' : 'configured',
  };
}

// Count EXISTING eligible contact_points using the SAME safety rules the
// queue builder uses (verified · has email · not suppressed global/tenant ·
// not already queued). No discovery, no enrichment — pure read of Warehouse.
async function countEligibleExisting(
  tenantId: number, opts: { country?: string; industries?: string[]; clientsHelpFit?: boolean },
): Promise<{ total: number; preset: number }> {
  // Broad: every verified, non-suppressed, not-already-queued email lead.
  const [{ c: total }] = await query(
    `SELECT COUNT(*) c FROM contact_points cp
     JOIN companies c ON c.id = cp.company_id
     WHERE cp.type='email' AND cp.status='verified' AND cp.value IS NOT NULL AND cp.value <> ''
       AND cp.value NOT IN (SELECT email FROM suppressions WHERE tenant_id=?)
       AND LOWER(cp.value) NOT IN (SELECT normalized_value FROM global_contact_suppression WHERE type='email')
       AND cp.email_domain NOT IN (SELECT normalized_value FROM global_contact_suppression WHERE type='domain')
       AND cp.value NOT IN (SELECT email FROM manual_outreach_queue WHERE tenant_id=?)`,
    [tenantId, tenantId],
  );

  // Preset: same as above + Clients.Help service-business industry hint.
  const industries = (opts.industries && opts.industries.length) ? opts.industries : CLIENTS_HELP_INDUSTRIES;
  const country = (opts.country ?? '').toUpperCase().slice(0, 2);
  const indLike = industries.map(() => '(c.category_primary LIKE ? OR c.category_secondary LIKE ? OR c.name LIKE ?)').join(' OR ');
  const indParams: any[] = [];
  for (const i of industries) { const w = `%${i}%`; indParams.push(w, w, w); }
  const [{ c: preset }] = await query(
    `SELECT COUNT(*) c FROM contact_points cp
     JOIN companies c ON c.id = cp.company_id
     WHERE cp.type='email' AND cp.status='verified' AND cp.value IS NOT NULL AND cp.value <> ''
       AND (? = '' OR c.country = ?)
       AND (${indLike})
       AND cp.value NOT IN (SELECT email FROM suppressions WHERE tenant_id=?)
       AND LOWER(cp.value) NOT IN (SELECT normalized_value FROM global_contact_suppression WHERE type='email')
       AND cp.email_domain NOT IN (SELECT normalized_value FROM global_contact_suppression WHERE type='domain')
       AND cp.value NOT IN (SELECT email FROM manual_outreach_queue WHERE tenant_id=?)`,
    [country, country, ...indParams, tenantId, tenantId],
  );
  return { total: Number(total), preset: Number(preset) };
}

// ── GET /go-live/status — live audit + 7-step checklist + score + next action ─
goLiveRouter.get('/status', async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  await ensureTemplates(tenantId);

  const smtp = smtpState();
  const providers = await query(
    'SELECT id, provider_type, name, status, inbound_enabled, outbound_enabled, test_status FROM sending_providers WHERE tenant_id=?',
    [tenantId],
  );
  const mailboxes = await query('SELECT * FROM sender_identities WHERE tenant_id=?', [tenantId]);
  const activeMailboxes = mailboxes.filter((m: any) => m.status === 'active');
  const smtpTested = mailboxes.filter((m: any) => m.last_smtp_test_at != null);
  const imapTested = mailboxes.filter((m: any) => m.last_imap_test_at != null);
  const inboundMailboxes = mailboxes.filter((m: any) => Number(m.inbound_enabled) === 1);

  const [tmpl] = await query(
    `SELECT SUM(approved=1) approved, COUNT(*) total,
            SUM(approved=1 AND category IN('cold_first_touch','remote_it_ps','clients_help_sales')) approved_first_touch
     FROM manual_outreach_templates WHERE tenant_id=?`, [tenantId],
  );
  const approvedTemplates = Number(tmpl?.approved || 0);
  const approvedFirstTouch = Number(tmpl?.approved_first_touch || 0);

  const elig = await countEligibleExisting(tenantId, {});

  const [q] = await query(
    `SELECT
       SUM(status='pending_review') pending_review, SUM(status='approved') approved,
       SUM(status='sent_smtp') sent_smtp, SUM(status='sent_manual') sent_manual,
       SUM(status='do_not_contact') do_not_contact,
       SUM(safety_status IN('suppressed','blocked')) blocked,
       SUM(mailbox_id IS NOT NULL) assigned, SUM(mailbox_id IS NULL) unassigned
     FROM manual_outreach_queue WHERE tenant_id=?`, [tenantId],
  );
  const [sup] = await query(
    'SELECT (SELECT COUNT(*) FROM suppressions WHERE tenant_id=?) tenant, (SELECT COUNT(*) FROM global_contact_suppression) global', [tenantId],
  );
  const [repl] = await query(
    `SELECT COUNT(*) total, SUM(handled=0) unhandled,
            SUM(classification='interested') interested,
            SUM(DATE(received_at)=CURDATE()) today
     FROM inbox_replies WHERE tenant_id=?`, [tenantId],
  );
  const [fu] = await query(
    "SELECT SUM(status IN('pending','ready') AND due_at<=NOW()+INTERVAL 1 DAY) due, SUM(status='blocked') blocked, SUM(status='cancelled') cancelled FROM manual_followup_tasks WHERE tenant_id=?",
    [tenantId],
  );

  // Real-world send count (system SMTP) + campaign schedule count — both must stay 0.
  let campaignScheduled = 0;
  try {
    const [cc] = await query("SELECT COUNT(*) c FROM campaigns WHERE tenant_id=? AND status='scheduled'", [tenantId]);
    campaignScheduled = Number(cc?.c || 0);
  } catch { campaignScheduled = 0; }
  const realSmtpSends = Number(q?.sent_smtp || 0);

  // ── Day-1 / today figures (per active mailbox, manual + smtp counters) ──
  let allowedToday = 0, sentToday = 0; const mailboxStatus: any[] = [];
  const today = new Date().toISOString().slice(0, 10);
  for (const m of mailboxes) {
    if (m.manual_counters_day && m.manual_counters_day.toISOString?.().slice(0, 10) !== today) m.manual_sent_today = 0;
    const used = Number(m.manual_sent_today || 0) + Number(m.sent_today || 0);
    if (m.status === 'active') { allowedToday += Number(m.daily_send_limit || 0); sentToday += used; }
    let health: 'safe' | 'warning' | 'danger' = 'safe';
    if (m.status !== 'active') health = 'danger';
    else if (Number(m.health_status === 'danger')) health = 'danger';
    else if (used >= Number(m.daily_send_limit || 0)) health = 'warning';
    mailboxStatus.push({
      id: m.id, email: m.from_email, status: m.status, purpose: m.purpose,
      inboundEnabled: !!m.inbound_enabled, smtpTested: m.last_smtp_test_at != null,
      imapTested: m.last_imap_test_at != null, dailyLimit: Number(m.daily_send_limit || 0),
      used, health, healthStatus: m.health_status, pausedReason: m.paused_reason ?? null,
    });
  }
  // Real remaining = operator-set mailbox daily limits minus what was sent.
  // The day-1 "5" is only an ADVISORY warmup suggestion, never a hard cap.
  const remainingToday = Math.max(0, allowedToday - sentToday);

  // ── Build the 7-step checklist ──
  const ST = (ready: boolean, blocked: boolean) => (ready ? 'ready' : blocked ? 'blocked' : 'needs_action');
  const steps = [
    {
      key: 'channel', title: 'Sending channel',
      status: ST(activeMailboxes.length > 0 && smtpTested.length > 0, providers.length === 0),
      checks: {
        providerProfile: providers.length > 0,
        mailboxExists: mailboxes.length > 0,
        mailboxActive: activeMailboxes.length > 0,
        smtpTestPassed: smtpTested.length > 0,
        imapTestPassed: imapTested.length > 0,
        inboundEnabled: inboundMailboxes.length > 0,
        productionSmtp: smtp.productionReady,
      },
      detail: { providers: providers.length, mailboxes: mailboxes.length, active: activeMailboxes.length, smtpTested: smtpTested.length, smtp },
      fix: activeMailboxes.length === 0 ? { text: 'No active mailbox. Go to Mailboxes → Add mailbox.', href: '/mailboxes' }
        : smtpTested.length === 0 ? { text: 'SMTP not tested. Test it in Mailboxes, or use copy-mode.', href: '/mailboxes' } : null,
    },
    {
      key: 'template', title: 'Template',
      status: ST(approvedTemplates > 0, false),
      checks: { anyApproved: approvedTemplates > 0, approvedFirstTouch: approvedFirstTouch > 0 },
      detail: { approved: approvedTemplates, approvedFirstTouch, total: Number(tmpl?.total || 0) },
      fix: approvedTemplates === 0 ? { text: 'No approved template. Go to Sender Studio → approve a Clients.Help first-touch.', href: '/sender-studio' } : null,
    },
    {
      key: 'select_leads', title: 'Select existing leads',
      status: ST(elig.total >= 1, false),
      checks: { warehouseHasEligible: elig.total > 0, enoughForFirstSelection: elig.total >= GO_LIVE_FIRST_SELECTION },
      detail: {
        eligibleExistingTotal: elig.total, eligibleClientsHelpPreset: elig.preset,
        recommendedFirstSelection: GO_LIVE_FIRST_SELECTION,
        filters: ['verified only', 'not invalid', 'not risky', 'not suppressed (global+tenant)', 'not unsubscribed/bounced/complained', 'has email', 'prefer company/website', 'prefer Clients.Help fit'],
        sources: ['existing_warehouse', 'manual_selected'],
        note: 'Selects from existing Warehouse contact_points only. No discovery/collector/enrichment.',
      },
      fix: elig.total === 0 ? { text: 'No eligible existing leads. Check suppression/verification in Warehouse.', href: '/warehouse' } : null,
    },
    {
      key: 'queue', title: 'Queue',
      status: ST(Number(q?.pending_review || 0) + Number(q?.approved || 0) > 0, false),
      checks: { hasItems: Number(q?.pending_review || 0) + Number(q?.approved || 0) > 0, allAssigned: Number(q?.unassigned || 0) === 0 },
      detail: {
        pendingReview: Number(q?.pending_review || 0), approved: Number(q?.approved || 0),
        blocked: Number(q?.blocked || 0), assigned: Number(q?.assigned || 0), unassigned: Number(q?.unassigned || 0),
        whyBlocked: Number(q?.blocked || 0) > 0 ? 'Some items suppressed/blocked — excluded from sending.' : null,
      },
      fix: (Number(q?.pending_review || 0) + Number(q?.approved || 0)) === 0
        ? { text: 'Queue empty. Use "Create safe first queue" below (max 20 existing leads).', href: '/go-live' } : null,
    },
    {
      key: 'day1', title: 'Day 1 sending',
      status: remainingToday > 0 ? 'ready' : (allowedToday > 0 ? 'blocked' : 'needs_action'),
      checks: { canSendToday: remainingToday > 0 },
      detail: { recommendedDay1: GO_LIVE_DAY1_CAP, allowedToday, sentToday, remainingToday, mode: smtpTested.length > 0 ? 'one_by_one_smtp' : 'copy_mode' },
      fix: remainingToday === 0 && allowedToday > 0 ? { text: 'Day 1 limit reached. Stop today.', href: null } : null,
    },
    {
      key: 'replies', title: 'Replies',
      status: inboundMailboxes.length > 0 ? 'ready' : 'needs_action',
      checks: { imapImportReady: inboundMailboxes.length > 0 && imapTested.length > 0 },
      detail: {
        inboundMailboxes: inboundMailboxes.length, imapTested: imapTested.length,
        repliesToday: Number(repl?.today || 0), interested: Number(repl?.interested || 0), unhandled: Number(repl?.unhandled || 0),
      },
      fix: inboundMailboxes.length === 0 ? { text: 'Enable IMAP on a mailbox to import replies (Mailboxes).', href: '/mailboxes' } : null,
    },
    {
      key: 'followups', title: 'Follow-ups',
      status: 'ready',
      checks: {},
      detail: { due: Number(fu?.due || 0), blocked: Number(fu?.blocked || 0), cancelledDueReply: Number(fu?.cancelled || 0), maxSteps: 2, note: 'Manual tasks only. Reply cancels follow-ups.' },
      fix: null,
    },
  ];

  // ── Readiness score 0–100 ──
  let score = 0;
  if (providers.length > 0) score += 10;
  if (mailboxes.length > 0) score += 10;
  if (activeMailboxes.length > 0) score += 10;
  if (smtpTested.length > 0) score += 20;
  if (approvedTemplates > 0) score += 25;
  if (elig.total >= GO_LIVE_FIRST_SELECTION) score += 15;
  else if (elig.total > 0) score += 8;
  if (Number(sup?.global || 0) >= 0) score += 5;   // suppression system reachable
  if (inboundMailboxes.length > 0 && imapTested.length > 0) score += 5;
  score = Math.min(100, score);

  // ── Operating status (deterministic) ──
  const paused = mailboxStatus.some((m) => m.status === 'paused' || m.health === 'danger' && m.status === 'active');
  let opStatus: string;
  if (paused) opStatus = 'Paused due risk';
  else if (realSmtpSends > 0) opStatus = 'Running safely';
  // One-by-one SMTP readiness depends on an ACTIVE mailbox whose SMTP test passed
  // (sends go through the mailbox/provider, NOT the campaign-engine config.smtp).
  else if (approvedTemplates > 0 && activeMailboxes.length > 0 && activeMailboxes.some((m: any) => m.last_smtp_test_at != null)) opStatus = 'Ready for one-by-one SMTP';
  else if (approvedTemplates > 0 && elig.total > 0) opStatus = 'Ready for manual copy-mode';
  else if (mailboxes.length > 0 || elig.total > 0) opStatus = 'Setup needed';
  else opStatus = 'Not ready';

  // ── Top blockers + single next action ──
  const blockers: Array<{ step: string; text: string; href: string | null }> = [];
  for (const s of steps) if (s.fix) blockers.push({ step: s.title, text: s.fix.text, href: s.fix.href });

  let nextAction = 'You are ready. Create a safe first queue of 20 existing leads, then send 5 on day 1.';
  if (approvedTemplates === 0) nextAction = 'No approved template. Go to Sender Studio → approve a Clients.Help first-touch.';
  else if (activeMailboxes.length === 0) nextAction = 'No active mailbox. Go to Mailboxes → add and activate one (or use copy-mode).';
  else if (smtpTested.length === 0 && !smtp.productionReady) nextAction = 'SMTP is test-only (mailhog). Use copy-mode, or configure + test a real mailbox.';
  else if ((Number(q?.pending_review || 0) + Number(q?.approved || 0)) === 0) nextAction = 'Create a safe first queue (max 20 existing verified leads).';
  else if (remainingToday === 0 && allowedToday > 0) nextAction = 'Day 1 limit reached. Stop today.';
  else if (Number(repl?.interested || 0) > 0) nextAction = `Reply to ${repl.interested} interested lead(s).`;

  res.json({
    audit: {
      smtp, productionSmtpEnabled: smtp.productionReady,
      providers: providers.length, providerProfiles: providers,
      mailboxesTotal: mailboxes.length, mailboxesActive: activeMailboxes.length,
      mailboxesSmtpPassed: smtpTested.length, mailboxesImapPassed: imapTested.length,
      templatesApproved: approvedTemplates, templatesTotal: Number(tmpl?.total || 0),
      contactPointsEligibleExisting: elig.total, contactPointsEligiblePreset: elig.preset,
      suppressions: { tenant: Number(sup?.tenant || 0), global: Number(sup?.global || 0) },
      manualQueue: q, inboxReplies: Number(repl?.total || 0), followups: fu,
      realWorldSmtpSends: realSmtpSends, campaignScheduled,
    },
    steps,
    readiness: { score, status: opStatus, topBlockers: blockers.slice(0, 5), nextAction },
    today: {
      activeMailboxes: activeMailboxes.length, recommendedDay1: GO_LIVE_DAY1_CAP,
      allowedToday, sentToday, remainingToday, queueReady: Number(q?.approved || 0),
      queuePending: Number(q?.pending_review || 0), followupsDue: Number(fu?.due || 0),
      repliesToReview: Number(repl?.unhandled || 0), suppressionsToday: null, mailboxStatus,
    },
    clientsHelpPreset: {
      product: 'Clients.Help', templateCategory: 'clients_help_sales',
      firstSelectionSize: GO_LIVE_FIRST_SELECTION, day1Cap: GO_LIVE_DAY1_CAP,
      target: 'local service businesses',
      industries: CLIENTS_HELP_INDUSTRIES,
    },
    safety: {
      realEmailsSent: realSmtpSends, productionSmtpEnabled: smtp.productionReady,
      campaignScheduled, sendAllButton: false, autoSend: false,
      leadDiscoveryInWizard: false, note: 'Wizard selects existing leads only; never discovers, sends, or schedules.',
    },
  });
});

// ── POST /go-live/plan — first outreach plan generator (pure compute) ─────────
const planSchema = z.object({
  mailboxCount: z.coerce.number().int().min(0).max(50).optional(),
  dayNumber: z.coerce.number().int().min(1).max(60).optional(),
  desiredDaily: z.coerce.number().int().min(0).max(500).optional(),
  templateKey: z.string().max(60).optional(),
  cohortSize: z.coerce.number().int().min(0).max(QUEUE_HARD_MAX).optional(),
});
goLiveRouter.post('/plan', async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const p = planSchema.safeParse(req.body ?? {});
  if (!p.success) return res.status(400).json({ error: 'invalid_body', detail: p.error.issues });

  // Resolve real counts when caller omits them.
  const healthy = await query(
    "SELECT id, from_email, daily_send_limit, health_status, status FROM sender_identities WHERE tenant_id=? AND status='active'", [tenantId],
  );
  const mailboxCount = p.data.mailboxCount ?? healthy.length;
  const day = p.data.dayNumber ?? 1;
  const cohortSize = p.data.cohortSize ?? GO_LIVE_FIRST_SELECTION;

  const warnings: string[] = [];
  // Warmup SUGGESTION only (advisory, never a hard cap): day1=5, ramps with day.
  const warmupSuggested = day <= 1 ? 5 : day <= 3 ? 10 : day <= 7 ? 15 : 20;
  const anyDanger = healthy.some((m: any) => m.health_status === 'danger');

  // The OPERATOR sets the number. If they passed desiredDaily, split it across
  // active mailboxes; otherwise each mailbox uses its own daily_send_limit.
  const desiredPerMailbox = p.data.desiredDaily != null && healthy.length
    ? Math.ceil(p.data.desiredDaily / healthy.length) : null;

  const allocation = healthy.length
    ? healthy.map((m: any) => {
        const lim = Number(m.daily_send_limit || 0);
        // Operator's number wins, only bounded by the mailbox's own daily limit.
        const target = desiredPerMailbox != null ? Math.min(desiredPerMailbox, lim || desiredPerMailbox) : (lim || warmupSuggested);
        if (target > warmupSuggested) warnings.push(`${m.from_email}: ${target}/day exceeds the warmup suggestion of ${warmupSuggested} for day ${day} — fine if the mailbox is warmed up; watch bounces/complaints.`);
        if (m.health_status === 'danger') warnings.push(`${m.from_email}: health danger — pause/review before sending.`);
        return { mailbox: m.from_email, healthStatus: m.health_status, mailboxLimit: lim, recommendedToday: m.health_status === 'danger' ? 0 : target };
      })
    : [{ mailbox: '(none — copy-mode)', healthStatus: 'n/a', mailboxLimit: 0, recommendedToday: p.data.desiredDaily ?? GO_LIVE_DAY1_CAP }];

  let safeRecommendedTotal = allocation.reduce((s: number, a: any) => s + a.recommendedToday, 0);
  if (!healthy.length) safeRecommendedTotal = p.data.desiredDaily ?? GO_LIVE_DAY1_CAP;
  if (anyDanger) warnings.push('One or more mailboxes are in danger state. Recommend PAUSE and review deliverability before any send.');

  const desired = p.data.desiredDaily ?? safeRecommendedTotal;
  if (day <= 1 && desired > 5 * Math.max(mailboxCount, 1)) warnings.push('Warmup advice: a brand-new mailbox does best at ~5/day on day 1. Higher is allowed — watch bounces/complaints.');

  const nextActions = [
    safeRecommendedTotal === 0 ? 'Do not send today — resolve mailbox health first.' : `Plan: send up to ${safeRecommendedTotal} message(s) today, one by one or copy-mode (you set the per-mailbox limit on the Mailboxes page).`,
    p.data.templateKey ? `Use template "${p.data.templateKey}" (must be approved).` : 'Approve a Clients.Help first-touch template in Sender Studio.',
    `Build a queue of ${Math.min(cohortSize, QUEUE_HARD_MAX)} existing eligible leads (no discovery).`,
    'Import + classify replies before sending more. Stop on complaints/bounces.',
  ];

  res.json({
    inputs: { mailboxCount, dayNumber: day, desiredDaily: desired, templateKey: p.data.templateKey ?? null, cohortSize },
    safeRecommendedTotal, warmupSuggested, allocation,
    paused: anyDanger, warnings, nextActions,
    note: 'Recommendation only — you control the real per-mailbox daily limit on the Mailboxes page. Nothing was sent, queued, or scheduled.',
  });
});

// ── Shared: select EXISTING eligible leads (warehouse or manual list) ─────────
async function selectExistingLeads(
  tenantId: number, body: { source?: string; emails?: string[]; country?: string; industries?: string[]; max?: number },
) {
  const max = Math.min(body.max ?? GO_LIVE_FIRST_SELECTION, QUEUE_HARD_MAX);
  if (body.source === 'manual' && body.emails && body.emails.length) {
    const emails = body.emails.map((e) => e.toLowerCase().trim()).filter(Boolean).slice(0, QUEUE_HARD_MAX);
    if (!emails.length) return { rows: [], source: 'manual', max };
    const ph = emails.map(() => '?').join(',');
    const rows = await query(
      `SELECT cp.id AS cp_id, cp.value AS email, cp.role_type, cp.verification_score, cp.source_url,
              c.id AS company_id, c.name AS company_name, c.canonical_domain AS website, c.country, c.city,
              cpf.fit_score AS fit_score
       FROM contact_points cp JOIN companies c ON c.id = cp.company_id
       LEFT JOIN company_product_fit cpf ON cpf.company_id = c.id AND cpf.product_key='clients_help'
       WHERE cp.type='email' AND cp.status='verified' AND LOWER(cp.value) IN (${ph})
         AND cp.value NOT IN (SELECT email FROM suppressions WHERE tenant_id=?)
         AND LOWER(cp.value) NOT IN (SELECT normalized_value FROM global_contact_suppression WHERE type='email')
         AND cp.email_domain NOT IN (SELECT normalized_value FROM global_contact_suppression WHERE type='domain')
         AND cp.value NOT IN (SELECT email FROM manual_outreach_queue WHERE tenant_id=?)
       GROUP BY cp.id LIMIT ?`,
      [...emails, tenantId, tenantId, max],
    );
    return { rows, source: 'manual', max };
  }
  // Default: existing Warehouse selection (Clients.Help preset filters).
  const { rows } = await buildCohort(tenantId, {
    country: body.country, industries: body.industries, max,
  });
  return { rows, source: 'existing_warehouse', max };
}

// ── POST /go-live/dry-run — preview ONLY, existing records, creates nothing ───
const dryRunSchema = z.object({
  source: z.enum(['existing_warehouse', 'warehouse', 'manual']).optional(),
  emails: z.array(z.string()).max(QUEUE_HARD_MAX).optional(),
  country: z.string().max(2).optional(),
  industries: z.array(z.string()).optional(),
  templateKey: z.string().max(60).optional(),
  max: z.coerce.number().int().min(1).max(QUEUE_HARD_MAX).optional(),
});
goLiveRouter.post('/dry-run', async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const p = dryRunSchema.safeParse(req.body ?? {});
  if (!p.success) return res.status(400).json({ error: 'invalid_body', detail: p.error.issues });
  await ensureTemplates(tenantId);

  const src = p.data.source === 'manual' ? 'manual' : 'warehouse';
  const { rows, max } = await selectExistingLeads(tenantId, { ...p.data, source: src });

  // Approved template (preferred). Report blocker if none approved.
  const templateKey = p.data.templateKey ?? null;
  const [tpl] = templateKey
    ? await query('SELECT id, template_key, subject, body, approved, category FROM manual_outreach_templates WHERE tenant_id=? AND template_key=? LIMIT 1', [tenantId, templateKey])
    : await query("SELECT id, template_key, subject, body, approved, category FROM manual_outreach_templates WHERE tenant_id=? AND approved=1 ORDER BY id ASC LIMIT 1", [tenantId]);

  const mailboxes = await query("SELECT * FROM sender_identities WHERE tenant_id=? AND status='active'", [tenantId]);
  const providers = await query('SELECT * FROM sending_providers WHERE tenant_id=?', [tenantId]);
  const providerById = new Map<number, any>(providers.map((pr: any) => [pr.id, pr]));

  // Simulated mailbox assignment (no writes).
  let assignment: any[] = [];
  if (mailboxes.length && rows.length) {
    for (const m of mailboxes) await rollMailboxCounters(m);
    const { byEmail, byCompany } = await priorMailboxMaps(tenantId);
    const items: AssignItem[] = rows.map((r: any) => ({
      key: r.cp_id, email: r.email, companyId: r.company_id ?? null,
      recipientDomain: (r.email || '').split('@')[1] ?? null,
    }));
    assignment = assignMailboxes(items, mailboxes, { strategy: 'healthiest_first', providerById, priorByCompany: byCompany, priorByEmail: byEmail });
  }
  const assignedMap = new Map<any, any>(assignment.map((a) => [a.key, a]));

  const wouldQueue: any[] = []; const blocked: any[] = [];
  for (const r of rows) {
    const missing: string[] = [];
    if (!r.email) missing.push('email');
    if (!r.company_name) missing.push('company_name');
    if (!r.website) missing.push('website');
    const suppressed = await isEmailSuppressed(tenantId, r.email);
    const a = assignedMap.get(r.cp_id);
    if (suppressed) { blocked.push({ email: r.email, reason: 'suppressed' }); continue; }
    wouldQueue.push({
      email: r.email, company: r.company_name, website: r.website, country: r.country, city: r.city,
      fitScore: r.fit_score, mailbox: a?.mailboxId ? (mailboxes.find((m: any) => m.id === a.mailboxId)?.from_email ?? null) : null,
      missingFields: missing,
    });
  }

  const warnings: string[] = [];
  if (!tpl) warnings.push('No approved template — queue creation will be blocked until one is approved in Sender Studio.');
  else if (!tpl.approved) warnings.push(`Template "${tpl.template_key}" is NOT approved — approve it before sending.`);
  if (!mailboxes.length) warnings.push('No active mailbox — copy-mode only (assignment skipped).');
  if (rows.length < max) warnings.push(`Only ${rows.length} eligible existing lead(s) matched (requested ${max}).`);

  res.json({
    mode: 'dry_run', source: src === 'manual' ? 'manual_selected' : 'existing_warehouse',
    template: tpl ? { key: tpl.template_key, approved: !!tpl.approved, category: tpl.category } : null,
    eligibleSelected: rows.length, wouldQueueCount: wouldQueue.length, blockedCount: blocked.length,
    wouldQueue: wouldQueue.slice(0, 20), blocked: blocked.slice(0, 20), warnings,
    note: 'DRY RUN — nothing created, queued, subscribed, sent, or scheduled. Existing records only.',
  });
});

// ── POST /go-live/create-first-queue — ≤20 pending_review items, existing only ─
const createQueueSchema = dryRunSchema.extend({ acknowledge: z.literal(true) });
goLiveRouter.post('/create-first-queue', requireWriteAccess, async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const p = createQueueSchema.safeParse(req.body ?? {});
  if (!p.success) return res.status(400).json({ error: 'acknowledge_required', detail: 'Set acknowledge:true and valid filters.' });
  await ensureTemplates(tenantId);

  // ── HARD GATES ──
  const templateKey = p.data.templateKey ?? null;
  const [tpl] = templateKey
    ? await query('SELECT id, template_key, subject, body, approved FROM manual_outreach_templates WHERE tenant_id=? AND template_key=? LIMIT 1', [tenantId, templateKey])
    : await query("SELECT id, template_key, subject, body, approved FROM manual_outreach_templates WHERE tenant_id=? AND approved=1 ORDER BY id ASC LIMIT 1", [tenantId]);
  if (!tpl || !tpl.approved) {
    return res.status(412).json({ error: 'no_approved_template', detail: 'Approve a template in Sender Studio first. No approved template → cannot create queue.' });
  }
  const activeMailboxes = await query("SELECT * FROM sender_identities WHERE tenant_id=? AND status='active'", [tenantId]);
  const copyMode = !!(req.body?.copyMode);
  if (!activeMailboxes.length && !copyMode) {
    return res.status(412).json({ error: 'no_active_mailbox', detail: 'No active mailbox and copy-mode not selected → cannot create queue.' });
  }

  // Enforce hard queue cap across existing + new.
  const [{ open }] = await query(
    `SELECT COUNT(*) AS open FROM manual_outreach_queue WHERE tenant_id=? AND status IN('pending_review','approved')`, [tenantId],
  );
  const room = Math.min(GO_LIVE_FIRST_SELECTION, QUEUE_HARD_MAX - Number(open));
  if (room <= 0) return res.status(409).json({ error: 'queue_full', detail: `Open queue near hard max ${QUEUE_HARD_MAX}. Process items first.` });

  const src = p.data.source === 'manual' ? 'manual' : 'warehouse';
  const { rows } = await selectExistingLeads(tenantId, { ...p.data, source: src, max: room });

  let inserted = 0; const insertedIds: number[] = [];
  for (const r of rows) {
    const vars = { company: r.company_name || 'your business', sender_name: '{{sender_name}}', sender_address: '{{sender_address}}' };
    const draft = renderTemplate({ subject: tpl.subject, body: tpl.body }, vars);
    const suppressed = await isEmailSuppressed(tenantId, r.email);
    if (suppressed) continue; // suppression bypass forbidden — skip
    try {
      const ins = await query(
        `INSERT INTO manual_outreach_queue
          (tenant_id, contact_point_id, company_id, company_name, website, email, reason, source_url,
           template_key, draft_subject, draft_body, safety_status, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok', 'pending_review')`,
        [tenantId, r.cp_id, r.company_id, r.company_name, r.website, r.email,
         `Go-Live first queue · existing verified ${r.role_type ?? 'contact'} · ${r.city ?? ''} ${r.country ?? ''}`.trim(),
         r.source_url, tpl.template_key, draft.subject, draft.body],
      );
      inserted++; insertedIds.push(Number(ins.insertId));
    } catch (e: any) {
      if (e?.code !== 'ER_DUP_ENTRY') throw e;
    }
  }

  // Assign mailboxes to freshly-queued items (no send; just mailbox_id).
  let assigned = 0;
  if (activeMailboxes.length && insertedIds.length) {
    for (const m of activeMailboxes) await rollMailboxCounters(m);
    const providers = await query('SELECT * FROM sending_providers WHERE tenant_id=?', [tenantId]);
    const providerById = new Map<number, any>(providers.map((pr: any) => [pr.id, pr]));
    const { byEmail, byCompany } = await priorMailboxMaps(tenantId);
    const ph = insertedIds.map(() => '?').join(',');
    const unassigned = await query(
      `SELECT id, email, company_id FROM manual_outreach_queue WHERE tenant_id=? AND mailbox_id IS NULL AND id IN(${ph})`,
      [tenantId, ...insertedIds],
    );
    const items: AssignItem[] = unassigned.map((it: any) => ({
      key: it.id, email: it.email, companyId: it.company_id ?? null,
      recipientDomain: (it.email || '').split('@')[1] ?? null,
    }));
    const results = assignMailboxes(items, activeMailboxes, { strategy: 'healthiest_first', providerById, priorByCompany: byCompany, priorByEmail: byEmail });
    for (const rr of results) {
      if (rr.mailboxId) { await query('UPDATE manual_outreach_queue SET mailbox_id=? WHERE id=? AND tenant_id=?', [rr.mailboxId, rr.key, tenantId]); assigned++; }
    }
  }

  await audit(req, 'go_live.create_first_queue', { type: 'manual_queue' }, { inserted, assigned, source: src, templateKey: tpl.template_key });
  res.json({
    inserted, assigned, requested: room, source: src === 'manual' ? 'manual_selected' : 'existing_warehouse',
    templateKey: tpl.template_key, copyMode,
    note: 'Created as pending_review only. Nothing sent, subscribed, or scheduled. Existing leads only.',
  });
});
