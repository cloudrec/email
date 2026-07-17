import { resolveSecret } from './dist/services/secretsVault.js';
import { query } from './dist/db.js';
import nodemailer from 'nodemailer';

const DOMAIN = 'clearorchard.online';
const FROM = 'hello@clearorchard.online';
const DAILY_CAP = 6;
const now = () => new Date().toISOString().slice(0, 16).replace('T', ' ');
const log = (m) => console.log(`[${now()}] ${m}`);

async function domainHealthOk() {
  const [r] = await query(
    `SELECT COALESCE(SUM(sent_today),0) sent, COALESCE(SUM(bounce_like_today),0) bounce,
            COALESCE(SUM(complaints_today),0) complaint
     FROM sender_identities WHERE status='active' AND from_email LIKE ?`, [`%@${DOMAIN}`],
  );
  const sent = +r.sent, bounce = +r.bounce, complaint = +r.complaint;
  if (complaint > 0) { log(`STOP: ${complaint} complaint(s) today on ${DOMAIN}`); return false; }
  if (sent >= 15 && bounce / sent > 0.05) { log(`STOP: bounce rate ${(100 * bounce / sent).toFixed(1)}% > 5% on ${DOMAIN}`); return false; }
  return true;
}

async function main() {
  if (!(await domainHealthOk())) { process.exit(0); }

  const [sentTodayRow] = await query(
    `SELECT COUNT(*) c FROM manual_outreach_queue WHERE template_key='clearorchard_pilot_2026_07' AND status='sent_smtp' AND DATE(sent_at)=UTC_DATE()`,
  );
  const already = +sentTodayRow.c;
  const remaining = Math.max(0, DAILY_CAP - already);
  log(`already sent today: ${already}, remaining cap: ${remaining}`);
  if (!remaining) { log('daily cap reached, nothing to do'); return; }

  const batch = await query(
    `SELECT id, email, draft_subject, draft_body FROM manual_outreach_queue
     WHERE template_key='clearorchard_pilot_2026_07' AND status='approved'
     ORDER BY id ASC LIMIT ?`, [remaining],
  );
  if (!batch.length) { log('no approved items left'); return; }

  const user = await resolveSecret('POSTAL_OUTREACH_SMTP_USER');
  const pass = await resolveSecret('POSTAL_OUTREACH_SMTP_PASSWORD');
  const tx = nodemailer.createTransport({ host: 'email_postal_smtp', port: 25, secure: false, auth: { user, pass }, tls: { rejectUnauthorized: false }, connectionTimeout: 15000, socketTimeout: 20000 });

  let sent = 0, failed = 0;
  for (const item of batch) {
    try {
      await tx.sendMail({
        from: `ClearOrchard <${FROM}>`,
        to: item.email,
        replyTo: 'andrii@emails.cheap',
        subject: item.draft_subject,
        text: item.draft_body,
      });
      await query(`UPDATE manual_outreach_queue SET status='sent_smtp', sent_at=NOW(), sent_method='smtp' WHERE id=?`, [item.id]);
      await query(`UPDATE sender_identities SET sent_today=sent_today+1, smtp_sent_today=smtp_sent_today+1, last_sent_at=NOW() WHERE from_email=?`, [FROM]);
      log(`sent -> ${item.email}`);
      sent++;
    } catch (e) {
      await query(`UPDATE manual_outreach_queue SET send_attempts=send_attempts+1, last_send_error=? WHERE id=?`, [String(e.message ?? e).slice(0, 250), item.id]);
      log(`FAILED -> ${item.email}: ${e.message}`);
      failed++;
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  log(`done. sent=${sent} failed=${failed}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error('FATAL', e); process.exit(1); });
