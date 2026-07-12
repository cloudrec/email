// Prometheus metrics endpoint. Scraped internally by the `monitoring` profile
// (prometheus reaches api:4000/metrics over the internal docker network).
// Publicly blocked at nginx (`location = /api/metrics { return 404; }`) so the
// endpoint needs no auth of its own.
//
// The headline metric is `email_worker_heartbeat_age_seconds`: the worker writes
// `worker:heartbeat` (epoch ms) to Redis every 15s. If that age climbs past ~120s
// the worker is stalled/dead — this is exactly the silent-death incident class
// that previously went unnoticed for days. An alert on it makes that impossible.
import type { Request, Response } from 'express';
import client from 'prom-client';
import { redis } from './redis.js';

const registry = new client.Registry();
registry.setDefaultLabels({ service: 'email-api' });
client.collectDefaultMetrics({ register: registry });

const heartbeatAge = new client.Gauge({
  name: 'email_worker_heartbeat_age_seconds',
  help: 'Seconds since the worker last wrote worker:heartbeat (>120 = stalled/dead)',
  registers: [registry],
});
const workerUp = new client.Gauge({
  name: 'email_worker_up',
  help: '1 if the worker heartbeat is fresh (<120s old), else 0',
  registers: [registry],
});

const STALE_SEC = 120;

export async function metricsHandler(_req: Request, res: Response): Promise<void> {
  try {
    const hb = await redis.get('worker:heartbeat');
    const ts = Number(hb);
    if (hb && Number.isFinite(ts)) {
      const ageSec = Math.max(0, (Date.now() - ts) / 1000);
      heartbeatAge.set(ageSec);
      workerUp.set(ageSec < STALE_SEC ? 1 : 0);
    } else {
      // No heartbeat ever seen / expired at 120s TTL / non-numeric — treat as down.
      heartbeatAge.set(1e9);
      workerUp.set(0);
    }
  } catch {
    // Redis unreachable — surface as down on BOTH gauges (don't leave age at a
    // stale/healthy-looking value).
    heartbeatAge.set(1e9);
    workerUp.set(0);
  }
  res.set('Content-Type', registry.contentType);
  res.end(await registry.metrics());
}
