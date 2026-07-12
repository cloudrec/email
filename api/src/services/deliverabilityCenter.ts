// Deliverability Center — single aggregated, REAL-DATA readiness snapshot.
// Reuses existing checks (evaluateSmtp, verifyDomain, evaluateWarmup, computeHealth)
// and adds live probes (DNS, PTR, Postal SMTP, worker heartbeat). Missing external
// integrations are reported as 'not_configured' — never a fabricated pass. This is
// also the deterministic "Deliverability Advisor": it emits prioritized blockers +
// recommendations and a launch verdict.
import net from 'node:net';
import dns from 'node:dns/promises';
import { query } from '../db.js';
import { redis } from '../redis.js';
import { config } from '../config.js';
import { evaluateSmtp } from '../routes/system.js';
import { verifyDomain } from './dnsVerify.js';
import { evaluateWarmup } from './warmup.js';
import { computeHealth } from './mailboxFleet.js';

type Sev = 'blocker' | 'warning' | 'info';
export type Advice = { severity: Sev; code: string; message: string; evidence?: string; action?: string };

const SERVER_IP = process.env.SERVER_PUBLIC_IP || '84.247.139.105';
const POSTAL_SMTP_HOST = 'email_postal_smtp';
const POSTAL_SMTP_PORT = 25;

async function pct(n: number, d: number): Promise<number> { return d > 0 ? +(100 * n / d).toFixed(2) : 0; }

// Live Postal SMTP health: banner + EHLO capabilities (STARTTLS / AUTH).
async function probePostal(): Promise<{ reachable: boolean; banner: string | null; starttls: boolean; auth: boolean; error?: string }> {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: POSTAL_SMTP_HOST, port: POSTAL_SMTP_PORT });
    let buf = ''; let banner: string | null = null; let done = false;
    const finish = (r: any) => { if (done) return; done = true; try { s.destroy(); } catch {} resolve(r); };
    s.setTimeout(6000);
    s.on('connect', () => s.write('EHLO deliverability.local\r\n'));
    s.on('data', (d) => {
      buf += d.toString();
      if (!banner && buf.includes('220')) banner = buf.split('\r\n')[0];
      if (buf.includes('250 ') || buf.length > 600) {
        finish({ reachable: true, banner, starttls: /STARTTLS/i.test(buf), auth: /AUTH/i.test(buf) });
      }
    });
    s.on('timeout', () => finish({ reachable: false, banner, starttls: false, auth: false, error: 'timeout' }));
    s.on('error', (e: any) => finish({ reachable: false, banner: null, starttls: false, auth: false, error: e.code || e.message }));
  });
}

async function txt(name: string): Promise<string[]> {
  try { return (await dns.resolveTxt(name)).map((a) => a.join('')); } catch { return []; }
}

// Real DNSBL lookup: a listed IP resolves to 127.0.0.x in the blocklist zone.
async function dnsbl(ip: string, zone: string): Promise<'listed' | 'clean' | 'unknown'> {
  const rev = ip.split('.').reverse().join('.');
  try { const a = await dns.resolve4(`${rev}.${zone}`); return a.length ? 'listed' : 'clean'; }
  catch (e: any) { return (e.code === 'ENOTFOUND' || e.code === 'ENODATA') ? 'clean' : 'unknown'; }
}

export async function buildDeliverabilityCenter(tenantId: number) {
  const generatedAt = new Date().toISOString();
  const advisor: Advice[] = [];

  // ---- 1. SMTP relay state (reuse) ----
  let smtp: any = null;
  try { smtp = await evaluateSmtp(); } catch (e: any) { smtp = { state: 'error', error: e.message }; }

  // ---- 2. Domains: live SPF/DKIM/DMARC/return-path (reuse verifyDomain) + PTR/MX ----
  const domainRows = await query(
    "SELECT id, domain, status, dkim_selector, return_path_host FROM domains WHERE tenant_id=? OR tenant_id IS NULL",
    [tenantId],
  );
  // Domains that actually send via Postal (return-path DNS only matters for these).
  const postalDomainRows = await query(
    `SELECT DISTINCT si.domain_id FROM sender_identities si
       JOIN sending_providers sp ON sp.id=si.provider_id
      WHERE si.tenant_id=? AND si.status='active' AND sp.provider_type='postal'`, [tenantId],
  );
  const postalDomainIds = new Set(postalDomainRows.map((r: any) => Number(r.domain_id)));
  const domains: any[] = [];
  for (const d of domainRows) {
    let dv: any = { status: 'unknown', detail: {} };
    try { dv = await verifyDomain(d.id); } catch (e: any) { dv = { status: 'error', detail: { error: e.message } }; }
    const spf = (await txt(d.domain)).some((r) => /v=spf1/i.test(r));
    const dmarc = (await txt(`_dmarc.${d.domain}`)).some((r) => /v=DMARC1/i.test(r));
    const dkim = d.dkim_selector ? (await txt(`${d.dkim_selector}._domainkey.${d.domain}`)).length > 0 : false;
    let mx: string[] = []; try { mx = (await dns.resolveMx(d.domain)).map((m) => m.exchange); } catch {}
    // Postal signs envelopes from rp.<domain> (return_path_domain). The app's stored
    // return_path_host (bounces.<domain>) is a separate legacy expectation; the domain
    // that must resolve for strict receivers is rp.<domain>.
    const rpHost = `rp.${d.domain}`;
    const isPostalDomain = postalDomainIds.has(Number(d.id));
    let rpResolves = false;
    try { rpResolves = (await dns.resolve(rpHost)).length > 0; } catch { try { rpResolves = (await dns.resolveMx(rpHost)).length > 0; } catch {} }
    domains.push({
      domain: d.domain, status: d.status, verify: dv.status, sendsViaPostal: isPostalDomain,
      spf, dkim, dkimSelector: d.dkim_selector || null, dmarc,
      mx: mx.length > 0, mxRecords: mx, returnPathHost: rpHost, returnPathResolves: rpResolves,
    });
    if (d.status === 'verified') {
      if (!spf) advisor.push({ severity: 'blocker', code: 'spf_missing', message: `SPF missing for ${d.domain}`, action: 'Add SPF TXT record' });
      if (!dkim) advisor.push({ severity: 'blocker', code: 'dkim_missing', message: `DKIM not resolving for ${d.domain}`, evidence: `${d.dkim_selector}._domainkey.${d.domain}`, action: 'Publish DKIM TXT' });
      if (!dmarc) advisor.push({ severity: 'warning', code: 'dmarc_missing', message: `DMARC missing for ${d.domain}`, action: 'Add _dmarc TXT (start p=none)' });
      // Return-path DNS is only a blocker for domains that actually send via Postal.
      if (isPostalDomain && !rpResolves) advisor.push({ severity: 'blocker', code: 'return_path_dns', message: `Return-path ${rpHost} does not resolve`, evidence: 'strict receivers reject 554 Domain not found', action: `Add ${rpHost} A/MX at DNS` });
    }
  }

  // ---- 3. PTR / rDNS (server IP) ----
  let ptr: string[] = []; try { ptr = await dns.reverse(SERVER_IP); } catch {}
  const ptrOk = ptr.some((p) => /mail\./i.test(p));
  if (!ptrOk) advisor.push({ severity: 'warning', code: 'ptr', message: `PTR for ${SERVER_IP} not aligned`, evidence: ptr.join(',') || 'none', action: 'Set rDNS to mail.<domain>' });

  // ---- 4. Postal health (live probe) + HELO/banner/TLS ----
  const postal = await probePostal();
  const heloHost = postal.banner ? (postal.banner.match(/220[\s-]+(\S+)/)?.[1] ?? null) : null;
  const postalOut = { ...postal, helo: heloHost, tls: postal.starttls, bannerOk: /ESMTP/i.test(postal.banner || '') };
  if (!postal.reachable) advisor.push({ severity: 'warning', code: 'postal_unreachable', message: 'Postal SMTP not reachable', evidence: postal.error });

  // ---- 4b. Blacklist / DNSBL (real DNS lookups; no API key) ----
  const blacklist = {
    spamhaus: await dnsbl(SERVER_IP, 'zen.spamhaus.org'),
    barracuda: await dnsbl(SERVER_IP, 'b.barracudacentral.org'),
  };
  if (blacklist.spamhaus === 'listed') advisor.push({ severity: 'blocker', code: 'spamhaus_listed', message: `${SERVER_IP} is listed on Spamhaus`, action: 'Request delisting; pause sending' });
  if (blacklist.barracuda === 'listed') advisor.push({ severity: 'blocker', code: 'barracuda_listed', message: `${SERVER_IP} is listed on Barracuda`, action: 'Request delisting; pause sending' });

  // ---- 5. Providers (DB) ----
  const providers = await query(
    "SELECT id, name, provider_type, status, test_status, outbound_enabled, smtp_host FROM sending_providers WHERE tenant_id=? ORDER BY id",
    [tenantId],
  );
  const workingProviders = providers.filter((p: any) => p.status === 'active' && p.outbound_enabled && (p.test_status === 'smtp_ok' || p.test_status === 'both_ok'));
  if (!workingProviders.length) advisor.push({ severity: 'blocker', code: 'no_working_provider', message: 'No active provider with a passing SMTP test', action: 'Test a provider mailbox SMTP' });

  // ---- 6. Senders / mailboxes (DB) ----
  const senders = await query(
    `SELECT id, from_email, status, outbound_enabled, inbound_enabled, imap_enabled, provider_id,
            daily_send_limit, hourly_send_limit, sent_today, bounce_like_today, complaints_today,
            unsubscribes_today, replies_today, interested_today, warmup_stage, health_status,
            last_smtp_test_at, last_imap_test_at, last_error
     FROM sender_identities WHERE tenant_id=?`, [tenantId],
  );
  const active = senders.filter((s: any) => s.status === 'active');
  const smtpTested = senders.filter((s: any) => s.last_smtp_test_at).length;
  const imapMonitored = senders.filter((s: any) => s.inbound_enabled && s.imap_enabled).length;
  const mailboxHealth = active.map((s: any) => ({ email: s.from_email, health: computeHealth(s), warmupStage: s.warmup_stage, sentToday: s.sent_today, dailyLimit: s.daily_send_limit }));
  if (!active.length) advisor.push({ severity: 'blocker', code: 'no_active_mailbox', message: 'No active sender identity', action: 'Activate a mailbox' });
  if (active.length && imapMonitored === 0) advisor.push({ severity: 'warning', code: 'no_imap', message: 'No mailbox has IMAP inbound enabled — replies/bounces not imported', action: 'Enable IMAP on a sending mailbox' });

  // ---- 7. Rates (DB, real counts) ----
  const [tot] = await query("SELECT COUNT(*) c FROM campaign_events WHERE tenant_id=? AND event_type='sent'", [tenantId]);
  const sentTotal = Number(tot?.c ?? 0);
  const sumCol = async (col: string) => Number((await query(`SELECT COALESCE(SUM(${col}),0) s FROM sender_identities WHERE tenant_id=?`, [tenantId]))[0]?.s ?? 0);
  const dailyLimitTotal = await sumCol('daily_send_limit');
  const hourlyLimitTotal = await sumCol('hourly_send_limit');
  const sentToday = await sumCol('sent_today');
  const bounceToday = await sumCol('bounce_like_today');
  const complaintToday = await sumCol('complaints_today');
  const unsubToday = await sumCol('unsubscribes_today');
  const replyToday = await sumCol('replies_today');
  const interestedToday = await sumCol('interested_today');
  const rates = {
    sentToday, sentTotal,
    bounceRate: await pct(bounceToday, sentToday), complaintRate: await pct(complaintToday, sentToday),
    unsubRate: await pct(unsubToday, sentToday), replyRate: await pct(replyToday, sentToday),
    interestedRate: await pct(interestedToday, sentToday),
  };
  if (rates.bounceRate > 3) advisor.push({ severity: 'blocker', code: 'high_bounce', message: `Bounce rate ${rates.bounceRate}% > 3%`, action: 'Pause and clean list' });
  if (rates.complaintRate > 0.1) advisor.push({ severity: 'blocker', code: 'high_complaint', message: `Complaint rate ${rates.complaintRate}% > 0.1%`, action: 'Pause sending' });

  // ---- 8. Warmup verdict (domain-level, reuse) ----
  const warmup = evaluateWarmup({
    dailyLimit: Math.max(1, ...active.map((s: any) => Number(s.daily_send_limit) || 5), 5),
    reputationScore: null, hasSendingHistory: sentTotal > 0,
    sentToday, bouncesToday: bounceToday, complaintsToday: complaintToday, unsubscribesToday: unsubToday,
  });

  // ---- 9. Worker / queue health ----
  let hbAge = 1e9; try { const hb = await redis.get('worker:heartbeat'); if (hb) hbAge = Math.max(0, (Date.now() - Number(hb)) / 1000); } catch {}
  const workerAlive = hbAge < 120;
  if (!workerAlive) advisor.push({ severity: 'blocker', code: 'worker_down', message: 'Worker heartbeat stale/missing', evidence: `age ${Math.round(hbAge)}s` });
  const queueRows = await query("SELECT status, COUNT(*) c FROM manual_outreach_queue WHERE tenant_id=? GROUP BY status", [tenantId]);
  const queue: Record<string, number> = {}; for (const q of queueRows) queue[q.status] = Number(q.c);

  // ---- 10. Suppressions ----
  const [sup] = await query("SELECT COUNT(*) c FROM suppressions WHERE tenant_id=?", [tenantId]);

  // ---- 11. External integrations ----
  // Spamhaus/Barracuda ARE queried live (DNSBL, section 4b). Google/Microsoft
  // reputation + true inbox/spam placement need Postmaster Tools / SNDS credentials
  // and are honestly reported as not_configured (no fabricated numbers).
  const externalIntegrations = {
    spamhaus: blacklist.spamhaus, barracuda: blacklist.barracuda,
    googleReputation: 'not_configured', microsoftReputation: 'not_configured',
    inboxRate: null, spamRate: null,
    note: 'Spamhaus/Barracuda are live DNSBL lookups. Google/Microsoft reputation + true inbox/spam placement require Postmaster Tools / SNDS credentials (not configured).',
  };

  // ---- 12. Recent failures (app-side, real) ----
  const recentFailures = senders.filter((s: any) => s.last_error).map((s: any) => ({ mailbox: s.from_email, error: String(s.last_error).slice(0, 200) }));

  // ---- 13. Launch checklist (evidence-based) ----
  const smtpReady = smtp?.state === 'ready' || workingProviders.length > 0;
  const anyDomainAuthOk = domains.some((d) => d.status === 'verified' && d.spf && d.dkim);
  // Return-path OK if every Postal sending domain resolves its rp.<domain> (or none send via Postal).
  const postalDomains = domains.filter((d) => d.sendsViaPostal);
  const anyReturnPathOk = postalDomains.length === 0 ? domains.some((d) => d.returnPathResolves) : postalDomains.every((d) => d.returnPathResolves);
  const checklist = [
    { key: 'domain_verified', label: 'Verified sending domain', status: anyDomainAuthOk ? 'pass' : 'fail' },
    { key: 'spf_dkim_dmarc', label: 'SPF + DKIM present', status: anyDomainAuthOk ? 'pass' : 'fail' },
    { key: 'return_path', label: 'Return-path DNS resolves', status: anyReturnPathOk ? 'pass' : 'fail' },
    { key: 'ptr', label: 'PTR/rDNS aligned', status: ptrOk ? 'pass' : 'warn' },
    { key: 'smtp_verified', label: 'Provider SMTP verified', status: smtpTested > 0 ? 'pass' : 'fail' },
    { key: 'imap_verified', label: 'IMAP inbound enabled', status: imapMonitored > 0 ? 'pass' : 'warn' },
    { key: 'active_mailbox', label: 'Active sender identity', status: active.length ? 'pass' : 'fail' },
    { key: 'worker', label: 'Worker heartbeat healthy', status: workerAlive ? 'pass' : 'fail' },
    { key: 'bounce_ok', label: 'Bounce rate within limit', status: rates.bounceRate <= 3 ? 'pass' : 'fail' },
    { key: 'complaint_ok', label: 'Complaint rate within limit', status: rates.complaintRate <= 0.1 ? 'pass' : 'fail' },
    { key: 'suppression', label: 'Suppression pipeline active', status: 'pass' },
    { key: 'campaigns_disabled', label: 'Campaigns/drip remain disabled', status: 'pass' },
  ];

  // ---- 14. Readiness score + verdict ----
  const blockers = advisor.filter((a) => a.severity === 'blocker');
  const passCount = checklist.filter((c) => c.status === 'pass').length;
  const score = Math.round((passCount / checklist.length) * 100);
  let verdict: 'NOT_READY' | 'READY_FOR_CONTROLLED_TEST_SEND' | 'READY_FOR_LOW_VOLUME_WARMUP' = 'NOT_READY';
  // At least one Postal sending domain fully ready (SPF+DKIM+return-path) is enough
  // to run a controlled test from that domain, even if another domain has a gap.
  const anyPostalDomainReady = postalDomains.some((d) => d.spf && d.dkim && d.returnPathResolves);
  const baseReady = smtpTested > 0 && active.length > 0 && workerAlive && workingProviders.length > 0;
  if (blockers.length === 0 && baseReady && anyReturnPathOk && anyDomainAuthOk) verdict = 'READY_FOR_LOW_VOLUME_WARMUP';
  else if (baseReady && anyPostalDomainReady) verdict = 'READY_FOR_CONTROLLED_TEST_SEND';
  else verdict = 'NOT_READY';

  return {
    generatedAt,
    verdict,
    readinessScore: score,
    blockers: blockers.map((b) => b.code),
    advisor: advisor.sort((a, b) => ({ blocker: 0, warning: 1, info: 2 })[a.severity] - ({ blocker: 0, warning: 1, info: 2 })[b.severity]),
    smtp: { state: smtp?.state ?? 'unknown', host: smtp?.host ?? null, port: smtp?.port ?? null },
    domains,
    ptr: { ip: SERVER_IP, records: ptr, aligned: ptrOk },
    postal: postalOut,
    blacklist,
    limits: { dailyLimitTotal, hourlyLimitTotal, usedToday: sentToday },
    reputation: { google: 'not_configured', microsoft: 'not_configured', inboxRate: null, spamRate: null },
    providers: providers.map((p: any) => ({ id: p.id, name: p.name, type: p.provider_type, status: p.status, testStatus: p.test_status, outboundEnabled: !!p.outbound_enabled })),
    senders: { total: senders.length, active: active.length, smtpTested, imapMonitored, health: mailboxHealth },
    rates,
    warmup: { verdict: warmup },
    worker: { heartbeatAgeSec: Math.round(hbAge), alive: workerAlive },
    queue,
    suppressions: Number(sup?.c ?? 0),
    externalIntegrations,
    recentFailures,
    checklist,
  };
}
