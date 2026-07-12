import nodemailer from 'nodemailer';
import { dedicatedRedis } from './redis.js';
import { query } from './db.js';
import { logger } from './logger.js';
import { config } from './config.js';

// Outreach test sender: consumes Redis stream `send:test-outreach`.
// Sends a SINGLE test email per stream entry to the recipient supplied at
// approval time. Never bulk. Audited via outreach_approval_events + audit_log.
//
// Safety:
//   - draft must belong to tenant (looked up tenant-scoped)
//   - SMTP must be configured (otherwise records "smtp_not_configured" event)
//   - tenant must be active or trial (no sending for suspended tenants)
//   - 1 recipient per stream entry, no list/segment expansion

let transporter: nodemailer.Transporter | null = null;
function getTransport() {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.password! } : undefined,
    pool: true,
    maxConnections: 2,
    maxMessages: 50,
  });
  return transporter;
}

// Conservative readiness check. Returns the failure reason string when not ready, otherwise null.
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

async function logEvent(
  tenantId: number, draftId: number, versionId: number | null,
  recipient: string, ok: boolean, detail: any,
) {
  await query(
    `INSERT INTO outreach_approval_events
       (tenant_id, draft_id, draft_version_id, event, recipient_email, reason, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      tenantId, draftId, versionId,
      ok ? 'test_sent' : 'rejected',
      recipient,
      ok ? null : 'smtp_send_failed',
      JSON.stringify(detail),
    ],
  );
  await query(
    `INSERT INTO audit_log
       (tenant_id, user_id, actor_email, action, target_type, target_id, metadata)
     VALUES (?, NULL, NULL, ?, 'outreach_draft', ?, ?)`,
    [tenantId, ok ? 'outreach.test_sent' : 'outreach.test_send_failed', String(draftId), JSON.stringify(detail)],
  );
}

async function processOne(obj: Record<string, string>) {
  const draftId = parseInt(obj.draftId, 10);
  const tenantId = parseInt(obj.tenantId, 10);
  const to = obj.to;
  if (!draftId || !tenantId || !to) return;

  const rows = await query(
    `SELECT d.id, d.tenant_id, d.current_version_id, d.language,
            v.subject_options, v.email_short, v.email_long,
            t.status AS tenant_status,
            pp.name AS product_name
     FROM outreach_drafts d
     JOIN outreach_draft_versions v ON v.id = d.current_version_id
     JOIN tenants t ON t.id = d.tenant_id
     LEFT JOIN tenant_product_profiles pp ON pp.id = d.product_profile_id
     WHERE d.id=? AND d.tenant_id=? LIMIT 1`,
    [draftId, tenantId],
  );
  if (!rows.length) {
    logger.warn({ draftId, tenantId }, 'outreach test: draft not found');
    return;
  }
  const d = rows[0];

  if (!['active', 'trial'].includes(d.tenant_status)) {
    await logEvent(tenantId, draftId, d.current_version_id, to, false, { reason: `tenant_${d.tenant_status}` });
    return;
  }

  const smtpReason = await smtpNotReadyReason();
  if (smtpReason) {
    await logEvent(tenantId, draftId, d.current_version_id, to, false, { reason: smtpReason, host: config.smtp.host || null });
    logger.warn({ draftId, tenantId, host: config.smtp.host, reason: smtpReason }, 'outreach test send blocked');
    return;
  }

  let subjectOptions: string[] = [];
  try { subjectOptions = typeof d.subject_options === 'string' ? JSON.parse(d.subject_options) : d.subject_options; }
  catch { subjectOptions = ['Test']; }
  const subject = subjectOptions[0] ?? `Test — ${d.product_name ?? 'outreach draft'}`;
  const body = d.email_short || d.email_long || '';

  try {
    const info = await getTransport().sendMail({
      from: `${config.smtp.fromName} <${config.smtp.fromAddress}>`,
      to,
      subject: `[TEST] ${subject}`,
      text: body,
      headers: {
        'X-Email-Platform': 'outreach-test',
        'X-Draft-Id': String(draftId),
        'X-Tenant-Id': String(tenantId),
        // Helpful for any downstream rules: this is a manual test send.
        'Auto-Submitted': 'auto-generated',
      },
    });
    await logEvent(tenantId, draftId, d.current_version_id, to, true, { messageId: info.messageId });
    logger.info({ draftId, tenantId, to, messageId: info.messageId }, 'outreach test sent');
  } catch (e: any) {
    await logEvent(tenantId, draftId, d.current_version_id, to, false, { reason: 'smtp_send_failed', err: e.message });
    logger.error({ draftId, tenantId, to, err: e.message }, 'outreach test send failed');
  }
}

export async function outreachTestSendLoop() {
  const r0 = dedicatedRedis();
  const LASTID_KEY = 'send:test-outreach:lastid';
  // Resume from the last durably-processed id (was '$') so entries enqueued
  // while the worker was down are not dropped.
  let lastId = (await r0.get(LASTID_KEY).catch(() => null)) || '$';
  while (true) {
    try {
      const r = await r0.xread('BLOCK', 5000, 'STREAMS', 'send:test-outreach', lastId);
      if (!r) continue;
      const [, entries] = r[0];
      for (const [id, fields] of entries) {
        const obj: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
        await processOne(obj);
        // Advance cursor only after success — a throw bubbles to the outer catch
        // leaving the cursor put, so the entry is retried, not lost.
        lastId = id;
        await r0.set(LASTID_KEY, id).catch(() => {});
      }
    } catch (e: any) {
      logger.error({ err: e.message }, 'outreach test send loop error');
      await new Promise((res) => setTimeout(res, 5000));
    }
  }
}
