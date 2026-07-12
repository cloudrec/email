import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query } from '../db.js';

export type Role =
  | 'super_admin'
  | 'support_admin'
  | 'tenant_owner'
  | 'tenant_admin'
  | 'marketer'
  | 'analyst'
  | 'read_only';

export interface AuthContext {
  userId: number;
  email: string;
  isSuperAdmin: boolean;
  tenantId: number | null;
  role: Role | null;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export function signToken(payload: { sub: number; tenant?: number | null }) {
  return jwt.sign(payload, config.jwt.secret, { expiresIn: config.jwt.ttl });
}

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const hdr = req.header('authorization');
  if (!hdr?.startsWith('Bearer ')) return res.status(401).json({ error: 'unauthorized' });

  let decoded: any;
  try {
    decoded = jwt.verify(hdr.slice(7), config.jwt.secret);
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }

  const userId = Number(decoded.sub);
  const requestedTenant = req.header('x-tenant-id') ? Number(req.header('x-tenant-id')) : decoded.tenant ?? null;

  const users = await query(
    'SELECT id, email, is_super_admin, status FROM users WHERE id=? LIMIT 1',
    [userId],
  );
  if (!users.length || users[0].status !== 'active') {
    return res.status(401).json({ error: 'user_invalid' });
  }
  const user = users[0];

  let role: Role | null = null;
  let tenantId: number | null = null;

  if (requestedTenant) {
    const tu = await query(
      `SELECT tu.role, t.status AS tenant_status
       FROM tenant_users tu
       JOIN tenants t ON t.id = tu.tenant_id
       WHERE tu.tenant_id=? AND tu.user_id=? LIMIT 1`,
      [requestedTenant, userId],
    );
    if (tu.length) {
      if (tu[0].tenant_status === 'deleted_soft' || tu[0].tenant_status === 'deleted_hard') {
        return res.status(403).json({ error: 'tenant_deleted' });
      }
      role = tu[0].role;
      tenantId = requestedTenant;
    } else if (!user.is_super_admin) {
      return res.status(403).json({ error: 'tenant_forbidden' });
    } else {
      tenantId = requestedTenant;
      role = 'support_admin';
    }
  }

  req.auth = {
    userId,
    email: user.email,
    isSuperAdmin: !!user.is_super_admin,
    tenantId,
    role,
  };
  next();
}

export function requireSuperAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.auth?.isSuperAdmin) return res.status(403).json({ error: 'super_admin_required' });
  next();
}

export function requireTenant(req: Request, res: Response, next: NextFunction) {
  if (!req.auth?.tenantId) return res.status(400).json({ error: 'tenant_required' });
  next();
}

export function requireRole(...allowed: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.auth?.isSuperAdmin) return next();
    if (!req.auth?.role || !allowed.includes(req.auth.role)) {
      return res.status(403).json({ error: 'role_forbidden' });
    }
    next();
  };
}

export function requireWriteAccess(req: Request, res: Response, next: NextFunction) {
  return requireRole('tenant_owner', 'tenant_admin', 'marketer', 'support_admin')(req, res, next);
}
