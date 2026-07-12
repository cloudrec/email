import IORedis from 'ioredis';
import { config } from './config.js';

const opts = {
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
  maxRetriesPerRequest: null,
};

// Shared client for non-blocking commands (xadd, zadd, set, get, etc.).
export const redis = new IORedis(opts);

// Each BLOCK xread monopolizes a connection. Loops that consume streams
// must use a dedicated connection — otherwise N concurrent BLOCK xreads on
// the shared client deadlock all subsequent commands behind whichever
// command landed first.
export function dedicatedRedis() {
  return new IORedis(opts);
}
