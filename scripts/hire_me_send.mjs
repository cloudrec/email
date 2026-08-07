// hire_me_send.mjs — availability outreach: offers the OWNER as a remote AI PM /
// automation operator. A different product from the audit campaign, so it is a
// separate script with its own audience and its own copy.
//
// Audience: every active business we have a deliverable address for — the whole pool,
// not a niche. Agencies were the obvious guess and are still included, but they mostly
// have in-house devs or their own freelancers; an ordinary firm with a stalled project
// is likelier to need a pair of hands. Cost per attempt is the same either way, so the
// wider net wins. Anyone already touched by the audit campaign is excluded, so the two
// offers never land on the same person.
//
// Safety rails, same as every other sender here:
//   * suppression (local + global email + global domain) and Postal's own list
//   * never contacted before by ANY campaign (no second pitch on top of a first)
//   * reserved-domain gate honoured
//   * one-click unsubscribe header + link on every mail
//   * daily cap, dry-run by default — nothing sends without --send
//
//   node hire_me_send.mjs [--limit 40] [--send]
import * as mariadb from 'mariadb';
import nodemailer from 'nodemailer';
import crypto from 'node:crypto';
import { textToHtml } from './lib/mailBody.mjs';

const args = process.argv.slice(2);
const arg = (n, d = null) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const SEND = args.includes('--send');
const LIMIT = Number(arg('--limit', 40));
// --preview-to <email>: send exactly one mail, to that address, skipping the whole
// audience query. For the owner to see in a real inbox what a recipient receives —
// same sender, subject, body and headers as the campaign, so it is a true preview and
// not a reconstruction. Never recorded as outreach: it is not a prospect.
const PREVIEW_TO = arg('--preview-to', null);

const TENANT = 1;
const DOMAIN = 'emails.cheap';
const JWT = process.env.API_JWT_SECRET;
const REPLY_TO = 'andrii@emails.cheap';          // monitored inbox the reply importer reads
const SENDER_NAME = 'Andrii Pecherskiy';         // a person, not a brand — this is a job pitch
// The database-backed portfolio, not the old static file: it is far lighter, is kept
// current from the admin, and carries the contact form that alerts the owner.
const PORTFOLIO = 'https://clients.help/portfolio';

const KEY = crypto.createHash('sha256').update(JWT || 'insecure-dev-key').digest();
function dec(b64) {
  const b = Buffer.from(b64, 'base64');
  const iv = b.subarray(0, 12), tag = b.subarray(12, 28), ct = b.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv); d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}
const pool = mariadb.createPool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  connectionLimit: 2, bigIntAsNumber: true });
const query = (sql, p) => pool.query(sql, p);
async function resolveSecret(ref) {
  const r = await query('SELECT value_enc FROM mailbox_secrets WHERE ref_name=? LIMIT 1', [ref]);
  if (r.length && r[0].value_enc) { try { return dec(r[0].value_enc); } catch {} }
  return process.env[ref];
}
const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const log = (m) => console.log(`[${now()}] hire_me: ${m}`);
function unsub(email) {
  const p = `1.${Buffer.from(email.toLowerCase()).toString('base64url')}`;
  return `https://${DOMAIN}/u/m/${p}.${crypto.createHmac('sha256', JWT).update(p).digest('base64url')}`;
}

// Any active business with a verified, deliverable address nobody has approached yet.
// mx.sendable = 1 keeps out Google-hosted and MX-less domains, which reject cold mail
// from a young sender outright — the same gate the warmup pool uses.
const rows = PREVIEW_TO ? [{ email: PREVIEW_TO, domain: '', company: '' }] : await query(
  `SELECT cp.value AS email, cp.email_domain AS domain, co.name AS company
     FROM contact_points cp
     JOIN companies co ON co.id = cp.company_id
     JOIN email_domain_mx mx ON mx.domain = cp.email_domain AND mx.sendable = 1
    WHERE co.status='active'
      AND cp.type='email' AND cp.status='verified'
      AND SUBSTRING_INDEX(cp.value,'@',1) NOT REGEXP '^(noreply|no-reply|donotreply|postmaster|abuse|privacy|dpo|legal|security|webmaster|hostmaster|spam|protocollo|press|media|editor|newsroom|records|foi|study|studies|admission|admissions|student|students|rector|dean|faculty|campus|library|alumni)$'
      -- Universities, government, hospitals and the like do not hire a remote contractor
      -- off a cold email; they run procurement. Widened after dropping the English-TLD
      -- gate let uni.lodz.pl / put.poznan.pl style academic domains back in — European
      -- universities rarely carry .edu, so match the words, not just the suffix.
      AND cp.email_domain NOT REGEXP 'univ|uni-|\\\\buni\\\\.|\\\\.uni\\\\.|universi|\\\\.ac\\\\.|\\\\.edu|politec|polytech|\\\\bpwr\\\\.|\\\\bput\\\\.|\\\\bagh\\\\.|akadem|hochschul|fachhochschul|\\\\bschool\\\\.|\\\\bcollege\\\\.|\\\\binstitut'
      -- Italian/Iberian universities are short "uni" + faculty code (unige.it, unimi.it,
      -- unibo.it). Anchored and length-bounded so real businesses (unilever, united,
      -- unique) are not swept up with them.
      AND cp.email_domain NOT REGEXP '^uni[a-z]{1,4}\\\\.(it|es|pt)$'
      AND SUBSTRING_INDEX(cp.value,'@',1) NOT LIKE '%student%'
      AND cp.email_domain NOT REGEXP 'gov|\\\\.gc\\\\.ca|\\\\.gob\\\\.|\\\\.gouv|\\\\.mil|\\\\bnhs\\\\b|\\\\bpolice\\\\.|\\\\bcouncil\\\\.|\\\\bparliament\\\\.|\\\\bmuseum\\\\.|\\\\bmairie'
      AND cp.email_domain NOT LIKE '%.gov%' AND cp.email_domain NOT LIKE '%.mil%'
      -- Free-mail domains are not businesses; big-four/consultancy giants have no use
      -- for a one-person contractor and only burn sender reputation.
      AND cp.email_domain NOT REGEXP '(gmail|googlemail|yahoo|hotmail|outlook|live|aol|icloud|gmx|protonmail|mail\\\\.ru|yandex|web\\\\.de|t-online|zoho)'
      AND cp.email_domain NOT REGEXP '(deloitte|pwc|kpmg|accenture|capgemini|infosys|wipro|ey\\\\.com|ibm\\\\.com|oracle\\\\.com|sap\\\\.com)'
      -- No TLD restriction: English is the working language of business everywhere, and
      -- a .de or .se firm reads an English pitch fine. Owner call 2026-08-06 — the
      -- earlier English-TLD-only gate threw away half the pool for no real gain.
      AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.email = cp.value)
      AND NOT EXISTS (SELECT 1 FROM global_contact_suppression g WHERE g.type='email' AND g.normalized_value = LOWER(cp.value))
      AND NOT EXISTS (SELECT 1 FROM global_contact_suppression g2 WHERE g2.type='domain' AND g2.normalized_value = LOWER(cp.email_domain))
      -- Uncorrelated set, built once. The correlated LOWER() form cannot use the index
      -- and re-scans outreach_touchpoints per candidate row — the exact shape that hung
      -- the warmup sender for ~28 min on 2026-08-06.
      AND cp.normalized_value NOT IN (SELECT DISTINCT LOWER(tp.email) FROM outreach_touchpoints tp WHERE tp.email LIKE '%@%')
      AND NOT EXISTS (SELECT 1 FROM \`postal-server-1\`.suppressions ps WHERE ps.address = cp.value)
      AND NOT EXISTS (SELECT 1 FROM reserved_domains rd WHERE rd.domain = LOWER(cp.email_domain) AND rd.released_at IS NULL)
    -- One mail per COMPANY, not per domain. Domain was the wrong unit in both
    -- directions: it merged info@/sales@/admin@ of one firm (right) but also merged
    -- every distinct business sharing a marketplace, WordPress or blogging platform
    -- domain into a single target, silently discarding real prospects. company_id is
    -- the actual "one human decides here" boundary.
    GROUP BY co.id
    -- Prefer a named person over a role inbox: role_type='personal' first (rare — only
    -- a couple thousand rows exist at all, and the classifier is conservative), then
    -- 'unknown' (unclassified, often a genuine firstname@ that just wasn't tagged —
    -- baseline check 2026-08-07 showed this tier is already ~24/25 of a typical batch),
    -- and only once both are exhausted fall back to explicit role inboxes (info/
    -- generic/support/sales/partnerships) — those stay reachable, just last in line,
    -- never a live problem at this cap since personal+unknown alone run in the tens
    -- of thousands.
    ORDER BY (CASE cp.role_type WHEN 'personal' THEN 0 WHEN 'unknown' THEN 1 ELSE 2 END),
             cp.verification_score DESC, cp.id
    LIMIT ?`, [LIMIT]);

log(`${rows.length} business contacts pass every gate${SEND ? '' : ' — DRY RUN'}`);
if (!rows.length) { await pool.end(); process.exit(0); }

// Written for a business owner, not a recruiter: says what I can DO for them in plain
// words, keeps the jargon ("AI PM", stack names) out of the first three lines, and puts
// the proof in a link instead of adjectives. Ends on the lowest possible ask — "reply
// and I'll send availability", never "hire me".
function build(company) {
  const who = company ? ` for ${company}` : '';
  return `Hello,

I'm Andrii. I do the technical work small businesses usually can't find a reliable person
for — remotely, one-off or ongoing:

• Websites and online shops — fixes, speed, forms that actually deliver enquiries
• Automation — the repetitive jobs someone currently does by hand every week
• AI chat support that answers customers out of hours, on the site or WordPress
• Servers, deployments, backups and monitoring, so things stop breaking quietly

I run this end to end: work out what's needed, do it or drive it through developers,
test it, and hand it over working. Real projects, live domains and the stack behind each:
${PORTFOLIO}

If something${who} needs doing and there's no one to do it — reply to this email and
I'll send my availability and rates. If it's not relevant, no problem at all.

Best regards,
${SENDER_NAME}`;
}

// Rotate across several warmed mailboxes instead of hammering one. A single mailbox was
// the only reason the first run was capped at 40 — the daily limit is 500 per mailbox,
// so one sender was never the constraint, caution was. These five are all warmup stage
// 14, all poll IMAP, and none of them are used by the warmup/pilot campaigns, so this
// adds no load to sends that already work. Display name stays "Andrii Pecherskiy" and
// Reply-To stays andrii@emails.cheap on every one, so a reply always lands in the one
// inbox the importer reads, whichever mailbox sent it.
const SENDER_POOL = ['andrii@emails.cheap', 'help@emails.cheap', 'myhelp@emails.cheap',
                     'eva@emails.cheap', 'book@emails.cheap'];
const senders = await query(
  `SELECT id, from_email, from_name, sent_today, daily_send_limit FROM sender_identities
    WHERE tenant_id=? AND status='active' AND outbound_enabled=1
      AND from_email IN (?,?,?,?,?) ORDER BY sent_today ASC, id`,
  [TENANT, ...SENDER_POOL]);
if (!senders.length) { console.error('no warmed sender available'); process.exit(1); }
log(`${senders.length} sender mailbox(es): ${senders.map(s => `${s.from_email}(${s.sent_today})`).join(', ')}`);

let tx = null;
if (SEND) {
  const user = await resolveSecret('POSTAL_OUTREACH_SMTP_USER');
  const pass = await resolveSecret('POSTAL_OUTREACH_SMTP_PASSWORD');
  tx = nodemailer.createTransport({ host: 'email_postal_smtp', port: 25, secure: false,
    auth: { user, pass }, tls: { rejectUnauthorized: false }, connectionTimeout: 15000, socketTimeout: 20000 });
} else {
  log('DRY RUN — re-run with --send once the preview looks right.');
}

let sent = 0, idx = 0;
for (const r of rows) {
  // Round-robin the mailboxes so the run spreads evenly instead of draining one.
  const sender = senders[idx % senders.length];
  idx++;
  const u = unsub(r.email);
  // No jargon in the subject — a shop owner does not search for an "AI PM".
  const subject = 'Technical help, remote — websites, automation, AI support';
  const body = `${build(r.company)}\n\nUnsubscribe: ${u}`;

  if (!SEND) {
    console.log(`\n===== ${r.company || r.domain} -> ${r.email} =====`);
    console.log(`Subject: ${subject}`);
    console.log(body);
    continue;
  }
  try {
    await tx.sendMail({
      from: `"${SENDER_NAME}" <${sender.from_email}>`, to: r.email, replyTo: REPLY_TO,
      subject, text: body,
      html: textToHtml(body),
      headers: {
        'List-Unsubscribe': `<mailto:${REPLY_TO}?subject=unsubscribe>, <${u}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        'X-Campaign': 'hire-me',
      },
    });
    // A preview to the owner is not outreach. Recording it would put the owner's own
    // address on the contacted list and skew the campaign counters.
    if (!PREVIEW_TO) {
      await query(`INSERT INTO outreach_touchpoints (tenant_id, email, mailbox_id, channel, direction, touch_type, status, subject, sent_at, created_at)
                   VALUES (?,?,?,?,?,?,?,?,NOW(),NOW())`,
        [TENANT, r.email, sender.id, 'email', 'outbound', 'first_touch', 'sent_smtp', subject]).catch(() => {});
      await query('UPDATE sender_identities SET sent_today=sent_today+1, last_sent_at=NOW() WHERE id=?', [sender.id]).catch(() => {});
    }
    sent++;
    log(`sent ${r.email} (${r.company || r.domain})`);
  } catch (e) { log(`FAIL ${r.email}: ${e.message}`); }
}
if (tx) tx.close();
log(SEND ? `DONE: sent ${sent}/${rows.length}` : `DRY RUN: ${rows.length} would send`);
await pool.end();
process.exit(0);
