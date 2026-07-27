// Read-only engine-safety aggregation for the admin UI (TZ §17 Safety). Surfaces the
// three engine-specific safety signals not covered by the existing /safety and
// /deliverability views:
//   1. offer policy violations — compliance_snapshots where a prohibited claim was hit;
//   2. stale offer terms      — APPROVED offers whose terms are unverified or > 30 days old;
//   3. paused campaigns        — campaigns with lifecycle_state = 'PAUSED'.
// SELECT-only: this router never writes. Tenant-scoped where the table carries a tenant
// (campaigns); offers/compliance_snapshots are global in this schema.
import { Router } from 'express';
import { query } from '../db.js';
import { authMiddleware, requireTenant } from '../middleware/auth.js';
import { isTermsStale, daysSince, DEFAULT_TERMS_MAX_AGE_DAYS } from '../services/engineSafety.js';

export const engineSafetyRouter = Router();
engineSafetyRouter.use(authMiddleware, requireTenant);

engineSafetyRouter.get('/safety', async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const now = new Date();

  // 1. Offer policy violations — most recent failed prohibited-claim checks.
  const violations = await query(
    `SELECT cs.id, cs.offer_id, cs.campaign_id, cs.contact_email, cs.created_at,
            o.offer_name, o.network_name
       FROM compliance_snapshots cs
       LEFT JOIN affiliate_offers o ON o.id = cs.offer_id
      WHERE cs.prohibited_claim_check = 'fail'
      ORDER BY cs.created_at DESC LIMIT 100`) as any[];

  // 2. Stale terms — evaluate approved offers with the shared staleness rule.
  const approved = await query(
    `SELECT id, offer_name, network_name, status, terms_verified_at, terms_verified_by
       FROM affiliate_offers
      WHERE status = 'APPROVED'
      ORDER BY COALESCE(terms_verified_at, '1970-01-01') ASC LIMIT 500`) as any[];
  const staleTerms = approved
    .filter((o) => isTermsStale(o.terms_verified_at, now))
    .map((o) => ({
      id: o.id, offerName: o.offer_name, networkName: o.network_name,
      termsVerifiedAt: o.terms_verified_at, termsVerifiedBy: o.terms_verified_by,
      ageDays: daysSince(o.terms_verified_at, now),
    }));

  // 3. Paused campaigns (tenant-scoped).
  const pausedCampaigns = await query(
    `SELECT id, name, status, lifecycle_state, campaign_mode, mode_owner, updated_at
       FROM campaigns
      WHERE tenant_id = ? AND lifecycle_state = 'PAUSED'
      ORDER BY updated_at DESC LIMIT 200`, [tenantId]) as any[];

  res.json({
    termsMaxAgeDays: DEFAULT_TERMS_MAX_AGE_DAYS,
    counts: {
      offerPolicyViolations: violations.length,
      staleTerms: staleTerms.length,
      pausedCampaigns: pausedCampaigns.length,
    },
    offerPolicyViolations: violations,
    staleTerms,
    pausedCampaigns,
  });
});
