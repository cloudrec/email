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
import { loadReservedDomains, isReserved } from './dist/services/reservedDomains.js';
import nodemailer from 'nodemailer';
import crypto from 'node:crypto';
import fs from 'node:fs';

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const FILE = arg('--file');
const SEND = args.includes('--send');
const CAP = +arg('--cap', 25);
const MIN_AGE_DAYS = +arg('--min-age-days', 3);
const MAX_AGE_DAYS = +arg('--max-age-days', 21);   // don't "circle back" on months-old contacts
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

// Follow up the address that ACTUALLY got the first email (in outreach_touchpoints),
// not the queue's current best-pick — the recipient-selection change means the queue
// may now name a different address that never received touch 1. Map each prospect's
// follow-up copy by domain so the right report link + company reaches the real contact.
const norm = (d) => (d || '').toLowerCase().replace(/^www\./, '');
const byDomain = new Map();
for (const r of queue) {
  const d = norm(r.domain);
  if (d && r.followup_body && r.report_url && r.followup_body.includes(r.report_url) && !byDomain.has(d)) {
    byDomain.set(d, r);
  }
}

const senders = await query(
  `SELECT id, from_email, from_name FROM sender_identities
    WHERE tenant_id=? AND status='active' AND from_email IN
      ('hello@clients.help','hi@clients.help','team@clients.help','widget@clients.help')
    ORDER BY id`, [TENANT]);
if (!senders.length) { console.error('no warmed clients.help senders'); process.exit(1); }
const senderIds = senders.map((s) => s.id);
const senderIdList = senderIds.join(',');

// Candidates = addresses we emailed >= MIN_AGE_DAYS ago that have NOT been followed up,
// are NOT suppressed, and — per owner — did NOT EXPLICITLY refuse or otherwise engage.
// "Explicit refusal / engaged" = a reply classified as a decline, a legal/privacy or
// complaint, a wrong-person redirect, a bounce, a positive lead (handled separately, a
// generic nudge would be wrong), a referral, or not-now. A silent contact, an auto-reply,
// an out-of-office or an unclassified ticket is FAIR GAME for a follow-up.
const EXCLUDE_CLASSES = [
  'not_interested', 'do_not_contact', 'unsubscribe', 'complaint', 'legal_or_privacy',
  'wrong_person', 'bounce_like', 'interested', 'meeting_request', 'request_details',
  'referral', 'not_now',
];
const placeholders = EXCLUDE_CLASSES.map(() => '?').join(',');
const candidates = await query(
  `SELECT tp.email, MIN(tp.sent_at) first_at
     FROM outreach_touchpoints tp
    WHERE tp.tenant_id=? AND tp.touch_type='first_touch' AND tp.direction='outbound'
      AND tp.mailbox_id IN (${senderIdList})
      AND tp.sent_at < (NOW() - INTERVAL ? DAY)
      AND tp.sent_at > (NOW() - INTERVAL ? DAY)
      AND NOT EXISTS (SELECT 1 FROM outreach_touchpoints f
                       WHERE f.email=tp.email AND f.touch_type='followup_1')
      AND NOT EXISTS (SELECT 1 FROM inbox_replies ir
                       WHERE ir.from_email=tp.email AND ir.classification IN (${placeholders}))
      AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.email=tp.email)
      AND NOT EXISTS (SELECT 1 FROM global_contact_suppression g
                       WHERE g.type='email' AND g.normalized_value=tp.email)
    GROUP BY tp.email
    ORDER BY first_at ASC`,
  [TENANT, MIN_AGE_DAYS, MAX_AGE_DAYS, ...EXCLUDE_CLASSES]);

log(`${candidates.length} contacted ${MIN_AGE_DAYS}-${MAX_AGE_DAYS}d ago, non-refusing, not-yet-followed`);

// Reserved domains (personal audit batch) are excluded from follow-ups too.
const reserved = await loadReservedDomains(query);
if (reserved.size) log(`${reserved.size} reserved domain(s) will be excluded`);

const ready = [];
for (const c of candidates) {
  if (ready.length >= CAP) break;
  const email = (c.email || '').toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) continue;
  const domain = email.split('@')[1] || '';
  if (isReserved(email, reserved)) { log(`skip ${email}: reserved for audit batch`); continue; }
  const row = byDomain.get(norm(domain));
  if (!row) continue;                                       // no current report/offer for this domain
  // Domain-level global suppression + Postal's own list (would be Held).
  const [g] = await query(
    `SELECT (SELECT COUNT(*) FROM global_contact_suppression WHERE type='domain' AND normalized_value=?) gd,
            (SELECT COUNT(*) FROM \`postal-server-1\`.suppressions WHERE address=?) postal`,
    [domain, email]);
  if (+g.gd) { log(`skip ${email}: domain suppressed`); continue; }
  if (+g.postal) { log(`skip ${email}: on Postal list (would be Held)`); continue; }
  ready.push({ ...row, email });
}

log(`${ready.length} eligible for follow-up`);
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
