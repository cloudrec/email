import express from 'express';
// Patches Express 4 so async route handlers that reject are forwarded to the
// error middleware instead of producing a hung request (Express 4 does not do
// this natively). Must be imported before any router is defined.
import 'express-async-errors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';

import { config } from './config.js';
import { logger } from './logger.js';
import { pool } from './db.js';
import { redis } from './redis.js';
import { metricsHandler } from './metrics.js';

import { authRouter } from './routes/auth.js';
import { tenantsRouter } from './routes/tenants.js';
import { domainsRouter } from './routes/domains.js';
import { contactsRouter } from './routes/contacts.js';
import { campaignsRouter } from './routes/campaigns.js';
import { trackingRouter } from './routes/tracking.js';
import { billingRouter } from './routes/billing.js';
import { leadsRouter } from './routes/leads.js';
import { productProfilesRouter } from './routes/productProfiles.js';
import { websiteAnalysisRouter } from './routes/websiteAnalysis.js';
import { outreachDraftsRouter } from './routes/outreachDrafts.js';
import { webhooksRouter } from './routes/webhooks.js';
import { systemRouter } from './routes/system.js';
import { collectorRouter, collectorAdminRouter } from './routes/collector.js';
import { inviteLinksRouter } from './routes/inviteLinks.js';
import { trackingDomainsRouter } from './routes/trackingDomains.js';
import { publicInviteRouter } from './routes/publicInvite.js';
import { adminSafetyRouter } from './routes/adminSafety.js';
import { themeRouter } from './routes/theme.js';
import { warehouseRouter, warehouseAdminRouter } from './routes/warehouse.js';
import { senderIdentitiesRouter } from './routes/senderIdentities.js';
import { sendingRouter } from './routes/sending.js';
import { manualOutreachRouter } from './routes/manualOutreach.js';
import { goLiveRouter } from './routes/goLive.js';
import { deliverabilityRouter } from './routes/deliverability.js';
import { senderStudioRouter } from './routes/senderStudio.js';
import { mailboxesRouter } from './routes/mailboxes.js';
import { smtpNodesRouter } from './routes/smtpNodes.js';
import { partnerOutreachRouter } from './routes/partnerOutreach.js';
import { listsRouter } from './routes/lists.js';
import { affiliateOffersRouter } from './routes/affiliateOffers.js';
import { affiliateTrackingRouter } from './routes/affiliateTracking.js';
import { authMiddleware } from './middleware/auth.js';
import { seoBlogRouter } from './routes/seoBlog.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '5mb' }));
app.use(pinoHttp({ logger }));

const generalLimiter = rateLimit({
  windowMs: 60_000,
  max: config.rateLimit.generalPerMin,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});
const authLimiter = rateLimit({
  windowMs: 60_000,
  max: config.rateLimit.authPerMin,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

// Health (no auth)
app.get('/health', async (_req, res) => {
  try {
    const c = await pool.getConnection();
    await c.ping();
    c.release();
    const pong = await redis.ping();
    res.json({ status: 'ok', db: 'ok', redis: pong === 'PONG' ? 'ok' : 'fail' });
  } catch (e: any) {
    res.status(503).json({ status: 'fail', error: e.message });
  }
});

// Prometheus metrics (no auth; blocked publicly at nginx, scraped internally)
app.get('/metrics', metricsHandler);

// Tracking is intentionally unauthenticated (token-signed instead)
app.use('/', trackingRouter);

// Public invite link redirect — unauthenticated. Suppression-aware. Rate-limited.
app.use('/', publicInviteRouter);

// Webhooks are token-authenticated (Bearer / x-webhook-token / ?token=)
app.use('/webhooks', webhooksRouter);
app.use('/webhooks/affiliate', affiliateTrackingRouter);

// Auth (with stricter rate limit on login/register)
app.use('/auth', authLimiter, authRouter);

// All API routes share general limiter
app.use(generalLimiter);

app.use('/tenants', tenantsRouter);
app.use('/domains', domainsRouter);
app.use('/contacts', contactsRouter);
app.use('/campaigns', campaignsRouter);
app.use('/affiliate/offers', affiliateOffersRouter);
app.use('/billing', billingRouter);
app.use('/leads', leadsRouter);
app.use('/product-profiles', productProfilesRouter);
app.use('/website-analysis', websiteAnalysisRouter);
app.use('/outreach/drafts', outreachDraftsRouter);
// Theme router mounts FIRST at root so its routes (/system/theme, /me/theme, /admin/theme-default)
// resolve before /system and /admin sub-routers can short-circuit them with their auth middleware.
app.use('/', themeRouter);
app.use('/system', systemRouter);
app.use('/collector', collectorRouter);
app.use('/admin/collector', collectorAdminRouter);
app.use('/invite-links', inviteLinksRouter);
app.use('/tracking-domains', trackingDomainsRouter);
app.use('/warehouse', warehouseRouter);
app.use('/admin/warehouse', warehouseAdminRouter);
app.use('/sender-identities', senderIdentitiesRouter);
app.use('/sending', sendingRouter);
app.use('/manual-outreach', manualOutreachRouter);
app.use('/go-live', goLiveRouter);
app.use('/deliverability', deliverabilityRouter);
app.use('/sender-studio', senderStudioRouter);
app.use('/mailboxes', mailboxesRouter);
app.use('/smtp-nodes', smtpNodesRouter);
app.use('/partner-outreach', partnerOutreachRouter);
app.use('/contacts/lists', listsRouter);
app.use('/admin', adminSafetyRouter);

// 404
app.use('/', seoBlogRouter);

app.use((_req, res) => res.status(404).json({ error: 'not_found' }));

// Error handler
app.use((err: any, _req: any, res: any, _next: any) => {
  logger.error({ err }, 'unhandled');
  res.status(500).json({ error: 'internal_error' });
});

const server = app.listen(config.port, () => {
  logger.info({ port: config.port, env: config.env }, 'api listening');
});

function shutdown(sig: string) {
  logger.info({ sig }, 'shutting down');
  server.close(() => {
    pool.end().catch(() => {});
    redis.quit().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// Resilience guard: Express 4 does NOT forward async-route rejections to the
// error middleware, so a single throwing handler (e.g. a DB constraint error)
// would otherwise crash the whole API and drop every in-flight request for all
// tenants. Log and stay up — the offending request fails, the service survives.
process.on('unhandledRejection', (reason: any) => {
  logger.error({ err: reason }, 'unhandledRejection (kept alive)');
});
process.on('uncaughtException', (err: any) => {
  logger.error({ err }, 'uncaughtException (kept alive)');
});
