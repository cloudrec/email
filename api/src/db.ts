import * as mariadb from 'mariadb';
import type { Pool, PoolConnection } from 'mariadb';
import { config } from './config.js';

export const pool: Pool = mariadb.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  connectionLimit: 20,
  charset: 'utf8mb4',
  timezone: 'Z',
  bigIntAsNumber: true,
});

export async function withConn<T>(fn: (c: PoolConnection) => Promise<T>): Promise<T> {
  const c = await pool.getConnection();
  try {
    return await fn(c);
  } finally {
    c.release();
  }
}

// Returns rows for SELECT, or { insertId, affectedRows, warningStatus } for INSERT/UPDATE/DELETE.
// Typed as `any` so callers can access either shape without unsafe casts.
export async function query(sql: string, params: any[] = []): Promise<any> {
  return withConn((c) => c.query(sql, params));
}
