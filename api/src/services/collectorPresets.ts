// Targeting presets for the Collector module.
// Presets only GENERATE search queries. They never run external searches unless
// the tenant has a configured search provider. The tenant can still combine
// these queries with manual URL or CSV imports.

export interface CollectorPreset {
  code: string;
  label: { en: string; ru: string; uk: string };
  buildQueries: (keywords: string[], country?: string, language?: string) => string[];
}

const k = (kws: string[]) => kws.filter(Boolean).join(' ');

export const PRESETS: CollectorPreset[] = [
  {
    code: 'wordpress',
    label: { en: 'WordPress sites', ru: 'Сайты на WordPress', uk: 'Сайти на WordPress' },
    buildQueries: (kw) => [
      `inurl:wp-content ${k(kw)}`,
      `"powered by wordpress" ${k(kw)}`,
      `inurl:/wp-login.php -intitle:"403"`,
    ],
  },
  {
    code: 'small_business',
    label: { en: 'Small business websites', ru: 'Сайты малого бизнеса', uk: 'Сайти малого бізнесу' },
    buildQueries: (kw) => [
      `"contact us" ${k(kw)}`,
      `"about us" ${k(kw)}`,
      `"family business" ${k(kw)}`,
    ],
  },
  {
    code: 'ecommerce',
    label: { en: 'E-commerce websites', ru: 'Интернет-магазины', uk: 'Інтернет-магазини' },
    buildQueries: (kw) => [
      `"add to cart" ${k(kw)}`,
      `"checkout" "shipping" ${k(kw)}`,
      `inurl:product ${k(kw)}`,
    ],
  },
  {
    code: 'saas_startup',
    label: { en: 'SaaS / startups', ru: 'SaaS / стартапы', uk: 'SaaS / стартапи' },
    buildQueries: (kw) => [
      `"pricing" "api" ${k(kw)}`,
      `"free trial" "signup" ${k(kw)}`,
      `"book a demo" ${k(kw)}`,
    ],
  },
  {
    code: 'agency_studio',
    label: { en: 'Agencies / web studios', ru: 'Агентства / веб-студии', uk: 'Агенції / веб-студії' },
    buildQueries: (kw) => [
      `"web design agency" ${k(kw)}`,
      `"digital agency" portfolio ${k(kw)}`,
      `"our clients" "case studies" ${k(kw)}`,
    ],
  },
  {
    code: 'local_service',
    label: { en: 'Local service websites', ru: 'Локальные сервисы', uk: 'Локальні сервіси' },
    buildQueries: (kw, country) => [
      `"book online" ${country ?? ''} ${k(kw)}`.trim(),
      `"call us" "${country ?? ''}" ${k(kw)}`.trim(),
      `"opening hours" ${k(kw)}`,
    ],
  },
  {
    code: 'has_contact_about',
    label: { en: 'Sites with contact/about pages', ru: 'Сайты со страницами Contact/About', uk: 'Сайти зі сторінками Contact/About' },
    buildQueries: (kw) => [
      `"contact us" ${k(kw)}`,
      `"about us" ${k(kw)}`,
      `"get in touch" ${k(kw)}`,
    ],
  },
  {
    code: 'custom',
    label: { en: 'Custom keywords only', ru: 'Только пользовательские ключевые слова', uk: 'Лише користувацькі ключові слова' },
    buildQueries: (kw) => kw.length ? [k(kw)] : [],
  },
  // ----- Tavily-friendly presets (natural-language queries) -----
  { code: 'tavily_small_business_contact',
    label: { en: 'Small business websites — contact page', ru: 'Сайты малого бизнеса — контакты', uk: 'Сайти малого бізнесу — контакти' },
    buildQueries: (kw, country) => [`small business website contact page ${country ?? ''} ${k(kw)}`.trim()] },
  { code: 'tavily_web_agency_contact',
    label: { en: 'Web design agency — contact', ru: 'Веб-агентство — контакты', uk: 'Веб-агенція — контакти' },
    buildQueries: (kw, country) => [`web design agency contact us ${country ?? ''} ${k(kw)}`.trim()] },
  { code: 'tavily_ecommerce_contact',
    label: { en: 'E-commerce website — contact us', ru: 'Интернет-магазин — Contact us', uk: 'Інтернет-магазин — Contact us' },
    buildQueries: (kw, country) => [`ecommerce website contact us ${country ?? ''} ${k(kw)}`.trim()] },
  { code: 'tavily_wordpress_business_contact',
    label: { en: 'WordPress business website — contact', ru: 'Бизнес-сайт на WordPress — контакты', uk: 'Бізнес-сайт на WordPress — контакти' },
    buildQueries: (kw, country) => [`wordpress business website contact ${country ?? ''} ${k(kw)}`.trim()] },
  { code: 'tavily_local_service_contact',
    label: { en: 'Local service company — contact', ru: 'Локальная сервисная компания — контакты', uk: 'Локальна сервісна компанія — контакти' },
    buildQueries: (kw, country) => [`local service company contact ${country ?? ''} ${k(kw)}`.trim()] },
  { code: 'tavily_beauty_salon_contact',
    label: { en: 'Beauty salon website — contact', ru: 'Сайт салона красоты — контакты', uk: 'Сайт салону краси — контакти' },
    buildQueries: (kw, country) => [`beauty salon website contact ${country ?? ''} ${k(kw)}`.trim()] },
  { code: 'tavily_dental_clinic_contact',
    label: { en: 'Dental clinic website — contact', ru: 'Сайт стоматологии — контакты', uk: 'Сайт стоматології — контакти' },
    buildQueries: (kw, country) => [`dental clinic website contact ${country ?? ''} ${k(kw)}`.trim()] },
  { code: 'tavily_repair_service_contact',
    label: { en: 'Repair service website — contact', ru: 'Сайт сервиса ремонта — контакты', uk: 'Сайт сервісу ремонту — контакти' },
    buildQueries: (kw, country) => [`repair service website contact ${country ?? ''} ${k(kw)}`.trim()] },
  { code: 'tavily_online_store_contact',
    label: { en: 'Online store — contact us', ru: 'Онлайн-магазин — Contact us', uk: 'Онлайн-магазин — Contact us' },
    buildQueries: (kw, country) => [`online store contact us ${country ?? ''} ${k(kw)}`.trim()] },
  { code: 'tavily_woocommerce_store_contact',
    label: { en: 'WooCommerce store — contact', ru: 'WooCommerce магазин — контакты', uk: 'WooCommerce магазин — контакти' },
    buildQueries: (kw, country) => [`woocommerce store contact ${country ?? ''} ${k(kw)}`.trim()] },
  { code: 'tavily_shopify_store_contact',
    label: { en: 'Shopify store — contact', ru: 'Shopify магазин — контакты', uk: 'Shopify магазин — контакти' },
    buildQueries: (kw, country) => [`shopify store contact ${country ?? ''} ${k(kw)}`.trim()] },
];

export function expandPresets(presetCodes: string[], keywords: string[], country?: string, language?: string): string[] {
  const out: string[] = [];
  for (const code of presetCodes) {
    const p = PRESETS.find((x) => x.code === code);
    if (!p) continue;
    for (const q of p.buildQueries(keywords, country, language)) out.push(q);
  }
  return [...new Set(out)].slice(0, 30);
}

// URL/domain normalization for bulk import.
export interface NormalizedUrl {
  ok: boolean;
  url?: string;       // canonical https://host[:port]/path
  domain?: string;
  reason?: 'invalid' | 'private' | 'unsupported_scheme';
}

const PRIVATE_RE = /(?:^|\.)(localhost|local|invalid|test|example|internal|lan)$|^10\.|^127\.|^192\.168\.|^172\.(1[6-9]|2[0-9]|3[01])\./i;

export function normalizeUrl(input: string): NormalizedUrl {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, reason: 'invalid' };

  let candidate = trimmed;
  if (!/^https?:\/\//i.test(candidate)) candidate = 'https://' + candidate;
  let u: URL;
  try { u = new URL(candidate); } catch { return { ok: false, reason: 'invalid' }; }

  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, reason: 'unsupported_scheme' };

  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return { ok: false, reason: 'invalid' };
  if (PRIVATE_RE.test(host)) return { ok: false, reason: 'private' };

  // Drop fragments and trailing slash for canonical form
  u.hostname = host;
  u.hash = '';
  let path = u.pathname;
  if (path === '/') path = '';
  const port = u.port ? `:${u.port}` : '';
  const canonical = `${u.protocol}//${host}${port}${path}${u.search}`;
  return { ok: true, url: canonical, domain: host };
}
