import * as mariadb from 'mariadb';
import type { Pool, PoolConnection } from 'mariadb';
import { config } from './config.js';
import { logger } from './logger.js';

export const pool: Pool = mariadb.createPool({
  ...config.db,
  connectionLimit: 10,
  charset: 'utf8mb4',
  bigIntAsNumber: true,
  // Recycle idle/broken sockets so a transient DB blip does not poison the pool.
  idleTimeout: 60,
  minimumIdle: 0,
  acquireTimeout: 15_000,
});

// A mariadb pool that has been ended (e.g. after a fatal disconnect) rejects
// every subsequent getConnection() with "pool is closed" forever. The worker's
// loops swallow that error and sleep, so the process stays "up" while doing
// nothing — the exact silent-hang incident this guards against. When we detect a
// terminal pool state, exit non-zero so Docker's `restart: unless-stopped`
// recreates the container with a fresh pool.
function isPoolDead(e: any): boolean {
  const msg = String(e?.message ?? e ?? '');
  return (
    e?.code === 'ER_POOL_CLOSED' ||
    /pool is closed/i.test(msg) ||
    /pool was destroyed/i.test(msg)
  );
}

function guardFatal(e: any): void {
  if (isPoolDead(e)) {
    logger.fatal({ err: e?.message ?? String(e) }, 'db pool is dead — exiting for restart');
    // Give the logger a tick to flush, then exit so the orchestrator restarts us.
    setTimeout(() => process.exit(1), 250);
  }
}

export async function query(sql: string, params: any[] = []): Promise<any> {
  let c: PoolConnection | undefined;
  try {
    c = await pool.getConnection();
    return await c.query(sql, params);
  } catch (e) {
    guardFatal(e);
    throw e;
  } finally {
    c?.release();
  }
}

export async function tx<T>(fn: (c: PoolConnection) => Promise<T>): Promise<T> {
  let c: PoolConnection | undefined;
  try {
    c = await pool.getConnection();
    await c.beginTransaction();
    const r = await fn(c);
    await c.commit();
    return r;
  } catch (e) {
    if (c) { try { await c.rollback(); } catch { /* ignore */ } }
    guardFatal(e);
    throw e;
  } finally {
    c?.release();
  }
}
