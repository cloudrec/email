// Affiliate postback ingestion (TZ §12, §18). Public, token-authenticated endpoint
// that affiliate networks call to report clicks, conversions, and commission/refund
// events. Every write carries a UNIQUE idempotency_key, so a network retrying the same
// postback (they all do) inserts once and no more — replay-safe by construction.
import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { query } from '../db.js';

export const affiliateTrackingRouter = Router();
affiliateTrackingRouter.use(rateLimit({ windowMs: 60_000, max: 600, standardHeaders: 'draft-7', legacyHeaders: false }));

function authorize(req: any): boolean {
  const secret = config.webhooks?.bounceSecret;
  if (!secret || secret.startsWith('CHANGE_ME')) return false;
  const auth = req.header('authorization');
  let token = '';
  if (auth?.startsWith('Bearer ')) token = auth.slice(7);
  else if (req.header('x-webhook-token')) token = req.header('x-webhook-token');
  else if (typeof req.query.token === 'string') token = req.query.token;
  if (!token) return false;
  const a = Buffer.from(token), b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Deterministic idempotency key: same logical event => same key => single row.
function idemKey(kind: string, p: Record<string, unknown>): string {
  const basis = [kind, p.offerId, p.campaignId, p.clickId, p.subId, p.eventType, p.externalId, p.contactEmail]
    .map((x) => (x == null ? '' : String(x))).join('|');
  return crypto.createHash('sha256').update(basis).digest('hex').slice(0, 48);
}

const clickSchema = z.object({
  campaignId: z.coerce.number().int().optional(),
  offerId: z.coerce.number().int().optional(),
  contactEmail: z.string().email().optional(),
  subId: z.string().max(120).optional(),
  clickId: z.string().max(190).optional(),
  externalId: z.string().max(190).optional(),
  occurredAt: z.string().datetime().optional(),
});
affiliateTrackingRouter.post('/click', async (req, res) => {
  if (!authorize(req)) return res.status(401).json({ error: 'unauthorized' });
  const p = clickSchema.parse(req.body);
  const key = idemKey('click', p as any);
  await query(
    `INSERT IGNORE INTO click_events (campaign_id, offer_id, contact_email, sub_id, click_id, idempotency_key, occurred_at)
     VALUES (?,?,?,?,?,?,?)`,
    [p.campaignId ?? null, p.offerId ?? null, p.contactEmail ?? null, p.subId ?? null,
     p.clickId ?? null, key, p.occurredAt ? new Date(p.occurredAt) : new Date()]);
  res.json({ ok: true, idempotency_key: key });
});

const convSchema = clickSchema.extend({
  eventType: z.enum(['lead', 'qualified_lead', 'sale', 'meeting', 'proposal', 'won', 'lost']),
});
affiliateTrackingRouter.post('/conversion', async (req, res) => {
  if (!authorize(req)) return res.status(401).json({ error: 'unauthorized' });
  const p = convSchema.parse(req.body);
  const key = idemKey('conversion', p as any);
  await query(
    `INSERT IGNORE INTO conversion_events (campaign_id, offer_id, contact_email, event_type, sub_id, click_id, idempotency_key, occurred_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [p.campaignId ?? null, p.offerId ?? null, p.contactEmail ?? null, p.eventType, p.subId ?? null,
     p.clickId ?? null, key, p.occurredAt ? new Date(p.occurredAt) : new Date()]);
  res.json({ ok: true, idempotency_key: key });
});

const revSchema = z.object({
  campaignId: z.coerce.number().int().optional(),
  offerId: z.coerce.number().int().optional(),
  mode: z.enum(['OWN_PRODUCT_B2B', 'AFFILIATE']),
  eventType: z.enum(['revenue', 'commission_pending', 'commission_approved', 'commission_rejected', 'refund', 'chargeback']),
  amount: z.coerce.number(),
  currency: z.string().length(3).optional(),
  contactEmail: z.string().email().optional(),
  externalId: z.string().max(190).optional(),
  occurredAt: z.string().datetime().optional(),
});
affiliateTrackingRouter.post('/revenue', async (req, res) => {
  if (!authorize(req)) return res.status(401).json({ error: 'unauthorized' });
  const p = revSchema.parse(req.body);
  const key = idemKey('revenue', p as any);
  await query(
    `INSERT IGNORE INTO revenue_events (campaign_id, offer_id, mode, event_type, amount, currency, contact_email, idempotency_key, occurred_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [p.campaignId ?? null, p.offerId ?? null, p.mode, p.eventType, p.amount, p.currency ?? null,
     p.contactEmail ?? null, key, p.occurredAt ? new Date(p.occurredAt) : new Date()]);
  res.json({ ok: true, idempotency_key: key });
});
