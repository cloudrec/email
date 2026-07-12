import 'dotenv/config';
import * as mariadb from 'mariadb';
import { ImapFlow } from 'imapflow';
import { parseBounceContent, isMailerDaemon, isBounceSender, shouldAutoSuppressBounce } from '../api/src/services/bounceParser.js';

const pool = mariadb.createPool({
  host: process.env.DB_HOST || 'db',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'email_app',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'email_platform',
  connectionLimit: 5,
  bigIntAsNumber: true,
});

interface MailboxInfo {
  id: number;
  tenant_id: number;
  from_email: string;
  imap_user_ref: string | null;
  imap_secret_ref: string | null;
  imap_host: string | null;
  imap_port: number | null;
  imap_secure: number | null;
  provider_id: number | null;
}

interface ProviderInfo {
  id: number;
  imap_host: string | null;
  imap_port: number | null;
  imap_secure: number | null;
  imap_user_ref: string | null;
  imap_secret_ref: string | null;
}

async function loadSecrets(ref: string | null | undefined): Promise<string | undefined> {
  if (!ref) return undefined;
  try {
    const rows = await pool.query('SELECT value_enc FROM mailbox_secrets WHERE ref_name=? LIMIT 1', [ref]);
    if (rows.length && rows[0].value_enc) {
      const KEY = crypto.createHash('sha256').update(process.env.API_JWT_SECRET || 'insecure-dev-key').digest();
      const buf = Buffer.from(rows[0].value_enc, 'base64');
      const iv = buf.subarray(0, 12);
      const tag = buf.subarray(12, 28);
      const ct = buf.subarray(28);
      const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    }
  } catch { /* fall through */ }
  const v = process.env[ref!];
  return v && v.length ? v : undefined;
}

async function reFetchBody(mailbox: MailboxInfo, messageId: string): Promise<string | null> {
  const provider = mailbox.provider_id
    ? (await pool.query('SELECT * FROM sending_providers WHERE id=? LIMIT 1', [mailbox.provider_id]))[0] as ProviderInfo | undefined
    : undefined;

  const imapHost = mailbox.imap_host || provider?.imap_host;
  const imapPort = mailbox.imap_port || provider?.imap_port || 993;
  const imapSecure = mailbox.imap_secure !== 0 && (provider?.imap_secure !== 0);
  const imapUserRef = mailbox.imap_user_ref || provider?.imap_user_ref || '';
  const imapSecretRef = mailbox.imap_secret_ref || provider?.imap_secret_ref || '';

  if (!imapHost || !imapUserRef || !imapSecretRef) return null;

  const user = await loadSecrets(imapUserRef);
  const pass = await loadSecrets(imapSecretRef);
  if (!user || !pass) return null;

  let client: ImapFlow | null = null;
  try {
    client = new ImapFlow({
      host: imapHost, port: imapPort, secure: imapSecure,
      auth: { user, pass }, logger: false, socketTimeout: 15000,
    });
    await client.connect();
    await client.mailboxOpen('INBOX', { readOnly: true });

    for await (const msg of client.fetch('1:*', { uid: true, envelope: true, source: true }, { uid: true })) {
      const env = msg.envelope;
      if (!env || env.messageId !== messageId) continue;
      if (msg.source) {
        const bytes: number[] = [];
        for await (const c of msg.source) { bytes.push(c as number); if (bytes.length > 10000) break; }
        if (bytes.length) {
          await client.logout();
          return Buffer.from(bytes).toString('utf-8').replace(/\s+/g, ' ').trim().slice(0, 2000);
        }
      }
      break;
    }
    await client.logout();
  } catch { try { await client?.logout(); } catch { /* ignore */ } }
  return null;
}

async function main() {
  console.log('Backfill Bounce Suppressions — safe one-time script');
  console.log('===================================================\n');

  const rows = await pool.query(
    `SELECT r.*, m.from_email AS mailbox_email, m.imap_user_ref, m.imap_secret_ref,
            m.imap_host, m.imap_port, m.imap_secure, m.provider_id
     FROM inbox_replies r
     LEFT JOIN sender_identities m ON m.id = r.mailbox_id
     WHERE r.classification = 'bounce_like'
       AND (r.failed_recipient IS NULL OR r.body_snippet IS NULL OR r.body_snippet = '')
     ORDER BY r.id ASC`,
  );

  console.log(`Found ${rows.length} bounce_like rows needing backfill.\n`);

  let scanned = 0;
  let parsed = 0;
  let suppressed = 0;
  let linkedToQueue = 0;
  let skippedLowConfidence = 0;
  let skippedNoBody = 0;

  for (const row of rows) {
    scanned++;
    const id = row.id;
    const tenantId = row.tenant_id;
    let body = row.body_snippet || '';

    if (!body && row.mailbox_id) {
      console.log(`  [${id}] Re-fetching body from IMAP (mailbox ${row.mailbox_id}, msg ${row.message_id})...`);
      body = (await reFetchBody(row as MailboxInfo, row.message_id)) || '';
      if (body) {
        await pool.query('UPDATE inbox_replies SET body_snippet=? WHERE id=?', [body.slice(0, 1000), id]);
        console.log(`    -> Body re-fetched (${body.length} chars)`);
      } else {
        console.log(`    -> Could not re-fetch body`);
      }
    }

    if (!body) {
      skippedNoBody++;
      console.log(`  [${id}] SKIP — no body available`);
      continue;
    }

    const cls = row.classification;
    const bounceResult = parseBounceContent(row.subject, body);

    if (bounceResult.failedRecipientEmail) {
      parsed++;
      const failedEmail = bounceResult.failedRecipientEmail.toLowerCase();

      // Update inbox_reply with parsed data
      await pool.query(
        'UPDATE inbox_replies SET failed_recipient=?, bounce_category=?, bounce_confidence=?, classification_reason=COALESCE(NULLIF(classification_reason,\'\'),?) WHERE id=?',
        [failedEmail, bounceResult.bounceCategory, bounceResult.confidence, `backfill: ${bounceResult.evidence ?? ''}`, id],
      );
      console.log(`  [${id}] Parsed -> failed_recipient=${failedEmail}, bounce_category=${bounceResult.bounceCategory}, confidence=${bounceResult.confidence}`);

      // Link to queue item
      const [qi] = await pool.query(
        'SELECT id FROM manual_outreach_queue WHERE tenant_id=? AND email=? ORDER BY id DESC LIMIT 1',
        [tenantId, failedEmail],
      );
      if (qi) {
        await pool.query('UPDATE inbox_replies SET queue_item_id=? WHERE id=?', [qi.id, id]);
        linkedToQueue++;
        console.log(`    -> Linked to queue item ${qi.id}`);
      }

      // Suppress — use gated logic matching the main import flow
      if (!isMailerDaemon(failedEmail) && shouldAutoSuppressBounce(bounceResult)) {
        await pool.query(
          'INSERT IGNORE INTO suppressions (tenant_id, email, reason) VALUES (?, ?, ?)',
          [tenantId, failedEmail, 'bounce_hard'],
        );
        await pool.query(
          'INSERT IGNORE INTO global_contact_suppression (type, normalized_value, reason, source) VALUES (?, ?, ?, ?)',
          ['email', failedEmail, 'hard_bounce', 'backfill_bounce_suppressions'],
        );
        await pool.query("UPDATE contact_points SET status='bounced' WHERE value=?", [failedEmail]);
        await pool.query(
          "UPDATE manual_outreach_queue SET safety_status='suppressed', status='do_not_contact' WHERE tenant_id=? AND email=? AND status IN ('pending_review','approved')",
          [tenantId, failedEmail],
        );
        suppressed++;
        console.log(`    -> Suppressed ${failedEmail}`);
      }
    } else if (bounceResult.confidence >= 0.30) {
      // Bounce-like but no specific recipient — still update the row metadata
      await pool.query(
        'UPDATE inbox_replies SET bounce_category=?, bounce_confidence=?, classification_reason=? WHERE id=?',
        [bounceResult.bounceCategory, bounceResult.confidence, `backfill: ${bounceResult.evidence ?? ''}`, id],
      );
      skippedLowConfidence++;
      console.log(`  [${id}] SKIP suppression — no recipient extracted (${bounceResult.bounceCategory}, conf=${bounceResult.confidence})`);
    } else {
      skippedLowConfidence++;
      console.log(`  [${id}] SKIP — could not parse failed recipient`);
    }
  }

  console.log(`\n=== RESULTS ===`);
  console.log(`Scanned:              ${scanned}`);
  console.log(`Parsed:               ${parsed}`);
  console.log(`Suppressed:           ${suppressed}`);
  console.log(`Linked to queue:      ${linkedToQueue}`);
  console.log(`Skipped low conf:     ${skippedLowConfidence}`);
  console.log(`Skipped no body:      ${skippedNoBody}`);

  await pool.end();
}

import crypto from 'crypto';
main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
