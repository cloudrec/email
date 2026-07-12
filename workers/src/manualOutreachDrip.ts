// manualOutreachDrip.ts — Phase 22G.
// Automatic, time-distributed ("drip") sender for APPROVED manual_outreach_queue
// items. For each tenant that has ARMED the drip (outreach_drip_settings.enabled=1)
// and is NOT outreach_paused, each active outbound mailbox sends at most:
//   - hourly_per_mailbox per rolling hour,
//   - daily_per_mailbox per calendar day,
//   - one send per min_interval_min (spacing),
// and only inside the configured server-hour window. Each item is re-gated at send
// time (approved + opt-out line present + recipient not suppressed). Sends are REAL
// (provider SMTP via the secrets vault). Disabled by default; the worker is a no-op
// until a tenant explicitly arms it.
//
// Self-contained: mirrors the vault decrypt + suppression + opt-out logic so the
// worker has no cross-package dependency on api/src.
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { query } from './db.js';
import { logger } from './logger.js';


// OUTREACH_SAFETY_GUARD_20260628
type DraftSafetyResult = { ok: true } | { ok: false; reason: string };

// Mirror of api/src/services/outboundContentGuard.ts — keep in sync.
function hasUnresolvedTemplateSyntax(value: unknown): boolean {
  const s = String(value ?? '');
  return /\{\{[^}]+\}\}/.test(s) || /\{[^{}\n]+\|[^{}\n]+\}/.test(s);
}
function hasReplacePlaceholder(value: unknown): boolean {
  return /<<<\s*REPLACE[\s\S]*?>>>/i.test(String(value ?? ''));
}
function hasBrokenGrammar(value: unknown): boolean {
  return /\bthe your\s+\w+/i.test(String(value ?? ''));
}

function validateOutboundDraftBeforeSmtp(item: any): DraftSafetyResult {
  const subject = String(item?.draft_subject ?? '').trim();
  const body = String(item?.draft_body ?? '').trim();

  if (!subject) return { ok: false, reason: 'missing_subject' };
  if (!body) return { ok: false, reason: 'missing_body' };

  if (hasUnresolvedTemplateSyntax(subject) || hasUnresolvedTemplateSyntax(body)) {
    return { ok: false, reason: 'unresolved_template_placeholder' };
  }
  if (hasReplacePlaceholder(subject) || hasReplacePlaceholder(body)) {
    return { ok: false, reason: 'unfilled_replace_field' };
  }
  if (hasBrokenGrammar(subject) || hasBrokenGrammar(body)) {
    return { ok: false, reason: 'broken_grammar' };
  }

  if (/unsubscribe here\s*:/i.test(body)) {
    return { ok: false, reason: 'bad_unsubscribe_placeholder_or_url_text' };
  }

  if (body.length < 80) {
    return { ok: false, reason: 'body_too_short' };
  }

  return { ok: true };
}



const TICK_INTERVAL_MS = 60_000;
const MAX_ATTEMPTS = 5;
// A mailbox that fails this many sends in a row is auto-paused (circuit breaker)
// and its open items are reassigned to healthy mailboxes — so one broken mailbox
// can never silently burn the whole base to death again.
const MAILBOX_FAULT_LIMIT = 5;
const mailboxFaults = new Map<number, number>(); // mailboxId -> consecutive fault count

// Secret resolution is the single hardened worker vault (allowlist + strong key).
import { resolveSecret } from './secretsVault.js';
// Single authoritative per-mailbox cap definition (shared with campaignRunner).
import { dailyLimit, hourlyLimit } from './mailboxCaps.js';

// HMAC unsubscribe token — MUST match api/src/routes/tracking.ts makeManualUnsubToken.
function hmac(payload: string): string {
  return crypto.createHmac('sha256', process.env.API_JWT_SECRET || 'insecure-dev-key').update(payload).digest('base64url');
}
function unsubUrl(tenantId: number, email: string): string {
  const payload = `${tenantId}.${Buffer.from(email.toLowerCase()).toString('base64url')}`;
  const token = `${payload}.${hmac(payload)}`;
  const base = process.env.PORTAL_PUBLIC_URL || 'https://emails.cheap';
  return `${base}/u/m/${token}`;
}

// ── Gates (mirror of manualOutreach.ts) ──────────────────────────────────────
function hasOptOut(body: string | null | undefined): boolean {
  if (!body) return false;
  const t = body.toLowerCase();
  return /unsubscribe|opt[\s-]?out|reply\s+["'“”]?\s*stop|\bstop\b.*won'?t email|no longer wish|reply .*to stop|don'?t want to hear|i'?ll remove you|i won'?t email again/.test(t);
}
async function isSuppressed(tenantId: number, email: string): Promise<boolean> {
  const e = email.toLowerCase(); const domain = e.split('@')[1] ?? '';
  const s = await query('SELECT 1 FROM suppressions WHERE tenant_id=? AND email=? LIMIT 1', [tenantId, e]);
  if (s.length) return true;
  const g = await query(
    `SELECT 1 FROM global_contact_suppression WHERE (type='email' AND normalized_value=?) OR (type='domain' AND normalized_value=?) LIMIT 1`,
    [e, domain],
  );
  return g.length > 0;
}

// ── Send one item from one mailbox ───────────────────────────────────────────
// Returns:
//   'sent'          — delivered to SMTP.
//   'item_skip'     — this RECIPIENT is permanently ineligible (opt-out/suppressed).
//                     Item is removed from the queue (status='skipped'); not a mailbox problem.
//   'mailbox_fault' — the MAILBOX could not send (no creds / SMTP error). The item is
//                     left retryable and the caller's circuit breaker counts the fault.
type SendResult = 'sent' | 'item_skip' | 'mailbox_fault';
async function sendItem(tenantId: number, mailbox: any, item: any, creds: { user?: string; pass?: string; host?: string; port: number }): Promise<SendResult> {
  // Re-gate at send time — never trust stale rows.
  if (item.status !== 'approved') return 'item_skip';
  // Recipient-permanent problems → take the item OUT of the queue, don't burn attempts forever.
  if (!hasOptOut(item.draft_body)) { await markSkipped(item.id, 'no_opt_out_line'); return 'item_skip'; }
  if (await isSuppressed(tenantId, item.email)) { await markSkipped(item.id, 'suppressed'); return 'item_skip'; }

  const { user, pass, host, port } = creds;
  if (!user || !pass || !host) { return 'mailbox_fault'; } // caller already vetted; defensive only

  // Per-recipient unsubscribe URL + List-Unsubscribe (RFC 8058 one-click).
  const uurl = unsubUrl(tenantId, item.email);
  const subject = (item.draft_subject || '(no subject)').replace(/\{\{\s*unsubscribe_url\s*\}\}/gi, uurl);
  const body = (item.draft_body || '').replace(/\{\{\s*unsubscribe_url\s*\}\}/gi, uurl);
  const fromName = mailbox.display_name || mailbox.from_name || 'Clients.Help';
  // The From / envelope sender MUST be the mailbox's real email address, NOT the SMTP
  // login. For Zoho/Gmail/Spacemail the login happens to equal the address, but for
  // Postal the login is a credential key (e.g. "clients-help/outreach") — using it as
  // the From address makes Postal reject the message at DATA (EMESSAGE). Always send
  // from from_email, which lives on a Postal-verified domain (SPF/DKIM OK).
  const draftSafety = validateOutboundDraftBeforeSmtp(item);
  if (!draftSafety.ok) {
    const reason = `blocked:${draftSafety.reason}`;
    await query(
      "UPDATE manual_outreach_queue SET status='pending_review', approved_at=NULL, safety_status='blocked', send_attempts=0, last_send_error=? WHERE id=?",
      [reason, item.id],
    );
    logger.warn({ itemId: item.id, mailboxId: mailbox.id, reason: draftSafety.reason }, 'drip: blocked unsafe draft before SMTP');
    return 'item_blocked' as any;
  }

  const fromAddr = mailbox.from_email || user;
  try {
    const t = nodemailer.createTransport({
      host, port, secure: port === 465, requireTLS: port === 587, auth: { user, pass },
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
    });
    await t.sendMail({
      from: { name: fromName, address: fromAddr }, to: item.email, subject, text: body,
      envelope: { from: fromAddr, to: item.email }, // MAIL FROM = real domain → SPF/return-path align
      headers: {
        'List-Unsubscribe': `<${uurl}>, <mailto:${fromAddr}?subject=unsubscribe>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });
    t.close();
  } catch (e: any) {
    // SMTP threw: still bump the item's attempt counter (guards genuinely bad recipients),
    // but report a mailbox_fault so a systemically broken mailbox trips the circuit breaker
    // before it kills the whole base.
    await markError(item.id, `smtp_err:${e?.code ?? e?.name ?? 'unknown'}`.slice(0, 200));
    return 'mailbox_fault';
  }

  await query("UPDATE manual_outreach_queue SET status='sent_smtp', sent_at=NOW(), sent_method='smtp', last_send_error=NULL WHERE id=?", [item.id]);
  await query(
    'UPDATE sender_identities SET manual_sent_today=manual_sent_today+1, smtp_sent_today=smtp_sent_today+1, sent_today=sent_today+1, last_sent_at=NOW() WHERE id=?',
    [mailbox.id],
  );
  // Best-effort touchpoint ledger.
  try {
    await query(
      `INSERT INTO outreach_touchpoints (tenant_id, contact_point_id, company_id, queue_item_id, mailbox_id, email, channel, direction, touch_type, subject, status, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, 'email', 'outbound', 'first_touch', ?, 'sent_smtp', NOW())`,
      [tenantId, item.contact_point_id ?? null, item.company_id ?? null, item.id, mailbox.id, item.email, item.draft_subject ?? null],
    );
  } catch { /* ledger optional */ }
  return 'sent';
}

async function markError(id: number, err: string) {
  await query('UPDATE manual_outreach_queue SET send_attempts=send_attempts+1, last_send_error=? WHERE id=?', [err, id]);
}

// Recipient-permanent skip: remove from the active queue so it stops being retried,
// without permanently inflating an attempt counter that the operator has to reason about.
async function markSkipped(id: number, reason: string) {
  await query("UPDATE manual_outreach_queue SET status='skipped', last_send_error=? WHERE id=?", [reason, id]);
}

// Round-robin a mailbox's OPEN approved items onto other (healthy) mailboxes and reset
// their attempt counters, so items are never orphaned on a paused/dead mailbox.
async function reassignOpenItems(tenantId: number, fromMailboxId: number, targets: any[]): Promise<number> {
  if (!targets.length) return 0;
  const items = await query(
    "SELECT id FROM manual_outreach_queue WHERE tenant_id=? AND mailbox_id=? AND status='approved' ORDER BY id",
    [tenantId, fromMailboxId],
  );
  let i = 0;
  for (const it of items) {
    const mb = targets[i % targets.length];
    await query('UPDATE manual_outreach_queue SET mailbox_id=?, send_attempts=0, last_send_error=NULL WHERE id=?', [mb.id, it.id]);
    i++;
  }
  return i;
}

// Self-heal: approved items pinned to a mailbox that is NOT currently healthy (paused,
// deleted, creds-less, or NULL) get moved onto a healthy mailbox with a fresh attempt
// budget. This is what makes a stalled queue recover on its own each tick.
async function rescueOrphans(tenantId: number, healthy: any[]): Promise<number> {
  if (!healthy.length) return 0;
  const ids = healthy.map((h) => h.id);
  const ph = ids.map(() => '?').join(',');
  const orphans = await query(
    `SELECT id FROM manual_outreach_queue
      WHERE tenant_id=? AND status='approved'
        AND (mailbox_id IS NULL OR mailbox_id NOT IN (${ph}))
      ORDER BY id`,
    [tenantId, ...ids],
  );
  let i = 0;
  for (const it of orphans) {
    const mb = healthy[i % healthy.length];
    await query('UPDATE manual_outreach_queue SET mailbox_id=?, send_attempts=0, last_send_error=NULL WHERE id=?', [mb.id, it.id]);
    i++;
  }
  if (i) logger.info({ tenantId, rescued: i }, 'drip: rescued orphaned items onto healthy mailboxes');
  return i;
}

// ── Auto-refill: keep the approved queue topped up from the warehouse ─────────
// When the open queue runs low, pull more eligible leads (verified email, not
// suppressed, not already queued/sent), render the approved template, assign a
// mailbox round-robin, and insert them already-approved so the drip keeps flowing
// through the whole base hands-off. Volume is still bounded by the drip's per-
// mailbox daily/hourly caps — this only keeps the buffer full.
const REFILL_TARGET = 50;       // keep up to this many open (pending+approved)
const REFILL_THRESHOLD = 20;    // refill once open drops below this
const refillEmptyUntil = new Map<number, number>(); // tenantId -> ts; back off when base is dry

// ── Spintax: resolve {a|b|c} (nestable) by random choice, so the same template
// produces a different wording per recipient. {{double-brace}} variables are
// protected and left intact for the later replace step.
function spin(text: string): string {
  // Only groups containing a pipe are spintax; {{vars}} have no pipe and are left intact.
  const re = /\{([^{}]*\|[^{}]*)\}/;
  let s = String(text ?? "");
  let guard = 0;
  while (re.test(s) && guard++ < 500) {
    s = s.replace(re, (_m, inner: string) => {
      const opts = inner.split("|");
      return opts[Math.floor(Math.random() * opts.length)];
    });
  }
  return s;
}
// Resolve spintax first (vars protected), then fill {{company}} / {{sender_name}}.
// {{unsubscribe_url}} is intentionally left for send-time replacement.
function renderTpl(t: string, company: string, senderName: string): string {
  // Fill {{company}} / {{sender_name}} FIRST so spintax options that contain them no longer
  // hold braces, then resolve spintax. {{unsubscribe_url}} has no pipe → left for send-time.
  const filled = String(t ?? '')
    .replace(/\{\{\s*company\s*\}\}/gi, company)
    .replace(/\{\{\s*sender_name\s*\}\}/gi, senderName);
  return spin(filled);
}

async function refillQueue(tenantId: number, mailboxes: any[]): Promise<number> {
  if (!mailboxes.length) return 0;
  const backoff = refillEmptyUntil.get(tenantId) ?? 0;
  if (Date.now() < backoff) return 0;

  const [open] = await query(
    "SELECT COUNT(*) AS n FROM manual_outreach_queue WHERE tenant_id=? AND status IN ('pending_review','approved')",
    [tenantId],
  );
  const openN = Number(open?.n ?? 0);
  if (openN >= REFILL_THRESHOLD) return 0;
  const need = REFILL_TARGET - openN;

  // All approved cold-outreach spintax templates (clients_help_chat, clients_help_chat_b, …).
  // One is picked at random per recipient so the angle rotates, not just the wording.
  const tpls = await query(
    "SELECT template_key, subject, body FROM manual_outreach_templates WHERE tenant_id=? AND template_key LIKE 'clients_help_chat%' AND approved=1",
    [tenantId],
  );
  if (!tpls.length) return 0; // no approved template → nothing to send

  // Eligible: verified email, not suppressed (tenant or global), not already queued/sent.
  // contact_points is the GLOBAL warehouse (no tenant_id) — never filter it by tenant.
  const leads = await query(
    `SELECT cp.id AS cp_id, cp.value AS email, cp.source_url,
            c.id AS company_id, c.name AS company_name, c.canonical_domain AS website, c.country, c.city
       FROM contact_points cp
       JOIN companies c ON c.id = cp.company_id
      WHERE cp.type='email' AND cp.status='verified' AND cp.value IS NOT NULL AND cp.value<>''
        AND cp.value NOT IN (SELECT email FROM suppressions WHERE tenant_id=?)
        AND LOWER(cp.value) NOT IN (SELECT normalized_value FROM global_contact_suppression WHERE type='email')
        AND cp.email_domain NOT IN (SELECT normalized_value FROM global_contact_suppression WHERE type='domain')
        AND cp.value NOT IN (SELECT email FROM manual_outreach_queue WHERE tenant_id=?)
      GROUP BY cp.id
      ORDER BY cp.verification_score DESC
      LIMIT ?`,
    [tenantId, tenantId, need],
  );
  if (!leads.length) { refillEmptyUntil.set(tenantId, Date.now() + 30 * 60 * 1000); return 0; }

  let added = 0;
  for (let i = 0; i < leads.length; i++) {
    const r = leads[i];
    const company = r.company_name || 'your business';
    const mb = mailboxes[added % mailboxes.length]; // round-robin across active mailboxes
    const senderName = mb.display_name || mb.from_name || 'the team';
    const tpl = tpls[Math.floor(Math.random() * tpls.length)]; // rotate angle per recipient
    // Spintax → unique wording per recipient; signature uses the sending mailbox's name.
    const subject = renderTpl(tpl.subject, company, senderName);
    const body = renderTpl(tpl.body, company, senderName);
    try {
      await query(
        `INSERT INTO manual_outreach_queue
          (tenant_id, contact_point_id, company_id, company_name, website, email, reason, source_url,
           template_key, draft_subject, draft_body, safety_status, status, approved_at, mailbox_id)
         VALUES (?, ?, ?, ?, ?, ?, 'auto-refill', ?, ?, ?, ?, 'ok', 'approved', NOW(), ?)`,
        [tenantId, r.cp_id, r.company_id, r.company_name, r.website, r.email, r.source_url, tpl.template_key, subject, body, mb.id],
      );
      added++;
    } catch (e: any) {
      if (e?.code !== 'ER_DUP_ENTRY') throw e; // already queued elsewhere — skip
    }
  }
  if (added) logger.info({ tenantId, added, openWas: openN }, 'drip auto-refill');
  return added;
}

// ── One tenant tick ──────────────────────────────────────────────────────────
async function tickTenant(s: any): Promise<number> {
  const tenantId = s.tenant_id;
  // Respect global/tenant pause.
  const [safety] = await query('SELECT outreach_paused FROM tenant_safety_settings WHERE tenant_id=? LIMIT 1', [tenantId]);
  if (safety && Number(safety.outreach_paused) === 1) return 0;

  // Server-hour send window.
  const hour = new Date().getUTCHours();
  if (hour < Number(s.window_start_hour) || hour >= Number(s.window_end_hour)) return 0;

  // Active outbound mailboxes for this tenant.
  const mailboxes = await query(
    `SELECT m.*, p.smtp_host, p.smtp_port, p.smtp_secure, p.provider_type, p.smtp_user_ref AS p_smtp_user_ref, p.smtp_secret_ref AS p_smtp_secret_ref, p.username_ref AS p_username_ref, p.secret_ref AS p_secret_ref
       FROM sender_identities m LEFT JOIN sending_providers p ON p.id=m.provider_id
      WHERE m.tenant_id=? AND m.status='active' AND m.outbound_enabled=1`,
    [tenantId],
  );

  // Vet each mailbox up front: resolve its SMTP creds ONCE. A mailbox with no
  // resolvable user/pass/host can never send — pause it immediately so it stops
  // being assigned items, instead of letting it burn item after item to death.
  const healthy: any[] = [];
  for (const m of mailboxes) {
    const provider = {
      smtp_host: m.smtp_host, smtp_port: m.smtp_port, smtp_secure: m.smtp_secure,
      smtp_user_ref: m.p_smtp_user_ref, smtp_secret_ref: m.p_smtp_secret_ref,
      username_ref: m.p_username_ref, secret_ref: m.p_secret_ref,
    };
    const userRef = m.smtp_user_ref || provider.smtp_user_ref || provider.username_ref;
    const passRef = m.smtp_secret_ref || provider.smtp_secret_ref || provider.secret_ref;
    const user = await resolveSecret(userRef);
    const pass = await resolveSecret(passRef);
    const host = provider.smtp_host; const port = Number(provider.smtp_port || 587);
    if (user && pass && host) {
      m.__creds = { user, pass, host, port };
      healthy.push(m);
    } else {
      await query("UPDATE sender_identities SET status='paused', paused_reason='no_smtp_creds', health_status='unhealthy' WHERE id=?", [m.id]);
      logger.warn({ tenantId, mailbox: m.from_email, id: m.id }, 'drip: mailbox has no resolvable SMTP creds — paused');
    }
  }
  if (!healthy.length) {
    await query('UPDATE outreach_drip_settings SET last_tick_at=NOW() WHERE tenant_id=?', [tenantId]);
    logger.warn({ tenantId }, 'drip: no healthy mailbox — nothing sent this tick');
    return 0;
  }

  // Self-heal: pull any items orphaned on a now-unhealthy mailbox back onto a working one.
  try { await rescueOrphans(tenantId, healthy); } catch (e: any) { logger.error({ tenantId, err: e?.message }, 'drip rescue error'); }
  // Keep the approved queue topped up so sending never stalls mid-base.
  try { await refillQueue(tenantId, healthy); } catch (e: any) { logger.error({ tenantId, err: e?.message }, 'drip refill error'); }
  let sent = 0;
  for (const m of healthy) {
    // Per-mailbox usage from the queue ledger (authoritative, no counter-roll bugs).
    const [u] = await query(
      `SELECT
         SUM(CASE WHEN DATE(sent_at)=UTC_DATE() THEN 1 ELSE 0 END) AS today,
         SUM(CASE WHEN sent_at > UTC_TIMESTAMP() - INTERVAL 1 HOUR THEN 1 ELSE 0 END) AS last_hour,
         TIMESTAMPDIFF(SECOND, MAX(sent_at), UTC_TIMESTAMP()) AS since_sec
       FROM manual_outreach_queue
       WHERE tenant_id=? AND mailbox_id=? AND status IN ('sent_smtp','sent_manual')`,
      [tenantId, m.id],
    );
    const today = Number(u?.today ?? 0), lastHour = Number(u?.last_hour ?? 0);
    // Coerce every cap to a finite number. A NULL drip-settings column would make
    // Number(null)=NaN and `today >= NaN` always false, silently disabling the
    // throttle (over-send). A NULL setting drops out of the min(), leaving the
    // mailbox's own limit as the backstop.
    const numOr = (v: any, d: number) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
    // Cap = min(drip-setting, authoritative per-mailbox limit). dailyLimit/hourlyLimit
    // are the shared definition (warmup keeps daily_send_limit current); an unset
    // mailbox limit resolves to 0 → fail-safe (blocks rather than defaulting high).
    const dailyCap = Math.min(numOr(s.daily_per_mailbox, Infinity), dailyLimit(m));
    const hourlyCap = Math.min(numOr(s.hourly_per_mailbox, Infinity), hourlyLimit(m));
    if (today >= dailyCap) continue;
    if (lastHour >= hourlyCap) continue;
    // Spacing guard. since_sec is computed DB-side (UTC) to avoid JS Date/timezone
    // ambiguity; the previous `new Date(last_at + 'Z')` produced an Invalid Date →
    // NaN, so the min_interval_min pacing never actually fired.
    if (u?.since_sec != null) {
      const sinceMin = Number(u.since_sec) / 60;
      if (sinceMin < numOr(s.min_interval_min, 0)) continue;
    }
    // Next approved item assigned to this mailbox, not over the attempt cap.
    const [item] = await query(
      `SELECT * FROM manual_outreach_queue
        WHERE tenant_id=? AND mailbox_id=? AND status='approved' AND send_attempts < ?
        ORDER BY created_at ASC LIMIT 1`,
      [tenantId, m.id, MAX_ATTEMPTS],
    );
    if (!item) continue;
    const res = await sendItem(tenantId, m, item, m.__creds);
    if (res === 'sent') {
      sent++;
      mailboxFaults.delete(m.id); // healthy again — reset its streak
      logger.info({ tenantId, mailbox: m.from_email, to: item.email, queueId: item.id }, 'drip sent');
    } else if (res === 'mailbox_fault') {
      // Circuit breaker: count consecutive faults; trip → pause mailbox + rehome its items.
      const n = (mailboxFaults.get(m.id) ?? 0) + 1;
      mailboxFaults.set(m.id, n);
      if (n >= MAILBOX_FAULT_LIMIT) {
        await query("UPDATE sender_identities SET status='paused', paused_reason='smtp_failures', health_status='unhealthy' WHERE id=?", [m.id]);
        const others = healthy.filter((h) => h.id !== m.id);
        const moved = await reassignOpenItems(tenantId, m.id, others);
        mailboxFaults.delete(m.id);
        logger.warn({ tenantId, mailbox: m.from_email, id: m.id, moved }, 'drip: mailbox circuit-breaker tripped — paused + items reassigned');
      }
    }
    // 'item_skip' → recipient removed from queue; not a mailbox problem, do nothing.
    // One send per mailbox per tick — spacing enforced by min_interval next ticks.
  }
  if (sent) await query('UPDATE outreach_drip_settings SET sent_total=sent_total+?, last_tick_at=NOW() WHERE tenant_id=?', [sent, tenantId]);
  else await query('UPDATE outreach_drip_settings SET last_tick_at=NOW() WHERE tenant_id=?', [tenantId]);
  return sent;
}

export async function manualOutreachDripLoop(): Promise<void> {
  logger.info('manualOutreachDrip loop started (disabled until a tenant arms it)');
  for (;;) {
    try {
      const armed = await query('SELECT * FROM outreach_drip_settings WHERE enabled=1');
      for (const s of armed) {
        try { await tickTenant(s); }
        catch (e: any) { logger.error({ tenantId: s.tenant_id, err: e?.message }, 'drip tenant tick error'); }
      }
    } catch (e: any) {
      logger.error({ err: e?.message }, 'drip loop tick error');
    }
    await new Promise((r) => setTimeout(r, TICK_INTERVAL_MS));
  }
}
