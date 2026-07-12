import { Router } from 'express';
import dns from 'node:dns/promises';
import { z } from 'zod';
import { query } from '../db.js';
import { authMiddleware, requireTenant, requireWriteAccess } from '../middleware/auth.js';
import { audit } from '../middleware/audit.js';
import { config } from '../config.js';

export const trackingDomainsRouter = Router();
trackingDomainsRouter.use(authMiddleware, requireTenant);

function expectedRecords(domain: string) {
  // Custom tracking domain → CNAME to platform tracking host (go.<platform>).
  // Tenants who want their own subdomain create a CNAME record only.
  return [
    {
      purpose: 'tracking_cname',
      type: 'CNAME',
      host: domain,
      expected: `go.${config.platformDomain}`,
    },
  ];
}

const createSchema = z.object({
  domain: z.string().min(3).max(255).regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i),
});

trackingDomainsRouter.get('/', async (req, res) => {
  const rows = await query(
    `SELECT id, domain, status, verified_at, disabled_reason, last_checked_at, last_status_detail, dns_records_json, created_at
     FROM tracking_domains WHERE tenant_id=? ORDER BY created_at DESC`,
    [req.auth!.tenantId],
  );
  res.json({ domains: rows });
});

trackingDomainsRouter.post('/', requireWriteAccess, async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });
  const domain = parsed.data.domain.toLowerCase();

  // Safety: tenant must have custom_tracking_domains_enabled
  const safety = (await query(
    'SELECT custom_tracking_domains_enabled FROM tenant_safety_settings WHERE tenant_id=? LIMIT 1',
    [req.auth!.tenantId],
  ))[0];
  if (!safety || !safety.custom_tracking_domains_enabled) {
    return res.status(402).json({ error: 'custom_tracking_domains_disabled' });
  }

  const records = expectedRecords(domain);
  const ins = await query(
    `INSERT INTO tracking_domains (tenant_id, domain, status, dns_records_json)
     VALUES (?, ?, 'pending', ?)`,
    [req.auth!.tenantId, domain, JSON.stringify(records)],
  );
  await audit(req, 'tracking_domain.create', { type: 'tracking_domain', id: Number(ins.insertId) }, { domain });
  res.status(201).json({ id: Number(ins.insertId), domain, records });
});

trackingDomainsRouter.post('/:id/verify', requireWriteAccess, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const rows = await query(
    'SELECT domain FROM tracking_domains WHERE id=? AND tenant_id=? LIMIT 1',
    [id, req.auth!.tenantId],
  );
  if (!rows.length) return res.status(404).json({ error: 'not_found' });

  const expected = `go.${config.platformDomain}`;
  let got: string[] = [];
  let detail: any = { expected };
  try {
    got = await dns.resolveCname(rows[0].domain);
  } catch (e: any) {
    detail.dns_error = e?.code ?? e?.message;
  }
  const ok = got.some((v) => v === expected || v.endsWith(`.${expected}`));
  const status = ok ? 'verified' : 'failed';
  detail.got = got;

  await query(
    `UPDATE tracking_domains
       SET status=?, verified_at=?, last_checked_at=NOW(), last_status_detail=?
     WHERE id=? AND tenant_id=?`,
    [status, ok ? new Date() : null, JSON.stringify(detail), id, req.auth!.tenantId],
  );
  await audit(req, 'tracking_domain.verify', { type: 'tracking_domain', id }, { status });
  res.json({ status, detail });
});

trackingDomainsRouter.patch('/:id/disable', requireWriteAccess, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const reason = (req.body?.reason as string | undefined)?.slice(0, 255) ?? null;
  const r = await query(
    "UPDATE tracking_domains SET status='disabled', disabled_reason=? WHERE id=? AND tenant_id=?",
    [reason, id, req.auth!.tenantId],
  );
  if (!r.affectedRows) return res.status(404).json({ error: 'not_found' });
  await audit(req, 'tracking_domain.disable', { type: 'tracking_domain', id }, { reason });
  res.json({ ok: true });
});
