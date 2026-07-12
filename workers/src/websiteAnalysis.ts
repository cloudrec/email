import { query, tx } from './db.js';
import { redis, dedicatedRedis } from './redis.js';
import { logger } from './logger.js';
import { loadRobots } from './services/robotsTxt.js';
import { extractEmails, extractTitle, stripScripts } from './services/emailExtract.js';

const UA = 'EmailPlatformWebsiteAnalysis/0.1 (+https://email.clients.help/about/crawler)';
const FETCH_TIMEOUT_MS = 12000;
const MAX_HTML_BYTES = 1_500_000;
const LOCK_TTL_S = 600;
const ANALYSIS_PATHS = ['/', '/about', '/about-us', '/contact', '/contact-us', '/services', '/products', '/pricing'];

interface JobRow {
  id: number;
  tenant_id: number;
  product_profile_id: number | null;
  target_url: string;
  target_domain: string;
  lead_id: number | null;
  language: 'en' | 'ru' | 'uk';
}

async function fetchPage(url: string): Promise<{ html: string | null; finalUrl: string; reason?: string }> {
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': UA,
        'accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
        'accept-language': 'en,*;q=0.5',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { html: null, finalUrl: res.url, reason: `http_${res.status}` };
    const ct = res.headers.get('content-type') ?? '';
    if (ct && !ct.toLowerCase().includes('text/html') && !ct.toLowerCase().includes('application/xhtml')) {
      return { html: null, finalUrl: res.url, reason: `bad_content_type_${ct}` };
    }
    const text = await res.text();
    const truncated = text.length > MAX_HTML_BYTES ? text.slice(0, MAX_HTML_BYTES) : text;
    return { html: truncated, finalUrl: res.url };
  } catch (e: any) {
    return { html: null, finalUrl: url, reason: `fetch_err_${e?.name ?? 'unknown'}` };
  }
}

function detectLanguage(html: string): 'en' | 'ru' | 'uk' | 'other' {
  const m = /<html[^>]*\blang\s*=\s*["']([^"']+)["']/i.exec(html);
  if (m) {
    const short = m[1].slice(0, 2).toLowerCase();
    if (short === 'en' || short === 'ru' || short === 'uk') return short;
  }
  // crude script-based detection
  const text = stripScripts(html).replace(/<[^>]+>/g, ' ').slice(0, 5000);
  const cyrillic = (text.match(/[А-Яа-я]/g) ?? []).length;
  const ukrainian = (text.match(/[іїєґІЇЄҐ]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  if (ukrainian > 5) return 'uk';
  if (cyrillic > latin && cyrillic > 50) return 'ru';
  if (latin > 50) return 'en';
  return 'other';
}

const INDUSTRY_HINTS: Array<[RegExp, string]> = [
  [/saas|software as a service|cloud platform|api/i, 'SaaS / software'],
  [/e-?commerce|online store|shop|buy online|checkout|cart/i, 'E-commerce'],
  [/agency|consulting|consultant/i, 'Agency / consulting'],
  [/restaurant|menu|reservation|cuisine|dining/i, 'Restaurant / hospitality'],
  [/clinic|medical|doctor|dental|healthcare/i, 'Healthcare / medical'],
  [/law firm|attorney|legal services/i, 'Legal services'],
  [/real estate|property|realtor|apartment/i, 'Real estate'],
  [/fitness|gym|yoga|trainer/i, 'Fitness / wellness'],
  [/school|university|course|education/i, 'Education'],
  [/blog|news|magazine|publication/i, 'Media / publishing'],
  [/portfolio|freelance/i, 'Freelance / portfolio'],
];

const PAIN_HINTS: Array<[RegExp, string]> = [
  [/contact (us|form)|get in touch|reach (us|out)/i, 'Visitors are asked to use a contact form — many never complete it.'],
  [/whatsapp|telegram|messenger|signal/i, 'Communication via messengers — fragmented inbox.'],
  [/24\/?7|always (open|available)/i, 'Promises 24/7 availability — likely missed inquiries off-hours.'],
  [/free (consultation|estimate|quote)/i, 'Lead-magnet flow that depends on prompt reply.'],
  [/book (a )?(call|meeting|appointment)/i, 'Booking flow — abandoned bookings if no fast reply.'],
  [/(missed|lost) (calls?|leads?|inquiries?)/i, 'Explicitly mentions missed leads/calls.'],
  [/customer (support|service)|help (center|desk)/i, 'Has support team — likely manages incoming volume.'],
  [/order (online|now)|checkout/i, 'E-commerce with checkout — cart abandonment risk.'],
];

function summarize(text: string, max = 1000): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function visibleText(html: string): string {
  return stripScripts(html)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectCompanyName(html: string, domain: string): string | null {
  // og:site_name first, then meta application-name, then schema.org name
  const og = /<meta[^>]+property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i.exec(html);
  if (og) return og[1].trim().slice(0, 200);
  const an = /<meta[^>]+name=["']application-name["'][^>]*content=["']([^"']+)["']/i.exec(html);
  if (an) return an[1].trim().slice(0, 200);
  const title = extractTitle(html);
  if (title) {
    // Split common separators "Company — tagline" or "Company | tagline"
    const cleaned = title.split(/[—–\-|·•]/)[0].trim();
    if (cleaned && cleaned.length < 80) return cleaned;
  }
  return domain.replace(/^www\./, '');
}

function detectIndustry(text: string): { industry: string | null; businessType: string | null } {
  for (const [re, label] of INDUSTRY_HINTS) {
    if (re.test(text)) return { industry: label, businessType: label };
  }
  return { industry: null, businessType: null };
}

function detectPainPoints(text: string): string[] {
  const out = new Set<string>();
  for (const [re, label] of PAIN_HINTS) if (re.test(text)) out.add(label);
  return [...out].slice(0, 6);
}

function detectOffering(html: string): string | null {
  const md = /<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["']/i.exec(html);
  if (md) return summarize(md[1], 300);
  const og = /<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']+)["']/i.exec(html);
  if (og) return summarize(og[1], 300);
  // Fallback: first 200 chars of visible body text
  const v = visibleText(html);
  return v ? summarize(v, 300) : null;
}

async function processJob(job: JobRow): Promise<void> {
  await query("UPDATE website_analysis_jobs SET status='running', started_at=NOW() WHERE id=?", [job.id]);
  let origin: string;
  try { origin = new URL(job.target_url).origin; }
  catch {
    await query("UPDATE website_analysis_jobs SET status='failed', error='invalid_url', finished_at=NOW() WHERE id=?", [job.id]);
    return;
  }

  const robots = await loadRobots(origin);
  if (!robots.allowed(new URL(job.target_url).pathname)) {
    await query("UPDATE website_analysis_jobs SET status='skipped_robots', error='disallowed_by_robots_txt', finished_at=NOW() WHERE id=?", [job.id]);
    return;
  }
  const delayMs = Math.max(2000, Math.round(robots.crawlDelaySec * 1000));

  const fetched: Array<{ url: string; html: string }> = [];
  const visited = new Set<string>();

  // 1. fetch the explicit target URL
  const main = await fetchPage(job.target_url);
  if (!main.html) {
    logger.warn({ jobId: job.id, url: job.target_url, reason: main.reason }, 'fetch failed');
    await query("UPDATE website_analysis_jobs SET status='failed', error=?, finished_at=NOW() WHERE id=?",
      [`fetch_failed:${main.reason ?? 'unknown'}`, job.id]);
    return;
  }
  fetched.push({ url: main.finalUrl, html: main.html });
  visited.add(main.finalUrl);

  // 2. try standard contact/about pages
  for (const path of ANALYSIS_PATHS) {
    if (fetched.length >= 5) break;
    const url = origin + path;
    if (visited.has(url)) continue;
    visited.add(url);
    if (!robots.allowed(path)) continue;
    await new Promise((r) => setTimeout(r, delayMs));
    const p = await fetchPage(url);
    if (p.html) fetched.push({ url: p.finalUrl, html: p.html });
  }

  // Aggregate facts
  const allText = fetched.map((p) => visibleText(p.html)).join(' ').slice(0, 50000);
  const allHtml = fetched.map((p) => p.html).join('\n');

  const companyName = detectCompanyName(fetched[0].html, job.target_domain);
  const { industry, businessType } = detectIndustry(allText);
  const painPoints = detectPainPoints(allText);
  const offering = detectOffering(fetched[0].html);
  const pageTitles = fetched.map((p) => extractTitle(p.html)).filter(Boolean) as string[];
  const sourceUrls = fetched.map((p) => p.url);

  // Emails (public contact emails only — from visible HTML)
  const emails = extractEmails(allHtml).emails.map((e) => e.email);

  const language = detectLanguage(fetched[0].html);

  // Confidence: lightweight scoring
  let confidence = 0;
  if (companyName) confidence += 15;
  if (industry)    confidence += 15;
  if (offering)    confidence += 20;
  if (painPoints.length) confidence += Math.min(25, painPoints.length * 8);
  if (pageTitles.length) confidence += Math.min(10, pageTitles.length * 3);
  if (sourceUrls.length > 1) confidence += 10;
  if (emails.length) confidence += 5;
  confidence = Math.min(100, confidence);

  const warning = !painPoints.length
    ? 'No explicit pain point detected — outreach text must remain soft and informational. Avoid claiming knowledge of specific problems.'
    : null;

  const relevanceReason = painPoints.length
    ? `Detected potential needs: ${painPoints.slice(0, 3).join('; ')}.`
    : 'No specific need detected; relevance must be derived from product fit, not from claimed problems.';

  const rawFacts = {
    fetchedPages: fetched.map((f) => ({ url: f.url, bytes: f.html.length })),
  };

  await tx(async (c) => {
    await c.query(
      `INSERT INTO website_analysis_results
         (tenant_id, job_id, company_name, industry, business_type, offering_summary,
          pain_points, relevance_reason, relevance_warning, contact_emails, source_urls,
          page_titles, raw_facts, confidence_score, language_detected)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        job.tenant_id, job.id, companyName, industry, businessType, offering,
        JSON.stringify(painPoints), relevanceReason, warning,
        JSON.stringify(emails), JSON.stringify(sourceUrls), JSON.stringify(pageTitles),
        JSON.stringify(rawFacts), confidence, language,
      ],
    );
    await c.query(
      `UPDATE website_analysis_jobs SET status='succeeded', pages_fetched=?, finished_at=NOW() WHERE id=?`,
      [fetched.length, job.id],
    );
  });

  // Collector chain hook: if this analysis job is tied to a collector campaign and
  // the campaign requested draft generation, queue an outreach draft request.
  const j2 = await query(
    `SELECT collector_campaign_id, product_profile_id, language FROM website_analysis_jobs WHERE id=? LIMIT 1`,
    [job.id],
  );
  if (j2.length && j2[0].collector_campaign_id) {
    const cc = (await query(
      `SELECT generate_draft, product_profile_id FROM collector_campaigns
       WHERE id=? AND tenant_id=? LIMIT 1`,
      [j2[0].collector_campaign_id, job.tenant_id],
    ))[0];
    if (cc?.generate_draft) {
      const profileId = j2[0].product_profile_id ?? cc.product_profile_id;
      if (profileId) {
        // Fire a draft-generate request via internal Redis stream.
        // The API path also exists; using a stream keeps worker independent of HTTP.
        await redis.xadd(
          'jobs:collector-draft', '*',
          'tenantId', String(job.tenant_id),
          'analysisJobId', String(job.id),
          'collectorCampaignId', String(j2[0].collector_campaign_id),
          'productProfileId', String(profileId),
          'language', j2[0].language ?? 'en',
        );
      }
    }
    const today = new Date().toISOString().slice(0, 10);
    await query(
      `INSERT INTO collector_campaign_stats (tenant_id, campaign_id, \`date\`, websites_analyzed)
       VALUES (?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE websites_analyzed = websites_analyzed + 1`,
      [job.tenant_id, j2[0].collector_campaign_id, today],
    );
  }

  logger.info({ jobId: job.id, tenantId: job.tenant_id, confidence, painPoints: painPoints.length, emails: emails.length }, 'website analysis done');
}

async function loadJob(jobId: number): Promise<JobRow | null> {
  const rows = await query(
    `SELECT id, tenant_id, product_profile_id, target_url, target_domain, lead_id, language
     FROM website_analysis_jobs WHERE id=? LIMIT 1`, [jobId],
  );
  return rows[0] ?? null;
}

async function safeProcess(jobId: number) {
  const got = await redis.set(`lock:wa-job:${jobId}`, '1', 'EX', LOCK_TTL_S, 'NX');
  if (!got) return;
  try {
    const j = await loadJob(jobId);
    if (!j) return;
    const cur = (await query('SELECT status FROM website_analysis_jobs WHERE id=?', [jobId]))[0]?.status;
    if (cur !== 'queued' && cur !== 'running') return;
    await processJob(j);
  } catch (e: any) {
    await query("UPDATE website_analysis_jobs SET status='failed', error=?, finished_at=NOW() WHERE id=?",
      [String(e.message ?? e).slice(0, 1000), jobId]);
    logger.error({ jobId, err: e.message }, 'website analysis failed');
  } finally {
    await redis.del(`lock:wa-job:${jobId}`);
  }
}

export async function websiteAnalysisLoop() {
  const r0 = dedicatedRedis();
  let lastId = '$';
  while (true) {
    try {
      const r = await r0.xread('BLOCK', 10000, 'STREAMS', 'jobs:website-analysis', lastId);
      if (!r) {
        const stalled = await query(
          "SELECT id FROM website_analysis_jobs WHERE status='queued' ORDER BY created_at ASC LIMIT 5",
        );
        for (const row of stalled) await safeProcess(row.id);
        continue;
      }
      const [, entries] = r[0];
      for (const [id, fields] of entries) {
        lastId = id;
        const obj: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
        await safeProcess(parseInt(obj.jobId, 10));
      }
    } catch (e: any) {
      logger.error({ err: e.message }, 'website analysis loop error');
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
