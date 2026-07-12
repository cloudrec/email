// leadIntel.ts — Phase 18 lead-intelligence helpers.
// 1. Lead Fit Score: turn the 0..1 company_product_fit.fit_score into a 0..100
//    score + label + human-readable reasons.
// 2. Natural-language Lead Search: deterministic parser that turns a free-text
//    query ("cleaning companies in London with website and public email") into
//    structured warehouse filters. No external LLM required; if one is wired up
//    later it can be slotted in via parseLeadQueryLLM (not implemented here).
//
// Safety: purely read/translate. Nothing here sends, activates, or mutates.

// ── Fit score ───────────────────────────────────────────────────────────────

export type FitLabel = 'excellent_fit' | 'good_fit' | 'weak_fit' | 'not_fit' | 'unknown';

export function fitLabelFromScore(score: number | null | undefined): FitLabel {
  if (score == null) return 'unknown';
  if (score >= 0.8) return 'excellent_fit';
  if (score >= 0.6) return 'good_fit';
  if (score >= 0.35) return 'weak_fit';
  return 'not_fit';
}

export function fitScore100(score: number | null | undefined): number | null {
  if (score == null) return null;
  return Math.round(Math.max(0, Math.min(1, Number(score))) * 100);
}

// Map raw pain / reason tokens to readable English reason strings (shown as badges).
const REASON_LABELS: Record<string, string> = {
  no_live_chat:        'no live chat detected',
  contact_form_only:   'contact form only',
  no_messenger:        'no messenger channel',
  no_online_booking:   'no online booking',
  manual_activation:   'manual activation flow',
  crypto_or_manual_payment: 'crypto / manual payment hints',
  payment_limitations: 'payment provider limitations',
  local_business:      'local service category',
  small_business:      'small business',
  ecommerce_contact_gap: 'ecommerce contact gap',
  beauty_industry:     'beauty industry match',
  appointment_based:   'appointment-based business',
  saas_product:        'SaaS product',
};

// Friendly product names for "strong fit for X" reason text.
const PRODUCT_LABELS: Record<string, string> = {
  clients_help: 'Clients.Help',
  beautybot:    'BeautyBot',
  manualpay:    'ManualPay',
};

export function productLabel(key: string | null | undefined): string {
  if (!key) return '';
  return PRODUCT_LABELS[key] ?? key;
}

export interface FitReasonInput {
  productKey?: string | null;
  fitScore?: number | null;
  fitReason?: string | null;          // comma-separated reason tokens
  detectedPains?: unknown;            // JSON array or string
  hasEmail?: boolean;
  hasWebsite?: boolean;
  industrySlugs?: string[];
}

// Build a de-duplicated list of readable reasons for a card / profile.
export function buildFitReasons(input: FitReasonInput): string[] {
  const out: string[] = [];
  const push = (s: string | null | undefined) => { if (s && !out.includes(s)) out.push(s); };

  if (input.hasEmail) push('has public business email');
  if (input.hasWebsite) push('has live website');

  const tokens: string[] = [];
  if (input.fitReason) tokens.push(...input.fitReason.split(',').map(s => s.trim()).filter(Boolean));
  const pains = normalizeJsonArray(input.detectedPains);
  tokens.push(...pains);

  for (const tok of tokens) push(REASON_LABELS[tok] ?? tok.replace(/_/g, ' '));

  const label = fitLabelFromScore(input.fitScore);
  if ((label === 'excellent_fit' || label === 'good_fit') && input.productKey) {
    push(`strong fit for ${productLabel(input.productKey)}`);
  }
  if (input.industrySlugs && input.industrySlugs.length) push('industry match');

  return out.slice(0, 8);
}

function normalizeJsonArray(v: unknown): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') {
    try { const p = JSON.parse(v); return Array.isArray(p) ? p.map(String) : []; }
    catch { return []; }
  }
  return [];
}

// ── Natural-language search parser ────────────────────────────────────────────

export interface ParsedLeadQuery {
  filters: {
    industry?: string;       // taxonomy slug
    country?: string;        // ISO-2
    city?: string;
    hasWebsite?: boolean;
    hasEmail?: boolean;
    productFit?: string;     // product key
    pains?: string[];        // detected_pains tokens to require
    minScore?: number;       // 0..1
  };
  interpreted: string[];     // human-readable chips describing what was understood
  parser: 'deterministic';
}

// Industry keyword → taxonomy slug. Order matters (longer / more specific first).
const INDUSTRY_KEYWORDS: Array<[RegExp, string]> = [
  [/\b(nail|manicure|pedicure)\b/i, 'nail_studio'],
  [/\b(barber|barbershop)\b/i, 'barbershop'],
  [/\b(spa)\b/i, 'spa'],
  [/\b(massage)\b/i, 'massage'],
  [/\b(beauty salon|beauty saloon|beauty|salon|hairdress|hair salon)\b/i, 'beauty_salon'],
  [/\b(dental|dentist|dental|teeth)\b/i, 'dental_clinic'],
  [/\b(dermatolog)\w*/i, 'dermatology'],
  [/\b(vet|veterinary|veterinar)\w*/i, 'veterinary_clinic'],
  [/\b(clinic|medical|doctor|health)\b/i, 'private_clinic'],
  [/\b(web agency|web design|web studio|web dev|website agency)\b/i, 'web_agency'],
  [/\b(marketing agenc|seo agenc|ppc|smm)\w*/i, 'marketing_agency'],
  [/\b(saas)\b/i, 'saas'],
  [/\b(shopify)\b/i, 'shopify_store'],
  [/\b(woocommerce)\b/i, 'woocommerce_store'],
  [/\b(wordpress)\b/i, 'wordpress_site'],
  [/\b(ecommerce|e-commerce|online store|online shop|webshop)\b/i, 'ecommerce'],
  [/\b(cleaning|cleaner|janitor|housekeep)\w*/i, 'cleaning_service'],
  [/\b(car service|auto service|car repair|garage|mechanic)\b/i, 'car_service'],
  [/\b(repair service|repair)\b/i, 'repair_service'],
  [/\b(lawyer|legal|law firm|attorney|notary|solicitor)\b/i, 'legal_service'],
  [/\b(real estate|realtor|estate agent|property agen)\w*/i, 'real_estate'],
  [/\b(restaurant|bistro|eatery)\b/i, 'restaurant'],
  [/\b(cafe|coffee shop|coffeehouse)\b/i, 'cafe'],
  [/\b(hotel|hostel|guest house|guesthouse)\b/i, 'hotel'],
  [/\b(travel agenc|tour operator)\w*/i, 'travel_agency'],
  [/\b(online course|courses|e-learning)\b/i, 'courses'],
  [/\b(tutor|tutoring)\b/i, 'tutoring'],
  [/\b(school)\b/i, 'school'],
  [/\b(training center|training centre|bootcamp)\b/i, 'training_center'],
];

// Country name (and common aliases) → ISO-2.
const COUNTRY_KEYWORDS: Array<[RegExp, string]> = [
  [/\b(united kingdom|great britain|britain|england|scotland|wales|\buk\b)\b/i, 'GB'],
  [/\b(poland|polska|polish)\b/i, 'PL'],
  [/\b(ukraine|ukrainian)\b/i, 'UA'],
  [/\b(united states|\busa\b|america|\bus\b)\b/i, 'US'],
  [/\b(germany|deutschland|german)\b/i, 'DE'],
  [/\b(france|french)\b/i, 'FR'],
  [/\b(spain|espana|spanish)\b/i, 'ES'],
  [/\b(italy|italian)\b/i, 'IT'],
  [/\b(netherlands|holland|dutch)\b/i, 'NL'],
  [/\b(ireland|irish)\b/i, 'IE'],
  [/\b(canada|canadian)\b/i, 'CA'],
  [/\b(australia|australian)\b/i, 'AU'],
  [/\b(portugal|portuguese)\b/i, 'PT'],
  [/\b(belgium|belgian)\b/i, 'BE'],
  [/\b(austria|austrian)\b/i, 'AT'],
  [/\b(switzerland|swiss)\b/i, 'CH'],
  [/\b(sweden|swedish)\b/i, 'SE'],
  [/\b(czech|czechia)\b/i, 'CZ'],
  [/\b(romania|romanian)\b/i, 'RO'],
];

// Known city → {city, country}. Keeps country inference tight for common targets.
const CITY_KEYWORDS: Array<[RegExp, { city: string; country?: string }]> = [
  [/\blondon\b/i, { city: 'London', country: 'GB' }],
  [/\bmanchester\b/i, { city: 'Manchester', country: 'GB' }],
  [/\bbirmingham\b/i, { city: 'Birmingham', country: 'GB' }],
  [/\bwarsaw\b|\bwarszawa\b/i, { city: 'Warsaw', country: 'PL' }],
  [/\bkrakow\b|\bcracow\b/i, { city: 'Krakow', country: 'PL' }],
  [/\bkyiv\b|\bkiev\b/i, { city: 'Kyiv', country: 'UA' }],
  [/\blviv\b/i, { city: 'Lviv', country: 'UA' }],
  [/\bberlin\b/i, { city: 'Berlin', country: 'DE' }],
  [/\bparis\b/i, { city: 'Paris', country: 'FR' }],
  [/\bmadrid\b/i, { city: 'Madrid', country: 'ES' }],
  [/\bamsterdam\b/i, { city: 'Amsterdam', country: 'NL' }],
  [/\bdublin\b/i, { city: 'Dublin', country: 'IE' }],
];

const PRODUCT_KEYWORDS: Array<[RegExp, string]> = [
  [/\b(clients[.\s]?help|client help)\b/i, 'clients_help'],
  [/\b(beautybot|beauty bot)\b/i, 'beautybot'],
  [/\b(manualpay|manual pay)\b/i, 'manualpay'],
];

function neg(re: string): RegExp {
  // matches "without X" / "no X" / "missing X" / "lacks X"
  return new RegExp(`\\b(without|no|missing|lacks?|don't have|does not have|not?\\s)\\s+(a\\s+)?${re}`, 'i');
}
function pos(re: string): RegExp {
  return new RegExp(`\\b(with|has|having|public|live|valid)\\s+(a\\s+)?${re}`, 'i');
}

export function parseLeadQuery(raw: string): ParsedLeadQuery {
  const q = (raw || '').trim();
  const filters: ParsedLeadQuery['filters'] = {};
  const interpreted: string[] = [];

  // Industry
  for (const [re, slug] of INDUSTRY_KEYWORDS) {
    if (re.test(q)) { filters.industry = slug; interpreted.push(`industry: ${slug}`); break; }
  }

  // City (also infers country) then country
  for (const [re, info] of CITY_KEYWORDS) {
    if (re.test(q)) {
      filters.city = info.city;
      interpreted.push(`city: ${info.city}`);
      if (info.country && !filters.country) filters.country = info.country;
      break;
    }
  }
  if (!filters.country) {
    for (const [re, code] of COUNTRY_KEYWORDS) {
      if (re.test(q)) { filters.country = code; interpreted.push(`country: ${code}`); break; }
    }
  } else {
    interpreted.push(`country: ${filters.country}`);
  }

  // Website existence
  if (neg('website').test(q)) { filters.hasWebsite = false; interpreted.push('without website'); }
  else if (pos('website').test(q) || /\bwith (a )?(live )?site\b/i.test(q)) { filters.hasWebsite = true; interpreted.push('has website'); }

  // Email existence
  if (neg('e?-?mail').test(q)) { filters.hasEmail = false; interpreted.push('without email'); }
  else if (pos('e?-?mail').test(q) || /\bpublic (business )?e?-?mail\b/i.test(q)) { filters.hasEmail = true; interpreted.push('has public email'); }

  // Pains / signals
  const pains: string[] = [];
  if (/\b(no|without|missing)\s+(live\s*)?chat\b/i.test(q)) { pains.push('no_live_chat'); interpreted.push('no live chat'); }
  if (/\bcontact form( only)?\b/i.test(q)) { pains.push('contact_form_only'); interpreted.push('contact form only'); }
  if (/\b(no|without|missing)\s+(online\s*)?booking\b/i.test(q)) { pains.push('no_online_booking'); interpreted.push('no online booking'); }
  if (/\b(no|without|missing)\s+(messenger|whatsapp|telegram|live chat widget)\b/i.test(q)) { pains.push('no_messenger'); interpreted.push('no messenger'); }
  if (pains.length) filters.pains = pains;

  // Product fit
  for (const [re, key] of PRODUCT_KEYWORDS) {
    if (re.test(q)) { filters.productFit = key; interpreted.push(`fit: ${productLabel(key)}`); break; }
  }

  return { filters, interpreted, parser: 'deterministic' };
}
