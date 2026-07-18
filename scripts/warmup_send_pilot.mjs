// Small-pilot warmup sender for newly-added branded domains (clients.help,
// treasurenetwork.space). Mirrors warmup_send.mjs's safety rails and candidate
// selection exactly, but runs an INDEPENDENT slow ramp per domain (own Redis
// daynum key) with its OWN single matching offer — sending the widget pitch
// FROM clients.help and the quest pitch FROM treasurenetwork.space, so the
// sender domain actually matches what's being pitched (coherent branding).
import { resolveSecret } from './dist/services/secretsVault.js';
import { query } from './dist/db.js';
import nodemailer from 'nodemailer';
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import IORedis from 'ioredis';

const TENANT = 1;
const JWT = process.env.API_JWT_SECRET;
const REPLY_TO = 'andrii@emails.cheap';
// Small, conservative pilot ramp — slower than emails.cheap's since these are
// brand-new sending domains starting from zero reputation.
const RAMP = [4, 6, 8, 12, 16, 20, 25, 30, 40, 50, 65, 80, 100];
const now = () => new Date().toISOString().slice(0, 16).replace('T', ' ');

const redis = new IORedis({ host: process.env.REDIS_HOST || 'redis', port: +(process.env.REDIS_PORT || 6379), password: process.env.REDIS_PASSWORD, maxRetriesPerRequest: 2 });

const TRACKS = [
  { key: 'clients_help', domain: 'clients.help', offerName: 'Clients.Help', tplIds: [20, 21, 22], agencyId: 21, altIds: [20, 22] },
  { key: 'treasure_network', domain: 'treasurenetwork.space', offerName: 'Treasure Network', tplIds: [23, 24, 25], agencyId: 24, altIds: [23, 25] },
  // Patent.rocks — 2026-07-16: was 502 (pm2 process wasn't running after a
  // restart), fixed and pm2-persisted across reboot. Re-enabled.
  { key: 'patent_rocks', domain: 'patent.rocks', offerName: 'Patent.rocks', tplIds: [28], agencyId: 28, altIds: [28],
    categoryFilter: ['web_agency', 'it_software', 'media_marketing'] },
  // Diamond/ACAP — no category match, general list, per explicit owner override.
  { key: 'diamond', domain: '469diamond.com', offerName: '469Diamond', tplIds: [26], agencyId: 26, altIds: [26] },
  { key: 'acap', domain: 'acap.network', offerName: 'ACAP Network', tplIds: [27], agencyId: 27, altIds: [27] },
];

// IP-level check only — correctly platform-wide, since a DNSBL listing hits
// every domain sharing this server's sending IP regardless of which domain's
// mailbox is used. Run once per invocation, gates the whole run.
async function ipHealthOk(log) {
  const rev = '105.139.247.84';
  try { const a = await dns.resolve4(`${rev}.b.barracudacentral.org`); if (a.length) { log('STOP: Barracuda-listed (IP-wide)'); return false; } } catch {}
  return true;
}

// Complaint/bounce check scoped to ONE domain's own mailboxes — a bad signal
// on one domain must not pause every other domain sharing this IP. Each
// track checks (and can be stopped) independently.
async function domainHealthOk(domain, log) {
  const [r] = await query(`SELECT COALESCE(SUM(sent_today),0) sent, COALESCE(SUM(bounce_like_today),0) bounce,
    COALESCE(SUM(complaints_today),0) complaint FROM sender_identities WHERE status='active' AND from_email LIKE ?`, [`%@${domain}`]);
  const sent = +r.sent, bounce = +r.bounce, complaint = +r.complaint;
  if (complaint > 0) { log(`STOP: ${complaint} complaint(s) today (${domain} only)`); return false; }
  if (sent >= 15 && bounce / sent > 0.05) { log(`STOP: bounce rate ${(100 * bounce / sent).toFixed(1)}% > 5% (${domain} only)`); return false; }
  return true;
}

// non-Google MX check, verdict cached per domain (see migration 0021). This used
// to resolve MX live for every candidate and discard the answer, so Google-hosted
// domains were rejected in-process and stayed at the head of the candidate
// ordering forever — that ordering is static (~114k rows tie at
// verification_score 85, tie-broken by ascending cp.id). Sendable domains earned
// a touchpoint and dropped out; unsendable ones piled up until the head was ~97%
// Google. Tracks with a small ramp target were hit first, because their
// `need * 4` window was too shallow to reach past the wall: diamond and acap
// (target 16 -> LIMIT 64) sent 1/16 on 2026-07-16 while clients_help
// (target 50 -> LIMIT 200) still managed 36/50.
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
// Shared across tracks: whichever track classifies a domain first, the rest of
// this same run already benefits.
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

async function candidates(need, categoryFilter) {
  const categoryClause = categoryFilter && categoryFilter.length
    ? `AND co.category_primary IN (${categoryFilter.map(c => `'${c.replace(/[^a-z_]/g, '')}'`).join(',')})`
    : '';
  return query(`
    SELECT cp.value AS email, cp.email_domain AS domain,
           mx.sendable AS mx_sendable, ${MX_FRESH} AS mx_fresh
    FROM contact_points cp JOIN companies co ON co.id=cp.company_id
    LEFT JOIN email_domain_mx mx ON mx.domain = cp.email_domain
    WHERE cp.type='email' AND cp.status='verified'
      ${categoryClause}
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
      -- Postal silently Holds mail to anyone on its own suppression list (still 250 OK),
      -- so a suppressed pick is "sent" and never delivered. Exclude up front.
      AND NOT EXISTS (SELECT 1 FROM \`postal-server-1\`.suppressions ps WHERE ps.address=cp.value)
    GROUP BY cp.email_domain
    ORDER BY cp.verification_score DESC, cp.id
    LIMIT ?`, [need * 4]);   // over-select; the loop still drops newly-classified Google/no-MX
}

function spin(s, seed) { let i = seed; return s.replace(/\{([^{}]*\|[^{}]*)\}/g, (_, g) => { const o = g.split('|'); return o[(i++) % o.length]; }); }
function fill(s, v) { return s.replace(/\{\{(\w+)\}\}/g, (_, k) => v[k] ?? ''); }
function brand(d) { return d.split('.')[0].split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '); }
// The unsubscribe link must be on the SAME domain that's actually sending —
// pointing it at emails.cheap while sending from e.g. acap.network is a
// From/unsubscribe domain mismatch, a real spam-filter signal (each branded
// domain's nginx now proxies /u/m/ to this same API, see the 2026-07-16 fix).
function unsub(email, domain) { const p = `1.${Buffer.from(email.toLowerCase()).toString('base64url')}`; return `https://${domain}/u/m/${p}.${crypto.createHmac('sha256', JWT).update(p).digest('base64url')}`; }

async function runTrack(track, tx) {
  const log = (m) => console.log(`[${now()}] warmup_pilot[${track.key}]: ${m}`);

  if (!(await domainHealthOk(track.domain, log))) return;

  const day = await redis.incr(`warmup_pilot:daynum:${track.key}`);
  const target = RAMP[Math.min(day - 1, RAMP.length - 1)];
  log(`day ${day}, target ${target}`);

  const senders = await query(`SELECT id, from_email, from_name FROM sender_identities
    WHERE tenant_id=? AND status='active' AND from_email LIKE ?
      AND provider_id=(SELECT id FROM sending_providers WHERE provider_type='postal' AND tenant_id=? LIMIT 1)
    ORDER BY id`, [TENANT, `%@${track.domain}`, TENANT]);
  if (!senders.length) { log('no senders configured for this domain'); return; }

  const tpls = {}; for (const id of track.tplIds) { const [t] = await query('SELECT subject, body FROM manual_outreach_templates WHERE id=?', [id]); tpls[id] = t; }

  const cand = await candidates(target, track.categoryFilter);
  let sent = 0, idx = 0, checked = 0;
  for (const c of cand) {
    if (sent >= target) break;
    checked++;
    if (!(await mxSendable(c))) continue;   // skip Google-hosted / no MX (won't deliver cold)
    const s = senders[idx % senders.length];
    const isAgency = /agenc|studio|creativ|design|web|digital|market|media/i.test(c.domain);
    const tplId = isAgency ? track.agencyId : track.altIds[idx % track.altIds.length];
    const t = tpls[tplId];
    // s.from_name is already the brand/product name (e.g. "ACAP Network"),
    // not a person's name — appending track.offerName duplicated it into
    // signatures like "ACAP Network, ACAP Network". Just use one.
    const vars = { company: brand(c.domain), sender_name: track.offerName };
    // fill() must run BEFORE spin(): {{company}} sits inside the spintax
    // {...|...} braces in several templates, and spin()'s regex can't match
    // across nested braces — the old order shipped literal unrendered
    // "{A|B|C}" text to real recipients. Filling vars first leaves plain text
    // for spin() to resolve correctly.
    const subject = spin(fill(t.subject, vars), idx).trim();
    let body = spin(fill(t.body, vars), idx);
    const u = unsub(c.email, track.domain);
    body = body.replace('Reply STOP', `Unsubscribe: ${u}  or reply STOP`);
    try {
      await tx.sendMail({
        from: `"${s.from_name}" <${s.from_email}>`, to: c.email, replyTo: REPLY_TO, subject, text: body,
        headers: { 'List-Unsubscribe': `<mailto:${REPLY_TO}?subject=unsubscribe>, <${u}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click', 'X-Campaign': `warmup-pilot-${track.key}-d${day}` },
      });
      await query(`INSERT INTO outreach_touchpoints (tenant_id, email, mailbox_id, channel, direction, touch_type, status, sent_at, created_at)
                   VALUES (?,?,?,?,?,?,?,NOW(),NOW())`, [TENANT, c.email, s.id, 'email', 'outbound', 'first_touch', 'sent_smtp']).catch(() => {});
      await query('UPDATE sender_identities SET sent_today=sent_today+1, last_sent_at=NOW() WHERE id=?', [s.id]).catch(() => {});
      sent++; idx++;
      log(`sent ${c.email} <- ${s.from_email} tpl${tplId}`);
    } catch (e) { log(`FAIL ${c.email}: ${e.message}`); }
  }
  log(`DONE day ${day}: sent ${sent}/${target} (scanned ${checked} candidates)`);
}

async function main() {
  const log = (m) => console.log(`[${now()}] warmup_pilot: ${m}`);
  await query(`UPDATE sender_identities SET sent_today=0, smtp_sent_today=0, manual_sent_today=0,
      bounce_like_today=0, complaints_today=0, bounced_today=0, complained_today=0,
      unsubscribes_today=0, unsubscribed_today=0, replies_today=0, interested_today=0, negative_today=0,
      counters_day=CURDATE()
    WHERE status='active' AND (counters_day IS NULL OR counters_day < CURDATE())`).catch(() => {});

  if (!(await ipHealthOk(log))) { await redis.quit(); return; }

  const user = await resolveSecret('POSTAL_OUTREACH_SMTP_USER'), pass = await resolveSecret('POSTAL_OUTREACH_SMTP_PASSWORD');
  const tx = nodemailer.createTransport({ host: 'email_postal_smtp', port: 25, secure: false, auth: { user, pass }, tls: { rejectUnauthorized: false }, connectionTimeout: 15000, socketTimeout: 20000 });

  for (const track of TRACKS) {
    try { await runTrack(track, tx); }
    catch (e) { log(`track ${track.key} error: ${e.message}`); }
  }
  await redis.quit();
}
main().then(() => process.exit(0)).catch(e => { console.error('FATAL', e); process.exit(1); });
