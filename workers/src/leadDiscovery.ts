import { query, tx } from './db.js';
import { redis, dedicatedRedis } from './redis.js';
import { logger } from './logger.js';
import { loadRobots } from './services/robotsTxt.js';
import { extractEmails } from './services/emailExtract.js';

const UA = 'EmailPlatformLeadDiscovery/0.1 (+https://email.clients.help/about/crawler)';
const MAX_PAGES_HARD_CAP = 20;
const DEFAULT_DELAY_MS = 2000;        // polite default
const FETCH_TIMEOUT_MS = 12000;
const MAX_HTML_BYTES = 1_500_000;
const LOCK_TTL_S = 600;
const STALE_RUNNING_MIN = 60;          // jobs stuck in 'running' past this are reaped
const COMMON_CONTACT_PATHS = [
  '/contact', '/contact-us', '/contacts', '/about', '/about-us',
  '/company', '/team', '/imprint', '/impressum', '/legal',
  '/help', '/support',
];

interface JobRow {
  id: number;
  tenant_id: number;
  source_id: number;
  max_pages: number;
  status: string;
  source_url: string;
  source_domain: string;
}

async function loadJob(jobId: number): Promise<JobRow | null> {
  const rows = await query(
    `SELECT j.id, j.tenant_id, j.source_id, j.max_pages, j.status,
            s.url AS source_url, s.domain AS source_domain
     FROM discovery_jobs j
     JOIN lead_sources s ON s.id = j.source_id
     WHERE j.id = ? LIMIT 1`,
    [jobId],
  );
  return rows[0] ?? null;
}

async function fetchPage(url: string): Promise<{ html: string | null; status: number; finalUrl: string }> {
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': UA,
        'accept': 'text/html,application/xhtml+xml',
        'accept-language': 'en,*;q=0.5',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { html: null, status: res.status, finalUrl: res.url };
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.toLowerCase().includes('text/html')) return { html: null, status: res.status, finalUrl: res.url };

    // Read up to MAX_HTML_BYTES to avoid OOM on huge pages
    const reader = res.body?.getReader();
    if (!reader) return { html: null, status: res.status, finalUrl: res.url };
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < MAX_HTML_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    try { await reader.cancel(); } catch {}
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.length; }
    return { html: new TextDecoder('utf-8', { fatal: false }).decode(buf), status: res.status, finalUrl: res.url };
  } catch (e: any) {
    return { html: null, status: 0, finalUrl: url };
  }
}

function sameOrigin(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.hostname.replace(/^www\./, '') === ub.hostname.replace(/^www\./, '');
  } catch { return false; }
}

function extractInternalLinks(html: string, base: string): string[] {
  const out = new Set<string>();
  const re = /href\s*=\s*["']([^"'#]+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      const abs = new URL(m[1], base).toString();
      if (sameOrigin(abs, base) && /^https?:/.test(abs)) out.add(abs);
    } catch {}
  }
  return [...out];
}

function prioritizeContactPaths(origin: string, links: string[]): string[] {
  const score = (u: string): number => {
    const path = (new URL(u)).pathname.toLowerCase();
    let s = 0;
    for (const p of COMMON_CONTACT_PATHS) if (path.includes(p)) s += 10;
    if (path === '/' || path === '') s -= 1;
    return s;
  };
  return [...new Set(links)].sort((a, b) => score(b) - score(a));
}

async function processJob(job: JobRow): Promise<void> {
  const maxPages = Math.min(MAX_PAGES_HARD_CAP, job.max_pages);
  await query("UPDATE discovery_jobs SET status='running', started_at=NOW() WHERE id=?", [job.id]);

  const origin = (() => { try { return new URL(job.source_url).origin; } catch { return null; } })();
  if (!origin) {
    await query("UPDATE discovery_jobs SET status='failed', error='invalid_url', finished_at=NOW() WHERE id=?", [job.id]);
    return;
  }

  const robots = await loadRobots(origin);
  const delayMs = Math.max(DEFAULT_DELAY_MS, Math.round(robots.crawlDelaySec * 1000));

  if (!robots.allowed(new URL(job.source_url).pathname)) {
    await query(
      "UPDATE discovery_jobs SET status='skipped_robots', error='disallowed_by_robots_txt', finished_at=NOW() WHERE id=?",
      [job.id],
    );
    await query("UPDATE lead_sources SET robots_allowed=0, last_status_detail=? WHERE id=?",
      [JSON.stringify({ reason: 'disallowed_by_robots_txt' }), job.source_id]);
    return;
  }

  const visited = new Set<string>();
  let queueLinks: string[] = [job.source_url];
  let pagesFetched = 0;
  let leadsFound = 0;
  let leadsNew = 0;

  while (queueLinks.length && pagesFetched < maxPages) {
    const url = queueLinks.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);

    try {
      const path = new URL(url).pathname;
      if (!robots.allowed(path)) continue;
    } catch { continue; }

    const r = await fetchPage(url);
    pagesFetched++;
    if (!r.html) continue;

    const { emails, title, snippets } = extractEmails(r.html);
    leadsFound += emails.length;

    for (const e of emails) {
      const ins = await query(
        `INSERT IGNORE INTO discovered_leads
           (tenant_id, source_id, discovery_job_id, email, email_domain, company_domain,
            source_url, page_title, context_snippet, role_hint, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'discovered')`,
        [
          job.tenant_id, job.source_id, job.id, e.email,
          e.email.split('@')[1],
          job.source_domain,
          r.finalUrl, title, snippets[e.email] ?? null, e.roleHint,
        ],
      );
      if (ins.affectedRows && ins.insertId) leadsNew++;
    }

    // First page only: enqueue prioritized internal links
    // If homepage has no emails, also probe common contact paths directly (bypass JS-rendered links)
    if (pagesFetched === 1) {
      const links = extractInternalLinks(r.html, r.finalUrl);
      const fromLinks = prioritizeContactPaths(origin, links);
      if (emails.length === 0) {
        const probed = COMMON_CONTACT_PATHS.map((p) => origin + p).filter((u) => !visited.has(u));
        queueLinks = [...new Set([...probed, ...fromLinks])].slice(0, maxPages * 3);
      } else {
        queueLinks = fromLinks.slice(0, maxPages * 3);
      }
    }

    if (pagesFetched < maxPages) {
      await new Promise((res) => setTimeout(res, delayMs));
    }
  }

  await query(
    `UPDATE discovery_jobs
       SET status='succeeded', finished_at=NOW(),
           pages_fetched=?, leads_found=?, leads_new=?
     WHERE id=?`,
    [pagesFetched, leadsFound, leadsNew, job.id],
  );
  await query(
    'UPDATE lead_sources SET last_crawled_at=NOW(), robots_allowed=?, last_status_detail=? WHERE id=?',
    [1, JSON.stringify({ leadsFound, leadsNew, pagesFetched }), job.source_id],
  );

  // Track monthly usage
  if (leadsNew) {
    const period = new Date().toISOString().slice(0, 7);
    await query(
      `INSERT INTO lead_usage_month (tenant_id, period, leads_discovered)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE leads_discovered = leads_discovered + VALUES(leads_discovered)`,
      [job.tenant_id, period, leadsNew],
    );
  }

  // Collector chain hook: if this discovery job was spawned by a collector campaign,
  // mark the linked collector_campaign_sources row, bump stats, and optionally queue
  // a website-analysis job for the source URL.
  const ccsRows = await query(
    `SELECT ccs.id AS ccs_id, ccs.campaign_id, cc.analyze_website, cc.generate_draft,
            cc.product_profile_id
     FROM collector_campaign_sources ccs
     JOIN collector_campaigns cc ON cc.id = ccs.campaign_id
     WHERE ccs.discovery_job_id=? LIMIT 1`,
    [job.id],
  );
  if (ccsRows.length) {
    const ccs = ccsRows[0];
    await query(
      "UPDATE collector_campaign_sources SET state='succeeded', finished_at=NOW() WHERE id=?",
      [ccs.ccs_id],
    );
    const today = new Date().toISOString().slice(0, 10);
    await query(
      `INSERT INTO collector_campaign_stats (tenant_id, campaign_id, \`date\`, sources_crawled, leads_found, leads_new)
       VALUES (?, ?, ?, 1, ?, ?)
       ON DUPLICATE KEY UPDATE sources_crawled = sources_crawled + 1,
                               leads_found = leads_found + VALUES(leads_found),
                               leads_new = leads_new + VALUES(leads_new)`,
      [job.tenant_id, ccs.campaign_id, today, leadsFound, leadsNew],
    );

    if (ccs.analyze_website && leadsNew >= 0) {
      // Spawn one website-analysis job per source URL. The analysis worker will pick it up.
      const ana = await query(
        `INSERT INTO website_analysis_jobs
           (tenant_id, product_profile_id, target_url, target_domain, language, collector_campaign_id)
         VALUES (?, ?, ?, ?, 'en', ?)`,
        [job.tenant_id, ccs.product_profile_id, job.source_url, job.source_domain, ccs.campaign_id],
      );
      await redis.xadd(
        'jobs:website-analysis', '*',
        'jobId', String(Number(ana.insertId)),
        'tenantId', String(job.tenant_id),
        'collectorCampaignId', String(ccs.campaign_id),
        'generateDraft', ccs.generate_draft ? '1' : '0',
      );
    }
  }

  logger.info({ jobId: job.id, tenantId: job.tenant_id, pagesFetched, leadsFound, leadsNew }, 'lead discovery done');
}

export async function leadDiscoveryLoop() {
  const r0 = dedicatedRedis();
  let lastId = '$';
  while (true) {
    try {
      const r = await r0.xread('BLOCK', 10000, 'STREAMS', 'jobs:lead-discovery', lastId);
      if (!r) {
        // Reap jobs orphaned in 'running' (worker died mid-job; recovery below
        // only re-picks 'queued', so without this they hang forever).
        const reaped = await query(
          `UPDATE discovery_jobs SET status='failed', error='reaped_stale_running', finished_at=NOW()
           WHERE status='running' AND started_at < NOW() - INTERVAL ? MINUTE`,
          [STALE_RUNNING_MIN],
        );
        if ((reaped as any)?.affectedRows) {
          logger.warn({ count: (reaped as any).affectedRows }, 'reaped stale running discovery_jobs');
        }
        // Also catch any 'queued' job missed (e.g. after worker restart)
        const stalled = await query(
          "SELECT id FROM discovery_jobs WHERE status='queued' ORDER BY created_at ASC LIMIT 5",
        );
        for (const row of stalled) await safeProcess(row.id);
        continue;
      }
      const [, entries] = r[0];
      for (const [id, fields] of entries) {
        lastId = id;
        const obj: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
        const jobId = parseInt(obj.jobId, 10);
        await safeProcess(jobId);
      }
    } catch (e: any) {
      logger.error({ err: e.message }, 'lead discovery loop error');
      await new Promise((res) => setTimeout(res, 5000));
    }
  }
}

async function safeProcess(jobId: number) {
  const got = await redis.set(`lock:lead-job:${jobId}`, '1', 'EX', LOCK_TTL_S, 'NX');
  if (!got) return;
  try {
    const job = await loadJob(jobId);
    if (!job) return;
    if (job.status !== 'queued' && job.status !== 'running') return;
    await processJob(job);
  } catch (e: any) {
    await query(
      "UPDATE discovery_jobs SET status='failed', error=?, finished_at=NOW() WHERE id=?",
      [String(e.message ?? e).slice(0, 1000), jobId],
    );
    logger.error({ jobId, err: e.message }, 'lead job failed');
  } finally {
    await redis.del(`lock:lead-job:${jobId}`);
  }
}
