// Audit follow-up sender (funnel: touch 2). Most cold-email replies come from a
// follow-up, not the first email — we were sending only one touch. This sends a short
// second nudge (the audit link is still live + the fixed-price offer still stands) to
// people who were emailed but have NOT replied.
//
// Reuses the same queue JSON as the first-touch sender (each row carries followup_body);
// it just picks a different, stricter recipient set. Safety, all enforced BEFORE any send:
//   - a first_touch exists AND is at least --min-age-days old (default 3)
//   - the contact has NOT replied (no inbox_replies, no inbound touchpoint)
//   - no follow-up already sent (touch_type='followup_1') — never nag twice
//   - not on our suppressions / global_contact_suppression (email or domain)
//   - not on Postal's own suppression list
//   - hard daily cap (default 25)
//
// Default is a DRY RUN — nothing is sent, previews are printed. --send is required.
//
//   docker compose exec -T api node /app/audit_followup_send.mjs --file /app/queue.json          # preview
//   docker compose exec -T api node /app/audit_followup_send.mjs --file /app/queue.json --send    # send
import { resolveSecret } from './dist/services/secretsVault.js';
import { query } from './dist/db.js';
import nodemailer from 'nodemailer';
import crypto from 'node:crypto';
import fs from 'node:fs';

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const FILE = arg('--file');
const SEND = args.includes('--send');
const CAP = +arg('--cap', 25);
const MIN_AGE_DAYS = +arg('--min-age-days', 3);
const DOMAIN = 'clients.help';
const TENANT = 1;
const JWT = process.env.API_JWT_SECRET;
const REPLY_TO = 'andrii@emails.cheap';
const SENDER_NAME = 'Andrii';

const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const log = (m) => console.log(`[${now()}] audit_followup: ${m}`);
if (!FILE) { console.error('need --file <queue.json>'); process.exit(1); }

function unsub(email) {
  const p = `1.${Buffer.from(email.toLowerCase()).toString('base64url')}`;
  return `https://${DOMAIN}/u/m/${p}.${crypto.createHmac('sha256', JWT).update(p).digest('base64url')}`;
}

const queue = JSON.parse(fs.readFileSync(FILE, 'utf8'));
log(`${queue.length} in queue; cap ${CAP}; min age ${MIN_AGE_DAYS}d${SEND ? '' : ' — DRY RUN'}`);

const senders = await query(
  `SELECT id, from_email, from_name FROM sender_identities
    WHERE tenant_id=? AND status='active' AND from_email IN
      ('hello@clients.help','hi@clients.help','team@clients.help','widget@clients.help')
    ORDER BY id`, [TENANT]);
if (!senders.length) { console.error('no warmed clients.help senders'); process.exit(1); }

const ready = [];
for (const r of queue) {
  if (ready.length >= CAP) break;
  const email = (r.email || '').toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) continue;
  if (!r.followup_body || !r.report_url || !r.followup_body.includes(r.report_url)) continue;
  const domain = email.split('@')[1] || '';

  const [row] = await query(
    `SELECT
       (SELECT MIN(sent_at) FROM outreach_touchpoints
          WHERE email=? AND touch_type='first_touch' AND direction='outbound') first_at,
       (SELECT COUNT(*) FROM outreach_touchpoints
          WHERE email=? AND touch_type='followup_1') followed,
       (SELECT COUNT(*) FROM outreach_touchpoints
          WHERE email=? AND direction='inbound') inbound,
       (SELECT COUNT(*) FROM inbox_replies WHERE from_email=?) replied,
       (SELECT COUNT(*) FROM suppressions WHERE email=?) sup_local,
       (SELECT COUNT(*) FROM global_contact_suppression WHERE type='email' AND normalized_value=?) sup_ge,
       (SELECT COUNT(*) FROM global_contact_suppression WHERE type='domain' AND normalized_value=?) sup_gd,
       (SELECT COUNT(*) FROM \`postal-server-1\`.suppressions WHERE address=?) postal`,
    [email, email, email, email, email, email, domain, email]);

  if (!row.first_at) { continue; }                         // never got a first touch
  const ageDays = (Date.now() - new Date(row.first_at).getTime()) / 86400000;
  if (ageDays < MIN_AGE_DAYS) { continue; }                // too soon
  if (+row.followed) { continue; }                         // already nudged
  if (+row.replied || +row.inbound) { log(`skip ${email}: already replied`); continue; }
  if (+row.sup_local || +row.sup_ge || +row.sup_gd) { log(`skip ${email}: suppressed`); continue; }
  if (+row.postal) { log(`skip ${email}: on Postal list (would be Held)`); continue; }

  ready.push({ ...r, email });
}

log(`${ready.length} eligible for follow-up (non-responders)`);
if (!ready.length) process.exit(0);

let tx = null;
if (SEND) {
  const user = await resolveSecret('POSTAL_OUTREACH_SMTP_USER'), pass = await resolveSecret('POSTAL_OUTREACH_SMTP_PASSWORD');
  tx = nodemailer.createTransport({ host: 'email_postal_smtp', port: 25, secure: false, auth: { user, pass },
    tls: { rejectUnauthorized: false }, connectionTimeout: 15000, socketTimeout: 20000 });
} else {
  log('DRY RUN — re-run with --send once the previews look right.');
}

let sent = 0, idx = 0;
for (const c of ready) {
  const s = senders[idx % senders.length];
  const u = unsub(c.email);
  const subject = `Re: ${c.subject}`;   // threads under the first email
  const body = `${c.followup_body.trimEnd()}\n${SENDER_NAME}\n\nUnsubscribe: ${u}`;

  if (!SEND) {
    console.log(`\n===== FOLLOW-UP ${c.domain} -> ${c.email} [from ${s.from_email}] =====`);
    console.log(`Subject: ${subject}`);
    console.log(body);
    idx++; continue;
  }
  try {
    await tx.sendMail({
      from: `"${SENDER_NAME}" <${s.from_email}>`, to: c.email, replyTo: REPLY_TO,
      subject, text: body,
      headers: {
        'List-Unsubscribe': `<mailto:${REPLY_TO}?subject=unsubscribe>, <${u}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        'X-Campaign': 'audit-followup',
      },
    });
    await query(`INSERT INTO outreach_touchpoints (tenant_id, email, mailbox_id, channel, direction, touch_type, status, sent_at, created_at)
                 VALUES (?,?,?,?,?,?,?,NOW(),NOW())`,
      [TENANT, c.email, s.id, 'email', 'outbound', 'followup_1', 'sent_smtp']).catch(() => {});
    await query('UPDATE sender_identities SET sent_today=sent_today+1, last_sent_at=NOW() WHERE id=?', [s.id]).catch(() => {});
    sent++; idx++;
    log(`follow-up sent ${c.email} <- ${s.from_email}`);
  } catch (e) { log(`FAIL ${c.email}: ${e.message}`); }
}
log(`done: ${sent} follow-ups sent`);
process.exit(0);
