import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { authMiddleware, requireTenant, requireWriteAccess } from '../middleware/auth.js';
import { audit } from '../middleware/audit.js';
import {
  runReadiness, dnsChecklist, reportJson, reportMarkdown, productionIps,
  type ReadinessInput,
} from '../services/smtpNodes.js';

// Phase 22F — Self-Hosted SMTP Node Readiness Manager (mounted /smtp-nodes).
// Register FUTURE dedicated self-hosted SMTP nodes and see whether they are safe
// to use. METADATA ONLY — no SMTP/root/SSH/account secrets are ever stored.
// NO send endpoint. NO MTA install. NO port opened. NO DNS changed. Sending is
// BLOCKED by default until every critical readiness check passes.
export const smtpNodesRouter = Router();
smtpNodesRouter.use(authMiddleware, requireTenant);

const NODE_TYPES = ['self_hosted_vps', 'dedicated_smtp_server', 'postal_later', 'mailcow_later', 'postfix_later', 'generic_smtp_node'] as const;
const PURPOSES = ['cold_outreach', 'transactional', 'internal_test'] as const;
const ISO = ['unknown', 'dedicated', 'shared_with_app_server', 'shared_with_production', 'unsafe'] as const;
const MAILBOX_STATE = ['unchecked', 'planned', 'configured', 'missing'] as const;
const MANUAL_REP = ['clean', 'listed', 'unknown', 'not_applicable'] as const;

function jb(v: any): any { if (v == null) return null; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return null; } }

function nodeView(n: any) {
  return {
    id: n.id, tenant_id: n.tenant_id, name: n.name, node_type: n.node_type, status: n.status,
    hostname: n.hostname, ipv4: n.ipv4, ipv6: n.ipv6, provider_name: n.provider_name, location: n.location,
    purpose: n.purpose, isolation_status: n.isolation_status, isolation_note: n.isolation_note,
    ptr_expected: n.ptr_expected, ptr_detected: n.ptr_detected, ptr_status: n.ptr_status,
    sending_domain: n.sending_domain, dkim_selector: n.dkim_selector,
    spf_status: n.spf_status, dkim_status: n.dkim_status, dmarc_status: n.dmarc_status,
    mx_status: n.mx_status, tls_status: n.tls_status, forward_dns_status: n.forward_dns_status,
    port25_status: n.port25_status,
    abuse_mailbox_status: n.abuse_mailbox_status, postmaster_mailbox_status: n.postmaster_mailbox_status,
    bounce_mailbox_status: n.bounce_mailbox_status, blacklist_status: n.blacklist_status,
    spamhaus_status: n.spamhaus_status, spamhaus_checked_at: n.spamhaus_checked_at,
    barracuda_status: n.barracuda_status, barracuda_checked_at: n.barracuda_checked_at,
    microsoft_snds_status: n.microsoft_snds_status, google_postmaster_status: n.google_postmaster_status,
    readiness_score: n.readiness_score, readiness_level: n.readiness_level,
    risk_level: n.risk_level, safe_to_connect_as_provider: !!n.safe_to_connect_as_provider, safe_to_send: !!n.safe_to_send,
    blockers: jb(n.blockers_json) ?? [], warnings: jb(n.warnings_json) ?? [],
    checklist: jb(n.checklist_json) ?? [], manual_done: jb(n.manual_done_json) ?? [],
    next_action: n.next_action, last_checked_at: n.last_checked_at, last_error: n.last_error,
    notes: n.notes, created_at: n.created_at, updated_at: n.updated_at,
  };
}

async function loadNode(tenantId: number, id: number): Promise<any | null> {
  const [n] = await query('SELECT * FROM smtp_nodes WHERE id=? AND tenant_id=? LIMIT 1', [id, tenantId]);
  return n ?? null;
}

// ── Environment facts (read-only) ────────────────────────────────────────────
smtpNodesRouter.get('/env', async (_req, res) => {
  res.json({
    production_ips: productionIps(),
    note: 'A node using any of these IPs is BLOCKED for cold outreach (production app server IP).',
    safety: { mta_installed: false, port25_opened: false, dns_changed: false, can_send_from_this_module: false },
  });
});

// ── List ─────────────────────────────────────────────────────────────────────
smtpNodesRouter.get('/', async (req, res) => {
  const rows = await query('SELECT * FROM smtp_nodes WHERE tenant_id=? ORDER BY created_at DESC', [req.auth!.tenantId]);
  res.json({ nodes: rows.map(nodeView) });
});

smtpNodesRouter.get('/:id', async (req, res) => {
  const n = await loadNode(req.auth!.tenantId!, Number(req.params.id));
  if (!n) return res.status(404).json({ error: 'not_found' });
  res.json({ node: nodeView(n), dns_checklist: dnsChecklist(n) });
});

// ── Create / update (draft) ──────────────────────────────────────────────────
const nodeBody = z.object({
  name: z.string().min(1).max(190),
  node_type: z.enum(NODE_TYPES).optional(),
  hostname: z.string().max(255).optional().nullable(),
  ipv4: z.string().max(45).optional().nullable(),
  ipv6: z.string().max(64).optional().nullable(),
  provider_name: z.string().max(190).optional().nullable(),
  location: z.string().max(190).optional().nullable(),
  purpose: z.enum(PURPOSES).optional(),
  ptr_expected: z.string().max(255).optional().nullable(),
  sending_domain: z.string().max(255).optional().nullable(),
  dkim_selector: z.string().max(190).optional().nullable(),
  isolation_status: z.enum(ISO).optional(),
  isolation_note: z.string().max(500).optional().nullable(),
  abuse_mailbox_status: z.enum(MAILBOX_STATE).optional(),
  postmaster_mailbox_status: z.enum(MAILBOX_STATE).optional(),
  bounce_mailbox_status: z.enum(MAILBOX_STATE).optional(),
  notes: z.string().max(5000).optional().nullable(),
});

smtpNodesRouter.post('/', requireWriteAccess, async (req, res) => {
  const p = nodeBody.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'invalid_body', detail: p.error.issues });
  const d = p.data;
  const r = await query(
    `INSERT INTO smtp_nodes
      (tenant_id, name, node_type, status, hostname, ipv4, ipv6, provider_name, location, purpose,
       ptr_expected, sending_domain, dkim_selector, isolation_status, isolation_note,
       abuse_mailbox_status, postmaster_mailbox_status, bounce_mailbox_status, notes)
     VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [req.auth!.tenantId, d.name, d.node_type ?? 'generic_smtp_node', d.hostname ?? null, d.ipv4 ?? null, d.ipv6 ?? null,
     d.provider_name ?? null, d.location ?? null, d.purpose ?? 'internal_test', d.ptr_expected ?? null,
     d.sending_domain ?? null, d.dkim_selector ?? null, d.isolation_status ?? 'unknown', d.isolation_note ?? null,
     d.abuse_mailbox_status ?? 'unchecked', d.postmaster_mailbox_status ?? 'unchecked', d.bounce_mailbox_status ?? 'unchecked',
     d.notes ?? null],
  );
  await audit(req, 'smtp_node.create', { type: 'smtp_node', id: r.insertId }, { name: d.name, purpose: d.purpose });
  const n = await loadNode(req.auth!.tenantId!, Number(r.insertId));
  res.json({ ok: true, node: nodeView(n) });
});

smtpNodesRouter.patch('/:id', requireWriteAccess, async (req, res) => {
  const n = await loadNode(req.auth!.tenantId!, Number(req.params.id));
  if (!n) return res.status(404).json({ error: 'not_found' });
  const p = nodeBody.partial().safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'invalid_body', detail: p.error.issues });
  const d = p.data;
  const cols: string[] = []; const vals: any[] = [];
  for (const [k, v] of Object.entries(d)) { cols.push(`${k}=?`); vals.push(v ?? null); }
  if (cols.length) { vals.push(n.id, req.auth!.tenantId); await query(`UPDATE smtp_nodes SET ${cols.join(', ')} WHERE id=? AND tenant_id=?`, vals); }
  await audit(req, 'smtp_node.update', { type: 'smtp_node', id: n.id }, { fields: Object.keys(d) });
  const updated = await loadNode(req.auth!.tenantId!, n.id);
  res.json({ ok: true, node: nodeView(updated) });
});

// ── Run readiness check ──────────────────────────────────────────────────────
smtpNodesRouter.post('/:id/check', requireWriteAccess, async (req, res) => {
  const n = await loadNode(req.auth!.tenantId!, Number(req.params.id));
  if (!n) return res.status(404).json({ error: 'not_found' });
  const probePort25 = req.body?.probePort25 === true;
  await query('UPDATE smtp_nodes SET status=? WHERE id=?', ['checking', n.id]);

  let result;
  try {
    const input: ReadinessInput = {
      hostname: n.hostname, ipv4: n.ipv4, ipv6: n.ipv6, sending_domain: n.sending_domain,
      ptr_expected: n.ptr_expected, dkim_selector: n.dkim_selector, purpose: n.purpose,
      isolation_status: n.isolation_status, abuse_mailbox_status: n.abuse_mailbox_status,
      postmaster_mailbox_status: n.postmaster_mailbox_status, bounce_mailbox_status: n.bounce_mailbox_status,
      blacklist_status: n.blacklist_status, spamhaus_status: n.spamhaus_status, barracuda_status: n.barracuda_status,
      microsoft_snds_status: n.microsoft_snds_status, google_postmaster_status: n.google_postmaster_status,
      probePort25,
    };
    result = await runReadiness(input);
  } catch (e: any) {
    await query('UPDATE smtp_nodes SET status=?, last_error=?, last_checked_at=NOW() WHERE id=?',
      ['warning', String(e?.message ?? e).slice(0, 500), n.id]);
    return res.status(500).json({ error: 'check_failed', detail: String(e?.message ?? e) });
  }

  await query(
    `UPDATE smtp_nodes SET
      status=?, ptr_status=?, ptr_detected=?, forward_dns_status=?, spf_status=?, dkim_status=?, dmarc_status=?,
      mx_status=?, tls_status=?, port25_status=?, isolation_status=?,
      readiness_score=?, readiness_level=?, risk_level=?,
      safe_to_connect_as_provider=?, safe_to_send=?,
      blockers_json=?, warnings_json=?, checklist_json=?, next_action=?, last_checked_at=NOW(), last_error=NULL
     WHERE id=? AND tenant_id=?`,
    [result.status, result.ptr_status, result.ptr_detected, result.forward_dns_status, result.spf_status,
     result.dkim_status, result.dmarc_status, result.mx_status, result.tls_status, result.port25_status, result.isolation_status,
     result.readiness_score, result.readiness_level, result.risk_level,
     result.safe_to_connect_as_provider ? 1 : 0, result.safe_to_send ? 1 : 0,
     JSON.stringify(result.blockers), JSON.stringify(result.warnings), JSON.stringify(result.checks), result.next_action,
     n.id, req.auth!.tenantId],
  );
  await audit(req, 'smtp_node.check', { type: 'smtp_node', id: n.id },
    { score: result.readiness_score, level: result.readiness_level, safe_to_send: result.safe_to_send, port25_probed: probePort25 });
  const updated = await loadNode(req.auth!.tenantId!, n.id);
  res.json({ ok: true, node: nodeView(updated), result, dns_checklist: dnsChecklist(n) });
});

// ── DNS checklist (instructions only) ────────────────────────────────────────
smtpNodesRouter.get('/:id/dns-checklist', async (req, res) => {
  const n = await loadNode(req.auth!.tenantId!, Number(req.params.id));
  if (!n) return res.status(404).json({ error: 'not_found' });
  res.json({ dns_checklist: dnsChecklist(n) });
});

// ── Manual blacklist / reputation checklist ──────────────────────────────────
const repBody = z.object({
  spamhaus_status: z.enum(MANUAL_REP).optional(),
  barracuda_status: z.enum(MANUAL_REP).optional(),
  microsoft_snds_status: z.enum(MANUAL_REP).optional(),
  google_postmaster_status: z.enum(MANUAL_REP).optional(),
  blacklist_status: z.enum(['unchecked', 'clean', 'listed', 'unknown']).optional(),
  notes: z.string().max(5000).optional().nullable(),
});
smtpNodesRouter.patch('/:id/reputation', requireWriteAccess, async (req, res) => {
  const n = await loadNode(req.auth!.tenantId!, Number(req.params.id));
  if (!n) return res.status(404).json({ error: 'not_found' });
  const p = repBody.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: 'invalid_body', detail: p.error.issues });
  const d = p.data;
  const cols: string[] = []; const vals: any[] = [];
  for (const [k, v] of Object.entries(d)) {
    cols.push(`${k}=?`); vals.push(v ?? null);
    if (k === 'spamhaus_status') { cols.push('spamhaus_checked_at=NOW()'); }
    if (k === 'barracuda_status') { cols.push('barracuda_checked_at=NOW()'); }
  }
  if (cols.length) { vals.push(n.id, req.auth!.tenantId); await query(`UPDATE smtp_nodes SET ${cols.join(', ')} WHERE id=? AND tenant_id=?`, vals); }
  await audit(req, 'smtp_node.reputation', { type: 'smtp_node', id: n.id }, d);
  res.json({ ok: true, node: nodeView(await loadNode(req.auth!.tenantId!, n.id)) });
});

// ── Mark a manual checklist item completed ───────────────────────────────────
smtpNodesRouter.post('/:id/manual-item', requireWriteAccess, async (req, res) => {
  const n = await loadNode(req.auth!.tenantId!, Number(req.params.id));
  if (!n) return res.status(404).json({ error: 'not_found' });
  const key = String(req.body?.key ?? '').slice(0, 100);
  const done = req.body?.done !== false;
  if (!key) return res.status(400).json({ error: 'key_required' });
  const cur: string[] = jb(n.manual_done_json) ?? [];
  const set = new Set(cur);
  if (done) set.add(key); else set.delete(key);
  await query('UPDATE smtp_nodes SET manual_done_json=? WHERE id=? AND tenant_id=?', [JSON.stringify([...set]), n.id, req.auth!.tenantId]);
  await audit(req, 'smtp_node.manual_item', { type: 'smtp_node', id: n.id }, { key, done });
  res.json({ ok: true, manual_done: [...set] });
});

// ── Disable ──────────────────────────────────────────────────────────────────
smtpNodesRouter.post('/:id/disable', requireWriteAccess, async (req, res) => {
  const n = await loadNode(req.auth!.tenantId!, Number(req.params.id));
  if (!n) return res.status(404).json({ error: 'not_found' });
  await query('UPDATE smtp_nodes SET status=?, safe_to_send=0 WHERE id=? AND tenant_id=?', ['disabled', n.id, req.auth!.tenantId]);
  await audit(req, 'smtp_node.disable', { type: 'smtp_node', id: n.id });
  res.json({ ok: true });
});

// ── Export report (Markdown / JSON) ──────────────────────────────────────────
async function buildReport(tenantId: number, id: number) {
  const n = await loadNode(tenantId, id);
  if (!n) return null;
  // Recompute live so the report reflects current DNS (read-only, no port probe).
  const result = await runReadiness({
    hostname: n.hostname, ipv4: n.ipv4, ipv6: n.ipv6, sending_domain: n.sending_domain,
    ptr_expected: n.ptr_expected, dkim_selector: n.dkim_selector, purpose: n.purpose,
    isolation_status: n.isolation_status, abuse_mailbox_status: n.abuse_mailbox_status,
    postmaster_mailbox_status: n.postmaster_mailbox_status, bounce_mailbox_status: n.bounce_mailbox_status,
    blacklist_status: n.blacklist_status, spamhaus_status: n.spamhaus_status, barracuda_status: n.barracuda_status,
    microsoft_snds_status: n.microsoft_snds_status, google_postmaster_status: n.google_postmaster_status,
    probePort25: false,
  });
  return { n, result, checklist: dnsChecklist(n) };
}

smtpNodesRouter.get('/:id/report', async (req, res) => {
  const built = await buildReport(req.auth!.tenantId!, Number(req.params.id));
  if (!built) return res.status(404).json({ error: 'not_found' });
  const fmt = String(req.query.format ?? 'json');
  if (fmt === 'markdown' || fmt === 'md') {
    res.setHeader('content-type', 'text/markdown; charset=utf-8');
    return res.send(reportMarkdown(built.n, built.result, built.checklist));
  }
  res.json(reportJson(built.n, built.result, built.checklist));
});

// ── Create draft provider profile from node (Part 6) ─────────────────────────
// Only allowed once readiness reaches ready_for_tiny_test. Provider is created
// DISABLED/PENDING with conservative limits. NO secrets stored. NO sending.
smtpNodesRouter.post('/:id/create-draft-provider', requireWriteAccess, async (req, res) => {
  const n = await loadNode(req.auth!.tenantId!, Number(req.params.id));
  if (!n) return res.status(404).json({ error: 'not_found' });
  if (n.readiness_level !== 'ready_for_tiny_test' || !n.safe_to_connect_as_provider) {
    return res.status(412).json({
      error: 'not_ready',
      detail: 'Node must reach readiness level "ready_for_tiny_test" and pass the production-IP/PTR gate before a provider profile can be created.',
      readiness_level: n.readiness_level, safe_to_connect_as_provider: !!n.safe_to_connect_as_provider,
    });
  }
  const r = await query(
    `INSERT INTO sending_providers
      (tenant_id, provider_type, name, smtp_host, smtp_port, smtp_secure,
       inbound_enabled, outbound_enabled, default_daily_limit, default_hourly_limit, status)
     VALUES (?, 'self_hosted_smtp_imap_later', ?, ?, 587, 0, 0, 0, 5, 2, 'pending')`,
    [req.auth!.tenantId, `Self-hosted node: ${n.name}`, n.hostname ?? null],
  );
  await audit(req, 'smtp_node.create_draft_provider', { type: 'sending_provider', id: r.insertId }, { node_id: n.id });
  res.json({
    ok: true, provider_id: Number(r.insertId), status: 'pending', outbound_enabled: false,
    note: 'Draft/disabled provider created with conservative limits (5/day, 2/hour). No secrets stored, no sending enabled. Configure mailbox credentials later in a deliberate step.',
  });
});

// ── Delete (only draft/disabled) ─────────────────────────────────────────────
smtpNodesRouter.delete('/:id', requireWriteAccess, async (req, res) => {
  const n = await loadNode(req.auth!.tenantId!, Number(req.params.id));
  if (!n) return res.status(404).json({ error: 'not_found' });
  if (!['draft', 'disabled'].includes(n.status)) return res.status(409).json({ error: 'disable_first', detail: 'Disable the node before deleting.' });
  await query('DELETE FROM smtp_nodes WHERE id=? AND tenant_id=?', [n.id, req.auth!.tenantId]);
  await audit(req, 'smtp_node.delete', { type: 'smtp_node', id: n.id });
  res.json({ ok: true });
});
