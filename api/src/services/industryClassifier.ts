// Deterministic industry classifier. No external AI dependency.

export interface ClassifyInput {
  osmTags?: Record<string, string>;
  tavilyQuery?: string;
  tavilyPreset?: string;
  pageTitle?: string;
  metaDescription?: string;
  pageText?: string;
  urlPath?: string;
  domain?: string;
  analysisFacts?: string;
}

export interface ClassifyResult {
  primary: string | null;
  secondary: string[];
  confidence: number; // 0.0–1.0
  source: 'osm' | 'tavily' | 'website_analysis' | 'manual';
}

// OSM amenity/shop/office/tourism tag → slug mapping
const OSM_TAG_MAP: Record<string, string> = {
  // beauty
  'amenity:beauty_salon': 'beauty_salon',
  'amenity:hairdresser':  'beauty_salon',
  'shop:hairdresser':     'beauty_salon',
  'shop:beauty':          'beauty_salon',
  'shop:cosmetics':       'beauty_salon',
  'shop:nail_salon':      'nail_studio',
  'amenity:nail_salon':   'nail_studio',
  'shop:barber':          'barbershop',
  'amenity:barber':       'barbershop',
  'amenity:spa':          'spa',
  'leisure:spa':          'spa',
  'amenity:massage':      'massage',
  'shop:massage':         'massage',
  // medical
  'amenity:dentist':      'dental_clinic',
  'amenity:clinic':       'private_clinic',
  'amenity:doctors':      'private_clinic',
  'amenity:hospital':     'private_clinic',
  'healthcare:clinic':    'private_clinic',
  'amenity:veterinary':   'veterinary_clinic',
  // local_services
  'shop:car_repair':      'car_service',
  'amenity:car_repair':   'car_service',
  'shop:car_service':     'car_service',
  'amenity:dry_cleaning': 'cleaning_service',
  'shop:dry_cleaning':    'cleaning_service',
  'office:lawyer':        'legal_service',
  'office:notary':        'legal_service',
  'office:estate_agent':  'real_estate',
  'shop:real_estate':     'real_estate',
  // food & hospitality
  'amenity:restaurant':   'restaurant',
  'amenity:fast_food':    'restaurant',
  'amenity:cafe':         'cafe',
  'amenity:bar':          'cafe',
  'tourism:hotel':        'hotel',
  'tourism:hostel':       'hotel',
  'tourism:guest_house':  'hotel',
  'tourism:travel_agency':'travel_agency',
  'amenity:travel_agency':'travel_agency',
  // education
  'amenity:school':       'school',
  'amenity:college':      'school',
  'amenity:university':   'school',
  'amenity:language_school':'courses',
  'amenity:driving_school':'courses',
  'office:educational_institution':'training_center',
};

// Keyword rules: [regex pattern, slug, confidence]
type Rule = [RegExp, string, number];

const TITLE_RULES: Rule[] = [
  // beauty
  [/beauty\s*salon|салон\s*красоты|салон\s*краси/i,       'beauty_salon',    0.85],
  [/nail\s*(salon|studio|bar)|ноготки|нейл/i,              'nail_studio',     0.85],
  [/barber\s*shop|барбершоп|barbershop/i,                   'barbershop',      0.85],
  [/\bspa\b|спа/i,                                          'spa',             0.75],
  [/massage|масаж|массаж/i,                                 'massage',         0.80],
  // medical
  [/dental|dentist|стомат|зубн/i,                           'dental_clinic',   0.90],
  [/\bclinic\b|клиник|клінік/i,                             'private_clinic',  0.80],
  [/dermatolog/i,                                            'dermatology',     0.90],
  [/veterinar|вет\s*клиник|вет\s*клінік|ветеринар/i,        'veterinary_clinic',0.90],
  // local services
  [/car\s*(repair|service|fix)|autoservice|автосерв/i,      'car_service',     0.85],
  [/cleaning\s*(service|company)|клинин|прибирання/i,       'cleaning_service',0.85],
  [/\b(lawyer|attorney|law\s*firm|юрист|адвокат)\b/i,       'legal_service',   0.85],
  [/real\s*estate|property|недвижимость|нерухомість/i,      'real_estate',     0.80],
  [/repair\s*(shop|service)|ремонт/i,                       'repair_service',  0.75],
  // digital
  [/web\s*(agency|studio|design)|веб.агентство|веб.студія/i,'web_agency',      0.85],
  [/marketing\s*(agency|studio)|маркетинг.агентство/i,      'marketing_agency',0.85],
  [/\bsaas\b|software\s*as/i,                               'saas',            0.80],
  [/online\s*store|e.?commerce|интернет.магазин|інтернет.магазин/i,'ecommerce',0.85],
  [/powered by shopify|shopify/i,                            'shopify_store',   0.90],
  [/woocommerce|woo\s*commerce/i,                            'woocommerce_store',0.90],
  [/wordpress/i,                                             'wordpress_site',  0.75],
  // food
  [/restaurant|ресторан/i,                                   'restaurant',      0.85],
  [/\bcafe\b|coffee\s*shop|кафе/i,                           'cafe',            0.80],
  [/hotel|hostel|готель|отель/i,                             'hotel',           0.85],
  [/travel\s*agenc|tour\s*operat|тур.агент/i,               'travel_agency',   0.85],
  // education
  [/online\s*course|онлайн.курс/i,                           'courses',         0.85],
  [/tutoring|репетитор/i,                                    'tutoring',        0.85],
  [/\bschool\b|школа/i,                                      'school',          0.75],
  [/training\s*(center|centre)|учебный\s*центр|навчальний\s*центр/i,'training_center',0.85],
];

// URL/path signals
const URL_RULES: Rule[] = [
  [/\/shop\/|\/store\/|\/cart\/|\/checkout\//i,  'ecommerce',    0.70],
  [/shopify\.com/i,                               'shopify_store',0.95],
  [/myshopify\.com/i,                             'shopify_store',0.95],
  [/woocommerce/i,                                'woocommerce_store',0.90],
  [/wordpress/i,                                  'wordpress_site',0.80],
  [/\/dental|\/dentist/i,                         'dental_clinic',0.80],
  [/\/spa\b|\/spa\//i,                            'spa',          0.75],
  [/\/hotel\b|\/hotel\//i,                        'hotel',        0.80],
];

// Tavily preset keyword → slug
const PRESET_MAP: Record<string, string> = {
  'beauty': 'beauty_salon',
  'nail': 'nail_studio',
  'barber': 'barbershop',
  'dental': 'dental_clinic',
  'clinic': 'private_clinic',
  'vet': 'veterinary_clinic',
  'restaurant': 'restaurant',
  'cafe': 'cafe',
  'hotel': 'hotel',
  'travel': 'travel_agency',
  'saas': 'saas',
  'ecommerce': 'ecommerce',
  'web_agency': 'web_agency',
  'real_estate': 'real_estate',
  'car_service': 'car_service',
  'law': 'legal_service',
  'school': 'school',
  'courses': 'courses',
};

// Map sub-slug to parent slug
const SLUG_PARENTS: Record<string, string> = {
  beauty_salon: 'beauty', nail_studio: 'beauty', barbershop: 'beauty', spa: 'beauty', massage: 'beauty',
  dental_clinic: 'medical', private_clinic: 'medical', dermatology: 'medical', veterinary_clinic: 'medical',
  repair_service: 'local_services', cleaning_service: 'local_services', car_service: 'local_services',
  legal_service: 'local_services', real_estate: 'local_services',
  web_agency: 'digital', marketing_agency: 'digital', saas: 'digital', ecommerce: 'digital',
  wordpress_site: 'digital', shopify_store: 'digital', woocommerce_store: 'digital',
  restaurant: 'food_hospitality', cafe: 'food_hospitality', hotel: 'food_hospitality', travel_agency: 'food_hospitality',
  courses: 'education', tutoring: 'education', school: 'education', training_center: 'education',
};

export function classifyIndustry(input: ClassifyInput): ClassifyResult {
  const candidates: Array<{ slug: string; confidence: number; source: ClassifyResult['source'] }> = [];

  // 1. OSM tags (highest authority)
  if (input.osmTags) {
    for (const [k, v] of Object.entries(input.osmTags)) {
      const key = `${k}:${v}`;
      const slug = OSM_TAG_MAP[key];
      if (slug) candidates.push({ slug, confidence: 0.95, source: 'osm' });
    }
  }

  // 2. Tavily preset
  if (input.tavilyPreset) {
    const slug = PRESET_MAP[input.tavilyPreset.toLowerCase()];
    if (slug) candidates.push({ slug, confidence: 0.75, source: 'tavily' });
  }

  // 3. Tavily query text
  if (input.tavilyQuery) {
    for (const [re, slug, conf] of TITLE_RULES) {
      if (re.test(input.tavilyQuery)) {
        candidates.push({ slug, confidence: conf * 0.8, source: 'tavily' });
        break;
      }
    }
  }

  // 4. Page title + meta description
  const textBlock = [input.pageTitle, input.metaDescription, input.analysisFacts].filter(Boolean).join(' ');
  if (textBlock) {
    for (const [re, slug, conf] of TITLE_RULES) {
      if (re.test(textBlock)) {
        candidates.push({ slug, confidence: conf, source: 'website_analysis' });
      }
    }
  }

  // 5. URL/domain signals
  const urlBlock = [input.urlPath, input.domain].filter(Boolean).join(' ');
  if (urlBlock) {
    for (const [re, slug, conf] of URL_RULES) {
      if (re.test(urlBlock)) {
        candidates.push({ slug, confidence: conf, source: 'website_analysis' });
      }
    }
  }

  // 6. Page text (lower confidence)
  if (input.pageText) {
    for (const [re, slug, conf] of TITLE_RULES) {
      if (re.test(input.pageText)) {
        candidates.push({ slug, confidence: conf * 0.65, source: 'website_analysis' });
      }
    }
  }

  if (!candidates.length) return { primary: null, secondary: [], confidence: 0, source: 'website_analysis' };

  // Aggregate scores per slug
  const scores = new Map<string, { total: number; count: number; source: ClassifyResult['source'] }>();
  for (const c of candidates) {
    const existing = scores.get(c.slug);
    if (!existing) {
      scores.set(c.slug, { total: c.confidence, count: 1, source: c.source });
    } else {
      existing.total = Math.min(1, existing.total + c.confidence * 0.3);
      existing.count++;
    }
  }

  // Sort by aggregated score desc
  const sorted = [...scores.entries()]
    .map(([slug, s]) => ({ slug, confidence: s.total, source: s.source }))
    .sort((a, b) => b.confidence - a.confidence);

  const primary = sorted[0];
  const secondary = sorted.slice(1, 4)
    .filter(s => s.confidence >= 0.4 && s.slug !== SLUG_PARENTS[primary.slug])
    .map(s => s.slug);

  // Include parent category in secondary if not primary
  const parentSlug = SLUG_PARENTS[primary.slug];
  if (parentSlug && !secondary.includes(parentSlug)) {
    secondary.unshift(parentSlug);
  }

  return {
    primary: primary.slug,
    secondary: secondary.slice(0, 3),
    confidence: Math.min(1, primary.confidence),
    source: primary.source,
  };
}
