// Worker liveness probe for docker-compose. Exits 0 if the worker refreshed its
// heartbeat within the freshness window, else 1 (marks the container unhealthy).
// The worker writes `worker:heartbeat` (epoch ms, 120s TTL) every 15s in index.ts.
import Redis from 'ioredis';

const FRESH_MS = 90_000;

const redis = new Redis({
  host: process.env.REDIS_HOST ?? 'redis',
  port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  lazyConnect: true,
  connectTimeout: 4000,
  maxRetriesPerRequest: 1,
});

const timer = setTimeout(() => { console.error('healthcheck timeout'); process.exit(1); }, 6000);

try {
  await redis.connect();
  const v = await redis.get('worker:heartbeat');
  const age = v ? Date.now() - Number(v) : Infinity;
  if (Number.isFinite(age) && age < FRESH_MS) {
    process.exit(0);
  }
  console.error(`stale heartbeat: age=${age}ms`);
  process.exit(1);
} catch (e) {
  console.error('healthcheck error', e?.message ?? e);
  process.exit(1);
} finally {
  clearTimeout(timer);
  redis.disconnect();
}
