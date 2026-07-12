import nodemailer from 'nodemailer';
import { dedicatedRedis } from './redis.js';
import { query } from './db.js';
import { sendOne } from './sender.js';
import { logger } from './logger.js';
import { config } from './config.js';

// P3 safety: even campaign test-send refuses to fire when SMTP isn't ready.
// Failure path records an audit_log row so the operator can diagnose without
// reading worker logs.
async function smtpNotReadyReason(): Promise<string | null> {
  if (!config.smtp.host) return 'smtp_not_configured';
  if (!config.smtp.fromAddress) return 'smtp_not_configured';
  if (config.smtp.host === 'postal') return 'smtp_not_configured';
  try {
    const probe = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.password! } : undefined,
      connectionTimeout: 5000,
      greetingTimeout: 5000,
      socketTimeout: 5000,
    });
    await probe.verify();
    probe.close();
    return null;
  } catch (e: any) {
    return e?.code === 'EAUTH' ? 'smtp_auth_failed' : 'smtp_not_ready';
  }
}

async function auditTest(tenantId: number, campaignId: number, to: string, ok: boolean, detail: any) {
  await query(
    `INSERT INTO audit_log
       (tenant_id, user_id, actor_email, action, target_type, target_id, metadata)
     VALUES (?, NULL, NULL, ?, 'campaign', ?, ?)`,
    [tenantId, ok ? 'campaign.test_sent' : 'campaign.test_send_failed', String(campaignId), JSON.stringify({ to, ...detail })],
  );
}

export async function testSendLoop() {
  const r0 = dedicatedRedis();
  const LASTID_KEY = 'send:test:lastid';
  // Resume from the last durably-processed id so test-send requests enqueued
  // while the worker was down are not lost (were previously read from '$').
  let lastId = (await r0.get(LASTID_KEY).catch(() => null)) || '$';
  while (true) {
    try {
      const r = await r0.xread('BLOCK', 5000, 'STREAMS', 'send:test', lastId);
      if (!r) continue;
      const [, entries] = r[0];
      for (const [id, fields] of entries) {
        try {
        const obj: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
        const campaignId = parseInt(obj.campaignId, 10);
        const tenantId = parseInt(obj.tenantId, 10);
        const to = obj.to;

        const c = (await query(
          `SELECT c.*, si.from_email, si.from_name, si.reply_to,
                  d.domain AS sender_domain, d.dkim_selector, d.dkim_private_key, d.status AS domain_status,
                  t.status AS tenant_status
           FROM campaigns c
           JOIN sender_identities si ON si.id = c.sender_identity_id
           JOIN domains d ON d.id = si.domain_id
           JOIN tenants t ON t.id = c.tenant_id
           WHERE c.id = ? AND c.tenant_id = ? LIMIT 1`, [campaignId, tenantId]))[0];
        if (!c) continue;

        // Defense-in-depth gates (API already checks these, but worker re-checks
        // in case state changed between enqueue and process).
        if (!['active', 'trial'].includes(c.tenant_status)) {
          await auditTest(tenantId, campaignId, to, false, { reason: `tenant_${c.tenant_status}` });
          logger.warn({ campaignId, tenantId, reason: c.tenant_status }, 'test send blocked: tenant inactive');
          continue;
        }
        if (c.domain_status !== 'verified') {
          await auditTest(tenantId, campaignId, to, false, { reason: 'domain_not_verified', domain: c.sender_domain });
          logger.warn({ campaignId, tenantId, domain: c.sender_domain }, 'test send blocked: domain_not_verified');
          continue;
        }

        const smtpReason = await smtpNotReadyReason();
        if (smtpReason) {
          await auditTest(tenantId, campaignId, to, false, { reason: smtpReason, host: config.smtp.host });
          logger.warn({ campaignId, tenantId, reason: smtpReason }, 'test send blocked: smtp not ready');
          continue;
        }

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
            contact: { id: 0, email: to, first_name: 'Test', last_name: null },
            trackingDomain: config.tracking.domain,
          });
          await auditTest(tenantId, campaignId, to, true, {});
          logger.info({ campaignId, to }, 'test sent');
        } catch (e: any) {
          await auditTest(tenantId, campaignId, to, false, { reason: 'smtp_send_failed', err: e.message });
          logger.error({ campaignId, to, err: e.message }, 'test send failed');
        }
        } finally {
          // Advance the durable cursor on every path (success or a `continue` skip)
          // so entries pushed during downtime aren't lost and a skip can't re-loop.
          lastId = id;
          await r0.set(LASTID_KEY, id).catch(() => {});
        }
      }
    } catch (e: any) {
      logger.error({ err: e.message }, 'test send loop error');
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
