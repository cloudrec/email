// Phase 22F — Self-Hosted SMTP Node Readiness Manager.
// Local, deterministic readiness/risk/DNS engine for FUTURE dedicated self-hosted
// SMTP nodes. This module NEVER installs an MTA, NEVER opens a port, NEVER changes
// DNS, and NEVER sends email. Port 25 is probed read-only (short TCP connect, no
// data written). The engine's whole job is to answer "is this node safe/ready?"
// and to BLOCK sending by default until every critical check passes.
import dns from 'node:dns/promises';
import net from 'node:net';
import os from 'node:os';

// ── Production-IP guard ──────────────────────────────────────────────────────
// A self-hosted cold-outreach node must NEVER reuse the production app server IP.
// We collect every IP this host owns (non-internal interfaces) plus an optional
// env-declared public IP, and treat a node IP match as a critical blocker.
// Known stable public IP(s) of THIS production host. The API runs inside Docker
// and only sees container-internal interfaces (172.x), and the public domain is
// behind a CDN, so neither os.networkInterfaces() nor DNS reveals the origin IP.
// This hard fallback guarantees the production-IP guard fires. Override via env
// SERVER_PUBLIC_IP without touching .env on disk.
const KNOWN_PRODUCTION_IPS = ['84.247.139.105'];

export function productionIps(): string[] {
  const ips = new Set<string>(KNOWN_PRODUCTION_IPS);
  const declared = process.env.SERVER_PUBLIC_IP || process.env.PLATFORM_SERVER_IP;
  if (declared) declared.split(',').forEach((s) => ips.add(s.trim()));
  try {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const i of ifaces[name] || []) {
        if (!i.internal && i.address) ips.add(i.address);
      }
    }
  } catch { /* read-only best effort */ }
  return [...ips].filter(Boolean);
}

export type Check = {
  key: string;
  label: string;
  status: 'pass' | 'fail' | 'warning' | 'unknown' | 'unchecked';
  critical: boolean;
  detail: string;
};

export interface ReadinessInput {
  hostname?: string | null;
  ipv4?: string | null;
  ipv6?: string | null;
  sending_domain?: string | null;
  ptr_expected?: string | null;
  dkim_selector?: string | null;
  purpose?: 'cold_outreach' | 'transactional' | 'internal_test';
  isolation_status?: string | null;
  abuse_mailbox_status?: string | null;
  postmaster_mailbox_status?: string | null;
  bounce_mailbox_status?: string | null;
  blacklist_status?: string | null;
  spamhaus_status?: string | null;
  barracuda_status?: string | null;
  microsoft_snds_status?: string | null;
  google_postmaster_status?: string | null;
  probePort25?: boolean;       // opt-in read-only TCP connect test
}

export interface ReadinessResult {
  checks: Check[];
  blockers: string[];
  warnings: string[];
  readiness_score: number;
  readiness_level:
    | 'not_ready' | 'needs_dns' | 'needs_reputation_check'
    | 'ready_for_lab' | 'ready_for_tiny_test' | 'blocked';
  status: 'draft' | 'checking' | 'ready' | 'warning' | 'blocked';
  risk_level: 'low' | 'medium' | 'high' | 'blocked';
  safe_to_connect_as_provider: boolean;
  safe_to_send: boolean;        // default false unless ALL critical checks pass
  next_action: string;
  // Persisted column shorthands
  ptr_status: 'unchecked' | 'pass' | 'fail' | 'mismatch';
  ptr_detected: string | null;
  forward_dns_status: 'unchecked' | 'pass' | 'fail' | 'mismatch' | 'unknown';
  spf_status: string; dkim_status: string; dmarc_status: string; mx_status: string;
  tls_status: 'unchecked' | 'pass' | 'fail' | 'unknown';
  port25_status: 'unchecked' | 'blocked' | 'open' | 'unknown';
  isolation_status: string;
}

// ── Low-level read-only DNS helpers (never throw) ────────────────────────────
async function txt(host: string): Promise<string[]> {
  try { return (await dns.resolveTxt(host)).map((p) => p.join('')); } catch { return []; }
}
async function resolve4(host: string): Promise<string[]> {
  try { return await dns.resolve4(host); } catch { return []; }
}
async function reverse(ip: string): Promise<string[]> {
  try { return await dns.reverse(ip); } catch { return []; }
}

// Read-only TCP connect probe (does NOT send any SMTP data). Short timeout.
async function probeTcp(host: string, port: number, timeoutMs = 4000): Promise<'open' | 'blocked' | 'unknown'> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (v: 'open' | 'blocked' | 'unknown') => { if (!done) { done = true; try { sock.destroy(); } catch {} resolve(v); } };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish('open'));
    sock.once('timeout', () => finish('blocked'));
    sock.once('error', () => finish('blocked'));
    try { sock.connect(port, host); } catch { finish('unknown'); }
  });
}

function norm(s?: string | null): string { return (s ?? '').trim().toLowerCase().replace(/\.$/, ''); }

// ── The deterministic readiness engine ───────────────────────────────────────
export async function runReadiness(input: ReadinessInput): Promise<ReadinessResult> {
  const checks: Check[] = [];
  const blockers: string[] = [];
  const warnings: string[] = [];
  const push = (c: Check) => { checks.push(c); };

  const host = norm(input.hostname);
  const ip = (input.ipv4 ?? '').trim();
  const domain = norm(input.sending_domain);
  const ptrExpected = norm(input.ptr_expected);
  const purpose = input.purpose ?? 'internal_test';

  // 1. Required fields ---------------------------------------------------------
  const missing: string[] = [];
  if (!host) missing.push('hostname');
  if (!ip) missing.push('IP');
  if (!domain) missing.push('sending domain');
  if (!ptrExpected) missing.push('expected PTR');
  push({
    key: 'required_fields', label: 'Required fields present', critical: true,
    status: missing.length ? 'fail' : 'pass',
    detail: missing.length ? `Missing: ${missing.join(', ')}` : 'hostname, IP, sending domain, expected PTR all present',
  });
  if (missing.length) blockers.push(`Missing required fields: ${missing.join(', ')}`);

  // 12. Isolation (production-IP guard) — evaluated early, hardest blocker ------
  const prodIps = productionIps();
  const isProdIp = !!ip && prodIps.includes(ip);
  let isolation_status = (input.isolation_status as string) || 'unknown';
  if (isProdIp) isolation_status = 'shared_with_production';
  const isolationUnsafe = isProdIp || ['shared_with_production', 'shared_with_app_server', 'unsafe'].includes(isolation_status);
  push({
    key: 'isolation', label: 'Node isolated from production', critical: true,
    status: isProdIp ? 'fail' : isolationUnsafe ? 'fail' : isolation_status === 'dedicated' ? 'pass' : 'warning',
    detail: isProdIp
      ? `Node IP ${ip} is THIS production app server IP — never send cold outreach from the production IP.`
      : isolationUnsafe ? `Isolation marked "${isolation_status}" — unsafe for cold outreach.`
      : isolation_status === 'dedicated' ? 'Dedicated IP, isolated from production.' : 'Isolation unknown — confirm a dedicated IP.',
  });
  if (isProdIp) blockers.push('Node IP equals the production app server IP — BLOCKED.');
  else if (isolationUnsafe && purpose === 'cold_outreach') blockers.push('Cold outreach requires a dedicated, isolated IP.');
  else if (isolation_status === 'unknown') warnings.push('Isolation unknown — confirm the node uses a dedicated IP.');

  // 3. Forward DNS: hostname → IP ----------------------------------------------
  let forward_dns_status: ReadinessResult['forward_dns_status'] = 'unchecked';
  if (host && ip) {
    const a = await resolve4(host);
    if (!a.length) { forward_dns_status = 'fail'; }
    else if (a.includes(ip)) { forward_dns_status = 'pass'; }
    else { forward_dns_status = 'mismatch'; }
    push({
      key: 'forward_dns', label: 'Forward DNS (A record) resolves to node IP', critical: false,
      status: forward_dns_status === 'pass' ? 'pass' : forward_dns_status === 'mismatch' ? 'warning' : 'fail',
      detail: a.length ? `${host} → ${a.join(', ')} (expected ${ip})` : `${host} has no A record`,
    });
    if (forward_dns_status !== 'pass') warnings.push(`Forward DNS for ${host} does not match ${ip}.`);
  } else {
    push({ key: 'forward_dns', label: 'Forward DNS (A record) resolves to node IP', critical: false, status: 'unchecked', detail: 'hostname or IP missing' });
  }

  // 2. PTR / rDNS --------------------------------------------------------------
  let ptr_status: ReadinessResult['ptr_status'] = 'unchecked';
  let ptr_detected: string | null = null;
  if (ip) {
    const ptrs = await reverse(ip);
    ptr_detected = ptrs[0] ?? null;
    if (!ptrs.length) ptr_status = 'fail';
    else if (ptrExpected && ptrs.map(norm).includes(ptrExpected)) ptr_status = 'pass';
    else if (ptrExpected) ptr_status = 'mismatch';
    else ptr_status = ptrs.length ? 'pass' : 'fail';
    push({
      key: 'ptr', label: 'PTR / reverse DNS matches expected hostname', critical: true,
      status: ptr_status === 'pass' ? 'pass' : ptr_status === 'mismatch' ? 'fail' : 'fail',
      detail: ptrs.length ? `IP ${ip} → ${ptrs.join(', ')} (expected ${ptrExpected || 'n/a'})` : `IP ${ip} has NO PTR record`,
    });
    if (ptr_status === 'fail') blockers.push(`No PTR for ${ip} — ask the VPS provider to set reverse DNS.`);
    else if (ptr_status === 'mismatch') blockers.push(`PTR for ${ip} does not match expected hostname.`);
  } else {
    push({ key: 'ptr', label: 'PTR / reverse DNS matches expected hostname', critical: true, status: 'unchecked', detail: 'IP missing' });
  }

  // 4. SPF ---------------------------------------------------------------------
  let spf_status = 'unchecked';
  if (domain) {
    const records = (await txt(domain)).filter((r) => /^v=spf1/i.test(r));
    if (!records.length) { spf_status = 'fail'; blockers.push(`No SPF record on ${domain}.`); }
    else {
      const joined = records.join(' ');
      const mentionsIp = !!ip && joined.includes(ip);
      const hasIncludeOrA = /include:|a[:\s]|mx[:\s]|ip4:|ip6:/i.test(joined);
      spf_status = mentionsIp ? 'pass' : hasIncludeOrA ? 'warning' : 'warning';
      if (!mentionsIp) warnings.push(`SPF on ${domain} does not list node IP ${ip} (add ip4:${ip} or an include).`);
    }
    push({ key: 'spf', label: 'SPF present and authorises node IP', critical: true,
      status: spf_status as Check['status'],
      detail: records.length ? records.join(' | ') : `No v=spf1 record on ${domain}` });
  } else push({ key: 'spf', label: 'SPF present and authorises node IP', critical: true, status: 'unchecked', detail: 'sending domain missing' });

  // 5. DKIM --------------------------------------------------------------------
  let dkim_status = 'unchecked';
  if (domain && input.dkim_selector) {
    const sel = input.dkim_selector.trim();
    const rec = await txt(`${sel}._domainkey.${domain}`);
    const ok = rec.some((r) => /v=DKIM1/i.test(r) || /p=/.test(r));
    dkim_status = ok ? 'pass' : 'fail';
    if (!ok) blockers.push(`DKIM selector ${sel}._domainkey.${domain} has no TXT record.`);
    push({ key: 'dkim', label: 'DKIM selector TXT present', critical: true, status: dkim_status as Check['status'],
      detail: rec.length ? rec.join(' | ') : `No TXT at ${sel}._domainkey.${domain}` });
  } else {
    dkim_status = 'warning';
    warnings.push('DKIM selector not configured — set one before sending.');
    push({ key: 'dkim', label: 'DKIM selector TXT present', critical: true, status: 'warning',
      detail: 'DKIM selector not configured' });
    if (domain) blockers.push('DKIM not configured (no selector).');
  }

  // 6. DMARC -------------------------------------------------------------------
  let dmarc_status = 'unchecked';
  if (domain) {
    const rec = (await txt(`_dmarc.${domain}`)).filter((r) => /^v=DMARC1/i.test(r));
    if (!rec.length) { dmarc_status = 'fail'; blockers.push(`No DMARC record on _dmarc.${domain}.`); }
    else { dmarc_status = 'pass'; if (/p=none/i.test(rec.join(' '))) warnings.push('DMARC p=none — acceptable for warmup, tighten later.'); }
    push({ key: 'dmarc', label: 'DMARC present', critical: true, status: dmarc_status as Check['status'],
      detail: rec.length ? rec.join(' | ') : `No DMARC on _dmarc.${domain}` });
  } else push({ key: 'dmarc', label: 'DMARC present', critical: true, status: 'unchecked', detail: 'sending domain missing' });

  // 7. MX ----------------------------------------------------------------------
  let mx_status = 'unchecked';
  if (domain) {
    let mx: any[] = [];
    try { mx = await dns.resolveMx(domain); } catch { mx = []; }
    mx_status = mx.length ? 'pass' : 'warning';
    if (!mx.length) warnings.push(`No MX on ${domain} — needed to receive replies/bounces.`);
    push({ key: 'mx', label: 'MX present (replies/bounces)', critical: false, status: mx_status as Check['status'],
      detail: mx.length ? mx.map((m) => `${m.priority} ${m.exchange}`).join(', ') : `No MX on ${domain}` });
  } else push({ key: 'mx', label: 'MX present (replies/bounces)', critical: false, status: 'unchecked', detail: 'sending domain missing' });

  // 9. Port 25 (read-only TCP connect only, opt-in) ----------------------------
  let port25_status: ReadinessResult['port25_status'] = 'unchecked';
  let tls_status: ReadinessResult['tls_status'] = 'unknown';
  if (input.probePort25 && ip) {
    port25_status = await probeTcp(ip, 25);
    push({ key: 'port25', label: 'Port 25 reachability (read-only probe)', critical: false,
      status: port25_status === 'open' ? 'pass' : port25_status === 'blocked' ? 'warning' : 'unknown',
      detail: port25_status === 'open' ? 'TCP 25 reachable from this host (no data sent)'
        : port25_status === 'blocked' ? 'TCP 25 not reachable from this host (provider may block 25)' : 'unknown' });
    // 8. TLS — only marked unknown; we do not perform STARTTLS handshakes here.
    push({ key: 'tls', label: 'STARTTLS expected', critical: false, status: 'unknown',
      detail: 'TLS not actively probed (no SMTP handshake performed) — confirm STARTTLS on the node.' });
    if (purpose === 'cold_outreach' && port25_status === 'blocked') warnings.push('Port 25 not reachable — direct delivery would fail; use a smarthost/relay or unblock 25.');
  } else {
    push({ key: 'port25', label: 'Port 25 reachability (read-only probe)', critical: false, status: 'unchecked', detail: 'probe not requested' });
    push({ key: 'tls', label: 'STARTTLS expected', critical: false, status: 'unknown', detail: 'TLS not probed' });
  }

  // 10. Abuse / postmaster (metadata only) -------------------------------------
  const mailboxCheck = (key: string, label: string, val?: string | null) => {
    const v = val ?? 'unchecked';
    const ok = v === 'configured' || v === 'planned';
    push({ key, label, critical: key === 'bounce', status: ok ? (v === 'configured' ? 'pass' : 'warning') : v === 'missing' ? 'fail' : 'unchecked',
      detail: `Status: ${v} (metadata only — no test email sent)` });
    return v;
  };
  mailboxCheck('abuse', 'abuse@ mailbox planned/configured', input.abuse_mailbox_status);
  mailboxCheck('postmaster', 'postmaster@ mailbox planned/configured', input.postmaster_mailbox_status);
  const bounceV = mailboxCheck('bounce', 'Bounce mailbox configured', input.bounce_mailbox_status);
  if (!(input.abuse_mailbox_status === 'configured' || input.abuse_mailbox_status === 'planned'))
    warnings.push('abuse@ mailbox not planned — create abuse@<domain>.');
  if (!(input.postmaster_mailbox_status === 'configured' || input.postmaster_mailbox_status === 'planned'))
    warnings.push('postmaster@ mailbox not planned — create postmaster@<domain>.');
  if (!(bounceV === 'configured' || bounceV === 'planned')) blockers.push('No bounce handling configured.');

  // 13. Blacklist / reputation -------------------------------------------------
  const manualListed = [input.spamhaus_status, input.barracuda_status, input.microsoft_snds_status, input.google_postmaster_status]
    .some((s) => s === 'listed');
  const bl = manualListed ? 'listed' : (input.blacklist_status as string) || 'unchecked';
  push({ key: 'blacklist', label: 'Blacklist / reputation (manual checklist)', critical: false,
    status: bl === 'clean' ? 'pass' : bl === 'listed' ? 'fail' : 'unknown',
    detail: bl === 'listed' ? 'Listed on at least one manual blacklist check'
      : bl === 'clean' ? 'Operator marked clean' : 'Unknown — record manual Spamhaus/Barracuda/SNDS/Postmaster results' });
  if (bl === 'listed') blockers.push('Node IP/domain is listed on a blacklist.');
  else if (bl !== 'clean') warnings.push('Blacklist status unknown — record manual reputation checks.');

  // ── Scoring ────────────────────────────────────────────────────────────────
  // Weighted critical checks. safe_to_send requires ZERO critical failures.
  const WEIGHTS: Record<string, number> = {
    required_fields: 10, isolation: 15, ptr: 15, spf: 12, dkim: 12, dmarc: 12,
    bounce: 8, forward_dns: 4, mx: 4, blacklist: 4, port25: 2, abuse: 1, postmaster: 1,
  };
  let score = 0, max = 0;
  for (const c of checks) {
    const w = WEIGHTS[c.key] ?? 0;
    if (!w) continue;
    max += w;
    if (c.status === 'pass') score += w;
    else if (c.status === 'warning' || c.status === 'unknown') score += Math.round(w * 0.4);
    else if (c.status === 'unchecked') score += 0;
  }
  const readiness_score = max ? Math.round((score / max) * 100) : 0;

  const criticalFails = checks.filter((c) => c.critical && (c.status === 'fail'));
  const criticalUnresolved = checks.filter((c) => c.critical && (c.status === 'fail' || c.status === 'unchecked'));
  const hasBlocker = blockers.length > 0 || criticalFails.length > 0;

  // Risk policy
  let risk_level: ReadinessResult['risk_level'] = 'blocked';
  if (!hasBlocker) {
    if (warnings.length === 0) risk_level = 'low';
    else if (warnings.length <= 2) risk_level = 'medium';
    else risk_level = 'high';
  }

  const safe_to_send = !hasBlocker && criticalUnresolved.length === 0 && risk_level !== 'blocked';
  const safe_to_connect_as_provider = !isProdIp && !missing.length && ptr_status !== 'fail';

  // Readiness level
  let readiness_level: ReadinessResult['readiness_level'];
  if (hasBlocker) readiness_level = isProdIp || isolationUnsafe ? 'blocked' : 'not_ready';
  else if (criticalUnresolved.length) readiness_level = 'needs_dns';
  else if (bl !== 'clean') readiness_level = 'needs_reputation_check';
  else if (warnings.length) readiness_level = 'ready_for_lab';
  else readiness_level = 'ready_for_tiny_test';

  // DB status column
  let status: ReadinessResult['status'];
  if (isProdIp || isolationUnsafe && purpose === 'cold_outreach') status = 'blocked';
  else if (hasBlocker) status = 'blocked';
  else if (warnings.length) status = 'warning';
  else status = 'ready';

  // Next recommended fix (single, deterministic)
  const next_action = (() => {
    if (isProdIp) return 'Use a SEPARATE dedicated VPS/IP — the production app server IP must never send cold outreach.';
    if (missing.length) return `Fill required fields: ${missing.join(', ')}.`;
    if (ptr_status === 'fail') return `Ask your VPS provider to set reverse DNS (PTR) for ${ip} to ${ptrExpected || host}.`;
    if (ptr_status === 'mismatch') return `Fix PTR for ${ip} to match ${ptrExpected || host}.`;
    if (spf_status === 'fail') return `Add an SPF TXT record on ${domain}: v=spf1 ip4:${ip} -all`;
    if (dkim_status === 'fail' || dkim_status === 'warning') return `Configure DKIM: publish <selector>._domainkey.${domain} TXT.`;
    if (dmarc_status === 'fail') return `Add DMARC: _dmarc.${domain} TXT v=DMARC1; p=none; rua=mailto:dmarc@${domain}`;
    if (!(bounceV === 'configured' || bounceV === 'planned')) return 'Configure a bounce mailbox / return-path before sending.';
    if (bl !== 'clean') return 'Run manual blacklist checks (Spamhaus, Barracuda, MS SNDS, Google Postmaster) and record results.';
    if (warnings.length) return `Resolve warnings: ${warnings[0]}`;
    return 'All critical checks pass. Start with a tiny test at 5/day after a manual final review.';
  })();

  return {
    checks, blockers, warnings, readiness_score, readiness_level, status, risk_level,
    safe_to_connect_as_provider, safe_to_send, next_action,
    ptr_status, ptr_detected, forward_dns_status,
    spf_status, dkim_status, dmarc_status, mx_status, tls_status, port25_status, isolation_status,
  };
}

// ── DNS checklist generator (instructions only — NEVER changes DNS) ──────────
export function dnsChecklist(input: {
  sending_domain?: string | null; hostname?: string | null; ipv4?: string | null;
  ptr_expected?: string | null; dkim_selector?: string | null;
}): Array<{ key: string; title: string; type: string; host: string; value: string; note: string }> {
  const domain = (input.sending_domain ?? 'your-domain.tld').trim();
  const host = (input.hostname ?? `mail.${domain}`).trim();
  const ip = (input.ipv4 ?? '<NODE_IP>').trim();
  const ptr = (input.ptr_expected ?? host).trim();
  const sel = (input.dkim_selector ?? 'default').trim();
  return [
    { key: 'a', title: 'A record (hostname → IP)', type: 'A', host, value: ip,
      note: 'Point the node hostname at the dedicated node IP.' },
    { key: 'ptr', title: 'PTR / reverse DNS', type: 'PTR', host: ip, value: ptr,
      note: 'Set at your VPS provider control panel (NOT in your DNS zone). Ask support to set reverse DNS for the IP to the hostname.' },
    { key: 'spf', title: 'SPF', type: 'TXT', host: domain, value: `v=spf1 ip4:${ip} -all`,
      note: 'If an SPF record already exists, MERGE — add ip4:' + ip + ' to the existing record, do not create a second SPF.' },
    { key: 'dkim', title: 'DKIM', type: 'TXT', host: `${sel}._domainkey.${domain}`, value: 'v=DKIM1; k=rsa; p=<PUBLIC_KEY>',
      note: 'Generate a DKIM keypair on the node and publish the public key here.' },
    { key: 'dmarc', title: 'DMARC', type: 'TXT', host: `_dmarc.${domain}`, value: `v=DMARC1; p=none; rua=mailto:dmarc@${domain}`,
      note: 'p=none is acceptable for warmup; tighten to quarantine/reject later.' },
    { key: 'mx', title: 'MX / return-path (bounces)', type: 'MX', host: domain, value: `10 ${host}`,
      note: 'Configure a bounce mailbox / return-path domain if direct sending is planned.' },
    { key: 'abuse', title: 'abuse@ + postmaster@', type: 'MAILBOX', host: domain, value: `abuse@${domain}, postmaster@${domain}`,
      note: 'Create both mailboxes and monitor them — required by RFC 2142 and expected by mailbox providers.' },
  ];
}

// ── Report export (Markdown + JSON) ──────────────────────────────────────────
const SENDING_BLOCK_STATEMENT = 'This node is not allowed to send until all critical blockers are resolved.';

export function reportJson(node: any, readiness: ReadinessResult, checklist: ReturnType<typeof dnsChecklist>) {
  return {
    node: {
      id: node.id, name: node.name, node_type: node.node_type, status: node.status,
      hostname: node.hostname, ipv4: node.ipv4, ipv6: node.ipv6, provider_name: node.provider_name,
      location: node.location, purpose: node.purpose, isolation_status: readiness.isolation_status,
      sending_domain: node.sending_domain, dkim_selector: node.dkim_selector,
    },
    readiness: {
      readiness_score: readiness.readiness_score, readiness_level: readiness.readiness_level,
      risk_level: readiness.risk_level, safe_to_connect_as_provider: readiness.safe_to_connect_as_provider,
      safe_to_send: readiness.safe_to_send, next_action: readiness.next_action,
    },
    checks: readiness.checks, blockers: readiness.blockers, warnings: readiness.warnings,
    dns_checklist: checklist,
    statement: SENDING_BLOCK_STATEMENT,
    generated_for_tenant: node.tenant_id,
  };
}

export function reportMarkdown(node: any, readiness: ReadinessResult, checklist: ReturnType<typeof dnsChecklist>): string {
  const L: string[] = [];
  L.push(`# SMTP Node Readiness Report — ${node.name}`);
  L.push('');
  L.push(`> **${SENDING_BLOCK_STATEMENT}**`);
  L.push('');
  L.push('## Node');
  L.push(`- **Type:** ${node.node_type}`);
  L.push(`- **Hostname:** ${node.hostname ?? '—'}`);
  L.push(`- **IPv4:** ${node.ipv4 ?? '—'}${node.ipv6 ? `  ·  **IPv6:** ${node.ipv6}` : ''}`);
  L.push(`- **Provider / location:** ${node.provider_name ?? '—'} / ${node.location ?? '—'}`);
  L.push(`- **Purpose:** ${node.purpose}`);
  L.push(`- **Isolation:** ${readiness.isolation_status}`);
  L.push(`- **Sending domain:** ${node.sending_domain ?? '—'}`);
  L.push('');
  L.push('## Readiness');
  L.push(`- **Score:** ${readiness.readiness_score}/100`);
  L.push(`- **Level:** ${readiness.readiness_level}`);
  L.push(`- **Risk:** ${readiness.risk_level}`);
  L.push(`- **Safe to connect as provider:** ${readiness.safe_to_connect_as_provider ? 'yes' : 'no'}`);
  L.push(`- **Safe to send:** ${readiness.safe_to_send ? 'yes' : 'NO'}`);
  L.push(`- **Next action:** ${readiness.next_action}`);
  L.push('');
  L.push('## Checklist');
  for (const c of readiness.checks) {
    const icon = c.status === 'pass' ? '✅' : c.status === 'fail' ? '❌' : c.status === 'warning' ? '⚠️' : c.status === 'unknown' ? '❔' : '⬜';
    L.push(`- ${icon} **${c.label}**${c.critical ? ' _(critical)_' : ''} — ${c.detail}`);
  }
  L.push('');
  if (readiness.blockers.length) { L.push('## Blockers'); readiness.blockers.forEach((b) => L.push(`- ❌ ${b}`)); L.push(''); }
  if (readiness.warnings.length) { L.push('## Warnings'); readiness.warnings.forEach((w) => L.push(`- ⚠️ ${w}`)); L.push(''); }
  L.push('## DNS checklist (instructions only — nothing is changed automatically)');
  for (const r of checklist) {
    L.push(`- **${r.title}** \`${r.type}\``);
    L.push(`  - host: \`${r.host}\``);
    L.push(`  - value: \`${r.value}\``);
    L.push(`  - ${r.note}`);
  }
  L.push('');
  L.push(`> **${SENDING_BLOCK_STATEMENT}**`);
  return L.join('\n');
}
