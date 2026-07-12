import 'dotenv/config';
import { query } from '../db.js';
import {
  resolveProvider,
  fetchReplies as rtFetchReplies,
  classifyReply,
  type ProviderRow,
} from '../services/mailboxRuntime.js';
import {
  parseBounceContent,
  isBounceSender,
  isMailerDaemon,
  shouldAutoSuppressBounce,
  type BounceParseResult,
} from '../services/bounceParser.js';
import { addSuppression } from '../services/suppression.js';
import { recordTouchpoint } from '../services/mailboxFleet.js';

const TENANT_ID = 1;

async function main() {
  console.log('Reply import worker — started');

  const mailboxes = await query(
    `SELECT si.* FROM sender_identities si
     JOIN sending_providers sp ON sp.id=si.provider_id AND sp.tenant_id=si.tenant_id
     WHERE si.tenant_id=?
       AND si.status='active'
       AND si.inbound_enabled=1
       AND si.imap_enabled=1
       AND si.provider_id IS NOT NULL
       AND sp.status='active'
       AND sp.inbound_enabled=1`, [TENANT_ID],
  );

  if (!mailboxes.length) {
    console.log('No inbound-enabled mailboxes found.');
    return;
  }

  console.log(`Mailboxes to check: ${mailboxes.length}`);
  let totalImported = 0;
  let totalSuppressed = 0;

  for (const mb of mailboxes) {
    const [prov] = await query('SELECT * FROM sending_providers WHERE id=? AND tenant_id=? LIMIT 1', [mb.provider_id, TENANT_ID]);
    if (!prov) { console.log(`  [${mb.id}] No provider`); continue; }

    const merged = {
      ...prov,
      smtp_user_ref: mb.smtp_user_ref || prov.smtp_user_ref || prov.username_ref || '',
      smtp_secret_ref: mb.smtp_secret_ref || prov.smtp_secret_ref || prov.secret_ref || '',
      imap_user_ref: mb.imap_user_ref || prov.imap_user_ref || mb.smtp_user_ref || prov.smtp_user_ref || prov.username_ref || '',
      imap_secret_ref: mb.imap_secret_ref || prov.imap_secret_ref || mb.smtp_secret_ref || prov.smtp_secret_ref || prov.secret_ref || '',
      inbound_enabled: mb.inbound_enabled,
      outbound_enabled: mb.outbound_enabled,
    } as ProviderRow;

    const conn = resolveProvider(merged);
    if (!conn.imapConfigured) { console.log(`  [${mb.id}] IMAP not configured`); continue; }

    const startAt = mb.imap_start_at ? new Date(mb.imap_start_at) : null;
    // Hard per-mailbox timeout: a slow/hanging IMAP box (some providers stall on the
    // source fetch) must NOT stall the whole sequential import. On timeout the box is
    // skipped and the cursor is left untouched (retried next run).
    const r = await Promise.race([
      rtFetchReplies(conn, { sinceUid: mb.imap_last_uid ?? null, startAt, limit: 50 }),
      new Promise<Awaited<ReturnType<typeof rtFetchReplies>>>((res) =>
        setTimeout(() => res({ ok: false, detail: 'imap_timeout', replies: [], maxUid: mb.imap_last_uid ?? 0 }), 35000)),
    ]);

    if (!r.ok && r.replies.length === 0) { console.log(`  [${mb.id}] Error: ${r.detail}`); continue; }

    let boxImported = 0;
    let boxSuppressed = 0;
    for (const rep of r.replies) {
      const cls = classifyReply(rep.subject, rep.snippet, rep.fromEmail);

      let cpId: number | null = null, companyId: number | null = null;
      if (rep.fromEmail) {
        const [cp] = await query('SELECT id, company_id FROM contact_points WHERE value=? LIMIT 1', [rep.fromEmail]);
        if (cp) { cpId = cp.id; companyId = cp.company_id; }
      }

      let queueItemId: number | null = null;
      if (rep.fromEmail) {
        const [qi] = await query('SELECT id FROM manual_outreach_queue WHERE tenant_id=? AND email=? ORDER BY id DESC LIMIT 1', [TENANT_ID, rep.fromEmail]);
        if (qi) queueItemId = qi.id;
      }

      let bounceResult: BounceParseResult = { failedRecipientEmail: null, bounceCategory: null, confidence: 0, evidence: null };
      if (cls.classification === 'bounce_like' || isBounceSender(rep.fromEmail)) {
        const bodyForParse = rep.rawBody ?? rep.snippet;
        bounceResult = parseBounceContent(rep.subject, bodyForParse);
      }

      try {
        const insertFields = `(tenant_id, mailbox_id, message_id, from_email, from_name, subject, body_snippet, received_at,
             classification, classification_source, confidence, classification_reason,
             contact_point_id, company_id, queue_item_id, failed_recipient, bounce_category, bounce_confidence)`;
        const insertVals = `(?, ?, ?, ?, ?, ?, ?, ?, ?, 'rule', ?, ?, ?, ?, ?, ?, ?, ?)`;
        await query(
          `INSERT INTO inbox_replies ${insertFields} VALUES ${insertVals}`,
          [TENANT_ID, mb.id, rep.messageId, rep.fromEmail, rep.fromName, rep.subject, rep.snippet,
           rep.receivedAt, cls.classification, cls.confidence, cls.reason, cpId, companyId, queueItemId,
           bounceResult.failedRecipientEmail, bounceResult.bounceCategory, bounceResult.confidence],
        );
        boxImported++;

        const isNeg = ['not_interested', 'do_not_contact', 'unsubscribe'].includes(cls.classification);
        await query(
          `UPDATE sender_identities SET replies_today=replies_today+1, last_reply_at=NOW(),
             interested_today=interested_today+?, negative_today=negative_today+?,
             bounce_like_today=bounce_like_today+?, unsubscribes_today=unsubscribes_today+?
           WHERE id=?`,
          [cls.classification === 'interested' ? 1 : 0, isNeg ? 1 : 0,
           cls.classification === 'bounce_like' ? 1 : 0, cls.classification === 'unsubscribe' ? 1 : 0, mb.id],
        );

        await recordTouchpoint({
          tenantId: TENANT_ID, contactPointId: cpId, companyId, queueItemId, mailboxId: mb.id,
          email: rep.fromEmail, channel: 'email', direction: 'inbound', touchType: 'reply',
          subject: rep.subject, status: 'replied', repliedAt: rep.receivedAt ?? new Date(),
          metadata: { classification: cls.classification, confidence: cls.confidence, bounce: bounceResult },
        });

        if (rep.fromEmail) {
          await query(
            "UPDATE manual_followup_tasks SET status='cancelled' WHERE tenant_id=? AND email=? AND status IN ('pending','ready')",
            [TENANT_ID, rep.fromEmail],
          );
        }

        if (cls.classification === 'bounce_like' && bounceResult.failedRecipientEmail && !isMailerDaemon(bounceResult.failedRecipientEmail)) {
          if (shouldAutoSuppressBounce(bounceResult)) {
            const failedEmail = bounceResult.failedRecipientEmail.toLowerCase();
            await addSuppression(TENANT_ID, failedEmail, 'bounce_hard');
            await query(
              `INSERT IGNORE INTO global_contact_suppression (type, normalized_value, reason, source)
               VALUES ('email', ?, 'hard_bounce', 'reply_import_bounce')`,
              [failedEmail],
            );
            await query("UPDATE contact_points SET status='bounced' WHERE value=?", [failedEmail]);
            await query(
              "UPDATE manual_outreach_queue SET safety_status='suppressed', status='do_not_contact' WHERE tenant_id=? AND email=? AND status IN ('pending_review','approved')",
              [TENANT_ID, failedEmail],
            );
            // Cancel the FAILED recipient's follow-ups — the generic cancel above
            // keys on rep.fromEmail (= mailer-daemon on a bounce), not the bounced address.
            await query(
              "UPDATE manual_followup_tasks SET status='cancelled' WHERE tenant_id=? AND email=? AND status IN ('pending','ready')",
              [TENANT_ID, failedEmail],
            );
            boxSuppressed++;
          }
        }

        if (['do_not_contact', 'unsubscribe'].includes(cls.classification) && cls.confidence >= 0.9 && rep.fromEmail) {
          await addSuppression(TENANT_ID, rep.fromEmail, 'unsubscribe');
          await query(
            `INSERT IGNORE INTO global_contact_suppression (type, normalized_value, reason, source)
             VALUES ('email', ?, 'unsubscribe', 'reply_import_optout')`,
            [rep.fromEmail],
          );
          await query("UPDATE contact_points SET status='do_not_contact' WHERE value=?", [rep.fromEmail]);
          await query(
            "UPDATE manual_outreach_queue SET safety_status='suppressed' WHERE tenant_id=? AND email=? AND status IN ('pending_review','approved')",
            [TENANT_ID, rep.fromEmail],
          );
          boxSuppressed++;
        }
      } catch (e: any) {
        if (e?.code !== 'ER_DUP_ENTRY') throw e;
      }
    }

    await query('UPDATE sender_identities SET imap_last_uid=?, imap_last_checked_at=NOW() WHERE id=?', [r.maxUid, mb.id]);
    console.log(`  [${mb.id}] ${mb.from_email}: ${boxImported} imported, ${boxSuppressed} suppressed`);
    totalImported += boxImported;
    totalSuppressed += boxSuppressed;
  }

  console.log(`\nDone. Total imported: ${totalImported}, Total suppressed: ${totalSuppressed}`);
}

main()
  .then(() => process.exit(0))   // force clean exit even if a timed-out IMAP socket lingers
  .catch((e) => {
    console.error('FATAL:', e);
    process.exit(1);
  });
