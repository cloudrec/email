// Read-only revenue reporting for the admin UI (TZ §17 Revenue section). This router
// never writes — revenue_events are written only by the postback ingestion API
// (affiliateTracking.ts). It aggregates the ledger into the five figures the spec asks
// for: own-product revenue, pending affiliate commission, approved affiliate commission,
// refunds, and net revenue. Amounts are grouped by currency (mixing currencies in one
// sum would be meaningless).
import { Router } from 'express';
import { query } from '../db.js';
import { authMiddleware, requireTenant } from '../middleware/auth.js';

export const affiliateRevenueRouter = Router();
affiliateRevenueRouter.use(authMiddleware, requireTenant);

// Net = own-product revenue + approved commission − refunds − chargebacks.
// Pending commission is shown but NOT counted as net (TZ §12: no profit claim before
// the commission is approved).
affiliateRevenueRouter.get('/summary', async (_req, res) => {
  const rows = await query(
    `SELECT COALESCE(currency,'—') AS currency,
            SUM(CASE WHEN mode='OWN_PRODUCT_B2B' AND event_type='revenue' THEN amount ELSE 0 END) AS own_product_revenue,
            SUM(CASE WHEN event_type='commission_pending'  THEN amount ELSE 0 END) AS pending_commission,
            SUM(CASE WHEN event_type='commission_approved' THEN amount ELSE 0 END) AS approved_commission,
            SUM(CASE WHEN event_type IN ('refund','chargeback') THEN amount ELSE 0 END) AS refunds,
            COUNT(*) AS events
       FROM revenue_events
      GROUP BY COALESCE(currency,'—')
      ORDER BY currency`) as any[];

  const byCurrency = rows.map((r) => {
    const own = Number(r.own_product_revenue) || 0;
    const approved = Number(r.approved_commission) || 0;
    const refunds = Number(r.refunds) || 0;
    return {
      currency: r.currency,
      ownProductRevenue: own,
      pendingCommission: Number(r.pending_commission) || 0,
      approvedCommission: approved,
      refunds,
      netRevenue: own + approved - refunds,
      events: Number(r.events) || 0,
    };
  });

  // A small recent-events tail so the operator can see the underlying ledger.
  const recent = await query(
    `SELECT id, campaign_id, offer_id, mode, event_type, amount, currency, contact_email, occurred_at
       FROM revenue_events ORDER BY COALESCE(occurred_at, created_at) DESC LIMIT 50`) as any[];

  res.json({ byCurrency, recent });
});
