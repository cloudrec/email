import { query } from '../db.js';
import { logger } from '../logger.js';
import { classifyIndustry } from './industryClassifier.js';

export interface IngestResult {
  companyId: number;
  websiteId: number | null;
  contactPointIds: number[];
  isNew: boolean;
}

export interface BackfillStats {
  companiesCreated: number;
  websitesCreated: number;
  contactPointsCreated: number;
  industriesAssigned: number;
  productFitsAssigned: number;
  errors: number;
}

// Product fit definitions (deterministic scoring, no external AI)
const PRODUCT_FIT_RULES: Record<string, (facts: CompanyFacts) => { score: number; reasons: string[]; pains: string[] }> = {
  clients_help: (f) => {
    const reasons: string[] = [];
    const pains: string[] = [];
    let score = 0.3;
    if (!f.hasLiveChat) { score += 0.25; pains.push('no_live_chat'); }
    if (f.hasContactFormOnly) { score += 0.15; pains.push('contact_form_only'); }
    if (!f.hasTelegram && !f.hasWhatsapp) { score += 0.1; pains.push('no_messenger'); }
    if (f.isLocalBusiness) { score += 0.1; reasons.push('local_business'); }
    if (f.isSmallBusiness) { score += 0.05; reasons.push('small_business'); }
    if (f.isEcommerce) { score += 0.05; reasons.push('ecommerce_contact_gap'); }
    return { score: Math.min(1, score), reasons, pains };
  },
  beautybot: (f) => {
    const reasons: string[] = [];
    const pains: string[] = [];
    let score = 0;
    const beautyIndustries = ['beauty_salon','nail_studio','barbershop','spa','massage'];
    if (beautyIndustries.some(s => f.industries.includes(s))) { score += 0.7; reasons.push('beauty_industry'); }
    if (!f.hasOnlineBooking) { score += 0.2; pains.push('no_online_booking'); }
    if (f.isAppointmentBased) { score += 0.1; reasons.push('appointment_based'); }
    return { score: Math.min(1, score), reasons, pains };
  },
  manualpay: (f) => {
    const reasons: string[] = [];
    const pains: string[] = [];
    let score = 0;
    if (f.isSaas) { score += 0.4; reasons.push('saas_product'); }
    if (f.hasManualActivation) { score += 0.3; pains.push('manual_activation'); }
    if (f.hasCryptoPaymentHints) { score += 0.2; pains.push('crypto_or_manual_payment'); }
    if (f.hasPaymentProviderLimitations) { score += 0.1; pains.push('payment_limitations'); }
    return { score: Math.min(1, score), reasons, pains };
  },
};

interface CompanyFacts {
  industries: string[];
  hasLiveChat: boolean;
  hasContactFormOnly: boolean;
  hasTelegram: boolean;
  hasWhatsapp: boolean;
  hasOnlineBooking: boolean;
  isAppointmentBased: boolean;
  isLocalBusiness: boolean;
  isSmallBusiness: boolean;
  isEcommerce: boolean;
  isSaas: boolean;
  hasManualActivation: boolean;
  hasCryptoPaymentHints: boolean;
  hasPaymentProviderLimitations: boolean;
}

function extractFacts(analysisJson: any, industries: string[]): CompanyFacts {
  const text = JSON.stringify(analysisJson ?? '').toLowerCase();
  return {
    industries,
    hasLiveChat: /live\s*chat|tawk|intercom|crisp|drift|zendesk\s*chat|livechat/.test(text),
    hasContactFormOnly: /contact\s*form/.test(text) && !/email|@/.test(text),
    hasTelegram: /telegram|t\.me\//.test(text),
    hasWhatsapp: /whatsapp|wa\.me\//.test(text),
    hasOnlineBooking: /online\s*book|appointment\s*system|calendly|book\s*now|schedule\s*online/.test(text),
    isAppointmentBased: /appointment|booking|записат|запис|schedule/.test(text),
    isLocalBusiness: /local|address|hours|working\s*hours|открыт|відчинен/.test(text),
    isSmallBusiness: !/(enterprise|corporation|global|worldwide|international)/.test(text),
    isEcommerce: /cart|checkout|add\s*to\s*cart|shop|woocommerce|shopify/.test(text),
    isSaas: /saas|software\s*as|subscription|pricing|plan|dashboard|api\s*access/.test(text),
    hasManualActivation: /manual\s*activ|activate\s*account|pending\s*approval/.test(text),
    hasCryptoPaymentHints: /bitcoin|crypto|usdt|btc|eth\b|blockchain\s*pay/.test(text),
    hasPaymentProviderLimitations: /payment\s*method|payment\s*limit|not\s*available\s*in|country\s*restrict/.test(text),
  };
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function extractDomain(url: string): string {
  try {
    return new URL(url.startsWith('http') ? url : `https://${url}`).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return url.toLowerCase().replace(/^www\./, '').split('/')[0];
  }
}

async function getOrCreateCompany(domain: string, data: {
  name?: string | null;
  country?: string | null;
  city?: string | null;
  language?: string | null;
  description?: string | null;
}): Promise<{ id: number; isNew: boolean }> {
  const rows = await query('SELECT id FROM companies WHERE canonical_domain=? LIMIT 1', [domain]);
  if (rows.length) {
    await query(
      `UPDATE companies SET
         name=COALESCE(name,?), country=COALESCE(country,?), city=COALESCE(city,?),
         language=COALESCE(language,?), description=COALESCE(description,?),
         source_count=source_count+1, last_seen_at=NOW()
       WHERE canonical_domain=?`,
      [data.name ?? null, data.country ?? null, data.city ?? null,
       data.language ?? null, data.description ?? null, domain],
    );
    return { id: Number(rows[0].id), isNew: false };
  }
  const r = await query(
    `INSERT INTO companies (canonical_domain, name, country, city, language, description, source_count)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
    [domain, data.name ?? null, data.country ?? null, data.city ?? null,
     data.language ?? null, data.description ?? null],
  );
  return { id: Number(r.insertId), isNew: true };
}

async function upsertWebsite(companyId: number, url: string, data: {
  pageTitle?: string | null;
  metaDescription?: string | null;
  languageDetected?: string | null;
  sourceProvider?: string | null;
}): Promise<number> {
  const domain = extractDomain(url);
  const rows = await query(
    'SELECT id FROM company_websites WHERE company_id=? AND url=? LIMIT 1',
    [companyId, url.slice(0, 1900)],
  );
  if (rows.length) {
    await query(
      `UPDATE company_websites SET
         page_title=COALESCE(page_title,?), meta_description=COALESCE(meta_description,?),
         language_detected=COALESCE(language_detected,?), last_seen_at=NOW()
       WHERE id=?`,
      [data.pageTitle ?? null, data.metaDescription ?? null, data.languageDetected ?? null, rows[0].id],
    );
    return Number(rows[0].id);
  }
  const r = await query(
    `INSERT INTO company_websites (company_id, url, domain, page_title, meta_description, language_detected, source_provider)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [companyId, url.slice(0, 1900), domain,
     data.pageTitle ?? null, data.metaDescription ?? null,
     data.languageDetected ?? null, data.sourceProvider ?? null],
  );
  return Number(r.insertId);
}

async function upsertContactPoint(companyId: number, websiteId: number | null, opts: {
  type: string;
  value: string;
  roleType?: string;
  sourceUrl?: string;
  contextSnippet?: string;
  verificationScore?: number;
}): Promise<{ id: number; isNew: boolean }> {
  const normalized = normalizeEmail(opts.value);
  const emailDomain = opts.type === 'email' ? normalized.split('@')[1] ?? null : null;

  const rows = await query(
    'SELECT id FROM contact_points WHERE type=? AND normalized_value=? AND company_id=? LIMIT 1',
    [opts.type, normalized.slice(0, 200), companyId],
  );
  if (rows.length) {
    await query(
      'UPDATE contact_points SET last_seen_at=NOW(), website_id=COALESCE(website_id,?) WHERE id=?',
      [websiteId, rows[0].id],
    );
    return { id: Number(rows[0].id), isNew: false };
  }
  const r = await query(
    `INSERT INTO contact_points
      (company_id, website_id, type, value, normalized_value, email_domain,
       role_type, source_url, context_snippet, verification_score)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [companyId, websiteId, opts.type, opts.value.slice(0, 499), normalized.slice(0, 499),
     emailDomain, opts.roleType ?? 'unknown',
     opts.sourceUrl?.slice(0, 1999) ?? null,
     opts.contextSnippet?.slice(0, 499) ?? null,
     opts.verificationScore ?? null],
  );
  return { id: Number(r.insertId), isNew: true };
}

async function assignIndustry(companyId: number, slug: string, confidence: number, source: string, isPrimary: boolean): Promise<boolean> {
  const rows = await query('SELECT id FROM industry_taxonomy WHERE slug=? LIMIT 1', [slug]);
  if (!rows.length) return false;
  const industryId = Number(rows[0].id);
  await query(
    `INSERT INTO company_industries (company_id, industry_id, confidence, source, is_primary)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE confidence=GREATEST(confidence,VALUES(confidence)), is_primary=VALUES(is_primary)`,
    [companyId, industryId, confidence, source, isPrimary ? 1 : 0],
  );
  return true;
}

async function computeAndStoreFit(companyId: number, facts: CompanyFacts): Promise<number> {
  let count = 0;
  for (const [productKey, scoreFn] of Object.entries(PRODUCT_FIT_RULES)) {
    const { score, reasons, pains } = scoreFn(facts);
    const status = score >= 0.65 ? 'good_fit' : score >= 0.35 ? 'weak_fit' : 'not_fit';
    await query(
      `INSERT INTO company_product_fit (company_id, product_key, fit_score, confidence, fit_reason, detected_pains_json, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE fit_score=VALUES(fit_score), confidence=VALUES(confidence),
         fit_reason=VALUES(fit_reason), detected_pains_json=VALUES(detected_pains_json), status=VALUES(status)`,
      [companyId, productKey, score, score, reasons.join(', ') || null, JSON.stringify(pains), status],
    );
    count++;
  }
  return count;
}

async function recordEvent(event: {
  tenantId?: number;
  companyId?: number;
  contactPointId?: number;
  eventType: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await query(
    'INSERT INTO lead_warehouse_events (tenant_id, company_id, contact_point_id, event_type, metadata_json) VALUES (?,?,?,?,?)',
    [event.tenantId ?? null, event.companyId ?? null, event.contactPointId ?? null,
     event.eventType, JSON.stringify(event.metadata ?? null)],
  );
}

// Ingest a single URL with all available context
export async function ingestUrl(opts: {
  tenantId?: number;
  url: string;
  domain?: string;
  pageTitle?: string | null;
  metaDescription?: string | null;
  languageDetected?: string | null;
  sourceProvider?: string | null;
  emails?: string[];
  osmTags?: Record<string, string>;
  tavilyQuery?: string;
  analysisJson?: any;
  country?: string | null;
  city?: string | null;
}): Promise<IngestResult> {
  const domain = opts.domain ?? extractDomain(opts.url);

  const { id: companyId, isNew } = await getOrCreateCompany(domain, {
    name: opts.pageTitle?.slice(0, 200) ?? null,
    country: opts.country ?? null,
    city: opts.city ?? null,
    language: opts.languageDetected ?? null,
    description: opts.metaDescription?.slice(0, 500) ?? null,
  });

  const websiteId = await upsertWebsite(companyId, opts.url, {
    pageTitle: opts.pageTitle ?? null,
    metaDescription: opts.metaDescription ?? null,
    languageDetected: opts.languageDetected ?? null,
    sourceProvider: opts.sourceProvider ?? null,
  });

  // Classify industry
  const classification = classifyIndustry({
    osmTags: opts.osmTags,
    tavilyQuery: opts.tavilyQuery,
    pageTitle: opts.pageTitle ?? undefined,
    metaDescription: opts.metaDescription ?? undefined,
    domain,
    analysisFacts: opts.analysisJson ? JSON.stringify(opts.analysisJson).slice(0, 2000) : undefined,
  });

  let industriesAssigned = 0;
  if (classification.primary) {
    const ok = await assignIndustry(companyId, classification.primary, classification.confidence, classification.source, true);
    if (ok) industriesAssigned++;
    for (const sec of classification.secondary) {
      const ok2 = await assignIndustry(companyId, sec, classification.confidence * 0.6, classification.source, false);
      if (ok2) industriesAssigned++;
    }
    await query(
      `UPDATE companies SET category_primary=?, category_secondary=? WHERE id=?`,
      [classification.primary, classification.secondary[0] ?? null, companyId],
    );
  }

  // Upsert contact points
  const contactPointIds: number[] = [];
  for (const email of (opts.emails ?? [])) {
    if (!email || !email.includes('@')) continue;
    const { id: cpId, isNew: cpNew } = await upsertContactPoint(companyId, websiteId, {
      type: 'email',
      value: email,
      sourceUrl: opts.url,
    });
    contactPointIds.push(cpId);
    if (cpNew) await recordEvent({ tenantId: opts.tenantId, companyId, contactPointId: cpId, eventType: 'contact_point.created', metadata: { email, source: opts.sourceProvider } });
  }

  // Compute product fit
  const allIndustryRows = await query('SELECT slug FROM industry_taxonomy it JOIN company_industries ci ON ci.industry_id=it.id WHERE ci.company_id=?', [companyId]);
  const allIndustries = allIndustryRows.map((r: any) => r.slug as string);
  const facts = extractFacts(opts.analysisJson, allIndustries);
  await computeAndStoreFit(companyId, facts);

  if (isNew) await recordEvent({ tenantId: opts.tenantId, companyId, eventType: 'company.created', metadata: { domain, source: opts.sourceProvider } });

  return { companyId, websiteId, contactPointIds, isNew };
}

// Full backfill from all existing data
export async function backfillAll(tenantId?: number): Promise<BackfillStats> {
  const stats: BackfillStats = { companiesCreated: 0, websitesCreated: 0, contactPointsCreated: 0, industriesAssigned: 0, productFitsAssigned: 0, errors: 0 };

  // 1. Backfill from lead_sources
  const tenantFilter = tenantId ? 'AND ls.tenant_id=?' : '';
  const lsParams = tenantId ? [tenantId] : [];
  const sources = await query(
    `SELECT ls.id, ls.url, ls.domain, ls.tenant_id FROM lead_sources ls WHERE ls.status != 'removed' ${tenantFilter} LIMIT 50000`,
    lsParams,
  );
  logger.info({ count: sources.length }, 'warehouse backfill: lead_sources');
  for (const s of sources) {
    try {
      const res = await ingestUrl({ tenantId: Number(s.tenant_id), url: s.url, domain: s.domain, sourceProvider: 'lead_source' });
      if (res.isNew) stats.companiesCreated++;
    } catch (e: any) {
      stats.errors++;
      logger.debug({ err: e.message, url: s.url }, 'warehouse backfill: lead_source error');
    }
  }

  // 2. Backfill from discovered_leads (has email + source url)
  const dlParams = tenantId ? [tenantId] : [];
  const leads = await query(
    `SELECT dl.id, dl.email, dl.email_domain, dl.company_domain,
            dl.source_url, dl.page_title, dl.context_snippet, dl.role_hint, dl.tenant_id
     FROM discovered_leads dl
     WHERE dl.status NOT IN ('invalid','duplicate') ${tenantId ? 'AND dl.tenant_id=?' : ''}
     LIMIT 100000`,
    dlParams,
  );
  logger.info({ count: leads.length }, 'warehouse backfill: discovered_leads');
  for (const dl of leads) {
    try {
      const domain = dl.company_domain ?? dl.email_domain ?? extractDomain(dl.source_url ?? '');
      if (!domain) continue;
      const res = await ingestUrl({
        tenantId: Number(dl.tenant_id),
        url: dl.source_url ?? `https://${domain}`,
        domain,
        pageTitle: dl.page_title ?? null,
        emails: dl.email ? [dl.email] : [],
        sourceProvider: 'discovered_lead',
      });
      if (res.isNew) stats.companiesCreated++;
      stats.contactPointsCreated += res.contactPointIds.length;
    } catch (e: any) {
      stats.errors++;
      logger.debug({ err: e.message, leadId: dl.id }, 'warehouse backfill: lead error');
    }
  }

  // 3. Backfill from website_analysis_results (actual column names)
  const waParams = tenantId ? [tenantId] : [];
  const analyses = await query(
    `SELECT war.id, waj.target_url, waj.target_domain, war.company_name,
            war.language_detected, war.industry, war.offering_summary,
            war.contact_emails, war.raw_facts, war.tenant_id
     FROM website_analysis_results war
     JOIN website_analysis_jobs waj ON waj.id=war.job_id
     WHERE waj.status='succeeded' ${tenantId ? 'AND war.tenant_id=?' : ''}
     LIMIT 50000`,
    waParams,
  );
  logger.info({ count: analyses.length }, 'warehouse backfill: website_analysis');
  for (const wa of analyses) {
    try {
      let emails: string[] = [];
      try {
        const raw = wa.contact_emails ?? '[]';
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        emails = Array.isArray(parsed) ? parsed : [];
      } catch {}
      const res = await ingestUrl({
        tenantId: Number(wa.tenant_id),
        url: wa.target_url,
        domain: wa.target_domain,
        pageTitle: wa.company_name ?? null,
        languageDetected: wa.language_detected ?? null,
        emails,
        analysisJson: wa.raw_facts ? (typeof wa.raw_facts === 'string' ? JSON.parse(wa.raw_facts) : wa.raw_facts) : null,
        sourceProvider: 'website_analysis',
      });
      if (res.isNew) stats.companiesCreated++;
      stats.contactPointsCreated += res.contactPointIds.length;
    } catch (e: any) {
      stats.errors++;
      logger.debug({ err: e.message, url: wa.target_url }, 'warehouse backfill: analysis error');
    }
  }

  // Final tally
  const coCount = await query('SELECT COUNT(*) AS c FROM companies');
  const cwCount = await query('SELECT COUNT(*) AS c FROM company_websites');
  const cpCount = await query('SELECT COUNT(*) AS c FROM contact_points');
  const ciCount = await query('SELECT COUNT(*) AS c FROM company_industries');
  const fitCount = await query('SELECT COUNT(*) AS c FROM company_product_fit');
  stats.companiesCreated = Number(coCount[0].c);
  stats.websitesCreated = Number(cwCount[0].c);
  stats.contactPointsCreated = Number(cpCount[0].c);
  stats.industriesAssigned = Number(ciCount[0].c);
  stats.productFitsAssigned = Number(fitCount[0].c);

  logger.info(stats, 'warehouse backfill complete');
  return stats;
}
