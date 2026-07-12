// Collector scheduler: drains active collector campaigns into lead-discovery jobs.
// NEVER sends emails. Defense-in-depth:
//   - Refuses to schedule if collector is paused globally or per-tenant.
//   - Enforces tenant lead-discovery monthly quota (delegated to lead_usage_month).
//   - Enforces per-campaign `max_sources_per_day` against `collector_campaign_stats`.
//   - Conservative per-tick budget so a burst of pending sources doesn't fan out too fast.
//   - Honors `max_pages_per_source` (cap 20) on each spawned discovery job.

import { redis } from './redis.js';
import { query } from './db.js';
import { logger } from './logger.js';

const TICK_INTERVAL_MS = 10_000;        // every 10s
const PER_TICK_MAX_JOBS = 20;           // global per-tick across all tenants
const ABSOLUTE_MAX_PAGES = 20;

type CampaignRow = {
  id: number;
  tenant_id: number;
  name: string;
  max_sources_per_day: number;
  max_pages_per_source: number;
  analyze_website: number;
  generate_draft: number;
  product_profile_id: number | null;
};

async function pickCampaigns(): Promise<CampaignRow[]> {
  // Active campaigns whose tenant has collector_enabled and global pause is OFF.
  return query(
    `SELECT cc.id, cc.tenant_id, cc.name, cc.max_sources_per_day, cc.max_pages_per_source,
            cc.analyze_website, cc.generate_draft, cc.product_profile_id
     FROM collector_campaigns cc
     JOIN collector_admin_settings cas ON cas.tenant_id = cc.tenant_id
     JOIN collector_global_settings cgs ON cgs.id = 1
     JOIN tenants t ON t.id = cc.tenant_id
     WHERE cc.status='active'
       AND cas.collector_enabled = 1
       AND cas.paused_globally = 0
       AND cgs.paused_globally = 0
       AND t.status IN ('active','trial')`,
  );
}

async function sourcesAddedToday(campaignId: number): Promise<number> {
  // "Sources scheduled today" = collector_campaign_sources rows whose scheduled_at is today.
  const r = await query(
    `SELECT COUNT(*) AS c FROM collector_campaign_sources
     WHERE campaign_id=? AND scheduled_at >= CURDATE()`,
    [campaignId],
  );
  return Number(r[0]?.c ?? 0);
}

async function pickPendingSources(campaignId: number, limit: number): Promise<Array<{ id: number; lead_source_id: number }>> {
  return query(
    `SELECT id, lead_source_id FROM collector_campaign_sources
     WHERE campaign_id=? AND state='pending'
     ORDER BY id ASC LIMIT ?`,
    [campaignId, limit],
  );
}

async function scheduleOne(campaign: CampaignRow, ccsRow: { id: number; lead_source_id: number }) {
  const pages = Math.min(ABSOLUTE_MAX_PAGES, Math.max(1, campaign.max_pages_per_source));

  // Create discovery_job
  const job = await query(
    `INSERT INTO discovery_jobs (tenant_id, source_id, max_pages)
     VALUES (?, ?, ?)`,
    [campaign.tenant_id, ccsRow.lead_source_id, pages],
  );
  const jobId = Number(job.insertId);

  // Mark the collector_campaign_sources row queued
  await query(
    `UPDATE collector_campaign_sources
       SET state='queued', discovery_job_id=?, scheduled_at=NOW()
     WHERE id=? AND state='pending'`,
    [jobId, ccsRow.id],
  );

  // Enqueue on the shared lead-discovery stream
  await redis.xadd(
    'jobs:lead-discovery', '*',
    'jobId', String(jobId),
    'tenantId', String(campaign.tenant_id),
    // Annotate so post-discovery chain knows to fan out
    'collectorCampaignId', String(campaign.id),
    'analyzeWebsite',  campaign.analyze_website  ? '1' : '0',
    'generateDraft',   campaign.generate_draft   ? '1' : '0',
    'productProfileId', campaign.product_profile_id ? String(campaign.product_profile_id) : '',
  );

  // Daily stats
  const today = new Date().toISOString().slice(0, 10);
  await query(
    `INSERT INTO collector_campaign_stats (tenant_id, campaign_id, \`date\`, sources_added)
     VALUES (?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE sources_added = sources_added + 1`,
    [campaign.tenant_id, campaign.id, today],
  );
}

async function tick() {
  // Pre-check: nothing scheduled if global pause is on (cheap)
  const g = await query("SELECT paused_globally FROM collector_global_settings WHERE id=1");
  if (g[0]?.paused_globally) return;

  const campaigns = await pickCampaigns();
  if (!campaigns.length) return;

  let budget = PER_TICK_MAX_JOBS;
  for (const c of campaigns) {
    if (budget <= 0) break;
    const usedToday = await sourcesAddedToday(c.id);
    const room = Math.max(0, c.max_sources_per_day - usedToday);
    if (room <= 0) continue;

    const toTake = Math.min(budget, room);
    const pending = await pickPendingSources(c.id, toTake);
    if (!pending.length) continue;

    for (const p of pending) {
      try {
        await scheduleOne(c, p);
        budget--;
        if (budget <= 0) break;
      } catch (e: any) {
        logger.warn({ campaignId: c.id, src: p.id, err: e.message }, 'collector schedule failed');
        await query(
          "UPDATE collector_campaign_sources SET state='failed' WHERE id=?",
          [p.id],
        );
      }
    }
  }

  // Auto-complete campaigns whose budget is exhausted AND no pending sources remain.
  await query(
    `UPDATE collector_campaigns cc
       SET status='completed'
     WHERE status='active'
       AND NOT EXISTS (SELECT 1 FROM collector_campaign_sources s WHERE s.campaign_id=cc.id AND s.state IN ('pending','queued','running'))
       AND EXISTS      (SELECT 1 FROM collector_campaign_sources s WHERE s.campaign_id=cc.id)`,
  );
}

export async function collectorSchedulerLoop() {
  while (true) {
    try { await tick(); }
    catch (e: any) { logger.error({ err: e.message }, 'collector scheduler tick error'); }
    await new Promise((r) => setTimeout(r, TICK_INTERVAL_MS));
  }
}
