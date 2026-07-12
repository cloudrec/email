import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.env === 'production' ? 'info' : 'debug',
  base: { service: 'email-api' },
  redact: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.token'],
});
