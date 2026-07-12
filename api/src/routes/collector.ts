import { Router } from 'express';
import { z } from 'zod';
import { query, withConn } from '../db.js';
import { authMiddleware, requireTenant, requireSuperAdmin, requireWriteAccess } from '../middleware/auth.js';
import { audit } from '../middleware/audit.js';
import { getLeadLimits } from '../services/leadLimits.js';
import { normalizeUrl, expandPresets, PRESETS } from '../services/collectorPresets.js';
import {
  defaultConfiguredProvider, getSearchProvider, listSearchProviders,
} from '../services/searchProvider.js';
import { TavilyError, tavilyProvider } from '../services/tavilyProvider.js';
import { osmSearch, OsmError, OSM_CATEGORIES, type OsmCategory } from '../services/osmOverpass.js';
import { config } from '../config.js';
import { redis } from '../redis.js';

// Tavily credit accounting helpers (DB-backed)
async function tavilyUsedSince(tenantId: number, sinceSql: string): Promise<number> {
  const rows = await query(
    `SELECT COALESCE(SUM(credits_estimated),0) AS c
     FROM search_provider_usage
     WHERE tenant_id=? AND provider='tavily' AND created_at >= ${sinceSql}
       AND status IN ('ok','provider_error','rate_limited')`,
    [tenantId],
  );
  return Number(rows[0]?.c ?? 0);
}
async function tavilyUsedToday(tenantId: number): Promise<number> {
  return tavilyUsedSince(tenantId, 'CURDATE()');
}
async function tavilyUsedMonth(tenantId: number): Promise<number> {
  return tavilyUsedSince(tenantId, "DATE_FORMAT(CURDATE(),'%Y-%m-01')");
}
async function logSearchUsage(args: {
  tenantId: number; campaignId: number | null; provider: string; query: string;
  country?: string | null; language?: string | null;
  requested: number; returned: number; imported: number;
  status: 'ok'|'provider_error'|'credits_exhausted'|'timeout'|'not_configured'|'rate_limited';
  errorCode?: string | null; credits?: number; userId?: number | null;
}) {
  await query(
    `INSERT INTO search_provider_usage
       (tenant_id, collector_campaign_id, provider, query, country, language,
        requested_results, returned_results, imported_results, status, error_code,
        credits_estimated, triggered_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [args.tenantId, args.campaignId, args.provider, args.query.slice(0, 500),
     args.country ?? null, args.language ?? null,
     args.requested, args.returned, args.imported,
     args.status, args.errorCode ? args.errorCode.slice(0, 60) : null, args.credits ?? 1, args.userId ?? null],
  );
}

export const collectorRouter = Router();
collectorRouter.use(authMiddleware, requireTenant);

// ------------- Helpers -------------
// Tolerant array reader for JSON columns (keywords / preset_codes). Malformed
// JSON in the row must not 500 the request.
function safeArr(v: any): any[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { const x = JSON.parse(v); return Array.isArray(x) ? x : []; } catch { return []; } }
  return [];
}


async function getAdminSettings(tenantId: number) {
  const rows = await query('SELECT * FROM collector_admin_settings WHERE tenant_id=?', [tenantId]);
  if (rows.length) return rows[0];
  // Lazy-create default row
  await query(
    `INSERT IGNORE INTO collector_admin_settings (tenant_id) VALUES (?)`,
    [tenantId],
  );
  return (await query('SELECT * FROM collector_admin_settings WHERE tenant_id=?', [tenantId]))[0];
}

async function requireCollectorEnabled(tenantId: number) {
  const ld = await getLeadLimits(tenantId);
  if (!ld.enabled) return { ok: false as const, reason: 'lead_discovery_disabled' };
  const s = await getAdminSettings(tenantId);
  if (!s.collector_enabled) return { ok: false as const, reason: 'collector_disabled' };
  const g = await query('SELECT paused_globally FROM collector_global_settings WHERE id=1');
  if (g[0]?.paused_globally) return { ok: false as const, reason: 'collector_paused_globally' };
  return { ok: true as const, settings: s };
}

// ------------- Campaigns CRUD -------------

const campaignSchema = z.object({
  name: z.string().min(2).max(200),
  productProfileId: z.number().int().positive().nullable().optional(),
  mode: z.enum(['manual_urls','csv_import','search_provider','mixed']).default('manual_urls'),
  keywords: z.array(z.string().min(1).max(120)).max(20).default([]),
  countries: z.array(z.string().min(2).max(8)).max(20).default([]),
  languages: z.array(z.string().min(2).max(8)).max(10).default([]),
  presetCodes: z.array(z.string().min(2).max(40)).max(20).default([]),
  maxSourcesTotal: z.number().int().min(1).max(100000).default(1000),
  maxSourcesPerDay: z.number().int().min(1).max(5000).default(100),
  maxPagesPerSource: z.number().int().min(1).max(20).default(5),
  crawlDelaySeconds: z.number().int().min(1).max(60).default(2),
  analyzeWebsite: z.boolean().default(false),
  generateDraft: z.boolean().default(false),
});

collectorRouter.get('/campaigns', async (req, res) => {
  const rows = await query(
    `SELECT id, name, status, mode, max_sources_total, max_sources_per_day, max_pages_per_source,
            crawl_delay_seconds, analyze_website, generate_draft, product_profile_id,
            keywords, countries, languages, preset_codes, created_at, updated_at
     FROM collector_campaigns WHERE tenant_id=? ORDER BY created_at DESC LIMIT 200`,
    [req.auth!.tenantId],
  );
  res.json({ campaigns: rows });
});

collectorRouter.post('/campaigns', requireWriteAccess, async (req, res) => {
  const en = await requireCollectorEnabled(req.auth!.tenantId!);
  if (!en.ok) return res.status(402).json({ error: en.reason });
  const parsed = campaignSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', detail: parsed.error.flatten() });
  const p = parsed.data;
  const r = await query(
    `INSERT INTO collector_campaigns
       (tenant_id, product_profile_id, name, status, mode, keywords, countries, languages, preset_codes,
        max_sources_total, max_sources_per_day, max_pages_per_source, crawl_delay_seconds,
        analyze_website, generate_draft, created_by_user_id)
     VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      req.auth!.tenantId, p.productProfileId ?? null, p.name, p.mode,
      JSON.stringify(p.keywords), JSON.stringify(p.countries), JSON.stringify(p.languages),
      JSON.stringify(p.presetCodes), p.maxSourcesTotal, p.maxSourcesPerDay, p.maxPagesPerSource,
      p.crawlDelaySeconds, p.analyzeWebsite ? 1 : 0, p.generateDraft ? 1 : 0, req.auth!.userId,
    ],
  );
  await audit(req, 'collector.campaign.create', { type: 'collector_campaign', id: Number(r.insertId) });
  res.status(201).json({ id: Number(r.insertId) });
});

collectorRouter.patch('/campaigns/:id', requireWriteAccess, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const parsed = campaignSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });
  const owns = await query('SELECT id FROM collector_campaigns WHERE id=? AND tenant_id=? LIMIT 1', [id, req.auth!.tenantId]);
  if (!owns.length) return res.status(404).json({ error: 'not_found' });

  const fields: string[] = []; const params: any[] = [];
  const m = parsed.data;
  if (m.name !== undefined)              { fields.push('name=?');                 params.push(m.name); }
  if (m.productProfileId !== undefined)  { fields.push('product_profile_id=?');   params.push(m.productProfileId); }
  if (m.mode !== undefined)              { fields.push('mode=?');                 params.push(m.mode); }
  if (m.keywords !== undefined)          { fields.push('keywords=?');             params.push(JSON.stringify(m.keywords)); }
  if (m.countries !== undefined)         { fields.push('countries=?');            params.push(JSON.stringify(m.countries)); }
  if (m.languages !== undefined)         { fields.push('languages=?');            params.push(JSON.stringify(m.languages)); }
  if (m.presetCodes !== undefined)       { fields.push('preset_codes=?');         params.push(JSON.stringify(m.presetCodes)); }
  if (m.maxSourcesTotal !== undefined)   { fields.push('max_sources_total=?');    params.push(m.maxSourcesTotal); }
  if (m.maxSourcesPerDay !== undefined)  { fields.push('max_sources_per_day=?');  params.push(m.maxSourcesPerDay); }
  if (m.maxPagesPerSource !== undefined) { fields.push('max_pages_per_source=?'); params.push(m.maxPagesPerSource); }
  if (m.crawlDelaySeconds !== undefined) { fields.push('crawl_delay_seconds=?');  params.push(m.crawlDelaySeconds); }
  if (m.analyzeWebsite !== undefined)    { fields.push('analyze_website=?');      params.push(m.analyzeWebsite ? 1 : 0); }
  if (m.generateDraft !== undefined)     { fields.push('generate_draft=?');       params.push(m.generateDraft ? 1 : 0); }
  if (!fields.length) return res.status(400).json({ error: 'no_changes' });
  params.push(id, req.auth!.tenantId);
  await query(`UPDATE collector_campaigns SET ${fields.join(', ')} WHERE id=? AND tenant_id=?`, params);
  await audit(req, 'collector.campaign.update', { type: 'collector_campaign', id });
  res.json({ ok: true });
});

collectorRouter.post('/campaigns/:id/start', requireWriteAccess, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const en = await requireCollectorEnabled(req.auth!.tenantId!);
  if (!en.ok) return res.status(402).json({ error: en.reason });
  const r = await query(
    "UPDATE collector_campaigns SET status='active' WHERE id=? AND tenant_id=? AND status IN ('draft','paused')",
    [id, req.auth!.tenantId],
  );
  if (!r.affectedRows) return res.status(409).json({ error: 'cannot_start' });
  await audit(req, 'collector.campaign.start', { type: 'collector_campaign', id });
  res.json({ ok: true });
});

collectorRouter.post('/campaigns/:id/pause', requireWriteAccess, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = await query(
    "UPDATE collector_campaigns SET status='paused' WHERE id=? AND tenant_id=? AND status='active'",
    [id, req.auth!.tenantId],
  );
  if (!r.affectedRows) return res.status(409).json({ error: 'cannot_pause' });
  await audit(req, 'collector.campaign.pause', { type: 'collector_campaign', id });
  res.json({ ok: true });
});

// ------------- Bulk URL import -------------

const importUrlsSchema = z.object({
  urls: z.array(z.string().min(3).max(2000)).min(1).max(5000),
});

async function ingestUrls(tenantId: number, campaignId: number, urls: string[], mode: 'manual_urls'|'csv_import', userId: number): Promise<{ accepted: number; duplicates: number; invalid: number; blocked: number; queued: number; sample_invalid: string[] }> {
  const en = await requireCollectorEnabled(tenantId);
  if (!en.ok) throw new Error(en.reason);
  const settings = en.settings;
  let accepted = 0, duplicates = 0, invalid = 0, blocked = 0, queued = 0;
  const sampleInvalid: string[] = [];

  await withConn(async (c) => {
    for (const raw of urls) {
      const norm = normalizeUrl(raw);
      if (!norm.ok || !norm.url || !norm.domain) {
        invalid++;
        if (sampleInvalid.length < 10) sampleInvalid.push(raw);
        continue;
      }
      // Check tenant-level deduplication on lead_sources
      const existing = await c.query(
        'SELECT id FROM lead_sources WHERE tenant_id=? AND url=? LIMIT 1',
        [tenantId, norm.url],
      );
      let leadSourceId: number;
      if (existing.length) {
        leadSourceId = existing[0].id;
        duplicates++;
      } else {
        const ins = await c.query(
          `INSERT INTO lead_sources (tenant_id, url, domain, label, status, added_by)
           VALUES (?, ?, ?, ?, 'active', ?)`,
          [tenantId, norm.url, norm.domain, mode === 'csv_import' ? 'CSV import' : 'Bulk paste', userId],
        );
        leadSourceId = Number(ins.insertId);
        accepted++;
      }
      // Attach to campaign (unique constraint protects)
      try {
        await c.query(
          `INSERT INTO collector_campaign_sources
             (tenant_id, campaign_id, lead_source_id, added_by_mode, state)
           VALUES (?, ?, ?, ?, 'pending')`,
          [tenantId, campaignId, leadSourceId, mode],
        );
        queued++;
      } catch {
        // already attached — count under duplicates
        duplicates++;
      }
    }
  });

  // Track daily stats
  const today = new Date().toISOString().slice(0, 10);
  await query(
    `INSERT INTO collector_campaign_stats (tenant_id, campaign_id, \`date\`, sources_added)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE sources_added = sources_added + VALUES(sources_added)`,
    [tenantId, campaignId, today, accepted],
  );

  return { accepted, duplicates, invalid, blocked, queued, sample_invalid: sampleInvalid };
}

collectorRouter.post('/campaigns/:id/import-urls', requireWriteAccess, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const parsed = importUrlsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });

  const owns = await query('SELECT id FROM collector_campaigns WHERE id=? AND tenant_id=? LIMIT 1', [id, req.auth!.tenantId]);
  if (!owns.length) return res.status(404).json({ error: 'not_found' });

  try {
    const summary = await ingestUrls(req.auth!.tenantId!, id, parsed.data.urls, 'manual_urls', req.auth!.userId);
    const batch = await query(
      `INSERT INTO collector_import_batches
         (tenant_id, campaign_id, mode, submitted_count, accepted_count, duplicates_count,
          invalid_count, blocked_count, queued_count, summary, submitted_by)
       VALUES (?, ?, 'manual_urls', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.auth!.tenantId, id, parsed.data.urls.length,
       summary.accepted, summary.duplicates, summary.invalid, summary.blocked, summary.queued,
       JSON.stringify(summary), req.auth!.userId],
    );
    await audit(req, 'collector.import.urls', { type: 'collector_campaign', id }, summary);
    res.json({ batchId: Number(batch.insertId), ...summary });
  } catch (e: any) {
    res.status(402).json({ error: e.message });
  }
});

collectorRouter.post('/campaigns/:id/import-csv', requireWriteAccess, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  // Accept either JSON {csv:"a,b,c\nhttp://..."} or raw text/csv body
  const ct = req.header('content-type') ?? '';
  let csv = '';
  if (ct.includes('application/json')) {
    const parsed = z.object({ csv: z.string().min(1).max(2_000_000) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });
    csv = parsed.data.csv;
  } else if (ct.startsWith('text/')) {
    csv = typeof req.body === 'string' ? req.body : '';
  } else if (typeof req.body === 'object' && req.body && typeof (req.body as any).csv === 'string') {
    csv = (req.body as any).csv;
  } else {
    return res.status(400).json({ error: 'invalid_body' });
  }

  // Extract URL/domain tokens across lines and columns
  const tokens = csv
    .split(/\r?\n/)
    .flatMap((line) => line.split(/[,\t;]/))
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'));
  if (!tokens.length) return res.status(400).json({ error: 'empty_csv' });
  if (tokens.length > 5000) tokens.length = 5000;

  const owns = await query('SELECT id FROM collector_campaigns WHERE id=? AND tenant_id=? LIMIT 1', [id, req.auth!.tenantId]);
  if (!owns.length) return res.status(404).json({ error: 'not_found' });

  try {
    const summary = await ingestUrls(req.auth!.tenantId!, id, tokens, 'csv_import', req.auth!.userId);
    const batch = await query(
      `INSERT INTO collector_import_batches
         (tenant_id, campaign_id, mode, submitted_count, accepted_count, duplicates_count,
          invalid_count, blocked_count, queued_count, summary, submitted_by)
       VALUES (?, ?, 'csv_import', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.auth!.tenantId, id, tokens.length,
       summary.accepted, summary.duplicates, summary.invalid, summary.blocked, summary.queued,
       JSON.stringify(summary), req.auth!.userId],
    );
    await audit(req, 'collector.import.csv', { type: 'collector_campaign', id }, summary);
    res.json({ batchId: Number(batch.insertId), ...summary });
  } catch (e: any) {
    res.status(402).json({ error: e.message });
  }
});

// ------------- Search provider preview / import -------------

const searchSchema = z.object({
  provider: z.string().min(2).max(40).default(''),
  query: z.string().min(2).max(500).optional(),
  presetCodes: z.array(z.string()).max(20).default([]),
  country: z.string().max(8).optional(),
  language: z.string().max(8).optional(),
  maxResults: z.number().int().min(1).max(50).default(20),
});

collectorRouter.post('/campaigns/:id/search-preview', requireWriteAccess, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const parsed = searchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });
  const p = parsed.data;

  const campaigns = await query(
    'SELECT keywords, preset_codes FROM collector_campaigns WHERE id=? AND tenant_id=? LIMIT 1',
    [id, req.auth!.tenantId],
  );
  if (!campaigns.length) return res.status(404).json({ error: 'not_found' });
  const camp = campaigns[0];

  const provider = p.provider ? getSearchProvider(p.provider) : defaultConfiguredProvider();
  if (!provider) {
    return res.status(412).json({ error: 'search_provider_not_configured', providers: listSearchProviders() });
  }
  if (!provider.isConfigured()) {
    return res.status(412).json({ error: 'search_provider_not_configured', provider: provider.name });
  }

  // Hard-stop on Tavily credits before calling the paid API — same cap the
  // tenant-level /search-preview enforces (these campaign routes previously
  // bypassed it, letting a tenant burn unlimited credits).
  if (provider.name === 'tavily') {
    const dailyUsed = await tavilyUsedToday(req.auth!.tenantId!);
    const monthlyUsed = await tavilyUsedMonth(req.auth!.tenantId!);
    if (dailyUsed >= config.tavily.dailyCreditLimit || monthlyUsed >= config.tavily.monthlyCreditLimit) {
      return res.status(402).json({ error: 'credits_exhausted', daily_used: dailyUsed, monthly_used: monthlyUsed });
    }
  }

  const kws = safeArr(camp.keywords);
  const presetCodes = p.presetCodes.length ? p.presetCodes : safeArr(camp.preset_codes);

  const queries = p.query ? [p.query] : expandPresets(presetCodes, kws, p.country, p.language);
  const results: Array<{ url: string; title: string | null; snippet: string | null; query: string }> = [];
  for (const q of queries) {
    const items = await provider.search({ query: q, country: p.country, language: p.language, maxResults: p.maxResults });
    for (const it of items) results.push({ url: it.url, title: it.title ?? null, snippet: it.snippet ?? null, query: q });
    if (results.length >= p.maxResults) break;
  }

  await query(
    `INSERT INTO collector_search_provider_runs
       (tenant_id, campaign_id, provider, query, country, language, max_results,
        results_count, results, triggered_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      req.auth!.tenantId, id, provider.name,
      (queries[0] ?? '').slice(0, 500), p.country ?? null, p.language ?? null, p.maxResults,
      results.length, JSON.stringify(results.slice(0, p.maxResults)), req.auth!.userId,
    ],
  );
  res.json({ provider: provider.name, queries, results: results.slice(0, p.maxResults) });
});

collectorRouter.post('/campaigns/:id/search-import', requireWriteAccess, async (req, res) => {
  // Same as preview but immediately ingests URLs.
  const id = parseInt(req.params.id, 10);
  const parsed = searchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });
  const p = parsed.data;

  const campaigns = await query(
    'SELECT keywords, preset_codes FROM collector_campaigns WHERE id=? AND tenant_id=? LIMIT 1',
    [id, req.auth!.tenantId],
  );
  if (!campaigns.length) return res.status(404).json({ error: 'not_found' });
  const camp = campaigns[0];

  const provider = p.provider ? getSearchProvider(p.provider) : defaultConfiguredProvider();
  if (!provider || !provider.isConfigured()) {
    return res.status(412).json({ error: 'search_provider_not_configured', providers: listSearchProviders() });
  }

  // Hard-stop on Tavily credits before calling the paid API (see search-preview).
  if (provider.name === 'tavily') {
    const dailyUsed = await tavilyUsedToday(req.auth!.tenantId!);
    const monthlyUsed = await tavilyUsedMonth(req.auth!.tenantId!);
    if (dailyUsed >= config.tavily.dailyCreditLimit || monthlyUsed >= config.tavily.monthlyCreditLimit) {
      return res.status(402).json({ error: 'credits_exhausted', daily_used: dailyUsed, monthly_used: monthlyUsed });
    }
  }

  const kws = safeArr(camp.keywords);
  const presetCodes = p.presetCodes.length ? p.presetCodes : safeArr(camp.preset_codes);
  const queries = p.query ? [p.query] : expandPresets(presetCodes, kws, p.country, p.language);

  const urls: string[] = [];
  for (const q of queries) {
    const items = await provider.search({ query: q, country: p.country, language: p.language, maxResults: p.maxResults });
    for (const it of items) urls.push(it.url);
    if (urls.length >= p.maxResults) break;
  }
  if (!urls.length) return res.json({ accepted: 0, duplicates: 0, invalid: 0, blocked: 0, queued: 0, reason: 'no_results' });

  try {
    const summary = await ingestUrls(req.auth!.tenantId!, id, urls, 'manual_urls', req.auth!.userId);
    await audit(req, 'collector.import.search', { type: 'collector_campaign', id }, { provider: provider.name, ...summary });
    res.json({ provider: provider.name, ...summary });
  } catch (e: any) {
    res.status(402).json({ error: e.message });
  }
});

// ------------- Stats -------------

collectorRouter.get('/campaigns/:id/stats', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const owns = await query('SELECT name, status FROM collector_campaigns WHERE id=? AND tenant_id=? LIMIT 1', [id, req.auth!.tenantId]);
  if (!owns.length) return res.status(404).json({ error: 'not_found' });

  const last30 = await query(
    `SELECT \`date\`, sources_added, sources_crawled, leads_found, leads_new, websites_analyzed, drafts_generated
     FROM collector_campaign_stats
     WHERE tenant_id=? AND campaign_id=? AND \`date\` >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)
     ORDER BY \`date\` DESC`,
    [req.auth!.tenantId, id],
  );
  const totals = await query(
    `SELECT
       COUNT(*) AS sources_total,
       SUM(state='pending')    AS sources_pending,
       SUM(state='queued')     AS sources_queued,
       SUM(state='running')    AS sources_running,
       SUM(state='succeeded')  AS sources_succeeded,
       SUM(state='failed')     AS sources_failed
     FROM collector_campaign_sources WHERE tenant_id=? AND campaign_id=?`,
    [req.auth!.tenantId, id],
  );
  res.json({ campaign: owns[0], totals: totals[0], days: last30 });
});

collectorRouter.get('/admin-settings', async (req, res) => {
  res.json(await getAdminSettings(req.auth!.tenantId!));
});

collectorRouter.get('/presets', (_req, res) => {
  res.json({ presets: PRESETS.map((p) => ({ code: p.code, label: p.label })) });
});

// Provider status with Tavily credit accounting (per-tenant).
collectorRouter.get('/search-providers', async (req, res) => {
  const baseList = listSearchProviders();
  const tenantId = req.auth!.tenantId!;
  const out: any[] = [];
  for (const p of baseList) {
    if (p.name === 'tavily') {
      const dailyUsed = await tavilyUsedToday(tenantId);
      const monthlyUsed = await tavilyUsedMonth(tenantId);
      const dailyLimit = config.tavily.dailyCreditLimit;
      const monthlyLimit = config.tavily.monthlyCreditLimit;
      const lastError = (await query(
        `SELECT status, error_code FROM search_provider_usage
         WHERE provider='tavily' AND tenant_id=? ORDER BY id DESC LIMIT 1`,
        [tenantId],
      ))[0];
      let status: 'ready' | 'not_configured' | 'credits_exhausted' | 'provider_error' | 'disabled' =
        p.configured ? 'ready' : 'not_configured';
      if (p.configured) {
        if (dailyUsed >= dailyLimit || monthlyUsed >= monthlyLimit) status = 'credits_exhausted';
        else if (lastError?.status === 'credits_exhausted')           status = 'credits_exhausted';
        else if (lastError?.status === 'provider_error')              status = 'provider_error';
      }
      // Per-key snapshot (masked labels only — never raw secrets).
      const keyStatus = (tavilyProvider as any).keyStatus ? (tavilyProvider as any).keyStatus() as Array<{ label: string; exhausted: boolean; until: number | null; reason: string | null }> : [];
      out.push({
        name: 'tavily',
        configured: p.configured,
        enabled: p.configured && status === 'ready',
        status,
        daily_used: dailyUsed,
        daily_limit: dailyLimit,
        monthly_used: monthlyUsed,
        monthly_limit: monthlyLimit,
        last_error_code: lastError?.error_code ?? null,
        keys: keyStatus,
        keys_total: keyStatus.length,
        keys_active: keyStatus.filter((k) => !k.exhausted).length,
      });
    } else {
      out.push({ name: p.name, configured: p.configured, enabled: p.configured, status: p.configured ? 'ready' : 'not_configured' });
    }
  }
  const defaultProviderName = config.search.defaultProvider || (out.find((x) => x.enabled)?.name ?? null);
  res.json({ providers: out, default_provider: defaultProviderName });
});

// ------------- Tenant-level search preview / import (no campaign id required) -------------
const tenantSearchSchema = z.object({
  provider: z.string().min(2).max(40).optional(),
  query: z.string().min(2).max(500).optional(),
  presetCodes: z.array(z.string()).max(20).default([]),
  keywords: z.array(z.string().min(1).max(120)).max(20).default([]),
  country: z.string().max(8).optional(),
  language: z.string().max(8).optional(),
  maxResults: z.number().int().min(1).max(50).default(10),
  campaignId: z.number().int().positive().optional(),
});

function pickProvider(name?: string) {
  if (name) return getSearchProvider(name);
  if (config.search.defaultProvider) return getSearchProvider(config.search.defaultProvider);
  return defaultConfiguredProvider();
}

collectorRouter.post('/search-preview', requireWriteAccess, async (req, res) => {
  const parsed = tenantSearchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', detail: parsed.error.flatten() });
  const p = parsed.data;

  const provider = pickProvider(p.provider);
  if (!provider || !provider.isConfigured()) {
    await logSearchUsage({
      tenantId: req.auth!.tenantId!, campaignId: p.campaignId ?? null,
      provider: provider?.name ?? (p.provider ?? 'unknown'),
      query: p.query ?? p.presetCodes.join(','), requested: p.maxResults, returned: 0, imported: 0,
      status: 'not_configured', credits: 0, userId: req.auth!.userId,
    });
    return res.status(412).json({ error: 'search_provider_not_configured' });
  }

  // Hard-stop on monthly credits before calling the API.
  if (provider.name === 'tavily') {
    const dailyUsed = await tavilyUsedToday(req.auth!.tenantId!);
    const monthlyUsed = await tavilyUsedMonth(req.auth!.tenantId!);
    if (dailyUsed >= config.tavily.dailyCreditLimit || monthlyUsed >= config.tavily.monthlyCreditLimit) {
      await logSearchUsage({
        tenantId: req.auth!.tenantId!, campaignId: p.campaignId ?? null, provider: 'tavily',
        query: p.query ?? p.presetCodes.join(','), requested: p.maxResults, returned: 0, imported: 0,
        status: 'credits_exhausted', errorCode: 'local_limit', credits: 0, userId: req.auth!.userId,
      });
      return res.status(402).json({ error: 'credits_exhausted', daily_used: dailyUsed, monthly_used: monthlyUsed });
    }
  }

  const queries = p.query ? [p.query] : expandPresets(p.presetCodes, p.keywords, p.country, p.language);
  if (!queries.length) return res.status(400).json({ error: 'no_query' });

  const results: Array<{ url: string; title: string | null; snippet: string | null; query: string; provider: string; discovered_at: string; domain: string }> = [];
  let lastStatus: 'ok' | 'provider_error' | 'credits_exhausted' | 'timeout' | 'rate_limited' = 'ok';
  let errorCode: string | null = null;

  for (const q of queries) {
    try {
      const items = await provider.search({ query: q, country: p.country, language: p.language, maxResults: p.maxResults });
      for (const it of items) {
        let domain = '';
        try { domain = new URL(it.url).hostname.replace(/^www\./, '').toLowerCase(); } catch {}
        results.push({
          url: it.url, title: it.title ?? null, snippet: it.snippet ?? null,
          query: q, provider: provider.name,
          discovered_at: new Date().toISOString(), domain,
        });
      }
      await logSearchUsage({
        tenantId: req.auth!.tenantId!, campaignId: p.campaignId ?? null, provider: provider.name,
        query: q, country: p.country ?? null, language: p.language ?? null,
        requested: p.maxResults, returned: items.length, imported: 0, status: 'ok',
        credits: 1, userId: req.auth!.userId,
      });
    } catch (e: any) {
      if (e instanceof TavilyError) {
        lastStatus = e.code as any;
        errorCode = e.detail;
      } else {
        lastStatus = 'provider_error';
        errorCode = String(e?.message ?? '').slice(0, 100);
      }
      await logSearchUsage({
        tenantId: req.auth!.tenantId!, campaignId: p.campaignId ?? null, provider: provider.name,
        query: q, country: p.country ?? null, language: p.language ?? null,
        requested: p.maxResults, returned: 0, imported: 0,
        status: lastStatus, errorCode, credits: lastStatus === 'ok' ? 1 : 0, userId: req.auth!.userId,
      });
      break; // Stop on provider error — don't burn more credits.
    }
    if (results.length >= p.maxResults) break;
  }

  // Dedup against existing lead_sources by domain
  const trimmed = results.slice(0, p.maxResults);
  const domains = [...new Set(trimmed.map((r) => r.domain).filter(Boolean))];
  const existing = domains.length
    ? await query(
        `SELECT DISTINCT domain FROM lead_sources WHERE tenant_id=? AND domain IN (${domains.map(() => '?').join(',')})`,
        [req.auth!.tenantId, ...domains],
      )
    : [];
  const existSet = new Set<string>(existing.map((r: any) => r.domain));
  const annotated = trimmed.map((r) => ({ ...r, duplicate: existSet.has(r.domain) }));

  // Credit info after the run
  let dailyUsed = 0; let monthlyUsed = 0;
  if (provider.name === 'tavily') {
    dailyUsed = await tavilyUsedToday(req.auth!.tenantId!);
    monthlyUsed = await tavilyUsedMonth(req.auth!.tenantId!);
  }

  res.json({
    provider: provider.name,
    queries,
    results: annotated,
    status: lastStatus,
    error_code: errorCode,
    found: annotated.length,
    accepted: annotated.filter((r) => !r.duplicate).length,
    duplicates: annotated.filter((r) =>  r.duplicate).length,
    invalid: 0,
    blocked: 0,
    tavily_daily_used: dailyUsed,
    tavily_daily_limit: config.tavily.dailyCreditLimit,
    tavily_monthly_used: monthlyUsed,
    tavily_monthly_limit: config.tavily.monthlyCreditLimit,
  });
});

const tenantImportSchema = z.object({
  campaignId: z.number().int().positive(),
  urls: z.array(z.string().min(3).max(2000)).max(200).optional(),
  // Or rerun query + import:
  rerun: tenantSearchSchema.optional(),
});

collectorRouter.post('/search-import', requireWriteAccess, async (req, res) => {
  const parsed = tenantImportSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });

  // Verify campaign ownership
  const owns = await query(
    'SELECT id FROM collector_campaigns WHERE id=? AND tenant_id=? LIMIT 1',
    [parsed.data.campaignId, req.auth!.tenantId],
  );
  if (!owns.length) return res.status(404).json({ error: 'campaign_not_found' });

  let urls: string[] = parsed.data.urls ?? [];

  if (!urls.length && parsed.data.rerun) {
    const p = parsed.data.rerun;
    const provider = pickProvider(p.provider);
    if (!provider || !provider.isConfigured()) return res.status(412).json({ error: 'search_provider_not_configured' });

    if (provider.name === 'tavily') {
      const monthlyUsed = await tavilyUsedMonth(req.auth!.tenantId!);
      const dailyUsed = await tavilyUsedToday(req.auth!.tenantId!);
      if (dailyUsed >= config.tavily.dailyCreditLimit || monthlyUsed >= config.tavily.monthlyCreditLimit) {
        return res.status(402).json({ error: 'credits_exhausted' });
      }
    }

    const queries = p.query ? [p.query] : expandPresets(p.presetCodes, p.keywords, p.country, p.language);
    for (const q of queries) {
      try {
        const items = await provider.search({ query: q, country: p.country, language: p.language, maxResults: p.maxResults });
        for (const it of items) urls.push(it.url);
        await logSearchUsage({
          tenantId: req.auth!.tenantId!, campaignId: parsed.data.campaignId, provider: provider.name,
          query: q, country: p.country ?? null, language: p.language ?? null,
          requested: p.maxResults, returned: items.length, imported: items.length,
          status: 'ok', credits: 1, userId: req.auth!.userId,
        });
      } catch (e: any) {
        const code = e instanceof TavilyError ? e.code : 'provider_error';
        await logSearchUsage({
          tenantId: req.auth!.tenantId!, campaignId: parsed.data.campaignId, provider: provider.name,
          query: q, country: p.country ?? null, language: p.language ?? null,
          requested: p.maxResults, returned: 0, imported: 0,
          status: code as any, errorCode: e?.detail ?? e?.message, credits: 0, userId: req.auth!.userId,
        });
        return res.status(502).json({ error: code, detail: e?.detail ?? null });
      }
      if (urls.length >= p.maxResults) break;
    }
  }

  if (!urls.length) return res.status(400).json({ error: 'no_urls_to_import' });

  try {
    const summary = await ingestUrls(req.auth!.tenantId!, parsed.data.campaignId, urls, 'manual_urls', req.auth!.userId);
    await audit(req, 'collector.import.search', { type: 'collector_campaign', id: parsed.data.campaignId }, summary);
    res.json(summary);
  } catch (e: any) {
    res.status(402).json({ error: e.message });
  }
});

// ------------- Free providers (OSM Overpass) -------------

collectorRouter.get('/free-providers', async (_req, res) => {
  // Static for now. OSM is the only free provider wired.
  res.json({
    providers: [
      {
        name: 'osm_overpass',
        configured: true,
        status: 'ready',
        categories: Object.entries(OSM_CATEGORIES).map(([code, c]) => ({ code, label: c.label })),
        notes: 'Polite usage: 1 request per ~6s, results cached 5 minutes per query.',
      },
    ],
  });
});

const osmPreviewSchema = z.object({
  category: z.enum([
    'web_agency','beauty_salon','dental_clinic','repair_service','fitness_studio',
    'restaurant_cafe','real_estate','law_firm','clinic','ecommerce_shop','local_service',
  ]),
  country: z.string().min(2).max(8).optional(),
  city: z.string().min(2).max(120).optional(),
  bbox: z.array(z.number()).length(4).optional(),
  maxResults: z.number().int().min(1).max(200).default(20),
  onlyWithWebsite: z.boolean().default(true),
  campaignId: z.number().int().positive().optional(),
});

async function logOsmUsage(args: {
  tenantId: number; campaignId: number | null; query: string;
  country?: string | null; requested: number; returned: number; imported: number;
  status: 'ok'|'provider_error'|'timeout'|'rate_limited'|'not_configured';
  errorCode?: string | null; userId: number | null;
}) {
  await query(
    `INSERT INTO search_provider_usage
       (tenant_id, collector_campaign_id, provider, query, country, language,
        requested_results, returned_results, imported_results, status, error_code,
        credits_estimated, triggered_by)
     VALUES (?, ?, 'osm_overpass', ?, ?, NULL, ?, ?, ?, ?, ?, 0, ?)`,
    [args.tenantId, args.campaignId, args.query.slice(0, 500), args.country ?? null,
     args.requested, args.returned, args.imported, args.status,
     args.errorCode ? args.errorCode.slice(0, 60) : null, args.userId],
  );
}

collectorRouter.post('/osm-preview', requireWriteAccess, async (req, res) => {
  const parsed = osmPreviewSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', detail: parsed.error.flatten() });
  const p = parsed.data;

  // Lazy ensure collector enabled for tenant (same gate as the rest of collector).
  const en = await requireCollectorEnabled(req.auth!.tenantId!);
  if (!en.ok) return res.status(402).json({ error: en.reason });

  try {
    const { results, cached } = await osmSearch({
      category: p.category as OsmCategory,
      country: p.country, city: p.city, bbox: p.bbox as any,
      maxResults: p.maxResults, onlyWithWebsite: p.onlyWithWebsite,
    });

    const withWebsite = results.filter((r) => r.website);
    const trimmed = (p.onlyWithWebsite ? withWebsite : results).slice(0, p.maxResults);

    // Dedup against existing lead_sources by domain
    const domains = [...new Set(trimmed.map((r) => {
      try { return r.website ? new URL(r.website).hostname.replace(/^www\./, '').toLowerCase() : null; }
      catch { return null; }
    }).filter(Boolean) as string[])];
    const existing = domains.length
      ? await query(
          `SELECT DISTINCT domain FROM lead_sources WHERE tenant_id=? AND domain IN (${domains.map(() => '?').join(',')})`,
          [req.auth!.tenantId, ...domains],
        )
      : [];
    const existSet = new Set<string>(existing.map((r: any) => r.domain));
    const annotated = trimmed.map((r) => {
      let domain: string | null = null;
      try { domain = r.website ? new URL(r.website).hostname.replace(/^www\./, '').toLowerCase() : null; } catch {}
      return { ...r, domain, duplicate: domain ? existSet.has(domain) : false };
    });

    if (!cached) {
      await logOsmUsage({
        tenantId: req.auth!.tenantId!, campaignId: p.campaignId ?? null,
        query: `osm:${p.category}:${p.city ?? p.country ?? 'bbox'}`,
        country: p.country ?? null, requested: p.maxResults,
        returned: results.length, imported: 0, status: 'ok', userId: req.auth!.userId,
      });
    }

    res.json({
      provider: 'osm_overpass',
      cached,
      total_returned: results.length,
      total_with_website: withWebsite.length,
      results: annotated,
      found: annotated.length,
      accepted: annotated.filter((r) => !r.duplicate).length,
      duplicates: annotated.filter((r) =>  r.duplicate).length,
    });
  } catch (e: any) {
    const code = e instanceof OsmError ? e.code : 'provider_error';
    await logOsmUsage({
      tenantId: req.auth!.tenantId!, campaignId: p.campaignId ?? null,
      query: `osm:${p.category}:${p.city ?? p.country ?? 'bbox'}`,
      country: p.country ?? null, requested: p.maxResults,
      returned: 0, imported: 0, status: code as any,
      errorCode: e?.detail ?? e?.message, userId: req.auth!.userId,
    });
    if (code === 'rate_limited') return res.status(429).json({ error: code });
    if (code === 'timeout')      return res.status(504).json({ error: code });
    if (code === 'bad_query')    return res.status(400).json({ error: code, detail: e?.detail });
    return res.status(502).json({ error: code, detail: e?.detail ?? null });
  }
});

const osmImportSchema = z.object({
  campaignId: z.number().int().positive(),
  // Either explicit URL list OR re-run a query:
  urls: z.array(z.string().min(3).max(2000)).max(200).optional(),
  query: osmPreviewSchema.optional(),
});

collectorRouter.post('/osm-import', requireWriteAccess, async (req, res) => {
  const parsed = osmImportSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });

  const owns = await query('SELECT id FROM collector_campaigns WHERE id=? AND tenant_id=? LIMIT 1',
    [parsed.data.campaignId, req.auth!.tenantId]);
  if (!owns.length) return res.status(404).json({ error: 'campaign_not_found' });

  let urls: string[] = parsed.data.urls ?? [];

  if (!urls.length && parsed.data.query) {
    const p = parsed.data.query;
    try {
      const { results } = await osmSearch({
        category: p.category as OsmCategory,
        country: p.country, city: p.city, bbox: p.bbox as any,
        maxResults: p.maxResults, onlyWithWebsite: true,
      });
      for (const r of results) if (r.website) urls.push(r.website);
      await logOsmUsage({
        tenantId: req.auth!.tenantId!, campaignId: parsed.data.campaignId,
        query: `osm:${p.category}:${p.city ?? p.country ?? 'bbox'}`,
        country: p.country ?? null, requested: p.maxResults,
        returned: results.length, imported: urls.length, status: 'ok', userId: req.auth!.userId,
      });
    } catch (e: any) {
      const code = e instanceof OsmError ? e.code : 'provider_error';
      await logOsmUsage({
        tenantId: req.auth!.tenantId!, campaignId: parsed.data.campaignId,
        query: `osm:${p.category}:${p.city ?? p.country ?? 'bbox'}`,
        country: p.country ?? null, requested: p.maxResults,
        returned: 0, imported: 0, status: code as any,
        errorCode: e?.detail ?? e?.message, userId: req.auth!.userId,
      });
      return res.status(502).json({ error: code, detail: e?.detail ?? null });
    }
  }

  if (!urls.length) return res.status(400).json({ error: 'no_urls_to_import' });

  try {
    const summary = await ingestUrls(req.auth!.tenantId!, parsed.data.campaignId, urls, 'manual_urls', req.auth!.userId);
    await audit(req, 'collector.import.osm', { type: 'collector_campaign', id: parsed.data.campaignId }, summary);
    res.json({ provider: 'osm_overpass', ...summary });
  } catch (e: any) {
    res.status(402).json({ error: e.message });
  }
});

collectorRouter.get('/source-runs', async (req, res) => {
  const rows = await query(
    `SELECT id, provider, query, country, returned_results, imported_results, status, error_code, created_at
     FROM search_provider_usage WHERE tenant_id=?
     ORDER BY id DESC LIMIT 50`,
    [req.auth!.tenantId],
  );
  res.json({ runs: rows });
});

// ------------- Collection Agent status (aggregated dashboard) -------------
// Read-only snapshot for the "Collection Agent" UI. No mutation, no sending.
collectorRouter.get('/agent-status', async (req, res) => {
  const tenantId = req.auth!.tenantId!;

  // Campaign run-state
  const [campAgg] = await query(
    `SELECT
       SUM(status='active')    AS active,
       SUM(status='paused')    AS paused,
       SUM(status='draft')     AS draft,
       SUM(status='completed') AS completed,
       COUNT(*)                AS total
     FROM collector_campaigns WHERE tenant_id=?`,
    [tenantId],
  );
  const [globalRow] = await query('SELECT paused_globally, paused_reason FROM collector_global_settings WHERE id=1', []).catch(() => [null]);
  const activeCount = Number(campAgg?.active ?? 0);
  const globallyPaused = !!(globalRow?.paused_globally);
  const running = activeCount > 0 && !globallyPaused;

  // Today's throughput (across tenant campaigns)
  const [today] = await query(
    `SELECT COALESCE(SUM(sources_added),0) AS sources_added,
            COALESCE(SUM(sources_crawled),0) AS sources_crawled,
            COALESCE(SUM(leads_found),0) AS leads_found,
            COALESCE(SUM(leads_new),0) AS leads_new,
            COALESCE(SUM(websites_analyzed),0) AS websites_analyzed,
            COALESCE(SUM(drafts_generated),0) AS drafts_generated
     FROM collector_campaign_stats WHERE tenant_id=? AND \`date\`=CURDATE()`,
    [tenantId],
  );

  // Queue pending
  const [queue] = await query(
    `SELECT SUM(state='pending') AS pending, SUM(state='queued') AS queued, SUM(state='running') AS running
     FROM collector_campaign_sources WHERE tenant_id=?`,
    [tenantId],
  );

  // Recent errors (last 24h) + last error code
  const [errAgg] = await query(
    `SELECT COUNT(*) AS errors,
            MAX(CASE WHEN status NOT IN ('ok') THEN error_code END) AS last_error
     FROM search_provider_usage
     WHERE tenant_id=? AND created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
       AND status NOT IN ('ok')`,
    [tenantId],
  );

  // Tavily credits
  const tavilyConfigured = listSearchProviders().some(p => p.name === 'tavily' && p.configured);
  const dailyUsed = await tavilyUsedToday(tenantId);
  const monthlyUsed = await tavilyUsedMonth(tenantId);

  // OSM status — free fallback, no credentials required.
  const osmStatus = 'ready';

  // Cooldown cities from Redis (perpetualCollector OSM cooldown keys)
  let cooldownCities: string[] = [];
  try {
    const keys = await redis.keys('perpcol:osm:cooldown:*');
    cooldownCities = keys.map(k => k.replace('perpcol:osm:cooldown:', '')).slice(0, 50);
  } catch { cooldownCities = []; }

  // Last activity timestamp
  const [last] = await query(
    `SELECT MAX(created_at) AS ts FROM search_provider_usage WHERE tenant_id=?`,
    [tenantId],
  );

  res.json({
    agent: {
      state: globallyPaused ? 'paused_global' : (running ? 'running' : 'paused'),
      running,
      globallyPaused,
      globalPauseReason: globalRow?.paused_reason ?? null,
      campaigns: {
        active: activeCount,
        paused: Number(campAgg?.paused ?? 0),
        draft: Number(campAgg?.draft ?? 0),
        completed: Number(campAgg?.completed ?? 0),
        total: Number(campAgg?.total ?? 0),
      },
    },
    today: {
      sourcesFound: Number(today?.sources_added ?? 0),
      sourcesCrawled: Number(today?.sources_crawled ?? 0),
      leadsFound: Number(today?.leads_found ?? 0),
      leadsNew: Number(today?.leads_new ?? 0),
      websitesAnalyzed: Number(today?.websites_analyzed ?? 0),
      draftsGenerated: Number(today?.drafts_generated ?? 0),
    },
    queue: {
      pending: Number(queue?.pending ?? 0),
      queued: Number(queue?.queued ?? 0),
      running: Number(queue?.running ?? 0),
    },
    errors: {
      last24h: Number(errAgg?.errors ?? 0),
      lastErrorCode: errAgg?.last_error ?? null,
    },
    tavily: {
      configured: tavilyConfigured,
      dailyUsed,
      dailyLimit: config.tavily.dailyCreditLimit,
      monthlyUsed,
      monthlyLimit: config.tavily.monthlyCreditLimit,
    },
    osm: { status: osmStatus, free: true },
    cooldownCities,
    lastActivityAt: last?.ts ?? null,
  });
});

// ------------- Super-admin: per-tenant collector settings -------------
export const collectorAdminRouter = Router();
collectorAdminRouter.use(authMiddleware, requireSuperAdmin);

collectorAdminRouter.get('/tenants', async (_req, res) => {
  const rows = await query(
    `SELECT t.id, t.name, t.slug, t.status, t.lead_discovery_enabled,
            cas.collector_enabled, cas.max_sources_per_day, cas.max_leads_per_day, cas.max_pages_per_source,
            cas.allow_manual_urls, cas.allow_csv_import, cas.allow_search_provider, cas.paused_globally
     FROM tenants t
     LEFT JOIN collector_admin_settings cas ON cas.tenant_id = t.id
     ORDER BY t.created_at DESC LIMIT 500`,
  );
  res.json({ tenants: rows });
});

const adminPatchSchema = z.object({
  collectorEnabled: z.boolean().optional(),
  maxSourcesPerDay: z.number().int().min(0).max(100000).optional(),
  maxLeadsPerDay: z.number().int().min(0).max(1000000).optional(),
  maxPagesPerSource: z.number().int().min(1).max(20).optional(),
  allowManualUrls: z.boolean().optional(),
  allowCsvImport: z.boolean().optional(),
  allowSearchProvider: z.boolean().optional(),
  pausedGlobally: z.boolean().optional(),
});

collectorAdminRouter.patch('/tenants/:tenantId', async (req, res) => {
  const tenantId = parseInt(req.params.tenantId, 10);
  const parsed = adminPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });
  const p = parsed.data;

  await query('INSERT IGNORE INTO collector_admin_settings (tenant_id) VALUES (?)', [tenantId]);

  const fields: string[] = []; const params: any[] = [];
  if (p.collectorEnabled    !== undefined) { fields.push('collector_enabled=?');     params.push(p.collectorEnabled ? 1 : 0); }
  if (p.maxSourcesPerDay    !== undefined) { fields.push('max_sources_per_day=?');   params.push(p.maxSourcesPerDay); }
  if (p.maxLeadsPerDay      !== undefined) { fields.push('max_leads_per_day=?');     params.push(p.maxLeadsPerDay); }
  if (p.maxPagesPerSource   !== undefined) { fields.push('max_pages_per_source=?');  params.push(p.maxPagesPerSource); }
  if (p.allowManualUrls     !== undefined) { fields.push('allow_manual_urls=?');     params.push(p.allowManualUrls ? 1 : 0); }
  if (p.allowCsvImport      !== undefined) { fields.push('allow_csv_import=?');      params.push(p.allowCsvImport ? 1 : 0); }
  if (p.allowSearchProvider !== undefined) { fields.push('allow_search_provider=?'); params.push(p.allowSearchProvider ? 1 : 0); }
  if (p.pausedGlobally      !== undefined) { fields.push('paused_globally=?');       params.push(p.pausedGlobally ? 1 : 0); }
  if (!fields.length) return res.status(400).json({ error: 'no_changes' });
  params.push(tenantId);
  await query(`UPDATE collector_admin_settings SET ${fields.join(', ')} WHERE tenant_id=?`, params);
  await audit(req, 'collector.admin.update', { type: 'tenant', id: tenantId }, p);
  res.json({ ok: true });
});

const globalPatchSchema = z.object({ pausedGlobally: z.boolean(), reason: z.string().max(255).optional() });
collectorAdminRouter.patch('/global', async (req, res) => {
  const parsed = globalPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });
  await query(
    'UPDATE collector_global_settings SET paused_globally=?, paused_reason=? WHERE id=1',
    [parsed.data.pausedGlobally ? 1 : 0, parsed.data.reason ?? null],
  );
  await audit(req, 'collector.admin.global', undefined, parsed.data);
  res.json({ ok: true });
});
