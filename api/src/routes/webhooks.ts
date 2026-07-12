import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { redis } from '../redis.js';
import { query } from '../db.js';

export const webhooksRouter = Router();

// Stricter rate limit — webhook is unauthenticated below the token check.
const webhookLimiter = rateLimit({
  windowMs: 60_000,
  max: 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});
webhooksRouter.use(webhookLimiter);

function authorize(req: any): { ok: true } | { ok: false; reason: string } {
  if (!config.webhooks.bounceSecret || config.webhooks.bounceSecret.startsWith('CHANGE_ME')) {
    return { ok: false, reason: 'webhook_secret_not_configured' };
  }
  const auth = req.header('authorization');
  let token = '';
  if (auth?.startsWith('Bearer ')) token = auth.slice(7);
  else if (req.header('x-webhook-token')) token = req.header('x-webhook-token');
  else if (typeof req.query.token === 'string') token = req.query.token;
  if (!token) return { ok: false, reason: 'missing_token' };

  // Timing-safe compare
  const a = Buffer.from(token);
  const b = Buffer.from(config.webhooks.bounceSecret);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad_token' };
  }
  return { ok: true };
}

// Accept generic bounce payloads. Normalize to a consistent shape and push to stream.
//
// Required fields (any provider): tenant_id (or x-tenant-id header), email,
// type in {bounce_hard, bounce_soft, complaint}.
//
// Optional: campaign_id, provider_event_id, occurred_at, raw.
const payloadSchema = z.object({
  tenantId:        z.number().int().positive().optional(),
  email:           z.string().email().max(255),
  type:            z.enum(['bounce_hard', 'bounce_soft', 'complaint']),
  campaignId:      z.number().int().positive().optional(),
  providerEventId: z.string().max(160).optional(),
  occurredAt:      z.string().datetime().optional(),
  raw:             z.string().max(20000).optional(),
  provider:        z.string().max(60).optional(),
});

webhooksRouter.post('/bounce', async (req, res) => {
  const a = authorize(req);
  if (!a.ok) return res.status(401).json({ error: a.reason });

  const parsed = payloadSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', detail: parsed.error.flatten() });
  const p = parsed.data;

  const tenantHeader = req.header('x-tenant-id');
  const tenantId = p.tenantId ?? (tenantHeader ? Number(tenantHeader) : NaN);
  if (!Number.isFinite(tenantId)) return res.status(400).json({ error: 'tenant_required' });

  // Confirm tenant exists; silently drop for unknown tenants (no info leak).
  const ten = await query('SELECT id FROM tenants WHERE id=? LIMIT 1', [tenantId]);
  if (!ten.length) return res.status(202).json({ accepted: false, reason: 'unknown_tenant' });

  const entry: string[] = [
    'tenantId',  String(tenantId),
    // Full address — bounceProcessor writes this into `suppressions` and matches
    // it against `contacts.email`. Truncating here would gap suppression for
    // addresses >60 chars (they'd be re-mailed after a hard bounce/complaint).
    // The 60-char slice belongs ONLY on the audit_log target_id column below.
    'email',     p.email.toLowerCase(),
    'type',      p.type,
  ];
  if (p.campaignId)      entry.push('campaignId', String(p.campaignId));
  if (p.providerEventId) entry.push('providerEventId', p.providerEventId);
  if (p.occurredAt)      entry.push('occurredAt', p.occurredAt);
  if (p.provider)        entry.push('provider', p.provider);
  if (p.raw)             entry.push('raw', p.raw);

  await redis.xadd('webhook:bounce', '*', ...entry);

  // Audit (no user context — null fields are fine).
  await query(
    `INSERT INTO audit_log
       (tenant_id, user_id, actor_email, action, target_type, target_id, ip, user_agent, metadata)
     VALUES (?, NULL, NULL, 'webhook.bounce', 'email', ?, ?, ?, ?)`,
    [
      tenantId,
      p.email.toLowerCase().slice(0, 60),
      req.ip ?? null,
      req.header('user-agent')?.slice(0, 500) ?? null,
      JSON.stringify({ type: p.type, campaignId: p.campaignId, provider: p.provider, providerEventId: p.providerEventId }),
    ],
  );

  res.status(202).json({ accepted: true });
});

// ---------------------------------------------------------------------------
// Brevo provider-native webhook adapter.
//
// Brevo posts its own event shape (NOT the normalized one above). This route
// translates Brevo events into the SAME normalized pipeline: it pushes onto the
// `webhook:bounce` Redis stream (consumed by the worker bounceProcessor, which
// owns suppression + contact-status writes) and writes the SAME audit_log rows.
//
// Auth: reuses WEBHOOK_BOUNCE_SECRET via authorize() (Bearer / x-webhook-token /
// ?token=). Brevo lets you append ?token=<secret> to the configured webhook URL.
//
// Tenant: Brevo's payload carries no tenant, so it MUST come from the
// x-tenant-id header or ?tenant_id query (same as the normalized endpoint).
//
// Idempotency: deduped on Brevo's per-event id (falls back to message-id) via a
// short-lived Redis NX key, so retries/duplicate deliveries are dropped.
//
// Event mapping (only these are actioned; everything else is acknowledged & ignored):
//   hard_bounce  -> bounce_hard
//   soft_bounce  -> bounce_soft
//   spam         -> complaint
//   unsubscribed -> unsubscribe
const BREVO_EVENT_MAP: Record<string, 'bounce_hard' | 'bounce_soft' | 'complaint' | 'unsubscribe'> = {
  hard_bounce:  'bounce_hard',
  soft_bounce:  'bounce_soft',
  spam:         'complaint',
  complaint:    'complaint',
  unsubscribed: 'unsubscribe',
  unsubscribe:  'unsubscribe',
};

const brevoEventSchema = z
  .object({
    event:        z.string().max(60),
    email:        z.string().email().max(255),
    id:           z.union([z.number(), z.string()]).optional(),
    'message-id': z.string().max(200).optional(),
    reason:       z.string().max(500).optional(),
    tag:          z.string().max(200).optional(),
  })
  .passthrough();

const DEDUP_TTL_SECONDS = 7 * 24 * 3600;

webhooksRouter.post('/brevo', async (req, res) => {
  const a = authorize(req);
  if (!a.ok) return res.status(401).json({ error: a.reason });

  const tenantHeader = req.header('x-tenant-id');
  const tenantQuery = typeof req.query.tenant_id === 'string' ? req.query.tenant_id : undefined;
  const tenantId = Number(tenantHeader ?? tenantQuery ?? NaN);
  if (!Number.isFinite(tenantId)) return res.status(400).json({ error: 'tenant_required' });

  const ten = await query('SELECT id FROM tenants WHERE id=? LIMIT 1', [tenantId]);
  if (!ten.length) return res.status(202).json({ accepted: false, reason: 'unknown_tenant' });

  // Brevo transactional webhook posts one event object; marketing webhook may
  // batch an array. Accept both.
  const rawEvents = Array.isArray(req.body) ? req.body : [req.body];
  if (!rawEvents.length) return res.status(400).json({ error: 'empty_payload' });

  let actioned = 0;
  let ignored = 0;
  let duplicates = 0;

  for (const raw of rawEvents) {
    const parsed = brevoEventSchema.safeParse(raw);
    if (!parsed.success) { ignored++; continue; }
    const ev = parsed.data;

    const type = BREVO_EVENT_MAP[ev.event.toLowerCase()];
    if (!type) { ignored++; continue; }  // delivered/opened/click/etc — not actioned

    const email = ev.email.toLowerCase();
    const eventId = ev.id != null ? String(ev.id) : (ev['message-id'] ?? '');

    // Idempotency: drop if we've already processed this Brevo event id.
    if (eventId) {
      const fresh = await redis.set(
        `webhook:brevo:evt:${tenantId}:${eventId}`, '1', 'EX', DEDUP_TTL_SECONDS, 'NX',
      );
      if (!fresh) { duplicates++; continue; }
    }

    const entry: string[] = [
      'tenantId', String(tenantId),
      'email',    email,
      'type',     type,
      'provider', 'brevo',
    ];
    if (eventId)    entry.push('providerEventId', eventId);
    if (ev.reason)  entry.push('raw', String(ev.reason).slice(0, 20000));

    await redis.xadd('webhook:bounce', '*', ...entry);

    await query(
      `INSERT INTO audit_log
         (tenant_id, user_id, actor_email, action, target_type, target_id, ip, user_agent, metadata)
       VALUES (?, NULL, NULL, 'webhook.brevo', 'email', ?, ?, ?, ?)`,
      [
        tenantId,
        email.slice(0, 60),
        req.ip ?? null,
        req.header('user-agent')?.slice(0, 500) ?? null,
        JSON.stringify({ type, brevoEvent: ev.event, provider: 'brevo', providerEventId: eventId || undefined }),
      ],
    );

    actioned++;
  }

  res.status(202).json({ accepted: true, actioned, ignored, duplicates });
});

// ---------------------------------------------------------------------------
// Shared normalized event sink. Pushes onto the same `webhook:bounce` Redis
// stream consumed by the worker bounceProcessor (which owns suppression +
// contact-status writes) and writes the matching audit_log row. Idempotent on
// (tenantId, provider, eventId) via a short-lived Redis NX key.
//
// Returns 'actioned' | 'duplicate'. Logs SAFE metadata only (no raw creds).
type NormType = 'bounce_hard' | 'bounce_soft' | 'complaint' | 'unsubscribe';

async function sinkNormalized(
  tenantId: number,
  provider: string,
  ev: { email: string; type: NormType; eventId?: string; reason?: string; nativeEvent?: string },
): Promise<'actioned' | 'duplicate'> {
  const email = ev.email.toLowerCase();
  if (ev.eventId) {
    const fresh = await redis.set(
      `webhook:${provider}:evt:${tenantId}:${ev.eventId}`, '1', 'EX', DEDUP_TTL_SECONDS, 'NX',
    );
    if (!fresh) return 'duplicate';
  }
  const entry: string[] = ['tenantId', String(tenantId), 'email', email, 'type', ev.type, 'provider', provider];
  if (ev.eventId) entry.push('providerEventId', ev.eventId);
  if (ev.reason)  entry.push('raw', String(ev.reason).slice(0, 20000));
  await redis.xadd('webhook:bounce', '*', ...entry);

  await query(
    `INSERT INTO audit_log
       (tenant_id, user_id, actor_email, action, target_type, target_id, ip, user_agent, metadata)
     VALUES (?, NULL, NULL, ?, 'email', ?, NULL, NULL, ?)`,
    [tenantId, `webhook.${provider}`, email.slice(0, 60),
     JSON.stringify({ type: ev.type, nativeEvent: ev.nativeEvent, provider, providerEventId: ev.eventId || undefined })],
  );
  return 'actioned';
}

function resolveTenant(req: any): number {
  const tenantHeader = req.header('x-tenant-id');
  const tenantQuery = typeof req.query.tenant_id === 'string' ? req.query.tenant_id : undefined;
  return Number(tenantHeader ?? tenantQuery ?? NaN);
}

// Generic adapter — handles a batch of normalized-ish events. Each item may carry
// a normalized `type` directly, or a provider-native `event` string we map.
const NATIVE_EVENT_MAP: Record<string, NormType> = {
  hard_bounce: 'bounce_hard', hardbounce: 'bounce_hard', bounce: 'bounce_hard', failed: 'bounce_hard',
  permanent_fail: 'bounce_hard', dropped: 'bounce_hard',
  soft_bounce: 'bounce_soft', softbounce: 'bounce_soft', deferred: 'bounce_soft', temporary_fail: 'bounce_soft',
  spam: 'complaint', complaint: 'complaint', complained: 'complaint', spamreport: 'complaint',
  unsubscribe: 'unsubscribe', unsubscribed: 'unsubscribe', unsub: 'unsubscribe',
};

function mapNative(raw: any): NormType | null {
  if (raw?.type && ['bounce_hard', 'bounce_soft', 'complaint', 'unsubscribe'].includes(raw.type)) return raw.type;
  const ev = String(raw?.event ?? raw?.['event-type'] ?? '').toLowerCase().replace(/[\s-]/g, '_');
  return NATIVE_EVENT_MAP[ev] ?? null;
}

async function genericBatch(req: any, res: any, provider: string, opts: { extract: (raw: any) => any | null }) {
  const a = authorize(req);
  if (!a.ok) return res.status(401).json({ error: a.reason });
  const tenantId = resolveTenant(req);
  if (!Number.isFinite(tenantId)) return res.status(400).json({ error: 'tenant_required' });
  const ten = await query('SELECT id FROM tenants WHERE id=? LIMIT 1', [tenantId]);
  if (!ten.length) return res.status(202).json({ accepted: false, reason: 'unknown_tenant' });

  const items = Array.isArray(req.body) ? req.body : [req.body];
  if (!items.length) return res.status(400).json({ error: 'empty_payload' });

  let actioned = 0, ignored = 0, duplicates = 0;
  for (const raw of items) {
    const norm = opts.extract(raw);
    if (!norm || !norm.email || !norm.type) { ignored++; continue; }
    const r = await sinkNormalized(tenantId, provider, norm);
    if (r === 'duplicate') duplicates++; else actioned++;
  }
  return res.status(202).json({ accepted: true, actioned, ignored, duplicates });
}

// POST /webhooks/smtp2go — SMTP2GO posts {event, email/rcpt, ...} (single or batch).
webhooksRouter.post('/smtp2go', (req, res) =>
  genericBatch(req, res, 'smtp2go', {
    extract: (raw) => {
      const type = mapNative(raw);
      const email = raw?.email ?? raw?.rcpt ?? raw?.recipient;
      if (!type || !email) return null;
      return { email: String(email), type, eventId: raw?.['x-smtpapi-id'] ?? raw?.id ?? raw?.message_id, reason: raw?.reason ?? raw?.detail, nativeEvent: raw?.event };
    },
  }),
);

// POST /webhooks/mailgun — Mailgun wraps the event in `event-data`.
webhooksRouter.post('/mailgun', (req, res) =>
  genericBatch(req, res, 'mailgun', {
    extract: (raw) => {
      const d = raw?.['event-data'] ?? raw;
      let ev = String(d?.event ?? '').toLowerCase();
      // Mailgun 'failed' carries severity permanent|temporary.
      if (ev === 'failed') ev = d?.severity === 'temporary' ? 'soft_bounce' : 'hard_bounce';
      const type = mapNative({ event: ev });
      const email = d?.recipient ?? d?.message?.headers?.to;
      if (!type || !email) return null;
      return { email: String(email), type, eventId: d?.id ?? d?.message?.headers?.['message-id'], reason: d?.reason ?? d?.['delivery-status']?.message, nativeEvent: d?.event };
    },
  }),
);

// POST /webhooks/generic — provider-neutral. Accepts normalized `type` or native `event`.
webhooksRouter.post('/generic', (req, res) =>
  genericBatch(req, res, 'generic', {
    extract: (raw) => {
      const type = mapNative(raw);
      const email = raw?.email ?? raw?.recipient ?? raw?.rcpt;
      if (!type || !email) return null;
      return { email: String(email), type, eventId: raw?.providerEventId ?? raw?.id ?? raw?.event_id, reason: raw?.reason ?? raw?.raw, nativeEvent: raw?.event ?? raw?.type };
    },
  }),
);
