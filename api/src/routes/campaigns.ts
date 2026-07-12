import { Router } from 'express';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { query } from '../db.js';
import { authMiddleware, requireTenant, requireWriteAccess } from '../middleware/auth.js';
import { audit } from '../middleware/audit.js';
import { requireActiveBilling, assertDomainVerified } from '../middleware/tenantGate.js';
import { redis } from '../redis.js';
import { evaluateSmtp, hasOperationalMailboxes } from './system.js';

export const campaignsRouter = Router();
campaignsRouter.use(authMiddleware, requireTenant);

campaignsRouter.get('/', async (req, res) => {
  const rows = await query(
    `SELECT id, uuid, name, subject, status, scheduled_at, total_recipients,
            sent_count, delivered_count, opened_count, clicked_count, bounced_count,
            unsubscribed_count, created_at
     FROM campaigns WHERE tenant_id=? ORDER BY created_at DESC LIMIT 200`,
    [req.auth!.tenantId],
  );
  res.json({ campaigns: rows });
});

const createSchema = z.object({
  name: z.string().min(1).max(200),
  subject: z.string().min(1).max(500),
  preheader: z.string().max(255).optional(),
  senderIdentityId: z.number().int().positive(),
  listId: z.number().int().positive().optional(),
  segmentId: z.number().int().positive().optional(),
  htmlBody: z.string().min(1),
  textBody: z.string().optional(),
});

campaignsRouter.post('/', requireWriteAccess, async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });
  const c = parsed.data;

  // P1 safety: segments disabled until evaluator ships.
  if (c.segmentId) {
    return res.status(501).json({
      error: 'segment_engine_not_ready',
      detail: 'Segment-based campaigns are disabled until the rule evaluator ships. Use listId instead.',
    });
  }
  if (!c.listId) {
    return res.status(400).json({ error: 'list_required', detail: 'A list_id is required. Segment scheduling is disabled.' });
  }

  // Validate sender belongs to tenant + domain is verified
  const senders = await query(
    `SELECT si.id, si.domain_id FROM sender_identities si
     WHERE si.id=? AND si.tenant_id=? LIMIT 1`,
    [c.senderIdentityId, req.auth!.tenantId],
  );
  if (!senders.length) return res.status(400).json({ error: 'sender_invalid' });
  if (!(await assertDomainVerified(req.auth!.tenantId!, senders[0].domain_id))) {
    return res.status(412).json({ error: 'domain_not_verified' });
  }

  const r = await query(
    `INSERT INTO campaigns
       (tenant_id, uuid, name, subject, preheader, sender_identity_id,
        list_id, segment_id, html_body, text_body, status, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)`,
    [
      req.auth!.tenantId,
      uuid(),
      c.name, c.subject, c.preheader ?? null,
      c.senderIdentityId, c.listId ?? null, c.segmentId ?? null,
      c.htmlBody, c.textBody ?? null,
      req.auth!.userId,
    ],
  );
  const id = Number(r.insertId);
  await audit(req, 'campaign.create', { type: 'campaign', id });
  res.status(201).json({ id });
});

campaignsRouter.post('/:id/test', requireWriteAccess, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const to = z.object({ to: z.string().email() }).safeParse(req.body);
  if (!to.success) return res.status(400).json({ error: 'invalid_body' });

  const camp = await query(
    `SELECT c.id, si.domain_id FROM campaigns c
     JOIN sender_identities si ON si.id = c.sender_identity_id
     WHERE c.id=? AND c.tenant_id=? LIMIT 1`,
    [id, req.auth!.tenantId],
  );
  if (!camp.length) return res.status(404).json({ error: 'not_found' });

  // P3 safety: even test-send requires a verified sending domain. SMTP-readiness
  // gating happens at the worker layer (workers/src/testSender.ts) so the failure
  // reason can be recorded in audit_log even when API can't see SMTP state.
  if (!(await assertDomainVerified(req.auth!.tenantId!, camp[0].domain_id))) {
    return res.status(412).json({ error: 'domain_not_verified' });
  }

  await redis.xadd(
    'send:test', '*',
    'campaignId', String(id),
    'tenantId', String(req.auth!.tenantId),
    'to', to.data.to,
  );
  await audit(req, 'campaign.test', { type: 'campaign', id }, { to: to.data.to });
  res.json({ queued: true });
});

const scheduleSchema = z.object({ scheduledAt: z.string().datetime().optional() });

campaignsRouter.post('/:id/schedule', requireWriteAccess, requireActiveBilling, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const parsed = scheduleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });

  const camp = await query(
    `SELECT c.id, c.status, c.list_id, c.segment_id, si.domain_id
     FROM campaigns c JOIN sender_identities si ON si.id = c.sender_identity_id
     WHERE c.id=? AND c.tenant_id=? LIMIT 1`,
    [id, req.auth!.tenantId],
  );
  if (!camp.length) return res.status(404).json({ error: 'not_found' });
  if (camp[0].status !== 'draft' && camp[0].status !== 'paused') {
    return res.status(409).json({ error: 'invalid_state', status: camp[0].status });
  }
  // P1 safety: segment evaluator not implemented. Block to prevent silent
  // send-to-all-subscribed. Force tenants to pick an explicit list.
  if (camp[0].segment_id) {
    return res.status(501).json({
      error: 'segment_engine_not_ready',
      detail: 'Segment-based campaigns are disabled until the rule evaluator ships. Use list_id instead.',
    });
  }
  if (!camp[0].list_id) {
    return res.status(400).json({ error: 'list_required', detail: 'Pick an explicit list_id. Segment scheduling is disabled.' });
  }
  if (!(await assertDomainVerified(req.auth!.tenantId!, camp[0].domain_id))) {
    return res.status(412).json({ error: 'domain_not_verified' });
  }

  // Phase 22H: campaign can send via provider-based mailboxes (preferred) or
  // env-var SMTP transport. If operational provider mailboxes exist, allow
  // scheduling even when SMTP_HOST is the local dev relay.
  const hasProvider = await hasOperationalMailboxes();
  if (!hasProvider) {
    const smtp = await evaluateSmtp();
    if (smtp.state !== 'ready') {
      const detail =
        smtp.state === 'test_only_mailhog' ? 'SMTP is Mailhog (local test only). Configure a real SMTP provider or activate provider mailboxes.' :
        smtp.state === 'not_configured'    ? 'SMTP is not configured. Set SMTP_HOST/SMTP_FROM_ADDRESS in .env or activate provider mailboxes.' :
        smtp.state === 'auth_failed'       ? 'SMTP authentication failed. Check SMTP_USER / SMTP_PASSWORD in .env.' :
                                             `SMTP is not ready: ${smtp.state}`;
      return res.status(412).json({ error: 'smtp_not_ready', smtpState: smtp.state, detail });
    }
  }

  const when = parsed.data.scheduledAt ?? new Date().toISOString();
  await query(
    "UPDATE campaigns SET status='scheduled', scheduled_at=? WHERE id=?",
    [new Date(when), id],
  );
  await redis.zadd('campaigns:due', new Date(when).getTime(), String(id));
  await audit(req, 'campaign.schedule', { type: 'campaign', id }, { scheduledAt: when });
  res.json({ ok: true, scheduledAt: when });
});

campaignsRouter.post('/:id/pause', requireWriteAccess, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await query(
    "UPDATE campaigns SET status='paused' WHERE id=? AND tenant_id=? AND status IN ('scheduled','sending')",
    [id, req.auth!.tenantId],
  );
  if (!r.affectedRows) return res.status(409).json({ error: 'cannot_pause' });
  await audit(req, 'campaign.pause', { type: 'campaign', id });
  res.json({ ok: true });
});

campaignsRouter.post('/:id/cancel', requireWriteAccess, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await query(
    "UPDATE campaigns SET status='canceled' WHERE id=? AND tenant_id=? AND status IN ('draft','scheduled','paused')",
    [id, req.auth!.tenantId],
  );
  await redis.zrem('campaigns:due', String(id));
  await audit(req, 'campaign.cancel', { type: 'campaign', id });
  res.json({ ok: true });
});

campaignsRouter.get('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const rows = await query(
    'SELECT * FROM campaigns WHERE id=? AND tenant_id=? LIMIT 1',
    [id, req.auth!.tenantId],
  );
  if (!rows.length) return res.status(404).json({ error: 'not_found' });
  res.json(rows[0]);
});
