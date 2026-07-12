import 'dotenv/config';

const need = (k: string, fallback?: string) => {
  const v = process.env[k] ?? fallback;
  if (v === undefined) throw new Error(`Missing env: ${k}`);
  return v;
};

// A JWT secret left at the .env.example placeholder (or too short) means every
// session token is signed with a publicly-known key → trivially forgeable auth.
// Refuse to boot rather than run with a guessable secret.
const requireStrongSecret = (k: string) => {
  const v = need(k);
  if (v.startsWith('CHANGE_ME') || v.length < 24) {
    throw new Error(`${k} is a placeholder or too short (need ≥24 random chars) — refusing to start`);
  }
  return v;
};

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.API_PORT ?? '4000', 10),
  platformDomain: need('PLATFORM_DOMAIN', 'email.clients.help'),
  defaultLocale: (process.env.PLATFORM_DEFAULT_LOCALE ?? 'en') as 'en' | 'ru' | 'uk',
  jwt: {
    secret: requireStrongSecret('API_JWT_SECRET'),
    ttl: parseInt(process.env.API_JWT_TTL ?? '86400', 10),
    refreshTtl: parseInt(process.env.API_REFRESH_TTL ?? '2592000', 10),
  },
  db: {
    host: need('DB_HOST', 'db'),
    port: parseInt(process.env.DB_PORT ?? '3306', 10),
    user: need('DB_USER'),
    password: need('DB_PASSWORD'),
    database: need('DB_NAME'),
  },
  redis: {
    host: need('REDIS_HOST', 'redis'),
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    password: process.env.REDIS_PASSWORD ?? undefined,
  },
  rateLimit: {
    authPerMin: parseInt(process.env.API_RATE_LIMIT_AUTH_PER_MIN ?? '10', 10),
    generalPerMin: parseInt(process.env.API_RATE_LIMIT_GENERAL_PER_MIN ?? '120', 10),
  },
  tracking: {
    defaultDomain: process.env.TRACKING_DEFAULT_DOMAIN ?? `track.${process.env.PLATFORM_DOMAIN}`,
    pixelPath: process.env.TRACKING_PIXEL_PATH ?? '/o',
    clickPath: process.env.TRACKING_CLICK_PATH ?? '/c',
    unsubPath: process.env.TRACKING_UNSUB_PATH ?? '/u',
  },
  billing: {
    defaultProvider: process.env.BILLING_DEFAULT_PROVIDER ?? 'manual',
    trialDays: parseInt(process.env.BILLING_TRIAL_DAYS ?? '14', 10),
  },
  webhooks: {
    bounceSecret: process.env.WEBHOOK_BOUNCE_SECRET ?? '',
  },
  smtp: {
    host: process.env.SMTP_HOST ?? '',
    port: parseInt(process.env.SMTP_PORT ?? '25', 10),
    user: process.env.SMTP_USER ?? '',
    fromAddress: process.env.SMTP_FROM_ADDRESS ?? '',
    fromName: process.env.SMTP_FROM_NAME ?? '',
  },
  // Zoho manual bridge (Phase 21A). Secrets stay in .env; we only read presence
  // here. Real values are resolved at call time and NEVER logged or echoed.
  zoho: {
    smtpHost: process.env.ZOHO_SMTP_HOST ?? 'smtp.zoho.eu',
    smtpPort: parseInt(process.env.ZOHO_SMTP_PORT ?? '587', 10),
    imapHost: process.env.ZOHO_IMAP_HOST ?? 'imap.zoho.eu',
    imapPort: parseInt(process.env.ZOHO_IMAP_PORT ?? '993', 10),
    // env-var NAMES the operator must populate (UI shows names, never values):
    smtpUserRef: 'ZOHO_SMTP_USER',
    smtpPassRef: 'ZOHO_SMTP_PASSWORD',
    imapUserRef: 'ZOHO_IMAP_USER',
    imapPassRef: 'ZOHO_IMAP_PASSWORD',
  },
  search: {
    defaultProvider: process.env.SEARCH_PROVIDER ?? '',
  },
  tavily: {
    // NEVER log raw values. Access through tavilyKeyring (services/tavilyKeyring.ts).
    // Backward compatibility: TAVILY_API_KEY still works as the first key.
    // Plus either of:
    //   TAVILY_API_KEYS="key1,key2,key3"     (comma-separated, easiest)
    //   TAVILY_API_KEY_1, TAVILY_API_KEY_2, …  (numbered)
    apiKey: process.env.TAVILY_API_KEY ?? '',
    apiKeys: process.env.TAVILY_API_KEYS ?? '',
    apiKeysNumbered: (() => {
      const out: string[] = [];
      for (let i = 1; i <= 32; i++) {
        const v = process.env[`TAVILY_API_KEY_${i}`];
        if (v) out.push(v);
      }
      return out;
    })(),
    maxResultsPerQuery: parseInt(process.env.TAVILY_MAX_RESULTS_PER_QUERY ?? '20', 10),
    dailyCreditLimit: parseInt(process.env.TAVILY_DAILY_CREDIT_LIMIT ?? '100', 10),
    monthlyCreditLimit: parseInt(process.env.TAVILY_MONTHLY_CREDIT_LIMIT ?? '1000', 10),
    timeoutMs: parseInt(process.env.TAVILY_TIMEOUT_MS ?? '15000', 10),
  },
};
