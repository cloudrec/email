// leadPromoter.ts
// Continuously drains discovered_leads (status='discovered') → companies + contact_points
// (the Warehouse). This is NOT contact activation: it fills the warehouse only.
// Runs every 20s. Processes in batches of 200.
// Does NOT send emails, does NOT touch campaigns, does NOT create addressable
// `contacts` rows, does NOT subscribe anything.
//
// PHASE 16 ROOT-CAUSE FIX:
//   discovered_leads.role_hint contains free-text values (hello, contact, team,
//   office, press, media, pr, help, service, admin, enquiries, ...) that are NOT
//   members of the contact_points.role_type ENUM. Under STRICT_TRANS_TABLES every
//   INSERT threw `ER_DATA_TRUNCATED (1265): Data truncated for column 'role_type'`.
//   The per-lead catch swallowed the error at debug level, the row was never
//   advanced past status='discovered', and the SAME 200 lowest-id rows were
//   re-selected every tick forever (promoted:0 skipped:200 batch:200), blocking
//   the ~4256 valid higher-id leads behind them.
//   Fix: map role_hint → a valid ENUM member (normalizeRole), and report skip
//   reasons explicitly instead of a bare counter.

import { query } from './db.js';
import { logger } from './logger.js';

const TICK_INTERVAL_MS = 20_000;
const BATCH_SIZE = 200;

// Valid members of contact_points.role_type ENUM.
const ROLE_MAP: Record<string, string> = {
  info: 'info',
  sales: 'sales',
  support: 'support',
  help: 'support',
  service: 'support',
  enquiries: 'support',
  enquiry: 'support',
  inquiries: 'support',
  inquiry: 'support',
  partner: 'partnerships',
  partners: 'partnerships',
  partnerships: 'partnerships',
  owner: 'owner',
  founder: 'owner',
  ceo: 'owner',
  manager: 'manager',
  office: 'generic',
  team: 'generic',
  admin: 'generic',
  hello: 'generic',
  hi: 'generic',
  contact: 'generic',
  'contact-us': 'generic',
  contactus: 'generic',
  press: 'generic',
  media: 'generic',
  pr: 'generic',
  marketing: 'generic',
  personal: 'personal',
};

// Maps a free-text role_hint to a valid role_type ENUM member.
// Always returns a valid member ('unknown' fallback) so the INSERT never throws
// under STRICT_TRANS_TABLES.
function normalizeRole(hint: string | null | undefined): string {
  if (!hint) return 'unknown';
  const key = hint.toLowerCase().trim();
  return ROLE_MAP[key] ?? 'unknown';
}

// verification_score column is tinyint UNSIGNED — clamp to 0..100, null stays null.
function clampScore(score: any): number | null {
  if (score === null || score === undefined) return null;
  const n = Number(score);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

function extractDomain(urlOrEmail: string): string | null {
  try {
    if (urlOrEmail.includes('@')) return urlOrEmail.split('@')[1]?.toLowerCase() ?? null;
    const u = new URL(urlOrEmail.startsWith('http') ? urlOrEmail : 'https://' + urlOrEmail);
    return u.hostname.replace(/^www\./, '').toLowerCase() || null;
  } catch { return null; }
}

function guessCategoryFromDomain(domain: string): string | null {
  const d = domain.toLowerCase();
  if (/dental|dent/.test(d)) return 'dental_clinic';
  if (/beauty|salon|hair|nail|spa/.test(d)) return 'beauty_salon';
  if (/clean|maid|janitorial/.test(d)) return 'cleaning';
  if (/plumb/.test(d)) return 'plumbers';
  if (/electric/.test(d)) return 'electricians';
  if (/hvac|heat|cool|air/.test(d)) return 'hvac';
  if (/roof/.test(d)) return 'roofing';
  if (/law|legal|attorney|solicitor/.test(d)) return 'legal';
  if (/agency|digital|web|seo|design/.test(d)) return 'web_agency';
  if (/auto|car|vehicle|tyre|tire/.test(d)) return 'auto_repair';
  return null;
}

// Returns { id, suppressed } — suppressed=true when the company is in a
// non-contactable status (suppressed/legal_deleted).
async function findOrCreateCompany(domain: string): Promise<{ id: number; suppressed: boolean }> {
  const rows = await query(
    'SELECT id, status FROM companies WHERE canonical_domain=? LIMIT 1',
    [domain],
  );
  if (rows.length) {
    const suppressed = ['suppressed', 'legal_deleted'].includes(rows[0].status);
    return { id: Number(rows[0].id), suppressed };
  }

  const cat = guessCategoryFromDomain(domain);
  const r = await query(
    `INSERT IGNORE INTO companies (canonical_domain, status, category_primary)
     VALUES (?, 'active', ?)`,
    [domain, cat],
  );
  if (r.insertId) return { id: Number(r.insertId), suppressed: false };

  // Race condition: another insert won, re-fetch
  const r2 = await query('SELECT id, status FROM companies WHERE canonical_domain=? LIMIT 1', [domain]);
  if (!r2[0]) return { id: 0, suppressed: false };
  return { id: Number(r2[0].id), suppressed: ['suppressed', 'legal_deleted'].includes(r2[0].status) };
}

async function upsertContactPoint(
  companyId: number,
  opts: {
    type: string;
    value: string;
    roleType: string;
    sourceUrl: string | null;
    contextSnippet: string | null;
    verificationScore: number | null;
  },
): Promise<{ id: number; isNew: boolean }> {
  const normalized = normalizeEmail(opts.value);
  const emailDomain = opts.type === 'email' ? normalized.split('@')[1] ?? null : null;

  const existing = await query(
    'SELECT id FROM contact_points WHERE type=? AND normalized_value=? AND company_id=? LIMIT 1',
    [opts.type, normalized.slice(0, 499), companyId],
  );
  if (existing.length) {
    await query('UPDATE contact_points SET last_seen_at=NOW() WHERE id=?', [existing[0].id]);
    return { id: Number(existing[0].id), isNew: false };
  }

  const ins = await query(
    `INSERT INTO contact_points
       (company_id, type, value, normalized_value, email_domain,
        role_type, source_url, context_snippet, verification_score)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      companyId, opts.type,
      opts.value.slice(0, 499), normalized.slice(0, 499), emailDomain,
      opts.roleType,
      opts.sourceUrl?.slice(0, 1999) ?? null,
      opts.contextSnippet?.slice(0, 499) ?? null,
      opts.verificationScore,
    ],
  );
  return { id: Number(ins.insertId), isNew: true };
}

// Is this email globally suppressed? (do_not_contact / unsubscribe / complaint / bounce / legal)
async function isGloballySuppressed(normalizedEmail: string): Promise<boolean> {
  const rows = await query(
    "SELECT 1 FROM global_contact_suppression WHERE type='email' AND normalized_value=? LIMIT 1",
    [normalizedEmail],
  );
  return rows.length > 0;
}

type SkipReason =
  | 'missing_email'
  | 'invalid_email'
  | 'missing_domain'
  | 'suppressed'
  | 'company_suppressed'
  | 'missing_company'
  | 'duplicate'
  | 'other';

async function tick(): Promise<void> {
  const leads = await query(
    `SELECT id, tenant_id, email, email_domain, company_domain, source_url,
            context_snippet, role_hint, verification_score
     FROM discovered_leads
     WHERE status='discovered'
     ORDER BY id ASC
     LIMIT ?`,
    [BATCH_SIZE],
  );

  if (!leads.length) return;

  let promoted = 0;
  const reasons: Record<SkipReason, number> = {
    missing_email: 0,
    invalid_email: 0,
    missing_domain: 0,
    suppressed: 0,
    company_suppressed: 0,
    missing_company: 0,
    duplicate: 0,
    other: 0,
  };

  for (const dl of leads) {
    try {
      // 1. Missing email → terminal 'invalid' (never re-selected).
      if (!dl.email || !String(dl.email).trim()) {
        await query("UPDATE discovered_leads SET status='invalid', notes='missing_email' WHERE id=?", [dl.id]);
        reasons.missing_email++;
        continue;
      }

      const email = normalizeEmail(String(dl.email));

      // 2. Invalid email format → terminal 'invalid'.
      if (!EMAIL_RE.test(email) || email.length > 254) {
        await query("UPDATE discovered_leads SET status='invalid', notes='invalid_email' WHERE id=?", [dl.id]);
        reasons.invalid_email++;
        continue;
      }

      // 3. Resolve company domain.
      const domain = dl.company_domain ?? dl.email_domain ?? extractDomain(dl.source_url ?? '');
      if (!domain || domain.length < 4) {
        await query("UPDATE discovered_leads SET status='invalid', notes='missing_domain' WHERE id=?", [dl.id]);
        reasons.missing_domain++;
        continue;
      }

      // 4. Globally suppressed email → terminal 'suppressed'.
      if (await isGloballySuppressed(email)) {
        await query("UPDATE discovered_leads SET status='suppressed', notes='global_suppression' WHERE id=?", [dl.id]);
        reasons.suppressed++;
        continue;
      }

      // 5. Find/create company.
      const company = await findOrCreateCompany(domain);
      if (!company.id) {
        // transient — leave 'discovered' so it retries next tick.
        reasons.missing_company++;
        continue;
      }
      if (company.suppressed) {
        await query("UPDATE discovered_leads SET status='suppressed', notes='company_suppressed' WHERE id=?", [dl.id]);
        reasons.company_suppressed++;
        continue;
      }

      // 6. Upsert contact point (role_hint mapped to a valid ENUM member).
      const { isNew } = await upsertContactPoint(company.id, {
        type: 'email',
        value: email,
        roleType: normalizeRole(dl.role_hint),
        sourceUrl: dl.source_url ?? null,
        contextSnippet: dl.context_snippet ?? null,
        verificationScore: clampScore(dl.verification_score),
      });

      // 7. Advance the lead out of the queue. NOTE: do NOT set
      //    imported_contact_id here — that column FK-references contacts(id)
      //    (the addressable list), not contact_points. The promoter only fills
      //    the Warehouse (contact_points); contacts rows are created later by
      //    the list builder. Setting it to a contact_points id violates
      //    fk_lead_contact and was an earlier regression.
      await query(
        "UPDATE discovered_leads SET status='imported', imported_at=NOW() WHERE id=?",
        [dl.id],
      );

      if (isNew) promoted++;
      else reasons.duplicate++;
    } catch (e: any) {
      // Unexpected (likely transient) error — leave row 'discovered' for retry,
      // but surface it instead of hiding at debug level.
      logger.warn({ id: dl.id, err: e.message }, 'leadPromoter: lead error (left for retry)');
      reasons.other++;
    }
  }

  const skipped = Object.values(reasons).reduce((a, b) => a + b, 0);
  if (promoted > 0 || skipped > 0) {
    logger.info(
      { promoted, skipped, batch: leads.length, reasons },
      'leadPromoter: tick done',
    );
  }
}

export async function leadPromoterLoop(): Promise<void> {
  logger.info('leadPromoter: starting');
  // stagger startup
  await new Promise((r) => setTimeout(r, 5_000));

  while (true) {
    try {
      await tick();
    } catch (e: any) {
      logger.error({ err: e.message }, 'leadPromoter: tick error');
    }
    await new Promise((r) => setTimeout(r, TICK_INTERVAL_MS));
  }
}
