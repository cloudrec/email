import { BillingProvider, CheckoutRequest, CheckoutResult, InvoiceMark, WebhookEvent, registerProvider } from './adapter.js';
import { query, withConn } from '../db.js';

export const manualProvider: BillingProvider = {
  name: 'manual',

  async createCheckout(req: CheckoutRequest): Promise<CheckoutResult> {
    // No external redirect. Generate an open invoice; admin marks it paid.
    const plans = await query('SELECT id, price_cents, currency FROM plans WHERE code=? LIMIT 1', [req.planCode]);
    if (!plans.length) throw new Error(`Unknown plan: ${req.planCode}`);
    const plan = plans[0];

    const number = `INV-${Date.now()}-${req.tenantId}`;
    await query(
      `INSERT INTO invoices (tenant_id, number, amount_cents, currency, status, due_at, notes)
       VALUES (?, ?, ?, ?, 'open', DATE_ADD(NOW(), INTERVAL 7 DAY), ?)`,
      [req.tenantId, number, plan.price_cents, req.currency || plan.currency, `Manual invoice for plan ${req.planCode}`],
    );

    return {
      provider: 'manual',
      providerReference: number,
      instructions:
        'Manual payment: contact admin with invoice number to arrange wire/crypto/card transfer. Admin will activate access on confirmation.',
    };
  },

  async handleWebhook(_event: WebhookEvent): Promise<void> {
    // Manual provider has no webhooks.
  },

  async markInvoicePaid(req: InvoiceMark): Promise<void> {
    await withConn(async (c) => {
      await c.beginTransaction();
      try {
        const inv = await c.query('SELECT id, tenant_id, status FROM invoices WHERE id=? LIMIT 1', [req.invoiceId]);
        if (!inv.length) throw new Error('Invoice not found');
        if (inv[0].status === 'paid') {
          await c.commit();
          return;
        }
        await c.query("UPDATE invoices SET status='paid', paid_at=NOW() WHERE id=?", [req.invoiceId]);
        await c.query(
          `INSERT INTO payments
            (tenant_id, invoice_id, provider, provider_reference, amount_cents, currency, status, actor_user_id, notes)
           VALUES (?, ?, 'manual', ?, ?, ?, 'succeeded', ?, ?)`,
          [
            inv[0].tenant_id,
            req.invoiceId,
            req.providerReference ?? null,
            req.amountCents,
            req.currency,
            req.actorUserId,
            req.notes ?? null,
          ],
        );
        await c.query(
          "UPDATE tenants SET status='active', suspended_at=NULL, suspended_reason=NULL WHERE id=? AND status IN ('payment_pending','suspended','trial')",
          [inv[0].tenant_id],
        );
        await c.commit();
      } catch (e) {
        await c.rollback();
        throw e;
      }
    });
  },
};

registerProvider(manualProvider);
