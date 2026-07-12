import { Request, Response, NextFunction } from 'express';
import { query } from '../db.js';

// Block live-sending operations when tenant is not in good standing.
// Read operations still allowed so user can fix billing.
export async function requireActiveBilling(req: Request, res: Response, next: NextFunction) {
  const tenantId = req.auth?.tenantId;
  if (!tenantId) return res.status(400).json({ error: 'tenant_required' });

  const rows = await query(
    'SELECT status FROM tenants WHERE id=? LIMIT 1',
    [tenantId],
  );
  if (!rows.length) return res.status(404).json({ error: 'tenant_not_found' });

  const allowed = ['active', 'trial'];
  if (!allowed.includes(rows[0].status)) {
    return res.status(402).json({ error: 'tenant_inactive', status: rows[0].status });
  }
  next();
}

export async function assertDomainVerified(tenantId: number, domainId: number): Promise<boolean> {
  const rows = await query(
    'SELECT status FROM domains WHERE id=? AND tenant_id=? LIMIT 1',
    [domainId, tenantId],
  );
  return rows.length === 1 && rows[0].status === 'verified';
}
