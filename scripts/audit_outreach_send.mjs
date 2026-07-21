// Audit outreach sender — the send half of the audit -> email bridge.
//
// Reads the JSON queue produced by /opt/prospect-audit/scripts/export_audit_queue.py
// (worst-scoring sites first, each row a ready short-audit email carrying the
// audit.clients.help report link) and delivers a capped daily batch through Postal.
//
// Sends FROM clients.help — the same org domain the report link lives on
// (audit.clients.help), so the email and the link tell one coherent story, and
// clients.help's SPF/DKIM/DMARC are already clean.
//
// Safety, all enforced BEFORE any send:
//   - valid email shape
//   - not on our suppressions / global_contact_suppression (email or domain)
//   - not on Postal's own suppression list (else Postal Holds it silently at 250 OK)
//   - never contacted before (outreach_touchpoints) — no double-send across runs
//   - hard daily cap (default 25) so a young-domain reputation isn't spiked
//
// Default is a DRY RUN — nothing is sent, previews are printed. --send is required.
//
//   docker cp scripts/audit_outreach_send.mjs "$(docker compose ps -q api)":/app/audit_outreach_send.mjs
//   docker compose exec -T api node /app/audit_outreach_send.mjs --file /app/queue.json           # preview
//   docker compose exec -T api node /app/audit_outreach_send.mjs --file /app/queue.json --send     # send
import { resolveSecret } from './dist/services/secretsVault.js';
import { query } from './dist/db.js';
import nodemailer from 'nodemailer';
import crypto from 'node:crypto';
import fs from 'node:fs';

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const FILE = arg('--file');
const SEND = args.includes('--send');
const CAP = +arg('--cap', 25);            // hard daily ceiling — start small, ramp later
const DOMAIN = 'clients.help';
const TENANT = 1;
const JWT = process.env.API_JWT_SECRET;
const REPLY_TO = 'andrii@emails.cheap';   // monitored inbox the reply importer reads

const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const log = (m) => console.log(`[${now()}] audit_send: ${m}`);
if (!FILE) { console.error('need --file <queue.json>'); process.exit(1); }

function unsub(email) {
  const p = `1.${Buffer.from(email.toLowerCase()).toString('base64url')}`;
  return `https://${DOMAIN}/u/m/${p}.${crypto.createHmac('sha256', JWT).update(p).digest('base64url')}`;
}

const queue = JSON.parse(fs.readFileSync(FILE, 'utf8'));
log(`${queue.length} in queue; daily cap ${CAP}${SEND ? '' : ' — DRY RUN'}`);

const senders = await query(
  `SELECT id, from_email, from_name FROM sender_identities
    WHERE tenant_id=? AND status='active' AND from_email IN
      ('hello@clients.help','hi@clients.help','team@clients.help','widget@clients.help')
    ORDER BY id`, [TENANT]);
if (!senders.length) { console.error('no warmed clients.help senders'); process.exit(1); }

// Validate + filter the whole batch first, so a bad row can't leave a half-sent run.
const ready = [];
for (const r of queue) {
  if (ready.length >= CAP) break;
  const email = (r.email || '').toLowerCase();
  const domain = email.split('@')[1] || '';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { continue; }
  if (!r.body || !r.subject || !r.report_url || !r.body.includes(r.report_url)) { continue; }

  // Wrong-target guard: an audit of THIS site must reach THIS business. Send only if
  // the email is on the site's own domain, or a generic mailbox provider (the owner
  // using gmail/aol/etc for their small business). An email on some OTHER company's
  // domain is usually the agency that built the site — not our prospect.
  const site = (r.domain || '').toLowerCase().replace(/^www\./, '');
  const GENERIC = /^(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|aol|icloud|me|mac|gmx|proton|protonmail|mail|yandex|zoho|fastmail|btinternet|comcast|verizon|sky|bt|virginmedia|orange|free|web|t-online)\./;
  const emailBase = domain.replace(/^www\./, '');
  if (emailBase !== site && !GENERIC.test(emailBase)) {
    log(`skip ${email}: email domain ${emailBase} ≠ site ${site} (likely not the owner)`);
    continue;
  }

  const [sup] = await query(
    `SELECT
       (SELECT COUNT(*) FROM suppressions WHERE email=?) local,
       (SELECT COUNT(*) FROM global_contact_suppression WHERE type='email' AND normalized_value=?) ge,
       (SELECT COUNT(*) FROM global_contact_suppression WHERE type='domain' AND normalized_value=?) gd,
       (SELECT COUNT(*) FROM outreach_touchpoints WHERE email=?) touched,
       (SELECT COUNT(*) FROM \`postal-server-1\`.suppressions WHERE address=?) postal`,
    [email, email, domain, email, email]);
  if (+sup.local || +sup.ge || +sup.gd) { log(`skip ${email}: suppressed`); continue; }
  if (+sup.postal) { log(`skip ${email}: on Postal list (would be Held)`); continue; }
  if (+sup.touched) { log(`skip ${email}: already contacted`); continue; }

  ready.push({ ...r, email });
}

log(`${ready.length} pass safety + cap`);
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
  // The generated body ends "Best regards," with no name — sign it with the sender,
  // and append the one-click unsubscribe line.
  const body = `${c.body.trimEnd()}\n${s.from_name}\n\nUnsubscribe: ${u}`;

  if (!SEND) {
    console.log(`\n===== ${c.domain}  (score ${c.score})  ->  ${c.email}  [from ${s.from_email}] =====`);
    console.log(`Subject: ${c.subject}`);
    console.log(body);
    idx++; continue;
  }
  try {
    await tx.sendMail({
      from: `"${s.from_name}" <${s.from_email}>`, to: c.email, replyTo: REPLY_TO,
      subject: c.subject, text: body,
      headers: {
        'List-Unsubscribe': `<mailto:${REPLY_TO}?subject=unsubscribe>, <${u}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        'X-Campaign': 'audit-outreach',
      },
    });
    await query(`INSERT INTO outreach_touchpoints (tenant_id, email, mailbox_id, channel, direction, touch_type, status, sent_at, created_at)
                 VALUES (?,?,?,?,?,?,?,NOW(),NOW())`,
      [TENANT, c.email, s.id, 'email', 'outbound', 'first_touch', 'sent_smtp']).catch(() => {});
    await query('UPDATE sender_identities SET sent_today=sent_today+1, last_sent_at=NOW() WHERE id=?', [s.id]).catch(() => {});
    sent++; idx++;
    log(`sent ${c.email} (score ${c.score}) <- ${s.from_email}`);
  } catch (e) { log(`FAIL ${c.email}: ${e.message}`); }
}
log(SEND ? `DONE: sent ${sent}/${ready.length}` : `DRY RUN: ${ready.length} would send`);
process.exit(0);
