import crypto from 'node:crypto';
import { query, tx } from './db.js';
import { redis } from './redis.js';
import { logger } from './logger.js';
import { sendOne, type SmtpOpts } from './sender.js';
import { config } from './config.js';

const VAULT_KEY = crypto.createHash('sha256').update(process.env.API_JWT_SECRET || 'insecure-dev-key').digest();
function decryptSecret(b64: string): string {
  const buf = Buffer.from(b64, 'base64');
  const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), ct = buf.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', VAULT_KEY, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

async function resolveSecret(ref: string | null | undefined): Promise<string | undefined> {
  if (!ref) return undefined;
  try {
    const rows = await query('SELECT value_enc FROM mailbox_secrets WHERE ref_name=? LIMIT 1', [ref]);
    if (rows.length && rows[0].value_enc) { try { return decryptSecret(rows[0].value_enc); } catch { /* fall through */ } }
  } catch { /* table missing -> env */ }
  const v = process.env[ref];
  return v && v.length ? v : undefined;
}

const LOCK_TTL = 60;

async function pickDue(): Promise<number | null> {
  const now = Date.now();
  const items = await redis.zrangebyscore('campaigns:due', 0, now, 'LIMIT', 0, 1);
  if (!items.length) return null;

  const id = items[0];
  const got = await redis.set(`lock:campaign:${id}`, '1', 'EX', LOCK_TTL, 'NX');
  if (!got) return null;
  await redis.zrem('campaigns:due', id);
  return parseInt(id, 10);
}

interface Recipient { id: number; email: string; first_name: string | null; last_name: string | null; }

async function recipientsFor(campaign: any): Promise<Recipient[]> {
  // Suppression-aware. Only subscribed contacts.
  // P1 safety: only list_id is supported. segment_id is blocked by gateChecks.
  if (!campaign.list_id) {
    // Defense-in-depth: should never reach here because gateChecks rejected.
    throw new Error('list_required_for_send');
  }
  return query(
    `SELECT c.id, c.email, c.first_name, c.last_name
     FROM list_contacts lc
     JOIN contacts c ON c.id = lc.contact_id
     WHERE lc.list_id = ?
       AND c.tenant_id = ?
       AND c.status = 'subscribed'
       AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.tenant_id = c.tenant_id AND s.email = c.email)
       -- Skip contacts already sent this campaign, so a throttled/resumed run never
       -- re-mails the head of the list (duplicate-send guard).
       AND NOT EXISTS (
         SELECT 1 FROM campaign_events ce
         WHERE ce.campaign_id = ? AND ce.contact_id = c.id AND ce.event_type = 'sent'
       )`,
    [campaign.list_id, campaign.tenant_id, campaign.id],
  );
}

async function loadCampaign(id: number): Promise<any | null> {
  const rows = await query(
    `SELECT c.id, c.tenant_id, c.uuid, c.name, c.subject, c.preheader, c.html_body, c.text_body,
            c.sender_identity_id, c.list_id, c.segment_id, c.status, c.created_by,
            c.total_recipients, c.sent_count, c.delivered_count, c.opened_count, c.clicked_count,
            c.bounced_count, c.unsubscribed_count, c.complained_count,
            c.scheduled_at, c.started_at, c.finished_at, c.created_at, c.updated_at,
            si.from_email, si.from_name, si.reply_to,
            si.status AS mailbox_status, si.daily_send_limit AS mailbox_daily,
            si.hourly_send_limit AS mailbox_hourly, si.sent_today AS mailbox_sent_today,
            si.counters_day AS mailbox_counters_day,
            si.smtp_user_ref, si.smtp_secret_ref,
            d.domain AS sender_domain, d.dkim_selector, d.dkim_private_key, d.status AS domain_status,
            d.daily_send_limit, d.hourly_send_limit AS domain_hourly, d.reputation_score,
            p.smtp_host, p.smtp_port, p.smtp_secure, p.provider_type,
            p.smtp_user_ref AS p_smtp_user_ref, p.smtp_secret_ref AS p_smtp_secret_ref,
            p.username_ref AS p_username_ref, p.secret_ref AS p_secret_ref
     FROM campaigns c
     JOIN sender_identities si ON si.id = c.sender_identity_id
     JOIN domains d ON d.status='verified' AND d.domain = SUBSTRING_INDEX(si.from_email, '@', -1)
     LEFT JOIN sending_providers p ON p.id = si.provider_id
     WHERE c.id = ? LIMIT 1`,
    [id],
  );
  return rows[0] ?? null;
}

async function gateChecks(campaign: any): Promise<string | null> {
  if (campaign.domain_status !== 'verified') return `domain_not_verified:${campaign.sender_domain}`;
  const tenant = await query("SELECT status FROM tenants WHERE id=? LIMIT 1", [campaign.tenant_id]);
  if (!tenant.length) return 'tenant_missing';
  if (!['active', 'trial'].includes(tenant[0].status)) return `tenant_${tenant[0].status}`;
  // Kill-switch: the tenant outreach pause (set manually or by autoPause on a
  // reputation breach) must stop campaigns too — previously only the drip honoured it.
  const paused = await query(
    'SELECT outreach_paused FROM tenant_safety_settings WHERE tenant_id=? AND outreach_paused=1 LIMIT 1',
    [campaign.tenant_id],
  );
  if (paused.length) return 'outreach_paused';
  // P1 safety: segment evaluator not implemented. Refuse to send segment-targeted
  // campaigns even if scheduler somehow let one through (defense in depth).
  if (campaign.segment_id && !campaign.list_id) return 'segment_engine_not_ready';
  if (!campaign.list_id) return 'list_required';
  // Per-mailbox hard gate: a paused/disabled sender identity cannot send.
  if (campaign.mailbox_status && campaign.mailbox_status !== 'active') return `mailbox_${campaign.mailbox_status}`;
  return null;
}

// Reset a mailbox's daily counters when the calendar day rolls over. Idempotent.
async function rollMailboxCounters(senderId: number): Promise<void> {
  await query(
    `UPDATE sender_identities
       SET sent_today=0, bounced_today=0, complained_today=0, unsubscribed_today=0, counters_day=CURDATE()
     WHERE id=? AND (counters_day IS NULL OR counters_day < CURDATE())`,
    [senderId],
  );
}

// Per-mailbox sent count in the trailing hour (real campaign_events, by sender).
async function mailboxSentInWindow(senderId: number, window: 'today' | 'hour'): Promise<number> {
  const w = window === 'today' ? 'occurred_at >= CURDATE()' : 'occurred_at >= (NOW() - INTERVAL 1 HOUR)';
  const [r] = await query(
    `SELECT COUNT(*) AS c FROM campaign_events ce
     JOIN campaigns c ON c.id=ce.campaign_id
     WHERE c.sender_identity_id=? AND ce.event_type IN ('sent','delivered') AND ${w}`,
    [senderId],
  );
  return Number(r.c);
}

// Phase 18 compliance gates. Real counts only — no fake warmup.
const GATE_BOUNCE = 0.03;     // > 3%
const GATE_COMPLAINT = 0.001; // > 0.1%

async function tenantEventCount(tenantId: number, types: string[], window: 'today' | 'hour'): Promise<number> {
  const ph = types.map(() => '?').join(',');
  const w = window === 'today' ? 'occurred_at >= CURDATE()' : 'occurred_at >= (NOW() - INTERVAL 1 HOUR)';
  const [r] = await query(
    `SELECT COUNT(*) AS c FROM campaign_events WHERE tenant_id=? AND event_type IN (${ph}) AND ${w}`,
    [tenantId, ...types],
  );
  return Number(r.c);
}

// Auto-pause: if today's bounce/complaint rate breaches thresholds, pause the
// campaign + the tenant's outreach, and record a risk event. Returns reason or null.
async function reputationGate(c: any): Promise<string | null> {
  const sentToday = await tenantEventCount(c.tenant_id, ['sent', 'delivered'], 'today');
  if (sentToday < 20) return null; // not enough signal yet
  const bounces = await tenantEventCount(c.tenant_id, ['bounced_hard', 'bounced_soft'], 'today');
  const complaints = await tenantEventCount(c.tenant_id, ['complained'], 'today');
  if (bounces / sentToday > GATE_BOUNCE) return `bounce_rate_${((bounces / sentToday) * 100).toFixed(1)}pct`;
  if (complaints / sentToday > GATE_COMPLAINT) return `complaint_rate_${((complaints / sentToday) * 100).toFixed(2)}pct`;
  return null;
}

async function autoPause(c: any, reason: string) {
  await query("UPDATE campaigns SET status='paused' WHERE id=?", [c.id]);
  await query(
    `INSERT INTO tenant_safety_settings (tenant_id, outreach_paused, outreach_paused_reason)
     VALUES (?, 1, ?) ON DUPLICATE KEY UPDATE outreach_paused=1, outreach_paused_reason=VALUES(outreach_paused_reason)`,
    [c.tenant_id, reason.slice(0, 255)],
  ).catch(() => {});
  await query(
    `INSERT INTO tenant_risk_events (tenant_id, event_type, severity, reason, metadata_json)
     VALUES (?, 'auto_pause', 'critical', ?, ?)`,
    [c.tenant_id, reason.slice(0, 500), JSON.stringify({ campaignId: c.id })],
  ).catch(() => {});
  logger.warn({ id: c.id, reason }, 'campaign auto-paused by reputation gate');
}

async function runCampaign(id: number) {
  const c = await loadCampaign(id);
  if (!c) { logger.warn({ id }, 'campaign vanished'); return; }
  if (c.status === 'canceled' || c.status === 'paused') {
    logger.info({ id, status: c.status }, 'skip due to status');
    return;
  }

  const blocked = await gateChecks(c);
  if (blocked) {
    await query("UPDATE campaigns SET status='failed', finished_at=NOW() WHERE id=?", [id]);
    logger.warn({ id, reason: blocked }, 'campaign blocked');
    return;
  }

  await tx(async (conn) => {
    await conn.query("UPDATE campaigns SET status='sending', started_at=NOW() WHERE id=?", [id]);
  });

  // Reputation auto-pause gate (bounce > 3% / complaint > 0.1% today).
  const gateReason = await reputationGate(c);
  if (gateReason) {
    await autoPause(c, gateReason);
    return;
  }

  let recipients = await recipientsFor(c);

  // Roll mailbox daily counters if the day changed, then compute the binding cap
  // across EVERY layer: per-domain, per-mailbox, and per-tenant — each day+hour.
  await rollMailboxCounters(c.sender_identity_id);

  const domainDaily  = Number(c.daily_send_limit) || 20;
  const domainHourly = Number(c.domain_hourly) || Math.max(1, Math.ceil(domainDaily / 4));
  const mbDaily      = Number(c.mailbox_daily) || 10;
  const mbHourly     = Number(c.mailbox_hourly) || Math.max(1, Math.ceil(mbDaily / 4));

  const tenantToday = await tenantEventCount(c.tenant_id, ['sent', 'delivered'], 'today');
  const tenantHour  = await tenantEventCount(c.tenant_id, ['sent', 'delivered'], 'hour');
  const mbToday     = await mailboxSentInWindow(c.sender_identity_id, 'today');
  const mbHour      = await mailboxSentInWindow(c.sender_identity_id, 'hour');

  // Per-tenant daily cap = sum of mailbox daily limits is hard to know cheaply;
  // reuse domain daily as the tenant-day ceiling (matches prior behaviour) AND
  // layer in the stricter per-mailbox + per-domain-hour caps.
  const allowance = Math.min(
    Math.max(0, domainDaily - tenantToday),
    Math.max(0, domainHourly - tenantHour),
    Math.max(0, mbDaily - mbToday),
    Math.max(0, mbHourly - mbHour),
  );

  if (allowance <= 0) {
    // Re-queue in ~15min instead of burning the campaign; nothing sent.
    await query("UPDATE campaigns SET status='scheduled' WHERE id=?", [id]);
    await redis.zadd('campaigns:due', Date.now() + 15 * 60 * 1000, String(id));
    logger.info({ id, domainDaily, tenantToday, mbDaily, mbToday, mbHourly, mbHour }, 'throttled: requeued, 0 allowance');
    return;
  }
  const eligibleRemaining = recipients.length;
  let cappedRemainder = false;
  if (recipients.length > allowance) {
    logger.info({ id, capped: allowance, of: recipients.length }, 'throttled: capping batch to limit');
    recipients = recipients.slice(0, allowance);
    cappedRemainder = true;
    // The rest auto-requeues below (see end of run) — no manual reschedule needed,
    // and the recipientsFor anti-join guarantees the next run skips these sent ones.
  }

  // total_recipients reflects the true remaining eligible size, not the throttled
  // batch, so delivery/rate denominators stay meaningful across resumes.
  await query('UPDATE campaigns SET total_recipients=GREATEST(COALESCE(total_recipients,0), ?) WHERE id=?', [eligibleRemaining, id]);

  const trackingDomain = (await query(
    "SELECT domain FROM domains WHERE tenant_id=? AND type='tracking' AND status='verified' ORDER BY id LIMIT 1",
    [c.tenant_id],
  ))[0]?.domain ?? config.tracking.domain;

  // Resolve provider SMTP credentials (Phase 22H: per-mailbox SMTP via sending_providers).
  let smtpOpts: SmtpOpts | undefined;
  if (c.smtp_host) {
    const userRef = c.smtp_user_ref || c.p_smtp_user_ref || c.p_username_ref;
    const passRef = c.smtp_secret_ref || c.p_smtp_secret_ref || c.p_secret_ref;
    const user = await resolveSecret(userRef);
    const pass = await resolveSecret(passRef);
    if (user && pass) {
      smtpOpts = {
        host: c.smtp_host,
        port: Number(c.smtp_port || 587),
        user,
        pass,
      };
    } else {
      logger.warn({ campaignId: id, sender: c.sender_identity_id, host: c.smtp_host }, 'campaign: provider SMTP creds not resolvable, falling back to env transport');
    }
  }

  const intervalMs = Math.max(1, Math.floor(1000 / config.sendRatePerSec));
  let consecutiveErrors = 0;
  for (const r of recipients) {
    try {
      await sendOne({
        campaign: c,
        sender: {
          from_email: c.from_email,
          from_name: c.from_name,
          reply_to: c.reply_to,
          dkim_selector: c.dkim_selector,
          dkim_private_key: c.dkim_private_key,
          domain: c.sender_domain,
        },
        contact: r,
        trackingDomain,
        smtp: smtpOpts,
      });
      consecutiveErrors = 0;
      // Per-mailbox live counter + last_sent_at (powers send-control + warmup view).
      await query(
        'UPDATE sender_identities SET sent_today=sent_today+1, last_sent_at=NOW() WHERE id=?',
        [c.sender_identity_id],
      ).catch(() => {});
    } catch (e: any) {
      logger.error({ id, to: r.email, err: e.message }, 'send fail');
      await query(
        `INSERT INTO campaign_events (tenant_id, campaign_id, contact_id, email, event_type, detail)
         VALUES (?, ?, ?, ?, 'failed', ?)`,
        [c.tenant_id, id, r.id, r.email, JSON.stringify({ err: e.message })],
      );
      // Provider-error gate: repeated SMTP failures pause the mailbox + campaign so
      // we don't keep hammering a broken relay (protects reputation + the provider).
      if (++consecutiveErrors >= 5) {
        await query("UPDATE sender_identities SET status='paused', paused_reason=? WHERE id=?",
          [`provider_errors:${String(e.message).slice(0, 180)}`, c.sender_identity_id]).catch(() => {});
        await autoPause(c, `provider_errors_x${consecutiveErrors}`);
        logger.error({ id, sender: c.sender_identity_id }, 'mailbox paused: repeated provider errors');
        return;
      }
    }
    await new Promise((res) => setTimeout(res, intervalMs));
  }

  if (cappedRemainder) {
    // More eligible recipients than this window allowed — requeue to deliver the
    // remainder next window instead of marking a partial send as fully 'sent'.
    await query("UPDATE campaigns SET status='scheduled' WHERE id=?", [id]);
    await redis.zadd('campaigns:due', Date.now() + 15 * 60 * 1000, String(id));
    logger.info({ id, sentThisRun: recipients.length, requeued: true }, 'campaign partial: remainder requeued');
    return;
  }

  await query("UPDATE campaigns SET status='sent', finished_at=NOW() WHERE id=?", [id]);
  logger.info({ id, total: recipients.length }, 'campaign done');
}

export async function campaignLoop() {
  while (true) {
    let current: number | null = null;
    try {
      current = await pickDue();
      if (current == null) {
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      await runCampaign(current);
    } catch (e) {
      logger.error({ id: current, err: (e as Error).message }, 'campaign loop error');
      // pickDue already removed this id from campaigns:due and runCampaign may have
      // set status='sending'. On a transient failure, reset + requeue so the campaign
      // isn't orphaned mid-flight (the recipientsFor anti-join makes the retry safe).
      if (current != null) {
        try {
          await query("UPDATE campaigns SET status='scheduled' WHERE id=? AND status='sending'", [current]);
          await redis.zadd('campaigns:due', Date.now() + 5 * 60 * 1000, String(current));
        } catch (re) {
          logger.error({ id: current, err: (re as Error).message }, 'campaign requeue failed');
        }
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
