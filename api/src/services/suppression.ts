import { query } from '../db.js';

export async function isSuppressed(tenantId: number, email: string): Promise<boolean> {
  const rows = await query(
    'SELECT id FROM suppressions WHERE tenant_id=? AND email=? LIMIT 1',
    [tenantId, email.toLowerCase()],
  );
  return rows.length > 0;
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
