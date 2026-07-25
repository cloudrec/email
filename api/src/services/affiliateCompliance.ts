// Affiliate compliance gate (TZ §10). The single hard checkpoint an affiliate message
// must clear before it can be sent. It is deliberately fail-closed: any missing,
// unverified, or expired condition BLOCKS the send. "The program probably allows email"
// is never sufficient — cold_email_allowed must be an explicit, stored 1.
//
// The core `evaluateOfferCompliance` is a pure function (no DB, no I/O) so every TZ
// invariant (unapproved offer blocks, no-email-permission blocks, blocked-geo blocks,
// stale-terms forces review, missing-disclosure blocks, prohibited-claim blocks) is
// unit-testable in isolation. `screenAffiliateMessage` wraps it with the DB read and
// the immutable compliance snapshot write.
import crypto from 'node:crypto';
import { query } from '../db.js';

export interface AffiliateOffer {
  id: number;
  status: string;                       // DRAFT|PENDING_REVIEW|APPROVED|PAUSED|REJECTED|EXPIRED
  cold_email_allowed: number | boolean;
  destination_url?: string | null;
  tracking_url_template?: string | null;
  allowed_geos_json?: string | string[] | null;
  blocked_geos_json?: string | string[] | null;
  required_disclosure?: string | null;
  prohibited_claims_json?: string | string[] | null;
  terms_verified_at?: string | Date | null;
}

export interface ComplianceContext {
  targetGeo?: string | null;            // ISO country of the recipient/company
  message: string;                      // full rendered message body
  subject?: string;
  now?: Date;
  termsMaxAgeDays?: number;             // default 30
}

export interface ComplianceResult {
  allowed: boolean;
  blockers: string[];                   // human-readable reasons; empty => allowed
  requiresReview: boolean;              // stale terms etc. — not a hard block, needs a human
  checks: {
    disclosure_present: boolean;
    prohibited_claim_check: 'pass' | 'fail' | 'skipped';
    allowed_geo: string | null;
  };
}

function toList(v: unknown): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  try {
    const parsed = JSON.parse(String(v));
    return Array.isArray(parsed) ? parsed.map((x) => String(x).trim()).filter(Boolean) : [];
  } catch {
    return String(v).split(',').map((x) => x.trim()).filter(Boolean);
  }
}

const TRACKING_URL_RE = /^https?:\/\/[^\s]+$/i;

export function evaluateOfferCompliance(offer: AffiliateOffer, ctx: ComplianceContext): ComplianceResult {
  const blockers: string[] = [];
  const now = ctx.now ?? new Date();
  const maxAge = (ctx.termsMaxAgeDays ?? 30) * 86_400_000;
  const geo = (ctx.targetGeo || '').toUpperCase() || null;
  const msg = `${ctx.subject ?? ''}\n${ctx.message ?? ''}`;

  // 1. Offer must be approved and not paused/expired/rejected.
  if (offer.status !== 'APPROVED') blockers.push(`offer status is ${offer.status}, not APPROVED`);

  // 2. The hard email gate.
  if (!(offer.cold_email_allowed === 1 || offer.cold_email_allowed === true)) {
    blockers.push('cold_email_allowed is not explicitly enabled for this offer');
  }

  // 3. Tracking URL must exist and be well-formed.
  const tracking = offer.tracking_url_template || offer.destination_url || '';
  if (!TRACKING_URL_RE.test(tracking)) blockers.push('tracking/destination URL missing or invalid');

  // 4. Geo gates.
  const allowed = toList(offer.allowed_geos_json).map((g) => g.toUpperCase());
  const blocked = toList(offer.blocked_geos_json).map((g) => g.toUpperCase());
  if (geo && blocked.includes(geo)) blockers.push(`recipient geo ${geo} is on the blocked list`);
  if (allowed.length && (!geo || !allowed.includes(geo))) {
    blockers.push(`recipient geo ${geo ?? '(unknown)'} is not in the offer's allowed geos`);
  }

  // 5. Required disclosure must appear verbatim in the message.
  let disclosurePresent = true;
  if (offer.required_disclosure && offer.required_disclosure.trim()) {
    disclosurePresent = msg.toLowerCase().includes(offer.required_disclosure.trim().toLowerCase());
    if (!disclosurePresent) blockers.push('required affiliate disclosure text is missing from the message');
  }

  // 6. Prohibited advertiser claims must not appear.
  let claimCheck: 'pass' | 'fail' | 'skipped' = 'skipped';
  const prohibited = toList(offer.prohibited_claims_json);
  if (prohibited.length) {
    const hit = prohibited.find((claim) => msg.toLowerCase().includes(claim.toLowerCase()));
    if (hit) { claimCheck = 'fail'; blockers.push(`message contains a prohibited claim: "${hit}"`); }
    else claimCheck = 'pass';
  }

  // 7. Stale terms force a human review (soft): not a silent continue (TZ §5).
  let requiresReview = false;
  const verifiedAt = offer.terms_verified_at ? new Date(offer.terms_verified_at) : null;
  if (!verifiedAt || (now.getTime() - verifiedAt.getTime()) > maxAge) {
    requiresReview = true;
    blockers.push('offer terms are unverified or stale — re-verify before sending');
  }

  return {
    allowed: blockers.length === 0,
    blockers,
    requiresReview,
    checks: { disclosure_present: disclosurePresent, prohibited_claim_check: claimCheck, allowed_geo: geo },
  };
}

export function messageHash(subject: string | undefined, body: string): string {
  return crypto.createHash('sha256').update(`${subject ?? ''}\n${body}`).digest('hex');
}

/**
 * DB-backed screen: load the offer, evaluate, and write an immutable compliance
 * snapshot (TZ §10). Returns the result; the caller must not send when !allowed.
 */
export async function screenAffiliateMessage(params: {
  campaignId?: number | null;
  offerId: number;
  contactEmail?: string | null;
  approver?: string | null;
  subject?: string;
  body: string;
  targetGeo?: string | null;
}): Promise<ComplianceResult> {
  const rows = await query('SELECT * FROM affiliate_offers WHERE id=? LIMIT 1', [params.offerId]) as any[];
  const offer = rows[0];
  if (!offer) {
    return { allowed: false, blockers: [`affiliate offer ${params.offerId} not found`], requiresReview: true,
      checks: { disclosure_present: false, prohibited_claim_check: 'skipped', allowed_geo: null } };
  }
  const result = evaluateOfferCompliance(offer, { message: params.body, subject: params.subject, targetGeo: params.targetGeo });

  // pin the latest terms version, if any
  const tv = await query('SELECT id FROM affiliate_offer_terms_versions WHERE offer_id=? ORDER BY id DESC LIMIT 1', [params.offerId]) as any[];

  await query(
    `INSERT INTO compliance_snapshots
       (campaign_id, offer_id, contact_email, offer_terms_version_id, terms_verified_at,
        allowed_geo, required_disclosure_present, prohibited_claim_check, approver, message_hash)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [params.campaignId ?? null, params.offerId, params.contactEmail ?? null, tv[0]?.id ?? null,
     offer.terms_verified_at ?? null, result.checks.allowed_geo, result.checks.disclosure_present ? 1 : 0,
     result.checks.prohibited_claim_check, params.approver ?? null,
     messageHash(params.subject, params.body)],
  ).catch(() => { /* snapshot best-effort; the gate decision is what blocks */ });

  return result;
}
