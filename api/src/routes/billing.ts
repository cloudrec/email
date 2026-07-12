import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware, requireTenant, requireSuperAdmin, requireWriteAccess } from '../middleware/auth.js';
import { audit } from '../middleware/audit.js';
import { query } from '../db.js';
import { getProvider, listProviders } from '../billing/adapter.js';
import { config } from '../config.js';
import './_registerProviders.js';

export const billingRouter = Router();
billingRouter.use(authMiddleware);

billingRouter.get('/plans', async (_req, res) => {
  const rows = await query(
    'SELECT code, name, price_cents, currency, billing_period, max_contacts, max_sends_month, max_domains, max_users FROM plans WHERE is_public=1 AND is_active=1',
  );
  res.json({ plans: rows });
});

billingRouter.get('/providers', (_req, res) => {
  res.json({ providers: listProviders(), default: config.billing.defaultProvider });
});

const checkoutSchema = z.object({
  planCode: z.string(),
  provider: z.string().optional(),
  currency: z.string().length(3).default('USD'),
});

billingRouter.post('/checkout', requireTenant, requireWriteAccess, async (req, res) => {
  const parsed = checkoutSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });
  const provider = getProvider(parsed.data.provider ?? config.billing.defaultProvider);
  const result = await provider.createCheckout({
    tenantId: req.auth!.tenantId!,
    planCode: parsed.data.planCode,
    currency: parsed.data.currency,
  });
  await audit(req, 'billing.checkout', undefined, { provider: provider.name, plan: parsed.data.planCode });
  res.json(result);
});

billingRouter.get('/invoices', requireTenant, async (req, res) => {
  const rows = await query(
    'SELECT id, number, amount_cents, currency, status, issued_at, due_at, paid_at, notes FROM invoices WHERE tenant_id=? ORDER BY issued_at DESC',
    [req.auth!.tenantId],
  );
  res.json({ invoices: rows });
});

const markPaidSchema = z.object({
  invoiceId: z.number().int().positive(),
  providerReference: z.string().max(160).optional(),
  notes: z.string().max(1000).optional(),
});

// Super admin manual activation
billingRouter.post('/admin/mark-paid', requireSuperAdmin, async (req, res) => {
  const parsed = markPaidSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });

  const inv = await query(
    'SELECT id, amount_cents, currency FROM invoices WHERE id=? LIMIT 1',
    [parsed.data.invoiceId],
  );
  if (!inv.length) return res.status(404).json({ error: 'not_found' });

  await getProvider('manual').markInvoicePaid({
    invoiceId: inv[0].id,
    providerReference: parsed.data.providerReference,
    amountCents: inv[0].amount_cents,
    currency: inv[0].currency,
    actorUserId: req.auth!.userId,
    notes: parsed.data.notes,
  });
  await audit(req, 'billing.mark_paid', { type: 'invoice', id: inv[0].id });
  res.json({ ok: true });
});
