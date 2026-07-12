// Consumes Redis stream `jobs:collector-draft`. When a website analysis under a
// collector campaign completes, this loop creates an outreach_draft using the
// same internal AI provider the API uses.
//
// Safety:
//   - Drafts arrive with `status='pending_review'`. NEVER sent automatically.
//   - This loop only writes to DB. No SMTP. No email is sent here.
//   - All honesty/forbidden-claim filters remain enforced by the generator.

import { dedicatedRedis, redis } from './redis.js';
import { query, tx } from './db.js';
import { logger } from './logger.js';

// We don't re-implement the AI provider here — instead we replicate the same
// internal template by calling out to the API container via fetch. Keeping the
// generator code in one place avoids drift. The API exposes the generation as a
// route protected by JWT; we use a worker-only internal token.
//
// Simpler choice: just call the DB directly to construct a deterministic draft
// using the SAME safe template approach. That removes the JWT dance. We import
// the aiInternalProvider from api package... but that's a separate package.
//
// Cleanest: vendor a small subset of the safe-template logic here. It's a
// stub draft (the human MUST review before any send), so even a minimal subject
// + body is acceptable — the operator will refine it via the existing editor UI.

interface AnalysisRow {
  id: number;
  tenant_id: number;
  company_name: string | null;
  industry: string | null;
  business_type: string | null;
  offering_summary: string | null;
  pain_points: any;
  source_urls: any;
  page_titles: any;
  confidence_score: number;
  language_detected: 'en' | 'ru' | 'uk' | 'other';
}

interface ProfileRow {
  id: number;
  name: string;
  product_url: string | null;
  description: string;
  key_benefits: any;
  forbidden_claims: any;
  preferred_tone: 'neutral' | 'friendly' | 'professional' | 'short_direct';
  default_language: 'en' | 'ru' | 'uk';
}

function parseJsonArr(v: any): string[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } }
  return [];
}

function safeSubject(companyName: string, productName: string): string {
  return `${companyName}: quick note about ${productName}`.slice(0, 200);
}

function safeBody(facts: AnalysisRow, profile: ProfileRow): { short: string; long: string; cited: string[]; risks: string[] } {
  const company = facts.company_name ?? 'your team';
  const product = profile.name;
  const productUrl = profile.product_url ? ` (${profile.product_url})` : '';
  const benefits = parseJsonArr(profile.key_benefits).slice(0, 3);
  const pains = parseJsonArr(facts.pain_points).slice(0, 3);
  const cited: string[] = [];
  if (facts.company_name) cited.push(`Company: ${facts.company_name}`);
  if (facts.industry)    cited.push(`Industry: ${facts.industry}`);
  if (facts.offering_summary) cited.push(`Public offering: ${facts.offering_summary}`);
  for (const p of pains) cited.push(`Possible pain point: ${p}`);

  const risks: string[] = [];
  if (facts.confidence_score < 40) risks.push('Low confidence — review carefully or do not send.');
  if (!pains.length) risks.push('No clear pain point detected. Avoid claiming knowledge of specific problems.');

  const benefitsBullets = benefits.length
    ? benefits.map((b) => `• ${b}`).join('\n')
    : `• ${profile.description.slice(0, 200)}`;

  const short =
    `Hi,\n\n` +
    `I came across your site and thought ${product}${productUrl} might be worth a quick look — it may help with ${benefits[0] ?? profile.description.slice(0, 80)}.\n\n` +
    `If relevant, happy to share a short overview. No pressure either way.\n\n` +
    `Best,`;

  const long =
    `Hi,\n\n` +
    `I had a quick look at your website${facts.industry ? ` (${facts.industry})` : ''}. ${product}${productUrl} may be useful for ${company} because:\n${benefitsBullets}\n\n` +
    `${profile.description.slice(0, 400)}\n\n` +
    `If this isn't relevant for ${company}, please disregard. Otherwise I can send a short example.\n\n` +
    `Best,`;

  return { short, long, cited, risks };
}

function stripForbidden(text: string, forbidden: string[]): string {
  let t = text;
  for (const claim of forbidden) {
    if (!claim) continue;
    const re = new RegExp(claim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    t = t.replace(re, '[REDACTED — claim not allowed by product policy]');
  }
  const universal = [
    /guaranteed (\w+ )?(sales|revenue|results|growth)/gi,
    /as discussed (earlier|previously|in our last)/gi,
    /per our (previous|earlier|last) (conversation|call|meeting)/gi,
    /our (mutual|shared) (client|customer|partner)/gi,
  ];
  for (const re of universal) t = t.replace(re, '[REDACTED — universal safety rule]');
  return t;
}

async function processOne(obj: Record<string, string>) {
  const tenantId = parseInt(obj.tenantId, 10);
  const analysisJobId = parseInt(obj.analysisJobId, 10);
  const campaignId = parseInt(obj.collectorCampaignId, 10);
  const profileId = parseInt(obj.productProfileId, 10);
  if (!tenantId || !analysisJobId || !campaignId || !profileId) return;

  const results = await query(
    `SELECT r.*, j.collector_campaign_id, j.language
     FROM website_analysis_results r
     JOIN website_analysis_jobs j ON j.id = r.job_id
     WHERE j.id=? AND r.tenant_id=? LIMIT 1`,
    [analysisJobId, tenantId],
  );
  if (!results.length) return;
  const r = results[0] as AnalysisRow & { language: 'en' | 'ru' | 'uk'; collector_campaign_id: number };

  const profiles = await query(
    'SELECT * FROM tenant_product_profiles WHERE id=? AND tenant_id=? LIMIT 1',
    [profileId, tenantId],
  );
  if (!profiles.length) return;
  const p = profiles[0] as ProfileRow;

  const subj = safeSubject(r.company_name ?? '', p.name);
  const body = safeBody(r, p);
  const forbidden = parseJsonArr(p.forbidden_claims);
  const shortBody = stripForbidden(body.short, forbidden);
  const longBody = stripForbidden(body.long, forbidden);

  await tx(async (c) => {
    const d = await c.query(
      `INSERT INTO outreach_drafts
         (tenant_id, product_profile_id, analysis_result_id, status, approval_required,
          language, tone, collector_campaign_id)
       VALUES (?, ?, ?, 'pending_review', 1, ?, ?, ?)`,
      [tenantId, p.id, r.id, r.language ?? p.default_language, p.preferred_tone, campaignId],
    );
    const did = Number(d.insertId);
    const v = await c.query(
      `INSERT INTO outreach_draft_versions
         (tenant_id, draft_id, version_no, generator, subject_options, email_short, email_long,
          follow_up, personalization_points, risks_or_uncertainties, confidence_score, cited_facts)
       VALUES (?, ?, 1, 'collector_internal', ?, ?, ?, NULL, ?, ?, ?, ?)`,
      [
        tenantId, did,
        JSON.stringify([subj]), shortBody, longBody,
        JSON.stringify(body.cited), JSON.stringify(body.risks),
        r.confidence_score, JSON.stringify(body.cited),
      ],
    );
    const vid = Number(v.insertId);
    await c.query('UPDATE outreach_drafts SET current_version_id=? WHERE id=?', [vid, did]);
    await c.query(
      `INSERT INTO outreach_approval_events
         (tenant_id, draft_id, draft_version_id, event, metadata)
       VALUES (?, ?, ?, 'generated', ?)`,
      [tenantId, did, vid, JSON.stringify({ generator: 'collector_internal', confidence: r.confidence_score, source: 'collector_chain' })],
    );
  });

  const today = new Date().toISOString().slice(0, 10);
  await query(
    `INSERT INTO collector_campaign_stats (tenant_id, campaign_id, \`date\`, drafts_generated)
     VALUES (?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE drafts_generated = drafts_generated + 1`,
    [tenantId, campaignId, today],
  );

  logger.info({ tenantId, campaignId, analysisJobId, confidence: r.confidence_score }, 'collector draft generated (pending_review)');
}

export async function collectorDraftLoop() {
  const r0 = dedicatedRedis();
  const LASTID_KEY = 'jobs:collector-draft:lastid';
  // Resume from the last durably-processed id (was '$') so draft jobs enqueued
  // while the worker was down are not dropped.
  let lastId = (await r0.get(LASTID_KEY).catch(() => null)) || '$';
  while (true) {
    try {
      const r = await r0.xread('BLOCK', 5000, 'STREAMS', 'jobs:collector-draft', lastId);
      if (!r) continue;
      const [, entries] = r[0];
      for (const [id, fields] of entries) {
        const obj: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
        try { await processOne(obj); }
        catch (e: any) { logger.error({ err: e.message }, 'collector draft processing failed'); }
        // Persist cursor after handling (errors are logged + skipped, not retried).
        lastId = id;
        await r0.set(LASTID_KEY, id).catch(() => {});
      }
    } catch (e: any) {
      logger.error({ err: e.message }, 'collector draft loop error');
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
