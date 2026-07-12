// Phase 22D — Mailbox fleet manager + assignment engine.
// Pure / deterministic helpers (env-ref generation, health, ramp, assignment,
// CSV) plus DB-aware fleet stats and the contact touch ledger writer.
// NOTHING here sends mail. Secrets are NEVER read or stored — only env-var NAMES.

import crypto from 'node:crypto';
import { query } from '../db.js';

// ── Defaults ─────────────────────────────────────────────────────────────────
export const NEW_MAILBOX_DAILY = 5;
export const NEW_MAILBOX_HOURLY = 2;
// Conservative per-mailbox cap of how many messages may go to one recipient
// domain per day (anti-spray). Used by the assignment engine only.
export const PER_DOMAIN_PER_MAILBOX_DAILY = 5;

const today = () => new Date().toISOString().slice(0, 10);

// ── Env-ref generator ────────────────────────────────────────────────────────
// sales1@example.com → SALES1_EXAMPLE_COM_SMTP_USER etc. Names only, no values.
export function envPrefix(email: string): string {
  return (email || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'MAILBOX';
}

export function suggestEnvRefs(email: string): {
  smtpUser: string; smtpSecret: string; imapUser: string; imapSecret: string;
} {
  const p = envPrefix(email);
  return {
    smtpUser: `${p}_SMTP_USER`,
    smtpSecret: `${p}_SMTP_PASSWORD`,
    imapUser: `${p}_IMAP_USER`,
    imapSecret: `${p}_IMAP_PASSWORD`,
  };
}

// Empty-value .env snippet for one mailbox (NEVER prints existing values).
export function envSnippet(email: string, refs?: {
  smtpUser?: string | null; smtpSecret?: string | null; imapUser?: string | null; imapSecret?: string | null;
}): string {
  const s = suggestEnvRefs(email);
  const lines = [
    `# ${email}`,
    `${refs?.smtpUser || s.smtpUser}=`,
    `${refs?.smtpSecret || s.smtpSecret}=`,
    `${refs?.imapUser || s.imapUser}=`,
    `${refs?.imapSecret || s.imapSecret}=`,
  ];
  return lines.join('\n');
}

// ── Counter roll ─────────────────────────────────────────────────────────────
// Reset all *_today counters at day change. Persists. Returns fresh row.
export async function rollMailboxCounters(mailbox: any): Promise<any> {
  if (!mailbox) return mailbox;
  const day = mailbox.counters_day ? new Date(mailbox.counters_day).toISOString().slice(0, 10) : null;
  const mday = mailbox.manual_counters_day ? new Date(mailbox.manual_counters_day).toISOString().slice(0, 10) : null;
  const t = today();
  if (day !== t) {
    await query(
      `UPDATE sender_identities SET
         sent_today=0, smtp_sent_today=0, replies_today=0, interested_today=0,
         negative_today=0, bounce_like_today=0, complaints_today=0, unsubscribes_today=0,
         bounced_today=0, complained_today=0, unsubscribed_today=0, counters_day=?
       WHERE id=?`, [t, mailbox.id],
    );
    Object.assign(mailbox, {
      sent_today: 0, smtp_sent_today: 0, replies_today: 0, interested_today: 0,
      negative_today: 0, bounce_like_today: 0, complaints_today: 0, unsubscribes_today: 0,
      bounced_today: 0, complained_today: 0, unsubscribed_today: 0, counters_day: t,
    });
  }
  if (mday !== t) {
    await query('UPDATE sender_identities SET manual_sent_today=0, manual_counters_day=? WHERE id=?', [t, mailbox.id]);
    mailbox.manual_sent_today = 0;
    mailbox.manual_counters_day = t;
  }
  return mailbox;
}

// ── Health ───────────────────────────────────────────────────────────────────
// Deterministic health from today's metrics. Conservative thresholds.
export function computeHealth(m: any): 'safe' | 'warning' | 'danger' | 'unknown' {
  if (!m) return 'unknown';
  if (m.status === 'error') return 'danger';
  const sent = Number(m.smtp_sent_today || 0) + Number(m.manual_sent_today || 0);
  const bounces = Number(m.bounce_like_today || 0) + Number(m.bounced_today || 0);
  const complaints = Number(m.complaints_today || 0) + Number(m.complained_today || 0);
  if (sent < 5) return m.last_smtp_test_at || m.status === 'active' ? 'safe' : 'unknown';
  const bounceRate = bounces / sent;
  const complaintRate = complaints / sent;
  if (complaintRate > 0.005 || bounceRate > 0.05) return 'danger';
  if (complaintRate > 0.001 || bounceRate > 0.03) return 'warning';
  return 'safe';
}

// ── Ramp recommendation (NEVER auto-applied) ─────────────────────────────────
export function rampForDay(dayIndex: number): number {
  if (dayIndex <= 1) return 5;
  if (dayIndex <= 3) return 10;
  if (dayIndex <= 7) return 15;
  if (dayIndex <= 14) return 20;
  if (dayIndex <= 21) return 30;
  return 40; // 50+ only after sustained healthy metrics, manually.
}

export function recommendNextLimit(m: any): { recommended: number; reason: string } {
  const created = m.created_at ? new Date(m.created_at) : new Date();
  const ageDays = Math.max(1, Math.floor((Date.now() - created.getTime()) / 86400000) + 1);
  const health = computeHealth(m);
  const current = Number(m.daily_send_limit || NEW_MAILBOX_DAILY);
  const target = rampForDay(ageDays);
  if (health === 'danger') {
    return { recommended: Math.max(5, Math.floor(current / 2)), reason: 'danger health — reduce volume; do not ramp' };
  }
  if (health === 'warning') {
    return { recommended: current, reason: 'warning health — hold current limit until metrics recover' };
  }
  if (target <= current) {
    return { recommended: current, reason: `already at/above ramp target for day ${ageDays}` };
  }
  return { recommended: target, reason: `healthy at day ${ageDays}; ramp target ${target}/day (manual apply only)` };
}

// ── Mailbox eligibility / blockers ───────────────────────────────────────────
// Reasons a mailbox cannot receive NEW outreach assignment. Empty = eligible.
export function mailboxBlockers(m: any, provider?: any): string[] {
  const b: string[] = [];
  if (!m) return ['mailbox_missing'];
  if (m.status !== 'active') b.push(`mailbox_${m.status}`);
  if (!m.outbound_enabled) b.push('outbound_disabled');
  if (computeHealth(m) === 'danger') b.push('health_danger');
  const used = Number(m.smtp_sent_today || 0) + Number(m.manual_sent_today || 0);
  if (used >= Number(m.daily_send_limit || NEW_MAILBOX_DAILY)) b.push('daily_limit_reached');
  if (provider) {
    if (provider.status === 'disabled') b.push('provider_disabled');
    if (provider.status === 'error') b.push('provider_error');
  }
  if (m.purpose === 'transactional' || m.purpose === 'main') {
    if (!m.admin_cold_override) b.push('main_or_transactional_no_cold_override');
  }
  return b;
}

export function dailyRemaining(m: any): number {
  const used = Number(m.smtp_sent_today || 0) + Number(m.manual_sent_today || 0);
  return Math.max(0, Number(m.daily_send_limit || NEW_MAILBOX_DAILY) - used);
}

// ── Assignment engine (pure) ─────────────────────────────────────────────────
export type AssignStrategy = 'healthiest_first' | 'least_used_today' | 'round_robin' | 'fixed_mailbox';

export type AssignItem = {
  key: string | number;        // queue item id or contact identifier
  email: string;
  companyId?: number | null;
  recipientDomain?: string | null;
};

export type AssignResult = {
  key: string | number;
  mailboxId: number | null;
  reason: string;
  blockers?: string[];
};

const HEALTH_RANK: Record<string, number> = { safe: 0, unknown: 1, warning: 2, danger: 3 };

// Assign each item to one eligible mailbox.
// `priorByCompany` / `priorByEmail` = mailbox already used for that company/contact
// (preserve same mailbox: follow-ups + avoid multi-mailbox to one company).
export function assignMailboxes(
  items: AssignItem[],
  mailboxes: any[],
  opts: {
    strategy?: AssignStrategy;
    fixedMailboxId?: number | null;
    priorByCompany?: Map<number, number>;
    priorByEmail?: Map<string, number>;
    providerById?: Map<number, any>;
  } = {},
): AssignResult[] {
  const strategy = opts.strategy ?? 'healthiest_first';
  const providerById = opts.providerById ?? new Map();
  const priorByCompany = opts.priorByCompany ?? new Map();
  const priorByEmail = opts.priorByEmail ?? new Map();

  // Eligible pool (mutable in-flight capacity per mailbox).
  type Slot = { m: any; remaining: number; usedThisRun: number; domainCount: Map<string, number>; companies: Set<number> };
  const slots: Slot[] = mailboxes
    .filter((m) => mailboxBlockers(m, m.provider_id ? providerById.get(m.provider_id) : undefined).length === 0)
    .map((m) => ({ m, remaining: dailyRemaining(m), usedThisRun: 0, domainCount: new Map(), companies: new Set() }));

  const slotById = new Map<number, Slot>(slots.map((s) => [s.m.id, s]));
  const orderForItem = (): Slot[] => {
    const live = slots.filter((s) => s.remaining > 0);
    if (strategy === 'round_robin') {
      return live.sort((a, b) => a.usedThisRun - b.usedThisRun || a.m.id - b.m.id);
    }
    if (strategy === 'least_used_today') {
      return live.sort((a, b) =>
        (Number(a.m.smtp_sent_today || 0) + a.usedThisRun) - (Number(b.m.smtp_sent_today || 0) + b.usedThisRun)
        || a.m.id - b.m.id);
    }
    // healthiest_first, fallback least_used_today
    return live.sort((a, b) =>
      HEALTH_RANK[computeHealth(a.m)] - HEALTH_RANK[computeHealth(b.m)]
      || (Number(a.m.smtp_sent_today || 0) + a.usedThisRun) - (Number(b.m.smtp_sent_today || 0) + b.usedThisRun)
      || a.m.id - b.m.id);
  };

  const take = (s: Slot, item: AssignItem) => {
    s.remaining -= 1;
    s.usedThisRun += 1;
    if (item.companyId) s.companies.add(item.companyId);
    const d = item.recipientDomain || (item.email.split('@')[1] ?? '');
    if (d) s.domainCount.set(d, (s.domainCount.get(d) ?? 0) + 1);
  };

  const out: AssignResult[] = [];
  for (const item of items) {
    const dom = (item.recipientDomain || (item.email.split('@')[1] ?? '')).toLowerCase();

    // fixed mailbox strategy
    if (strategy === 'fixed_mailbox') {
      const s = opts.fixedMailboxId ? slotById.get(opts.fixedMailboxId) : undefined;
      if (!s) { out.push({ key: item.key, mailboxId: null, reason: 'fixed mailbox not eligible', blockers: ['fixed_mailbox_ineligible'] }); continue; }
      if (s.remaining <= 0) { out.push({ key: item.key, mailboxId: null, reason: 'fixed mailbox daily limit reached', blockers: ['daily_limit_reached'] }); continue; }
      take(s, item); out.push({ key: item.key, mailboxId: s.m.id, reason: 'fixed mailbox' }); continue;
    }

    // preserve same mailbox for known contact (follow-up) or known company
    const priorMb = (priorByEmail.get(item.email.toLowerCase())
      ?? (item.companyId ? priorByCompany.get(item.companyId) : undefined));
    if (priorMb) {
      const s = slotById.get(priorMb);
      if (s && s.remaining > 0) { take(s, item); out.push({ key: item.key, mailboxId: s.m.id, reason: 'preserved prior mailbox (same contact/company)' }); continue; }
      // prior mailbox unavailable → require manual reassignment, do not silently switch
      out.push({ key: item.key, mailboxId: null, reason: 'prior mailbox unavailable — manual reassignment required', blockers: ['prior_mailbox_unavailable'] });
      continue;
    }

    // pick from ordered pool, honoring per-domain anti-spray
    const ordered = orderForItem();
    const pick = ordered.find((s) => (s.domainCount.get(dom) ?? 0) < PER_DOMAIN_PER_MAILBOX_DAILY)
      ?? ordered[0];
    if (!pick) { out.push({ key: item.key, mailboxId: null, reason: 'no eligible mailbox with capacity', blockers: ['no_capacity'] }); continue; }
    take(pick, item);
    out.push({ key: item.key, mailboxId: pick.m.id, reason: `assigned via ${strategy}` });
  }
  return out;
}

// ── Touch ledger writer (best-effort, additive) ──────────────────────────────
export function bodyHash(body: string | null | undefined): string | null {
  if (!body) return null;
  return crypto.createHash('sha256').update(body).digest('hex');
}

export async function recordTouchpoint(t: {
  tenantId: number;
  contactPointId?: number | null;
  contactId?: number | null;
  companyId?: number | null;
  queueItemId?: number | null;
  followupTaskId?: number | null;
  mailboxId?: number | null;
  providerProfileId?: number | null;
  campaignId?: number | null;
  email?: string | null;
  channel?: string;
  direction?: string;
  touchType?: string;
  subject?: string | null;
  body?: string | null;
  status?: string;
  sentAt?: Date | null;
  repliedAt?: Date | null;
  metadata?: Record<string, any>;
}): Promise<number | null> {
  try {
    const r = await query(
      `INSERT INTO outreach_touchpoints
        (tenant_id, contact_point_id, contact_id, company_id, queue_item_id, followup_task_id,
         mailbox_id, provider_profile_id, campaign_id, email, channel, direction, touch_type,
         subject, body_hash, status, sent_at, replied_at, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        t.tenantId, t.contactPointId ?? null, t.contactId ?? null, t.companyId ?? null,
        t.queueItemId ?? null, t.followupTaskId ?? null, t.mailboxId ?? null,
        t.providerProfileId ?? null, t.campaignId ?? null,
        t.email ? t.email.toLowerCase() : null,
        t.channel ?? 'email', t.direction ?? 'outbound', t.touchType ?? 'first_touch',
        t.subject ?? null, bodyHash(t.body), t.status ?? 'planned',
        t.sentAt ?? null, t.repliedAt ?? null,
        t.metadata && Object.keys(t.metadata).length ? JSON.stringify(t.metadata) : null,
      ],
    );
    return Number(r.insertId);
  } catch {
    return null; // ledger is best-effort; never break the calling flow
  }
}

// Prior outbound mailbox for a contact/company (for follow-up + anti-multi-mailbox).
export async function priorMailboxMaps(tenantId: number): Promise<{
  byEmail: Map<string, number>; byCompany: Map<number, number>;
}> {
  const rows = await query(
    `SELECT email, company_id, mailbox_id, MAX(created_at) AS last
     FROM outreach_touchpoints
     WHERE tenant_id=? AND direction='outbound' AND mailbox_id IS NOT NULL
     GROUP BY email, company_id, mailbox_id`, [tenantId],
  );
  const byEmail = new Map<string, number>();
  const byCompany = new Map<number, number>();
  for (const r of rows) {
    if (r.email && !byEmail.has(r.email)) byEmail.set(String(r.email).toLowerCase(), Number(r.mailbox_id));
    if (r.company_id && !byCompany.has(r.company_id)) byCompany.set(Number(r.company_id), Number(r.mailbox_id));
  }
  return { byEmail, byCompany };
}

// ── Fleet stats ──────────────────────────────────────────────────────────────
export async function fleetStats(tenantId: number): Promise<any> {
  const mailboxes = await query('SELECT * FROM sender_identities WHERE tenant_id=?', [tenantId]);
  const providers = await query('SELECT id, status FROM sending_providers WHERE tenant_id=?', [tenantId]);
  const provById = new Map<number, any>(providers.map((p: any) => [p.id, p]));
  for (const m of mailboxes) await rollMailboxCounters(m);

  const byStatus: Record<string, number> = { draft: 0, active: 0, paused: 0, disabled: 0, error: 0 };
  const byHealth: Record<string, number> = { safe: 0, warning: 0, danger: 0, unknown: 0 };
  let totalDaily = 0, usedToday = 0, repliesToday = 0;
  const needAttention: any[] = [];
  for (const m of mailboxes) {
    byStatus[m.status] = (byStatus[m.status] ?? 0) + 1;
    const h = computeHealth(m);
    byHealth[h] = (byHealth[h] ?? 0) + 1;
    if (m.status === 'active' && m.outbound_enabled) totalDaily += Number(m.daily_send_limit || 0);
    usedToday += Number(m.smtp_sent_today || 0) + Number(m.manual_sent_today || 0);
    repliesToday += Number(m.replies_today || 0);
    const blockers = mailboxBlockers(m, m.provider_id ? provById.get(m.provider_id) : undefined);
    if (h === 'danger' || h === 'warning' || m.status === 'error'
        || (m.status === 'draft') || (m.outbound_enabled && !m.last_smtp_test_at)) {
      needAttention.push({ id: m.id, email: m.from_email, status: m.status, health: h, blockers });
    }
  }

  const [{ c: queueAssigned } = { c: 0 }] = await query(
    `SELECT COUNT(*) c FROM manual_outreach_queue WHERE tenant_id=? AND mailbox_id IS NOT NULL
      AND status IN ('pending_review','approved')`, [tenantId],
  );
  const [{ c: followupsDue } = { c: 0 }] = await query(
    `SELECT COUNT(*) c FROM manual_followup_tasks WHERE tenant_id=? AND status IN ('pending','ready')
      AND (due_at IS NULL OR due_at <= NOW())`, [tenantId],
  );

  return {
    total: mailboxes.length,
    byStatus, byHealth,
    capacity: { totalDaily, usedToday, remainingToday: Math.max(0, totalDaily - usedToday) },
    repliesToday,
    followupsDue: Number(followupsDue || 0),
    queueAssigned: Number(queueAssigned || 0),
    needAttention,
  };
}

// ── CSV (metadata only — NEVER secrets) ──────────────────────────────────────
export const MAILBOX_CSV_COLUMNS = [
  'email', 'display_name', 'provider_profile_name', 'provider_profile_id', 'purpose',
  'daily_send_limit', 'hourly_send_limit', 'outbound_enabled', 'inbound_enabled',
  'smtp_user_ref', 'smtp_secret_ref', 'imap_user_ref', 'imap_secret_ref',
];

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export function parseMailboxCsv(text: string): Array<Record<string, string>> {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) return [];
  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const row: Record<string, string> = {};
    header.forEach((h, idx) => { row[h] = cells[idx] ?? ''; });
    rows.push(row);
  }
  return rows;
}

function csvCell(v: any): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function formatMailboxCsv(rows: any[]): string {
  const cols = MAILBOX_CSV_COLUMNS;
  const out = [cols.join(',')];
  for (const r of rows) out.push(cols.map((c) => csvCell(r[c])).join(','));
  return out.join('\n');
}

export function isValidEmail(e: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((e || '').trim());
}
