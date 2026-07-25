import { query } from '../db.js';

export async function isSuppressed(tenantId: number, email: string): Promise<boolean> {
  const rows = await query(
    'SELECT id FROM suppressions WHERE tenant_id=? AND email=? LIMIT 1',
    [tenantId, email.toLowerCase()],
  );
  return rows.length > 0;
}

// The full pre-send / pre-queue guard: a tenant-local suppression OR a global
// contact suppression (by exact email, or by domain). This is the single predicate
// the manual-outreach enqueue and send-gate consult (TZ §21.1/§21.2). Lives here in
// the service layer (no redis/express deps) so it is importable by tests.
export async function isSuppressedGlobal(tenantId: number, email: string): Promise<boolean> {
  const e = email.toLowerCase();
  const domain = e.split('@')[1] ?? '';
  const rows = await query(
    `SELECT 1 FROM suppressions WHERE tenant_id=? AND email=? LIMIT 1`, [tenantId, e],
  );
  if (rows.length) return true;
  const g = await query(
    `SELECT 1 FROM global_contact_suppression
     WHERE (type='email' AND normalized_value=?) OR (type='domain' AND normalized_value=?) LIMIT 1`,
    [e, domain],
  );
  return g.length > 0;
}

export async function addSuppression(
  tenantId: number,
  email: string,
  reason: 'unsubscribe' | 'bounce_hard' | 'complaint' | 'manual' | 'import',
  sourceEventId: number | null = null,
): Promise<void> {
  await query(
    `INSERT IGNORE INTO suppressions (tenant_id, email, reason, source_event_id)
     VALUES (?, ?, ?, ?)`,
    [tenantId, email.toLowerCase(), reason, sourceEventId],
  );
  // Sync contact status
  if (reason === 'unsubscribe') {
    await query(
      "UPDATE contacts SET status='unsubscribed', unsubscribed_at=NOW() WHERE tenant_id=? AND email=?",
      [tenantId, email.toLowerCase()],
    );
  } else if (reason === 'bounce_hard') {
    await query(
      "UPDATE contacts SET status='bounced', bounced_at=NOW() WHERE tenant_id=? AND email=?",
      [tenantId, email.toLowerCase()],
    );
  } else if (reason === 'complaint') {
    await query(
      "UPDATE contacts SET status='complained', complained_at=NOW() WHERE tenant_id=? AND email=?",
      [tenantId, email.toLowerCase()],
    );
  }
}
