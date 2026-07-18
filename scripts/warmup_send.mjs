// Self-regulating daily warmup sender. Run by cron inside the api container.
// SAFETY RAILS (any tripped -> no send this run):
//  - complaints today > 0, or hard-bounce rate high  -> STOP (protect reputation)
//  - IP on Barracuda blacklist                        -> STOP
// Otherwise sends a small ramped batch to CLEAN, NON-GOOGLE, Western business
// addresses (Google-hosted are dropped — cold reputation blocks them, wastes warmup),
// 1 per domain, deduped vs prior touchpoints, excluding suppressed. Rotates the 12
// emails.cheap senders + 3 templates, Reply-To -> monitored inbox, one-click unsubscribe.
import { resolveSecret } from './dist/services/secretsVault.js';
import { query } from './dist/db.js';
import nodemailer from 'nodemailer';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import IORedis from 'ioredis';

const TENANT = 1;
const JWT = process.env.API_JWT_SECRET;
const RAMP = [8, 12, 16, 22, 30, 40, 50, 65, 80, 100, 120, 150];  // per-day target (day-1=8 done manually)
const REPLY_TO = 'andrii@emails.cheap';
const now = () => new Date().toISOString().slice(0, 16).replace('T', ' ');
const log = (m) => console.log(`[${now()}] warmup_send: ${m}`);

const redis = new IORedis({ host: process.env.REDIS_HOST || 'redis', port: +(process.env.REDIS_PORT || 6379), password: process.env.REDIS_PASSWORD, maxRetriesPerRequest: 2 });

// ---- 1. Health pre-flight (regulation) ----
// Scoped to emails.cheap's own mailboxes only — other domains (clients.help,
// treasurenetwork.space, patent.rocks, diamond, acap) now share this same
// sender_identities table and IP, but a complaint on one of those must not
// pause emails.cheap's independent ramp, and vice versa (see warmup_send_pilot.mjs).
async function healthOk() {
  const [r] = await query(`SELECT COALESCE(SUM(sent_today),0) sent, COALESCE(SUM(bounce_like_today),0) bounce,
    COALESCE(SUM(complaints_today),0) complaint FROM sender_identities WHERE status='active' AND from_email LIKE '%@emails.cheap'`);
  const sent = +r.sent, bounce = +r.bounce, complaint = +r.complaint;
  if (complaint > 0) { log(`STOP: ${complaint} complaint(s) today (emails.cheap only)`); return false; }
  if (sent >= 20 && bounce / sent > 0.03) { log(`STOP: bounce rate ${(100 * bounce / sent).toFixed(1)}% > 3% (emails.cheap only)`); return false; }
  // Barracuda DNSBL is IP-wide by nature — correctly still checked platform-wide.
  const rev = '105.139.247.84';
  try { const a = await dns.resolve4(`${rev}.b.barracudacentral.org`); if (a.length) { log(`STOP: Barracuda-listed (IP-wide)`); return false; } } catch {}
  return true;
}

// ---- 1b. Sync real Postal bounces -> suppress INVALID addresses (not reputation) ----
async function syncPostalBounces() {
  let rows = [];
  try {
    rows = await query("SELECT m.rcpt_to, d.output FROM `postal-server-1`.messages m " +
      "JOIN `postal-server-1`.deliveries d ON d.id=(SELECT MAX(id) FROM `postal-server-1`.deliveries WHERE message_id=m.id) " +
      "WHERE m.timestamp > UNIX_TIMESTAMP()-90000 AND m.status IN ('HardFail','Bounced')");
  } catch { return { invalid: 0 }; }
  const INVALID = /(5\.1\.[013]|user unknown|no such (user|mailbox|recipient)|mailbox (unavailable|not found|does not exist|disabled|full)|recipient (unknown|rejected|not found|address rejected)|address (rejected|not found)|does not exist|no mailbox|account.*(disabled|closed|suspended))/i;
  const SKIP = /(5\.7\.1|reputation|spam|blocked|blacklist|rp\.emails\.cheap|sender address rejected|greylist|try again|rate|deferred|temporar)/i;
  let invalid = 0, suppressed = 0;
  for (const r of rows) {
    const o = r.output || '';
    if (!INVALID.test(o) || SKIP.test(o)) continue;
    invalid++;
    const em = (r.rcpt_to || '').toLowerCase();
    if (!em.includes('@')) continue;
    await query('INSERT IGNORE INTO suppressions (tenant_id, email, reason) VALUES (?,?,?)', [TENANT, em, 'bounce_hard']).catch(() => {});
    await query("INSERT IGNORE INTO global_contact_suppression (type, normalized_value, reason) VALUES ('email',?,'hard_bounce')", [em]).catch(() => {});
    await query("UPDATE contact_points SET status='bounced' WHERE value=?", [em]).catch(() => {});
    suppressed++;
  }
  if (suppressed) log(`postal bounce sync: suppressed ${suppressed} invalid address(es)`);
  return { invalid };
}

// ---- 2. non-Google MX check (verdict cached per domain — see migration 0021) ----
// This used to resolve MX live for every candidate and throw the answer away, so
// a Google-hosted domain was rejected in-process and left sitting at the head of
// the candidate ordering forever (that ordering is static: ~114k rows tie at
// verification_score 85, so it falls back to ascending cp.id). Sendable domains
// got a touchpoint and dropped out, unsendable ones accumulated until the head
// was ~97% Google. Now the verdict is persisted, candidates() filters on it in
// SQL, and DNS only runs for domains we haven't classified yet.
const GOOG = /(aspmx.*google|google\.com|googlemail|gmail-smtp)/i;
// Own resolver: the default has no timeout knob, so one hung nameserver could
// stall the whole run.
const resolver = new dns.Resolver({ timeout: 5000, tries: 2 });

// "Domain has no mail server" is permanent; "DNS was unhappy just now" is not.
// Caching the second as if it were the first would bench a good domain for a month.
function classifyErr(code) {
  return (code === 'ENODATA' || code === 'ENOTFOUND' || code === 'NXDOMAIN') ? 'no_mx' : 'dns_fail';
}
async function classifyMx(domain) {
  try {
    const mx = await resolver.resolveMx(domain);
    if (!mx.length) return 'no_mx';
    return mx.some(m => GOOG.test(m.exchange)) ? 'google' : 'ok';
  } catch (e) { return classifyErr(e.code); }
}
// Trusts a fresh cached verdict; otherwise resolves and writes it back so the
// next run can filter this domain out in SQL instead of paying for DNS again.
async function mxSendable(c) {
  if (c.mx_fresh) return c.mx_sendable === 1;
  const verdict = await classifyMx(c.domain);
  await query(`INSERT INTO email_domain_mx (domain, sendable, verdict) VALUES (?,?,?)
               ON DUPLICATE KEY UPDATE sendable=VALUES(sendable), verdict=VALUES(verdict)`,
    [c.domain, verdict === 'ok' ? 1 : 0, verdict]).catch(() => {});
  return verdict === 'ok';
}

// A cached verdict is only trusted for so long: dns_fail is transient and must
// expire fast, google/no_mx are stable properties of the domain.
const MX_FRESH = `(mx.domain IS NOT NULL
  AND mx.checked_at >= NOW() - INTERVAL (CASE mx.verdict WHEN 'dns_fail' THEN 3 ELSE 30 END) DAY)`;

// ---- 3. candidate selection (clean, western business, deduped, unsuppressed) ----
async function candidates(need) {
  return query(`
    SELECT cp.value AS email, cp.email_domain AS domain,
           mx.sendable AS mx_sendable, ${MX_FRESH} AS mx_fresh
    FROM contact_points cp JOIN companies co ON co.id=cp.company_id
    LEFT JOIN email_domain_mx mx ON mx.domain = cp.email_domain
    WHERE cp.type='email' AND cp.status='verified'
      -- unknown -> let the loop resolve it; sendable -> take it; stale -> re-check.
      -- Only a fresh "not sendable" verdict is filtered out here.
      AND (mx.domain IS NULL OR mx.sendable = 1 OR NOT ${MX_FRESH})
      AND cp.email_domain NOT REGEXP '(gmail|googlemail|yahoo|hotmail|outlook|live|aol|aim\\\\.com|icloud|me\\\\.com|mac\\\\.com|gmx|protonmail|proton\\\\.me|mail\\\\.ru|mail\\\\.com|yandex|msn|comcast|web\\\\.de|t-online|fastmail|zoho|tutanota|hey\\\\.com)'
      AND cp.email_domain NOT LIKE '%.ru' AND cp.email_domain NOT LIKE '%.gov%' AND cp.email_domain NOT LIKE '%.mil%'
      AND cp.email_domain NOT REGEXP 'gov|\\\\.gc\\\\.ca|\\\\.gob\\\\.|\\\\.gouv|\\\\.mil|zendesk|freshdesk|helpscout'
      AND cp.email_domain NOT REGEXP '(^|\\\\.)(au\\\\.dk|apix\\\\.fi)$'
      AND cp.email_domain NOT REGEXP '\\\\.gv\\\\.[a-z]+$'
      AND cp.value NOT LIKE '%exemplo%' AND cp.value NOT LIKE '%beispiel%'
      AND SUBSTRING_INDEX(cp.value,'@',1) NOT REGEXP '^(datenschutz|dsb)$'
      AND cp.email_domain NOT REGEXP 'univ|\\\\buni-|\\\\.ac\\\\.|\\\\.edu\\\\.|\\\\.edu$'
      AND cp.email_domain NOT REGEXP '\\\\.int$|\\\\bnhs\\\\b|\\\\bpolice\\\\.|\\\\bparliament\\\\.|\\\\bsenate\\\\.|\\\\bcongress\\\\.|\\\\bcourt(s)?\\\\.|\\\\bembassy|\\\\bconsulate|\\\\bunion\\\\.|\\\\bmuseum\\\\.|redcross|\\\\bmairie|\\\\bcouncil\\\\.|sch\\\\.uk$'
      AND SUBSTRING_INDEX(cp.value,'@',1) NOT REGEXP '^(press|media|editor|newsroom|journalist|reporter|ombudsman|foi|records)$'
      AND cp.email_domain NOT IN ('xyz.com','yourcompany.com','example.com','example.org','domain.com','yourdomain.com','company.com','test.com','email.com','website.com')
      AND SUBSTRING_INDEX(cp.value,'@',1) NOT REGEXP '^(abc|your\\\\.?name|your\\\\.?email|example|test|user|name|email|username|firstname|noreply|no-reply|donotreply|postmaster|privacy|rgpd|gdpr|dpo|legal|abuse|compliance|dmca|security|webmaster|hostmaster|spam)$'
      AND cp.value NOT LIKE '%example%' AND cp.value NOT LIKE '%yourname%'
      AND SUBSTRING_INDEX(cp.email_domain,'.',-1) IN ('com','uk','ca','au','ie','nz','de','nl','at','se','dk','ch','fi','be','pt','it','net','pl','cz','no','ro','fr','hu','es','hr','gr','ee','sk','za','sg','io','il','ae')
      AND SUBSTRING_INDEX(cp.value,'@',1) NOT REGEXP '^[0-9a-f]{16,}$'
      AND SUBSTRING_INDEX(cp.value,'@',1) NOT REGEXP '^[0-9]+$'
      AND CHAR_LENGTH(SUBSTRING_INDEX(cp.value,'@',1)) BETWEEN 3 AND 24
      AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.email=cp.value)
      AND NOT EXISTS (SELECT 1 FROM global_contact_suppression g WHERE g.type='email' AND g.normalized_value=LOWER(cp.value))
      AND NOT EXISTS (SELECT 1 FROM global_contact_suppression g WHERE g.type='domain' AND g.normalized_value=LOWER(cp.email_domain))
      AND NOT EXISTS (SELECT 1 FROM outreach_touchpoints tp WHERE tp.email LIKE CONCAT('%@', cp.email_domain))
      -- Postal keeps its OWN suppression list and silently Holds mail to anyone on it
      -- while still returning 250 OK. Without this, a suppressed recipient is picked,
      -- "sent", and quietly Held — 28 of 100 wasted this way on 2026-07-18.
      AND NOT EXISTS (SELECT 1 FROM \`postal-server-1\`.suppressions ps WHERE ps.address=cp.value)
    GROUP BY cp.email_domain
    ORDER BY cp.verification_score DESC, cp.id
    LIMIT ?`, [need * 4]);   // over-select; the loop still drops newly-classified Google/no-MX
}

function spin(s, seed) { let i = seed; return s.replace(/\{([^{}]*\|[^{}]*)\}/g, (_, g) => { const o = g.split('|'); return o[(i++) % o.length]; }); }
function fill(s, v) { return s.replace(/\{\{(\w+)\}\}/g, (_, k) => v[k] ?? ''); }
function brand(d) { return d.split('.')[0].split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '); }
function unsub(email) { const p = `1.${Buffer.from(email.toLowerCase()).toString('base64url')}`; return `https://emails.cheap/u/m/${p}.${crypto.createHmac('sha256', JWT).update(p).digest('base64url')}`; }

async function main() {
  // Roll per-mailbox daily counters at the start of a new UTC day so bounce/complaint
  // rates + the dashboard reflect TODAY only (campaigns aren't running to roll them).
  await query(`UPDATE sender_identities SET sent_today=0, smtp_sent_today=0, manual_sent_today=0,
      bounce_like_today=0, complaints_today=0, bounced_today=0, complained_today=0,
      unsubscribes_today=0, unsubscribed_today=0, replies_today=0, interested_today=0, negative_today=0,
      counters_day=CURDATE()
    WHERE status='active' AND (counters_day IS NULL OR counters_day < CURDATE())`).catch(() => {});

  await syncPostalBounces();                 // real bounces -> suppress invalid addresses
  if (!(await healthOk())) { await redis.quit(); return; }

  const day = await redis.incr('warmup:daynum');       // day-1 already sent; first cron run = day 2 idx
  const target = RAMP[Math.min(day, RAMP.length - 1)];
  log(`day ${day + 1}, target ${target}`);

  const senders = await query(`SELECT id, from_email, from_name FROM sender_identities
    WHERE tenant_id=? AND status='active' AND from_email LIKE '%@emails.cheap'
      AND provider_id=(SELECT id FROM sending_providers WHERE provider_type='postal' AND tenant_id=? LIMIT 1)
    ORDER BY id`, [TENANT, TENANT]);
  if (!senders.length) { log('no Postal senders'); await redis.quit(); return; }
  // Two offers, alternated by day so each mailbox pitches ONE clean story per run
  // instead of mixing two products into the same batch (looks templated otherwise).
  const OFFERS = [
    { name: 'Clients.Help', ids: [20, 21, 22], agencyId: 21, altIds: [20, 22] },
    { name: 'Treasure Network', ids: [23, 24, 25], agencyId: 24, altIds: [23, 25] },
  ];
  const offer = OFFERS[day % OFFERS.length];
  const tpls = {}; for (const id of offer.ids) { const [t] = await query('SELECT subject, body FROM manual_outreach_templates WHERE id=?', [id]); tpls[id] = t; }
  log(`offer: ${offer.name}`);

  const user = await resolveSecret('POSTAL_OUTREACH_SMTP_USER'), pass = await resolveSecret('POSTAL_OUTREACH_SMTP_PASSWORD');
  const tx = nodemailer.createTransport({ host: 'email_postal_smtp', port: 25, secure: false, auth: { user, pass }, tls: { rejectUnauthorized: false }, connectionTimeout: 15000, socketTimeout: 20000 });

  const cand = await candidates(target);
  let sent = 0, idx = 0, checked = 0;
  for (const c of cand) {
    if (sent >= target) break;
    checked++;
    if (!(await mxSendable(c))) continue;               // skip Google-hosted / no MX (won't deliver cold)
    const s = senders[idx % senders.length];
    const isAgency = /agenc|studio|creativ|design|web|digital|market|media/i.test(c.domain);
    const tplId = isAgency ? offer.agencyId : offer.altIds[idx % offer.altIds.length];
    const t = tpls[tplId];
    // s.from_name is already the brand/product name, not a person's name —
    // appending offer.name duplicated it into signatures like "Clients.Help,
    // Clients.Help". Just use one.
    const vars = { company: brand(c.domain), sender_name: offer.name };
    // fill() must run BEFORE spin(): {{company}} sits inside the spintax
    // {...|...} braces in several templates, and spin()'s regex can't match
    // across nested braces — the old order shipped literal unrendered
    // "{A|B|C}" text to real recipients. Filling vars first leaves plain text
    // for spin() to resolve correctly.
    const subject = spin(fill(t.subject, vars), idx).trim();
    let body = spin(fill(t.body, vars), idx);
    const u = unsub(c.email);
    body = body.replace('Reply STOP', `Unsubscribe: ${u}  or reply STOP`);
    try {
      const info = await tx.sendMail({
        from: `"${s.from_name}" <${s.from_email}>`, to: c.email, replyTo: REPLY_TO, subject, text: body,
        headers: { 'List-Unsubscribe': `<mailto:${REPLY_TO}?subject=unsubscribe>, <${u}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click', 'X-Campaign': `warmup-d${day + 1}` },
      });
      // record touchpoint (dedup) + bump sender counter (feeds auto-pause + monitor)
      await query(`INSERT INTO outreach_touchpoints (tenant_id, email, mailbox_id, channel, direction, touch_type, status, sent_at, created_at)
                   VALUES (?,?,?,?,?,?,?,NOW(),NOW())`, [TENANT, c.email, s.id, 'email', 'outbound', 'first_touch', 'sent_smtp']).catch(() => {});
      await query('UPDATE sender_identities SET sent_today=sent_today+1, last_sent_at=NOW() WHERE id=?', [s.id]).catch(() => {});
      sent++; idx++;
      log(`sent ${c.email} <- ${s.from_email} tpl${tplId}`);
    } catch (e) { log(`FAIL ${c.email}: ${e.message}`); }
  }
  log(`DONE day ${day + 1}: sent ${sent}/${target} (scanned ${checked} candidates)`);
  await redis.quit();
}
main().then(() => process.exit(0)).catch(e => { console.error('FATAL', e); process.exit(1); });
