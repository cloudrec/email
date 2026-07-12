import { backfillAll } from '../services/leadWarehouse.js';
import { logger } from '../logger.js';
import { pool } from '../db.js';

async function main() {
  logger.info('warehouse rebuild: starting');
  try {
    const stats = await backfillAll();
    logger.info(stats, 'warehouse rebuild: complete');
    console.log(JSON.stringify({ ok: true, ...stats }, null, 2));
  } catch (e: any) {
    logger.error({ err: e.message }, 'warehouse rebuild: failed');
    console.error('ERROR:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
    process.exit(process.exitCode ?? 0);
  }
}

main();
