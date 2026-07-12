// Phase 22G — Partner Directory Contact-Form Outreach (service).
// Non-email, operator-controlled, copy/paste outreach. NOTHING here sends email
// or submits any web form. Pure helpers + DB-backed seed/import/rate-limit, plus
// a thin bridge into the existing outreach_touchpoints ledger (recordTouchpoint).
import { query } from '../db.js';
import { recordTouchpoint } from './mailboxFleet.js';

// ── Safety limits (operator-overridable per request, never auto-raised) ──────
export const MAX_SUBMISSIONS_PER_SOURCE_PER_DAY = 5;
export const MAX_TASKS_PER_DAY = 20;
export const MAX_DISCOVERY_PER_RUN = 50;
export const MAX_IMPORT_ROWS = 200;

export const SAFETY_WARNINGS = [
  'This directory may have its own terms. Use low-volume, relevant partner messages only.',
  'Do not submit duplicate or irrelevant messages.',
];

// Seed directory source (Intuit / ZiftOne).
export const SEED_SOURCE = {
  name: 'Intuit Partner Directory',
  source_url: 'https://intuit.ziftone.com/#/page/directory',
  platform: 'ziftone' as const,
  status: 'active' as const,
  notes: 'Visible partner directory. Login + captcha may be required; import is manual / owner-session only.',
};

// ── Message template pack (PART 6). Copy/paste into the directory contact form.
// Placeholders are shown literally as <<< REPLACE: ... >>> so the operator edits
// them before submitting. Tone: short, honest, partner-oriented, no fake claims.
export const SEED_TEMPLATES: Array<{
  template_key: string; name: string; use_case: string; subject: string; body: string;
}> = [
  {
    template_key: 'ch_partnership_intro',
    name: 'Clients.Help partnership intro',
    use_case: 'partnership_intro',
    subject: 'Partnership with <<< REPLACE: Company name >>>',
    body: `Hi <<< REPLACE: Company name >>> team,

I found you on <<< REPLACE: Partner program / directory name >>>. I run <<< REPLACE: Website / project >>> and work with small businesses on websites, lead capture and simple automation.

I think there may be a fit to refer work to each other or partner on projects. Is this the right contact for partnership questions? If not, I'd appreciate a pointer to the right person.

Thanks,
<<< REPLACE: Sender name >>>
<<< REPLACE: Website / project >>>`,
  },
  {
    template_key: 'ch_lead_capture_offer',
    name: 'Website lead capture offer',
    use_case: 'lead_capture',
    subject: 'Lead capture for <<< REPLACE: Company name >>>',
    body: `Hi <<< REPLACE: Company name >>> team,

Saw your listing on <<< REPLACE: Partner program / directory name >>>. We help businesses turn website visitors into leads (forms, follow-up, light automation) and could do the same for your clients or yourselves.

Happy to share a short example if useful. Are you the right person to talk to about this?

<<< REPLACE: Sender name >>>
<<< REPLACE: Website / project >>>`,
  },
  {
    template_key: 'ch_remote_it_ps',
    name: 'Remote IT / WordPress / automation (P.S. version)',
    use_case: 'remote_it',
    subject: 'Partnership + remote support — <<< REPLACE: Company name >>>',
    body: `Hi <<< REPLACE: Company name >>> team,

Found you via <<< REPLACE: Partner program / directory name >>>. I run <<< REPLACE: Website / project >>> and partner with firms on website and lead-gen work.

Is this the right contact for partnership questions?

<<< REPLACE: Sender name >>>

P.S. We also help remotely with website, WordPress, automation and small IT tasks when needed.`,
  },
  {
    template_key: 'ch_referral_request',
    name: 'Wrong person / referral request',
    use_case: 'referral',
    subject: 'Right contact at <<< REPLACE: Company name >>>?',
    body: `Hi,

I'm trying to reach the person who handles partnerships at <<< REPLACE: Company name >>>. I run <<< REPLACE: Website / project >>> and found your listing on <<< REPLACE: Partner program / directory name >>>.

Could you point me to the right contact? Thank you.

<<< REPLACE: Sender name >>>`,
  },
  {
    template_key: 'ch_followup_manual',
    name: 'Follow-up note (manual only)',
    use_case: 'followup',
    subject: 'Following up — <<< REPLACE: Company name >>>',
    body: `Hi <<< REPLACE: Company name >>> team,

Following up on my earlier note about a possible partnership between <<< REPLACE: Website / project >>> and <<< REPLACE: Company name >>>. No worries if now isn't the right time — just let me know either way.

<<< REPLACE: Sender name >>>`,
  },
];

// dedupe key: prefer profile_url, else website host, else normalized name.
export function dedupeKey(t: { company_name?: string; profile_url?: string | null; website_url?: string | null }): string {
  const norm = (s: string) => s.trim().toLowerCase();
  if (t.profile_url) return 'p:' + norm(t.profile_url);
  if (t.website_url) {
    const host = t.website_url.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/^www\./i, '');
    if (host) return 'w:' + norm(host);
  }
  return 'n:' + norm(t.company_name ?? '');
}

// Render a template by replacing <<< REPLACE: Label >>> with provided values
// keyed by a slugified label, OR leaving the placeholder for manual edit.
export function renderPartnerMessage(
  tpl: { subject?: string | null; body: string },
  vars: Record<string, string> = {},
): { subject: string; body: string } {
  const slug = (label: string) => label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const fill = (s: string) =>
    s.replace(/<<<\s*REPLACE:\s*([^>]+?)\s*>>>/g, (m, label) => {
      const v = vars[slug(String(label))];
      return v != null && v !== '' ? v : m; // keep placeholder if no value
    });
  return { subject: fill(tpl.subject ?? ''), body: fill(tpl.body) };
}

// Parse pasted CSV (header row required) or one-URL/name-per-line.
export function parseImportText(text: string): Array<Record<string, string>> {
  const raw = (text ?? '').trim();
  if (!raw) return [];
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const looksCsv = lines[0].includes(',') && /company|name|url|website|profile|category|country/i.test(lines[0]);
  if (looksCsv) {
    const headers = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
    const out: Array<Record<string, string>> = [];
    for (const line of lines.slice(1)) {
      const cells = splitCsvLine(line);
      const row: Record<string, string> = {};
      headers.forEach((h, i) => { row[h] = (cells[i] ?? '').trim(); });
      if (Object.values(row).some((v) => v)) out.push(row);
    }
    return out;
  }
  // one item per line: a URL or a plain company name
  return lines.map((l): Record<string, string> => {
    if (/^https?:\/\//i.test(l)) {
      const isProfile = /profile|directory|partner|company/i.test(l);
      return isProfile ? { profile_url: l, company_name: '' } : { website_url: l, company_name: '' };
    }
    return { company_name: l };
  });
}

function splitCsvLine(line: string): string[] {
  const out: string[] = []; let cur = ''; let inq = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inq) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inq = false;
      else cur += ch;
    } else if (ch === '"') inq = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

// Map a parsed row into target fields (only visible/public fields).
export function rowToTarget(row: Record<string, string>): {
  company_name: string; profile_url: string | null; website_url: string | null;
  category: string | null; country: string | null; description: string | null;
  contact_button_present: boolean; contact_form_url: string | null;
} {
  const g = (...keys: string[]) => {
    for (const k of keys) { if (row[k] != null && row[k] !== '') return row[k]; }
    return '';
  };
  const website = g('website_url', 'website', 'url', 'site');
  const profile = g('profile_url', 'profile', 'listing_url', 'directory_url');
  const contactUrl = g('contact_form_url', 'contact_url', 'contact');
  return {
    company_name: g('company_name', 'company', 'name') || website || profile || 'Unknown company',
    profile_url: profile || null,
    website_url: website || null,
    category: g('category', 'industry') || null,
    country: g('country') || null,
    description: g('description', 'notes', 'about').slice(0, 2000) || null,
    contact_button_present: !!contactUrl || /^(1|true|yes|y)$/i.test(g('contact_button_present', 'has_contact')),
    contact_form_url: contactUrl || null,
  };
}

// ── Rate-limit ledger ────────────────────────────────────────────────────────
function todayYmd(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export async function getDailyCounts(tenantId: number, sourceId: number | null): Promise<{ submissions: number; tasks_created: number }> {
  const ymd = todayYmd();
  // tasks_created is counted tenant-wide (sourceId NULL bucket); submissions are per source.
  const [tasksRow] = await query(
    'SELECT COALESCE(SUM(tasks_created),0) AS n FROM partner_outreach_daily WHERE tenant_id=? AND ymd=?',
    [tenantId, ymd],
  );
  let submissions = 0;
  if (sourceId != null) {
    const [s] = await query(
      'SELECT COALESCE(submissions,0) AS n FROM partner_outreach_daily WHERE tenant_id=? AND ymd=? AND source_id=?',
      [tenantId, ymd, sourceId],
    );
    submissions = Number(s?.n ?? 0);
  }
  return { submissions, tasks_created: Number(tasksRow?.n ?? 0) };
}

export async function bumpDaily(tenantId: number, sourceId: number | null, field: 'submissions' | 'tasks_created', by = 1): Promise<void> {
  const ymd = todayYmd();
  // unique key includes source_id; use a sentinel 0 row for tenant-wide task counts.
  const sid = sourceId ?? 0;
  await query(
    `INSERT INTO partner_outreach_daily (tenant_id, ymd, source_id, ${field})
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE ${field} = ${field} + VALUES(${field})`,
    [tenantId, ymd, sid, by],
  );
}

// Bridge a partner contact-form action into the shared touch ledger.
export async function recordPartnerTouch(opts: {
  tenantId: number; companyId?: number | null; email?: string | null;
  status: 'copied' | 'sent_manual' | 'replied' | 'skipped' | 'blocked';
  touchType?: 'first_touch' | 'followup_1' | 'reply' | 'manual_note';
  direction?: 'outbound' | 'inbound';
  subject?: string | null; body?: string | null;
  targetId?: number; taskId?: number;
}): Promise<void> {
  await recordTouchpoint({
    tenantId: opts.tenantId,
    companyId: opts.companyId ?? null,
    email: opts.email ?? null,
    channel: 'contact_form',
    direction: opts.direction ?? 'outbound',
    touchType: opts.touchType ?? 'first_touch',
    status: opts.status,
    subject: opts.subject ?? null,
    body: opts.body ?? null,
    sentAt: opts.status === 'sent_manual' ? new Date() : null,
    metadata: { partner_target_id: opts.targetId, partner_task_id: opts.taskId, source: 'partner_directory' },
  });
}

export async function seedSourceAndTemplates(tenantId: number): Promise<{ source_id: number; templates: number }> {
  // Seed the Intuit/ZiftOne source (idempotent on name).
  const [existing] = await query(
    'SELECT id FROM partner_directory_sources WHERE tenant_id=? AND name=? LIMIT 1',
    [tenantId, SEED_SOURCE.name],
  );
  let sourceId: number;
  if (existing) sourceId = Number(existing.id);
  else {
    const r = await query(
      'INSERT INTO partner_directory_sources (tenant_id, name, source_url, platform, status, notes) VALUES (?, ?, ?, ?, ?, ?)',
      [tenantId, SEED_SOURCE.name, SEED_SOURCE.source_url, SEED_SOURCE.platform, SEED_SOURCE.status, SEED_SOURCE.notes],
    );
    sourceId = Number(r.insertId);
  }
  let n = 0;
  for (const t of SEED_TEMPLATES) {
    const r = await query(
      `INSERT INTO partner_message_templates (tenant_id, template_key, name, use_case, subject, body, is_seed)
       VALUES (?, ?, ?, ?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE name=VALUES(name), use_case=VALUES(use_case)`,
      [tenantId, t.template_key, t.name, t.use_case, t.subject, t.body],
    );
    if (r.affectedRows) n++;
  }
  return { source_id: sourceId, templates: n };
}
