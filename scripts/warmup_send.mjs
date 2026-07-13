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
async function healthOk() {
  const [r] = await query(`SELECT COALESCE(SUM(sent_today),0) sent, COALESCE(SUM(bounce_like_today),0) bounce,
    COALESCE(SUM(complaints_today),0) complaint FROM sender_identities WHERE status='active'`);
  const sent = +r.sent, bounce = +r.bounce, complaint = +r.complaint;
  if (complaint > 0) { log(`STOP: ${complaint} complaint(s) today`); return false; }
  if (sent >= 20 && bounce / sent > 0.03) { log(`STOP: bounce rate ${(100 * bounce / sent).toFixed(1)}% > 3%`); return false; }
  // Barracuda DNSBL (reliable via public resolver; Spamhaus blocks public resolvers)
  const rev = '105.139.247.84';
  try { const a = await dns.resolve4(`${rev}.b.barracudacentral.org`); if (a.length) { log(`STOP: Barracuda-listed`); return false; } } catch {}
  return true;
}

// ---- 2. non-Google MX check ----
const GOOG = /(aspmx.*google|google\.com|googlemail|gmail-smtp)/i;
async function nonGoogle(domain) {
  try { const mx = await dns.resolveMx(domain); if (!mx.length) return false; return !mx.some(m => GOOG.test(m.exchange)); }
  catch { return false; }
}

// ---- 3. candidate selection (clean, western business, deduped, unsuppressed) ----
async function candidates(need) {
  return query(`
    SELECT cp.value AS email, cp.email_domain AS domain
    FROM contact_points cp JOIN companies co ON co.id=cp.company_id
    WHERE cp.type='email' AND cp.status='verified'
      AND cp.email_domain NOT REGEXP '(gmail|googlemail|yahoo|hotmail|outlook|live|aol|aim\\\\.com|icloud|me\\\\.com|mac\\\\.com|gmx|protonmail|proton\\\\.me|mail\\\\.ru|mail\\\\.com|yandex|msn|comcast|web\\\\.de|t-online|fastmail|zoho|tutanota|hey\\\\.com)'
      AND cp.email_domain NOT LIKE '%.ru' AND cp.email_domain NOT LIKE '%.gov%' AND cp.email_domain NOT LIKE '%.mil%'
      AND cp.email_domain NOT REGEXP 'gov|\\\\.gc\\\\.ca|\\\\.gob\\\\.|\\\\.gouv|\\\\.mil|zendesk|freshdesk|helpscout'
      AND cp.email_domain NOT IN ('xyz.com','yourcompany.com','example.com','example.org','domain.com','yourdomain.com','company.com','test.com','email.com','website.com')
      AND SUBSTRING_INDEX(cp.value,'@',1) NOT REGEXP '^(abc|your\\\\.?name|your\\\\.?email|example|test|user|name|email|username|firstname|noreply|no-reply|donotreply|postmaster|privacy|rgpd|gdpr|dpo|legal|abuse|compliance|dmca|security|webmaster|hostmaster|spam)$'
      AND cp.value NOT LIKE '%example%' AND cp.value NOT LIKE '%yourname%'
      AND SUBSTRING_INDEX(cp.email_domain,'.',-1) IN ('com','uk','ca','au','ie','nz','de','nl','at','se','dk','ch','fi','be','pt','it','net')
      AND co.name IS NOT NULL AND co.name<>''
      AND SUBSTRING_INDEX(cp.value,'@',1) NOT REGEXP '^[0-9a-f]{16,}$'
      AND CHAR_LENGTH(SUBSTRING_INDEX(cp.value,'@',1)) BETWEEN 3 AND 24
      AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.email=cp.value)
      AND NOT EXISTS (SELECT 1 FROM global_contact_suppression g WHERE g.type='email' AND g.normalized_value=LOWER(cp.value))
      AND NOT EXISTS (SELECT 1 FROM global_contact_suppression g WHERE g.type='domain' AND g.normalized_value=LOWER(cp.email_domain))
      AND NOT EXISTS (SELECT 1 FROM outreach_touchpoints tp WHERE tp.email=cp.value)
    GROUP BY cp.email_domain
    ORDER BY cp.verification_score DESC, cp.id
    LIMIT ?`, [need * 4]);   // over-select; MX filter drops Google-hosted
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

  if (!(await healthOk())) { await redis.quit(); return; }

  const day = await redis.incr('warmup:daynum');       // day-1 already sent; first cron run = day 2 idx
  const target = RAMP[Math.min(day, RAMP.length - 1)];
  log(`day ${day + 1}, target ${target}`);

  const senders = await query(`SELECT id, from_email, from_name FROM sender_identities
    WHERE tenant_id=? AND status='active' AND from_email LIKE '%@emails.cheap'
      AND provider_id=(SELECT id FROM sending_providers WHERE provider_type='postal' AND tenant_id=? LIMIT 1)
    ORDER BY id`, [TENANT, TENANT]);
  if (!senders.length) { log('no Postal senders'); await redis.quit(); return; }
  const tpls = {}; for (const id of [20, 21, 22]) { const [t] = await query('SELECT subject, body FROM manual_outreach_templates WHERE id=?', [id]); tpls[id] = t; }

  const user = await resolveSecret('POSTAL_OUTREACH_SMTP_USER'), pass = await resolveSecret('POSTAL_OUTREACH_SMTP_PASSWORD');
  const tx = nodemailer.createTransport({ host: 'email_postal_smtp', port: 25, secure: false, auth: { user, pass }, tls: { rejectUnauthorized: false }, connectionTimeout: 15000, socketTimeout: 20000 });

  const cand = await candidates(target);
  let sent = 0, idx = 0, checked = 0;
  for (const c of cand) {
    if (sent >= target) break;
    checked++;
    if (!(await nonGoogle(c.domain))) continue;         // skip Google-hosted (won't deliver cold)
    const s = senders[idx % senders.length];
    const isAgency = /agenc|studio|creativ|design|web|digital|market|media/i.test(c.domain);
    const tplId = isAgency ? 21 : (idx % 2 ? 22 : 20);
    const t = tpls[tplId];
    const vars = { company: brand(c.domain), sender_name: `${s.from_name}, Clients.Help` };
    const subject = fill(spin(t.subject, idx), vars).trim();
    let body = fill(spin(t.body, idx), vars);
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
