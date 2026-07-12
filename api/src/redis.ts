import IORedis from 'ioredis';
import { config } from './config.js';

export const redis = new IORedis({
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
  maxRetriesPerRequest: null,
  lazyConnect: false,
});

redis.on('error', (e) => console.error('[redis] error', e.message));
