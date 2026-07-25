// Affiliate offer registry API (TZ §5, §17). Authenticated CRUD over affiliate_offers.
//
// The one rule that matters: an offer only becomes APPROVED through the explicit
// /approve action, which REQUIRES a caller-confirmed cold_email_allowed decision and a
// terms verification stamp. A plain PATCH can never flip status to APPROVED — approval
// is a deliberate, audited act, not a field edit.
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { authMiddleware, requireTenant, requireWriteAccess } from '../middleware/auth.js';
import { audit } from '../middleware/audit.js';

export const affiliateOffersRouter = Router();
affiliateOffersRouter.use(authMiddleware, requireTenant);

const offerSchema = z.object({
  networkName: z.string().min(2).max(160),
  advertiserName: z.string().min(1).max(200),
  offerName: z.string().min(1).max(200),
  externalOfferId: z.string().max(120).nullable().optional(),
  destinationUrl: z.string().url().max(2000).nullable().optional(),
  trackingUrlTemplate: z.string().url().max(2000).nullable().optional(),
  allowedGeos: z.array(z.string().min(2).max(8)).max(60).default([]),
  blockedGeos: z.array(z.string().min(2).max(8)).max(60).default([]),
  allowedTrafficSources: z.array(z.string().min(1).max(60)).max(30).default([]),
  incentiveAllowed: z.boolean().default(false),
  brandBiddingAllowed: z.boolean().default(false),
  directLinkingAllowed: z.boolean().default(false),
  requiredDisclosure: z.string().max(1000).nullable().optional(),
  prohibitedClaims: z.array(z.string().min(1).max(300)).max(40).default([]),
  payoutType: z.string().max(40).nullable().optional(),
  payoutAmount: z.number().nonnegative().nullable().optional(),
  payoutCurrency: z.string().length(3).nullable().optional(),
  cookieWindowDays: z.number().int().nonnegative().nullable().optional(),
  termsSource: z.string().max(2000).nullable().optional(),
});

affiliateOffersRouter.get('/', async (_req, res) => {
  const rows = await query(
    `SELECT id, network_name, advertiser_name, offer_name, external_offer_id, status,
            cold_email_allowed, payout_type, payout_amount, payout_currency,
            terms_verified_at, terms_verified_by, created_at, updated_at
     FROM affiliate_offers ORDER BY created_at DESC LIMIT 500`);
  res.json({ offers: rows });
});

affiliateOffersRouter.get('/:id', async (req, res) => {
  const rows = await query('SELECT * FROM affiliate_offers WHERE id=? LIMIT 1', [Number(req.params.id)]) as any[];
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json({ offer: rows[0] });
});

// Create — always lands in DRAFT. cold_email_allowed is NOT settable here; it is only
// affirmed at approval time, so a new offer can never be born send-ready.
affiliateOffersRouter.post('/', requireWriteAccess, async (req, res) => {
  const p = offerSchema.parse(req.body);
  const r = await query(
    `INSERT INTO affiliate_offers
       (network_name, advertiser_name, offer_name, external_offer_id, status,
        destination_url, tracking_url_template, allowed_geos_json, blocked_geos_json,
        allowed_traffic_sources_json, incentive_allowed, brand_bidding_allowed,
        direct_linking_allowed, required_disclosure, prohibited_claims_json,
        payout_type, payout_amount, payout_currency, cookie_window_days, terms_source)
     VALUES (?,?,?,?, 'DRAFT', ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [p.networkName, p.advertiserName, p.offerName, p.externalOfferId ?? null,
     p.destinationUrl ?? null, p.trackingUrlTemplate ?? null,
     JSON.stringify(p.allowedGeos), JSON.stringify(p.blockedGeos),
     JSON.stringify(p.allowedTrafficSources), p.incentiveAllowed ? 1 : 0,
     p.brandBiddingAllowed ? 1 : 0, p.directLinkingAllowed ? 1 : 0,
     p.requiredDisclosure ?? null, JSON.stringify(p.prohibitedClaims),
     p.payoutType ?? null, p.payoutAmount ?? null, p.payoutCurrency ?? null,
     p.cookieWindowDays ?? null, p.termsSource ?? null]) as any;
  await audit(req, 'affiliate_offer.create', { type: 'affiliate_offer', id: Number(r.insertId) });
  res.status(201).json({ id: r.insertId, status: 'DRAFT' });
});

affiliateOffersRouter.patch('/:id', requireWriteAccess, async (req, res) => {
  const p = offerSchema.partial().parse(req.body);
  // Deliberately not updatable here: status, cold_email_allowed, terms_verified_*.
  const map: Record<string, unknown> = {
    network_name: p.networkName, advertiser_name: p.advertiserName, offer_name: p.offerName,
    external_offer_id: p.externalOfferId, destination_url: p.destinationUrl,
    tracking_url_template: p.trackingUrlTemplate, required_disclosure: p.requiredDisclosure,
    payout_type: p.payoutType, payout_amount: p.payoutAmount, payout_currency: p.payoutCurrency,
    cookie_window_days: p.cookieWindowDays, terms_source: p.termsSource,
    allowed_geos_json: p.allowedGeos && JSON.stringify(p.allowedGeos),
    blocked_geos_json: p.blockedGeos && JSON.stringify(p.blockedGeos),
    allowed_traffic_sources_json: p.allowedTrafficSources && JSON.stringify(p.allowedTrafficSources),
    prohibited_claims_json: p.prohibitedClaims && JSON.stringify(p.prohibitedClaims),
    incentive_allowed: p.incentiveAllowed === undefined ? undefined : (p.incentiveAllowed ? 1 : 0),
    brand_bidding_allowed: p.brandBiddingAllowed === undefined ? undefined : (p.brandBiddingAllowed ? 1 : 0),
    direct_linking_allowed: p.directLinkingAllowed === undefined ? undefined : (p.directLinkingAllowed ? 1 : 0),
  };
  const sets: string[] = []; const vals: unknown[] = [];
  for (const [k, v] of Object.entries(map)) if (v !== undefined) { sets.push(`${k}=?`); vals.push(v); }
  if (!sets.length) return res.json({ updated: 0 });
  vals.push(Number(req.params.id));
  await query(`UPDATE affiliate_offers SET ${sets.join(', ')} WHERE id=?`, vals);
  await audit(req, 'affiliate_offer.update', { type: 'affiliate_offer', id: Number(req.params.id) });
  res.json({ updated: 1 });
});

// The explicit approval gate — the only path to APPROVED. Requires the caller to
// affirm cold_email_allowed and stamps terms verification (who + when).
const approveSchema = z.object({
  coldEmailAllowed: z.boolean(),
  termsVerified: z.literal(true),
  verifiedBy: z.string().min(1).max(120),
});
affiliateOffersRouter.post('/:id/approve', requireWriteAccess, async (req, res) => {
  const p = approveSchema.parse(req.body);
  if (!p.coldEmailAllowed) {
    return res.status(400).json({ error: 'cold_email_not_allowed', detail: 'Cannot approve an offer for email without confirming cold_email_allowed.' });
  }
  const r = await query(
    `UPDATE affiliate_offers
        SET status='APPROVED', cold_email_allowed=1, terms_verified_at=NOW(), terms_verified_by=?
      WHERE id=? AND status IN ('DRAFT','PENDING_REVIEW','PAUSED')`,
    [p.verifiedBy, Number(req.params.id)]) as any;
  if (!r.affectedRows) return res.status(409).json({ error: 'not_approvable_from_current_status' });
  // pin an immutable terms version at approval time
  await query(
    `INSERT INTO affiliate_offer_terms_versions (offer_id, terms_hash, terms_source, cold_email_allowed, verified_at, verified_by)
     SELECT id, SHA2(CONCAT(id,'|',IFNULL(terms_source,''),'|',NOW()),256), terms_source, 1, NOW(), ?
     FROM affiliate_offers WHERE id=?`,
    [p.verifiedBy, Number(req.params.id)]).catch(() => {});
  await audit(req, 'affiliate_offer.approve', { type: 'affiliate_offer', id: Number(req.params.id) });
  res.json({ status: 'APPROVED' });
});

const statusSchema = z.object({ status: z.enum(['PAUSED', 'REJECTED']) });
affiliateOffersRouter.post('/:id/status', requireWriteAccess, async (req, res) => {
  const p = statusSchema.parse(req.body);
  await query('UPDATE affiliate_offers SET status=? WHERE id=?', [p.status, Number(req.params.id)]);
  await audit(req, `affiliate_offer.status.${p.status}`, { type: 'affiliate_offer', id: Number(req.params.id) });
  res.json({ status: p.status });
});
