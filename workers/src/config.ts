import 'dotenv/config';

export const config = {
  db: {
    host: process.env.DB_HOST ?? 'db',
    port: parseInt(process.env.DB_PORT ?? '3306', 10),
    user: process.env.DB_USER!,
    password: process.env.DB_PASSWORD!,
    database: process.env.DB_NAME!,
  },
  redis: {
    host: process.env.REDIS_HOST ?? 'redis',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
  },
  smtp: {
    host: process.env.SMTP_HOST!,
    port: parseInt(process.env.SMTP_PORT ?? '25', 10),
    user: process.env.SMTP_USER || undefined,
    password: process.env.SMTP_PASSWORD || undefined,
    fromAddress: process.env.SMTP_FROM_ADDRESS!,
    fromName: process.env.SMTP_FROM_NAME ?? 'Email Platform',
  },
  tracking: {
    domain: process.env.TRACKING_DEFAULT_DOMAIN ?? 'track.email.clients.help',
    pixelPath: process.env.TRACKING_PIXEL_PATH ?? '/o',
    clickPath: process.env.TRACKING_CLICK_PATH ?? '/c',
    unsubPath: process.env.TRACKING_UNSUB_PATH ?? '/u',
  },
  jwtSecret: process.env.API_JWT_SECRET!,
  concurrency: parseInt(process.env.WORKER_CONCURRENCY ?? '4', 10),
  sendRatePerSec: parseInt(process.env.WORKER_SEND_RATE_PER_SEC ?? '20', 10),
};
