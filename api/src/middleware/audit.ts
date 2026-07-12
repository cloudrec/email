import { Request } from 'express';
import { query } from '../db.js';

export async function audit(
  req: Request,
  action: string,
  target: { type?: string; id?: string | number } = {},
  metadata: Record<string, any> = {},
) {
  await query(
    `INSERT INTO audit_log
      (tenant_id, user_id, actor_email, action, target_type, target_id, ip, user_agent, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      req.auth?.tenantId ?? null,
      req.auth?.userId ?? null,
      req.auth?.email ?? null,
      action,
      target.type ?? null,
      target.id !== undefined ? String(target.id) : null,
      req.ip ?? null,
      req.header('user-agent')?.slice(0, 500) ?? null,
      Object.keys(metadata).length ? JSON.stringify(metadata) : null,
    ],
  );
}
