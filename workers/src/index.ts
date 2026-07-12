import { campaignLoop } from './campaignRunner.js';
import { testSendLoop } from './testSender.js';
import { bounceLoop } from './bounceProcessor.js';
import { leadDiscoveryLoop } from './leadDiscovery.js';
import { websiteAnalysisLoop } from './websiteAnalysis.js';
import { outreachTestSendLoop } from './outreachTestSender.js';
import { collectorSchedulerLoop } from './collectorScheduler.js';
import { collectorDraftLoop } from './collectorDraftGenerator.js';
import { perpetualCollectorLoop } from './perpetualCollector.js';
import { leadPromoterLoop } from './leadPromoter.js';
import { contactVerifierLoop } from './contactVerifier.js';
import { manualOutreachDripLoop } from './manualOutreachDrip.js';
import { warmupSchedulerLoop } from './warmupScheduler.js';
import { logger } from './logger.js';
import { pool } from './db.js';
import { redis } from './redis.js';

logger.info('worker starting');

// Liveness heartbeat: refresh a short-TTL Redis key so an external healthcheck
// (docker-compose) can tell a hung/stalled worker apart from a healthy one.
// If Redis itself is unreachable the set throws and is swallowed — the DB pool
// guard (db.ts) covers the DB-death case, and a dead Redis fails the healthcheck
// read too, so either way an unhealthy worker is surfaced.
const HEARTBEAT_KEY = 'worker:heartbeat';
async function beat() {
  try { await redis.set(HEARTBEAT_KEY, Date.now().toString(), 'EX', 120); } catch { /* ignore */ }
}
beat();
setInterval(beat, 15_000).unref();

const loops = [
  campaignLoop(),
  testSendLoop(),
  bounceLoop(),
  leadDiscoveryLoop(), // worker 1
  leadDiscoveryLoop(), // worker 2
  leadDiscoveryLoop(), // worker 3
  leadDiscoveryLoop(), // worker 4
  leadDiscoveryLoop(), // worker 5
  websiteAnalysisLoop(),
  outreachTestSendLoop(),
  collectorSchedulerLoop(),
  collectorDraftLoop(),
  perpetualCollectorLoop(),
  leadPromoterLoop(),
  contactVerifierLoop(),
  manualOutreachDripLoop(),
  warmupSchedulerLoop(),
];

function shutdown(sig: string) {
  logger.info({ sig }, 'shutting down');
  pool.end().catch(() => {});
  redis.quit().catch(() => {});
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

Promise.allSettled(loops).then(() => {
  logger.warn('all loops exited');
  process.exit(1);
});
