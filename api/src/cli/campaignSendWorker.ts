// Campaign send-worker (TZ §18). Processes engine-mode campaigns (campaign_mode set),
// planning one message per subscribed recipient through the pure campaignSendPlanner /
// campaignSendGate, and — only when explicitly armed by the owner — dispatching them.
//
// SAFETY MODEL (default = DRY RUN, sends nothing):
//   A campaign is sent for real ONLY when ALL of these hold:
//     1. env CAMPAIGN_SEND_LIVE=1                 (global arm)
//     2. campaign.lifecycle_state = 'ACTIVE'      (per-campaign state)
//     3. env CAMPAIGN_SEND_CONFIRM = campaign.uuid (per-campaign confirmation token)
//   plus a per-run cap CAMPAIGN_SEND_MAX (default 1) and, per message, the §9 quality gate
//   and (affiliate) §10 compliance gate must pass. A DRY RUN evaluates and logs everything,
//   writes NO rows, and never contacts SMTP. This worker is NOT wired to any cron; it is
//   run by hand.
//
// Run:
//   docker compose exec api node dist/cli/campaignSendWorker.js [campaignId]     # dry run
//   docker compose exec -e CAMPAIGN_SEND_LIVE=1 -e CAMPAIGN_SEND_CONFIRM=<uuid> \
//     -e CAMPAIGN_SEND_MAX=5 api node dist/cli/campaignSendWorker.js <campaignId> # live (armed)
import 'dotenv/config';
import { query } from '../db.js';
import { planCampaign, type PlannerContact } from '../services/campaignSendPlanner.js';
import { isSuppressedGlobal } from '../services/suppression.js';
import { evaluateMessageQuality } from '../services/messageQualityGate.js';
import { screenAffiliateMessage } from '../services/affiliateCompliance.js';
import { resolveProvider, sendFromMailbox, type ProviderRow } from '../services/mailboxRuntime.js';

const TENANT_ID = Number(process.env.CAMPAIGN_TENANT_ID || 1);
const LIVE = process.env.CAMPAIGN_SEND_LIVE === '1';
const CONFIRM = process.env.CAMPAIGN_SEND_CONFIRM || '';
const MAX_PER_RUN = Math.max(0, Number(process.env.CAMPAIGN_SEND_MAX || 1));
const RECIPIENT_CAP = Math.max(1, Number(process.env.CAMPAIGN_RECIPIENT_CAP || 500));
const ONLY_ID = process.argv[2] ? Number(process.argv[2]) : (process.env.CAMPAIGN_ID ? Number(process.env.CAMPAIGN_ID) : null);
const STEP = 1;

function log(s: string) { console.log(s); }

async function loadMailbox(): Promise<any | null> {
  // The tenant's default sender identity, with today's counters.
  const [mb] = await query(
    `SELECT * FROM sender_identities WHERE tenant_id=? ORDER BY is_default DESC, id ASC LIMIT 1`, [TENANT_ID]);
  return mb ?? null;
}

async function connForMailbox(mailbox: any) {
  if (!mailbox?.provider_id) return null;
  const [prov] = await query('SELECT * FROM sending_providers WHERE id=? AND tenant_id=? LIMIT 1', [mailbox.provider_id, TENANT_ID]);
  if (!prov) return null;
  const merged = {
    ...prov,
    smtp_user_ref: mailbox.smtp_user_ref || prov.smtp_user_ref || prov.username_ref || '',
    smtp_secret_ref: mailbox.smtp_secret_ref || prov.smtp_secret_ref || prov.secret_ref || '',
    outbound_enabled: mailbox.outbound_enabled,
  } as ProviderRow;
  return resolveProvider(merged);
}

async function recipients(campaign: any): Promise<PlannerContact[]> {
  if (!campaign.list_id) return [];
  const rows = await query(
    `SELECT c.id AS contactId, c.email
       FROM list_contacts lc JOIN contacts c ON c.id = lc.contact_id
      WHERE lc.list_id=? AND c.tenant_id=? AND c.status='subscribed'
      ORDER BY c.id ASC LIMIT ?`, [campaign.list_id, TENANT_ID, RECIPIENT_CAP]);
  return rows.map((r: any) => ({ contactId: Number(r.contactId), email: String(r.email) }));
}

async function processCampaign(campaign: any) {
  const isAffiliate = campaign.campaign_mode === 'AFFILIATE';
  log(`\n=== campaign #${campaign.id} "${campaign.name}" mode=${campaign.campaign_mode} lifecycle=${campaign.lifecycle_state ?? '—'} ===`);

  const mailbox = await loadMailbox();
  if (!mailbox) { log('  no sender identity for tenant — skip'); return; }

  let offerApproved: boolean | null = null;
  if (isAffiliate) {
    if (!campaign.affiliate_offer_id) { offerApproved = false; }
    else {
      const [o] = await query('SELECT status FROM affiliate_offers WHERE id=? LIMIT 1', [campaign.affiliate_offer_id]);
      offerApproved = o?.status === 'APPROVED';
    }
  }

  const contacts = await recipients(campaign);
  if (!contacts.length) { log('  no subscribed recipients (needs a list_id) — skip'); return; }

  const sentRows = await query(
    `SELECT send_key FROM campaign_send_log WHERE campaign_id=? AND status='sent'`, [campaign.id]);
  const sentKeys = new Set<string>(sentRows.map((r: any) => String(r.send_key)));

  // Suppression check per unique email.
  const suppressed = new Set<string>();
  for (const c of contacts) {
    if (await isSuppressedGlobal(TENANT_ID, c.email)) suppressed.add(c.email.toLowerCase());
  }

  const plan = planCampaign({
    campaign: { id: campaign.id, isAffiliate, lifecycleState: campaign.lifecycle_state, affiliateOfferApproved: offerApproved },
    contacts, step: STEP, sentKeys, suppressedEmails: suppressed,
    mailbox: { usedToday: Number(mailbox.sent_today || 0), dailyLimit: Number(mailbox.daily_send_limit || 0) },
  });

  // Blocker breakdown.
  const reasons: Record<string, number> = {};
  for (const it of plan.items) for (const b of it.decision.blockers) reasons[b] = (reasons[b] || 0) + 1;
  log(`  recipients=${contacts.length}  wouldSend=${plan.wouldSend}  blocked=${plan.blocked}  ${Object.entries(reasons).map(([k, v]) => `${k}:${v}`).join('  ')}`);

  // Decide whether this run is live for THIS campaign.
  const armed = LIVE && campaign.lifecycle_state === 'ACTIVE' && CONFIRM && CONFIRM === campaign.uuid;
  if (!armed) {
    if (LIVE) log(`  LIVE requested but NOT armed for this campaign (need lifecycle_state=ACTIVE and CAMPAIGN_SEND_CONFIRM=${campaign.uuid}). Dry-run only.`);
    // Dry run: show a sample, write nothing.
    const sample = plan.items.filter((i) => i.decision.send).slice(0, 5);
    for (const s of sample) log(`    [DRY] would send → ${s.email} (key ${s.sendKey})`);
    return;
  }

  // ── Armed live send (owner-gated), capped ──
  log(`  *** LIVE ARMED — dispatching up to ${MAX_PER_RUN} message(s) ***`);
  const subject = campaign.subject || '';
  const html = campaign.html_body || campaign.body_html || '';
  const text = campaign.text_body || campaign.body_text || html.replace(/<[^>]+>/g, ' ').trim();
  const conn = await connForMailbox(mailbox);
  if (!conn) { log('  mailbox has no usable provider connection — abort live send'); return; }

  let sent = 0;
  for (const it of plan.items) {
    if (sent >= MAX_PER_RUN) break;
    if (!it.decision.send) continue;

    // Per-message §9 quality gate.
    const q = evaluateMessageQuality({ subject, body: text, isReply: false, requireSenderIdentity: false, requireOptOut: false, isAffiliate });
    if (!q.passed) { log(`    skip ${it.email}: quality ${q.blockers.join(',')}`); continue; }

    // Per-message §10 affiliate compliance.
    if (isAffiliate) {
      const comp = await screenAffiliateMessage({ campaignId: campaign.id, offerId: campaign.affiliate_offer_id, contactEmail: it.email, subject, body: text });
      if (!comp.allowed) { log(`    skip ${it.email}: compliance ${comp.blockers.join(',')}`); continue; }
    }

    // Claim the send key BEFORE dispatch (idempotent: dup key => already claimed).
    try {
      await query(
        `INSERT INTO campaign_send_log (tenant_id, campaign_id, contact_id, step, send_key, status, dry_run, mailbox_id)
         VALUES (?,?,?,?,?, 'planned', 0, ?)`,
        [TENANT_ID, campaign.id, it.contactId, STEP, it.sendKey, mailbox.id]);
    } catch (e: any) {
      if (e?.code === 'ER_DUP_ENTRY') { log(`    skip ${it.email}: already claimed`); continue; }
      throw e;
    }

    const res = await sendFromMailbox(conn, { from: mailbox.from_email, to: it.email, subject, text, html: html || undefined });
    await query(`UPDATE campaign_send_log SET status=? , blockers=? WHERE send_key=?`,
      [res.ok ? 'sent' : 'failed', res.ok ? null : res.detail.slice(0, 500), it.sendKey]);
    log(`    ${res.ok ? 'SENT' : 'FAILED'} → ${it.email} (${res.detail})`);
    if (res.ok) sent++;
  }
  log(`  live dispatch complete: ${sent} sent`);
}

async function main() {
  log(`campaign send-worker — mode=${LIVE ? 'LIVE(armed by env)' : 'DRY-RUN'} tenant=${TENANT_ID} max=${MAX_PER_RUN}${ONLY_ID ? ` campaign=${ONLY_ID}` : ''}`);
  const where = ['tenant_id=?', 'campaign_mode IS NOT NULL'];
  const params: any[] = [TENANT_ID];
  if (ONLY_ID) { where.push('id=?'); params.push(ONLY_ID); }
  const campaigns = await query(`SELECT * FROM campaigns WHERE ${where.join(' AND ')} ORDER BY id ASC`, params);
  if (!campaigns.length) { log('no engine-mode campaigns (campaign_mode set) to process.'); return; }
  for (const c of campaigns) await processCampaign(c);
}

main().then(() => process.exit(0)).catch((e) => { console.error('worker error:', e); process.exit(1); });
