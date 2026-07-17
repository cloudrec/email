// perpetualCollector.ts
// Keeps one "perpetual" collector campaign running forever.
// Sources are refilled from a rotating bank of Tavily queries and OSM Overpass
// lookups before the queue drains. No campaign ever completes — it stays active.
//
// Safety: never touches any sending logic, never creates contacts, never sends email.

import { query } from './db.js';
import { redis } from './redis.js';
import { logger } from './logger.js';

// ─── Config ─────────────────────────────────────────────────────────────────

// Tavily keys: rotate across multiple accounts to multiply the daily credit
// budget. Accept a comma/whitespace-separated list in TAVILY_API_KEYS, falling
// back to the legacy single TAVILY_API_KEY. Each key gets its own per-day
// counter; we drain one key up to TAVILY_USABLE, then move to the next.
const TAVILY_KEYS = (process.env.TAVILY_API_KEYS ?? process.env.TAVILY_API_KEY ?? '')
  .split(/[\s,]+/)
  .map((k) => k.trim())
  .filter(Boolean);
const TAVILY_KEY       = TAVILY_KEYS[0] ?? '';      // back-compat: first key
const TAVILY_ENDPOINT  = 'https://api.tavily.com/search';
const TAVILY_DAILY_CAP = parseInt(process.env.TAVILY_DAILY_CREDIT_LIMIT ?? '100', 10);
const TAVILY_RESERVE   = 15;                        // keep 15 credits buffer per key
const TAVILY_USABLE    = Math.max(0, TAVILY_DAILY_CAP - TAVILY_RESERVE);
// Total daily budget across all keys.
const TAVILY_USABLE_TOTAL = TAVILY_USABLE * Math.max(1, TAVILY_KEYS.length);
const TAVILY_RESULTS   = parseInt(process.env.TAVILY_MAX_RESULTS_PER_QUERY ?? '20', 10);
const TAVILY_TIMEOUT   = 18_000;

// Rotate through mirrors — first healthy one wins each request
const OVERPASS_MIRRORS = (process.env.OVERPASS_ENDPOINT
  ? [process.env.OVERPASS_ENDPOINT]
  : [
      // mail.ru: confirmed fresh data + fast. Primary.
      // NOTE: overpass.osm.ch was removed — it returns HTTP 200 with empty
      // `elements` (stale/broken DB), which the code treats as a successful
      // empty result, silently starving the collector. Do not re-add.
      'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
      'https://overpass-api.de/api/interpreter',
    ]
);
const REDIS_OSM_MIRROR_IDX = 'perpcol:osm:mirror_idx';
const OVERPASS_TIMEOUT  = 55_000;
const OVERPASS_GAP_MS   = 5_000;  // polite gap between Overpass requests

const CAMPAIGN_NAME    = '__perpetual_global__';
const CHECK_INTERVAL   = 50_000;   // check every 50s
const REFILL_THRESHOLD = 40;       // refill when pending sources < this
const REFILL_BATCH_TAVILY = 8;     // Tavily queries per refill batch
const REFILL_BATCH_OSM    = 6;     // OSM queries per refill batch

// Redis keys
const REDIS_TAVILY_COUNTER  = () => `perpcol:tavily:used:${utcDay()}`;
const REDIS_QUERY_CURSOR    = 'perpcol:query:cursor';
const REDIS_OSM_CURSOR      = 'perpcol:osm:cursor';
const REDIS_OSM_LAST_TS     = 'perpcol:osm:last_ts';
const REDIS_SEEN_URLS       = 'perpcol:seen_urls';

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

// ─── Query bank ──────────────────────────────────────────────────────────────

const INDUSTRIES = [
  'web design agency', 'digital marketing agency', 'SEO agency',
  'graphic design studio', 'software development company', 'IT support company',
  'mobile app developer', 'e-commerce website', 'online store',
  'WooCommerce store', 'Shopify store', 'Magento store',
  'dental clinic', 'dental practice', 'orthodontist',
  'beauty salon', 'hair salon', 'nail salon', 'spa wellness center',
  'fitness gym', 'personal training studio', 'yoga studio', 'pilates studio',
  'crossfit box', 'martial arts school',
  'restaurant', 'cafe', 'bakery', 'catering company', 'food delivery service',
  'pizza restaurant', 'sushi restaurant',
  'real estate agency', 'property management', 'mortgage broker',
  'law firm', 'accounting firm', 'financial advisor', 'insurance agency',
  'tax consultant', 'bookkeeping service',
  'plumber service', 'electrician service', 'HVAC company',
  'roofing contractor', 'painting contractor', 'landscaping company',
  'auto repair shop', 'car dealership', 'towing service', 'car wash',
  'photography studio', 'videography company', 'drone photography',
  'event planning company', 'wedding planner', 'florist shop',
  'tutoring center', 'language school', 'music school', 'art school',
  'coding bootcamp', 'driving school',
  'pediatric clinic', 'physiotherapy clinic', 'chiropractic office',
  'veterinary clinic', 'pet grooming salon', 'pet shop',
  'cleaning service company', 'moving company', 'storage facility',
  'interior design studio', 'architecture firm', 'construction company',
  'printing company', 'signage company', 'embroidery service',
  'travel agency', 'tour operator', 'bed and breakfast',
  'consultancy firm', 'business coaching', 'HR consulting',
  'security company', 'locksmith service', 'alarm system installer',
  'childcare center', 'daycare nursery', 'after-school program',
  'optician practice', 'eye care center',
  'tattoo studio', 'barbershop',
  'pharmacy', 'health food store', 'supplement shop',
  'clothing boutique', 'shoe store', 'jewelry store',
  'furniture store', 'home decor shop', 'lighting store',
  'electronics repair shop', 'phone repair shop',
  'bicycle shop', 'outdoor equipment store',
  'book store', 'toy store', 'hobby shop',
  'recruitment agency', 'staffing agency',
  'logistics company', 'courier service', 'freight company',
  'software as a service company', 'cloud hosting provider',
  'cybersecurity firm', 'data analytics company',
  'marketing consultant', 'PR agency', 'copywriting service',
  'translation service', 'transcription service',
  'meditation center', 'holistic therapy', 'acupuncture practice',
  'tattoo removal clinic', 'laser hair removal clinic',
  'escape room', 'game center', 'bowling alley',
  'gym equipment store', 'sports club',
  'nonprofit organization', 'charity',
  'wedding venue', 'conference center', 'coworking space',
  'podcast studio', 'recording studio',
];

const WORLD_CITIES: Array<{ city: string; country: string }> = [
  // UK
  { city: 'London', country: 'UK' },
  { city: 'Manchester', country: 'UK' },
  { city: 'Birmingham', country: 'UK' },
  { city: 'Leeds', country: 'UK' },
  { city: 'Glasgow', country: 'UK' },
  { city: 'Liverpool', country: 'UK' },
  { city: 'Bristol', country: 'UK' },
  { city: 'Edinburgh', country: 'UK' },
  { city: 'Sheffield', country: 'UK' },
  { city: 'Cardiff', country: 'UK' },
  { city: 'Leicester', country: 'UK' },
  { city: 'Nottingham', country: 'UK' },
  { city: 'Newcastle', country: 'UK' },
  { city: 'Brighton', country: 'UK' },
  { city: 'Belfast', country: 'UK' },
  // USA
  { city: 'New York', country: 'USA' },
  { city: 'Los Angeles', country: 'USA' },
  { city: 'Chicago', country: 'USA' },
  { city: 'Houston', country: 'USA' },
  { city: 'Phoenix', country: 'USA' },
  { city: 'Philadelphia', country: 'USA' },
  { city: 'San Antonio', country: 'USA' },
  { city: 'San Diego', country: 'USA' },
  { city: 'Dallas', country: 'USA' },
  { city: 'San Jose', country: 'USA' },
  { city: 'Austin', country: 'USA' },
  { city: 'San Francisco', country: 'USA' },
  { city: 'Seattle', country: 'USA' },
  { city: 'Denver', country: 'USA' },
  { city: 'Nashville', country: 'USA' },
  { city: 'Miami', country: 'USA' },
  { city: 'Atlanta', country: 'USA' },
  { city: 'Boston', country: 'USA' },
  { city: 'Minneapolis', country: 'USA' },
  { city: 'Portland', country: 'USA' },
  { city: 'Las Vegas', country: 'USA' },
  { city: 'Charlotte', country: 'USA' },
  { city: 'Columbus', country: 'USA' },
  { city: 'Indianapolis', country: 'USA' },
  { city: 'Detroit', country: 'USA' },
  { city: 'Memphis', country: 'USA' },
  { city: 'Baltimore', country: 'USA' },
  { city: 'Milwaukee', country: 'USA' },
  { city: 'Albuquerque', country: 'USA' },
  { city: 'Tucson', country: 'USA' },
  { city: 'Fresno', country: 'USA' },
  { city: 'Sacramento', country: 'USA' },
  { city: 'Kansas City', country: 'USA' },
  { city: 'Salt Lake City', country: 'USA' },
  { city: 'Tampa', country: 'USA' },
  { city: 'Orlando', country: 'USA' },
  // Canada
  { city: 'Toronto', country: 'Canada' },
  { city: 'Vancouver', country: 'Canada' },
  { city: 'Montreal', country: 'Canada' },
  { city: 'Calgary', country: 'Canada' },
  { city: 'Ottawa', country: 'Canada' },
  { city: 'Edmonton', country: 'Canada' },
  { city: 'Winnipeg', country: 'Canada' },
  { city: 'Quebec City', country: 'Canada' },
  // Australia
  { city: 'Sydney', country: 'Australia' },
  { city: 'Melbourne', country: 'Australia' },
  { city: 'Brisbane', country: 'Australia' },
  { city: 'Perth', country: 'Australia' },
  { city: 'Adelaide', country: 'Australia' },
  { city: 'Gold Coast', country: 'Australia' },
  { city: 'Canberra', country: 'Australia' },
  { city: 'Hobart', country: 'Australia' },
  // New Zealand
  { city: 'Auckland', country: 'New Zealand' },
  { city: 'Wellington', country: 'New Zealand' },
  { city: 'Christchurch', country: 'New Zealand' },
  // Germany
  { city: 'Berlin', country: 'Germany' },
  { city: 'Hamburg', country: 'Germany' },
  { city: 'Munich', country: 'Germany' },
  { city: 'Cologne', country: 'Germany' },
  { city: 'Frankfurt', country: 'Germany' },
  { city: 'Stuttgart', country: 'Germany' },
  { city: 'Dusseldorf', country: 'Germany' },
  { city: 'Dortmund', country: 'Germany' },
  { city: 'Leipzig', country: 'Germany' },
  { city: 'Bremen', country: 'Germany' },
  // Netherlands
  { city: 'Amsterdam', country: 'Netherlands' },
  { city: 'Rotterdam', country: 'Netherlands' },
  { city: 'The Hague', country: 'Netherlands' },
  { city: 'Utrecht', country: 'Netherlands' },
  { city: 'Eindhoven', country: 'Netherlands' },
  // France
  { city: 'Paris', country: 'France' },
  { city: 'Lyon', country: 'France' },
  { city: 'Marseille', country: 'France' },
  { city: 'Toulouse', country: 'France' },
  { city: 'Nice', country: 'France' },
  { city: 'Nantes', country: 'France' },
  { city: 'Strasbourg', country: 'France' },
  { city: 'Bordeaux', country: 'France' },
  // Spain
  { city: 'Madrid', country: 'Spain' },
  { city: 'Barcelona', country: 'Spain' },
  { city: 'Valencia', country: 'Spain' },
  { city: 'Seville', country: 'Spain' },
  { city: 'Zaragoza', country: 'Spain' },
  { city: 'Málaga', country: 'Spain' },
  { city: 'Bilbao', country: 'Spain' },
  // Italy
  { city: 'Rome', country: 'Italy' },
  { city: 'Milan', country: 'Italy' },
  { city: 'Naples', country: 'Italy' },
  { city: 'Turin', country: 'Italy' },
  { city: 'Florence', country: 'Italy' },
  { city: 'Bologna', country: 'Italy' },
  { city: 'Genoa', country: 'Italy' },
  // Poland
  { city: 'Warsaw', country: 'Poland' },
  { city: 'Krakow', country: 'Poland' },
  { city: 'Wroclaw', country: 'Poland' },
  { city: 'Gdansk', country: 'Poland' },
  { city: 'Poznan', country: 'Poland' },
  { city: 'Lodz', country: 'Poland' },
  // Sweden
  { city: 'Stockholm', country: 'Sweden' },
  { city: 'Gothenburg', country: 'Sweden' },
  { city: 'Malmo', country: 'Sweden' },
  // Norway
  { city: 'Oslo', country: 'Norway' },
  { city: 'Bergen', country: 'Norway' },
  // Denmark
  { city: 'Copenhagen', country: 'Denmark' },
  { city: 'Aarhus', country: 'Denmark' },
  // Finland
  { city: 'Helsinki', country: 'Finland' },
  { city: 'Tampere', country: 'Finland' },
  // Austria
  { city: 'Vienna', country: 'Austria' },
  { city: 'Graz', country: 'Austria' },
  { city: 'Linz', country: 'Austria' },
  // Switzerland
  { city: 'Zurich', country: 'Switzerland' },
  { city: 'Geneva', country: 'Switzerland' },
  { city: 'Basel', country: 'Switzerland' },
  // Belgium
  { city: 'Brussels', country: 'Belgium' },
  { city: 'Antwerp', country: 'Belgium' },
  { city: 'Ghent', country: 'Belgium' },
  // Czech Republic
  { city: 'Prague', country: 'Czech Republic' },
  { city: 'Brno', country: 'Czech Republic' },
  // Hungary
  { city: 'Budapest', country: 'Hungary' },
  // Portugal
  { city: 'Lisbon', country: 'Portugal' },
  { city: 'Porto', country: 'Portugal' },
  // Ireland
  { city: 'Dublin', country: 'Ireland' },
  { city: 'Cork', country: 'Ireland' },
  // Romania
  { city: 'Bucharest', country: 'Romania' },
  { city: 'Cluj-Napoca', country: 'Romania' },
  // Greece
  { city: 'Athens', country: 'Greece' },
  { city: 'Thessaloniki', country: 'Greece' },
  // Turkey
  { city: 'Istanbul', country: 'Turkey' },
  { city: 'Ankara', country: 'Turkey' },
  { city: 'Izmir', country: 'Turkey' },
  // South Africa
  { city: 'Cape Town', country: 'South Africa' },
  { city: 'Johannesburg', country: 'South Africa' },
  { city: 'Durban', country: 'South Africa' },
  // UAE
  { city: 'Dubai', country: 'UAE' },
  { city: 'Abu Dhabi', country: 'UAE' },
  // Israel
  { city: 'Tel Aviv', country: 'Israel' },
  { city: 'Jerusalem', country: 'Israel' },
  // India
  { city: 'Mumbai', country: 'India' },
  { city: 'Bangalore', country: 'India' },
  { city: 'Delhi', country: 'India' },
  { city: 'Hyderabad', country: 'India' },
  { city: 'Chennai', country: 'India' },
  { city: 'Pune', country: 'India' },
  // Singapore
  { city: 'Singapore', country: 'Singapore' },
  // Japan
  { city: 'Tokyo', country: 'Japan' },
  { city: 'Osaka', country: 'Japan' },
  { city: 'Nagoya', country: 'Japan' },
  // South Korea
  { city: 'Seoul', country: 'South Korea' },
  { city: 'Busan', country: 'South Korea' },
  // Brazil
  { city: 'Sao Paulo', country: 'Brazil' },
  { city: 'Rio de Janeiro', country: 'Brazil' },
  { city: 'Brasilia', country: 'Brazil' },
  { city: 'Curitiba', country: 'Brazil' },
  // Mexico
  { city: 'Mexico City', country: 'Mexico' },
  { city: 'Guadalajara', country: 'Mexico' },
  { city: 'Monterrey', country: 'Mexico' },
  // Argentina
  { city: 'Buenos Aires', country: 'Argentina' },
  { city: 'Cordoba', country: 'Argentina' },
  // Chile
  { city: 'Santiago', country: 'Chile' },
  // Colombia
  { city: 'Bogota', country: 'Colombia' },
  { city: 'Medellin', country: 'Colombia' },
  // Peru
  { city: 'Lima', country: 'Peru' },
  // Slovakia
  { city: 'Bratislava', country: 'Slovakia' },
  // Croatia
  { city: 'Zagreb', country: 'Croatia' },
  // Serbia
  { city: 'Belgrade', country: 'Serbia' },
];

// OSM Overpass selectors per category
const OSM_TARGETS: Array<{ selectors: string[]; label: string }> = [
  { label: 'web_it_agencies',    selectors: ['nwr[office=it][website]', 'nwr[office=company][website]'] },
  { label: 'beauty_salons',      selectors: ['nwr[shop=beauty][website]', 'nwr[shop=hairdresser][website]'] },
  { label: 'dental_clinics',     selectors: ['nwr[amenity=dentist][website]', 'nwr[healthcare=dentist][website]'] },
  { label: 'repair_services',    selectors: ['nwr[shop=car_repair][website]', 'nwr[craft=electronics_repair][website]', 'nwr[craft=plumber][website]'] },
  { label: 'fitness_studios',    selectors: ['nwr[leisure=fitness_centre][website]', 'nwr[sport=fitness][website]'] },
  { label: 'restaurants_cafes',  selectors: ['nwr[amenity=restaurant][website]', 'nwr[amenity=cafe][website]'] },
  { label: 'real_estate',        selectors: ['nwr[office=estate_agent][website]'] },
  { label: 'law_firms',          selectors: ['nwr[office=lawyer][website]'] },
  { label: 'clinics_medical',    selectors: ['nwr[amenity=clinic][website]', 'nwr[healthcare=clinic][website]', 'nwr[amenity=doctors][website]'] },
  { label: 'shops_with_sites',   selectors: ['nwr[shop][website]'] },
  { label: 'offices_with_sites', selectors: ['nwr[office][website]', 'nwr[craft][website]'] },
  // Phase 16 target niches (GB/US/CA/AU): cleaning, plumbers, electricians, HVAC, roofers.
  { label: 'cleaning_services',  selectors: ['nwr[craft=cleaning][website]', 'nwr[shop=laundry][website]', 'nwr[office=cleaning][website]'] },
  { label: 'plumbers',           selectors: ['nwr[craft=plumber][website]'] },
  { label: 'electricians',       selectors: ['nwr[craft=electrician][website]'] },
  { label: 'hvac',               selectors: ['nwr[craft=hvac][website]', 'nwr[craft=heating_engineer][website]'] },
  { label: 'roofers',            selectors: ['nwr[craft=roofer][website]'] },
];

// bbox: [south, west, north, east] — bbox queries are reliable; area+admin_level queries time out
const OSM_CITIES_FOR_OVERPASS: Array<{ city: string; country_code: string; bbox: [number,number,number,number] }> = [
  { city: 'Manchester',      country_code: 'GB', bbox: [53.33, -2.32, 53.56, -2.10] },
  { city: 'London',          country_code: 'GB', bbox: [51.38, -0.32, 51.62,  0.12] },
  { city: 'Birmingham',      country_code: 'GB', bbox: [52.38, -1.97, 52.56, -1.72] },
  { city: 'Glasgow',         country_code: 'GB', bbox: [55.80, -4.35, 55.90, -4.10] },
  { city: 'Bristol',         country_code: 'GB', bbox: [51.40, -2.65, 51.50, -2.50] },
  { city: 'Leeds',           country_code: 'GB', bbox: [53.75, -1.65, 53.85, -1.50] },
  { city: 'Sheffield',       country_code: 'GB', bbox: [53.33, -1.60, 53.45, -1.38] },
  { city: 'Edinburgh',       country_code: 'GB', bbox: [55.90, -3.35, 56.00, -3.10] },
  { city: 'Liverpool',       country_code: 'GB', bbox: [53.35, -3.05, 53.47, -2.85] },
  { city: 'Nottingham',      country_code: 'GB', bbox: [52.90, -1.25, 53.00, -1.10] },
  { city: 'Amsterdam',       country_code: 'NL', bbox: [52.30,  4.80, 52.42,  5.00] },
  { city: 'Rotterdam',       country_code: 'NL', bbox: [51.85,  4.40, 51.97,  4.60] },
  { city: 'Den Haag',        country_code: 'NL', bbox: [52.04,  4.24, 52.14,  4.40] },
  { city: 'Utrecht',         country_code: 'NL', bbox: [52.05,  5.05, 52.15,  5.20] },
  { city: 'Eindhoven',       country_code: 'NL', bbox: [51.40,  5.40, 51.50,  5.55] },
  { city: 'Warsaw',          country_code: 'PL', bbox: [52.10, 20.85, 52.33, 21.15] },
  { city: 'Kraków',          country_code: 'PL', bbox: [49.98, 19.82, 50.10, 20.07] },
  { city: 'Wrocław',         country_code: 'PL', bbox: [51.08, 16.98, 51.20, 17.10] },
  { city: 'Gdańsk',          country_code: 'PL', bbox: [54.28, 18.50, 54.42, 18.72] },
  { city: 'Poznań',          country_code: 'PL', bbox: [52.34, 16.83, 52.46, 17.02] },
  { city: 'Berlin',          country_code: 'DE', bbox: [52.45, 13.25, 52.60, 13.55] },
  { city: 'Hamburg',         country_code: 'DE', bbox: [53.45,  9.83, 53.65, 10.07] },
  { city: 'Munich',          country_code: 'DE', bbox: [48.08, 11.48, 48.22, 11.67] },
  { city: 'Cologne',         country_code: 'DE', bbox: [50.88,  6.83, 51.02,  7.02] },
  { city: 'Frankfurt am Main', country_code: 'DE', bbox: [50.08,  8.58, 50.20,  8.78] },
  { city: 'Vienna',          country_code: 'AT', bbox: [48.10, 16.22, 48.32, 16.52] },
  { city: 'Graz',            country_code: 'AT', bbox: [46.98, 15.30, 47.10, 15.50] },
  { city: 'Prague',          country_code: 'CZ', bbox: [49.98, 14.28, 50.16, 14.52] },
  { city: 'Brno',            country_code: 'CZ', bbox: [49.14, 16.53, 49.25, 16.72] },
  { city: 'Budapest',        country_code: 'HU', bbox: [47.38, 18.88, 47.62, 19.12] },
  { city: 'Brussels',        country_code: 'BE', bbox: [50.80,  4.30, 50.92,  4.47] },
  { city: 'Antwerp',         country_code: 'BE', bbox: [51.18,  4.33, 51.28,  4.47] },
  { city: 'Zurich',          country_code: 'CH', bbox: [47.30,  8.45, 47.45,  8.62] },
  { city: 'Geneva',          country_code: 'CH', bbox: [46.18,  6.10, 46.25,  6.22] },
  { city: 'Stockholm',       country_code: 'SE', bbox: [59.28, 17.98, 59.42, 18.17] },
  { city: 'Gothenburg',      country_code: 'SE', bbox: [57.63, 11.87, 57.75, 12.07] },
  { city: 'Oslo',            country_code: 'NO', bbox: [59.87, 10.68, 60.00, 10.87] },
  { city: 'Copenhagen',      country_code: 'DK', bbox: [55.60, 12.48, 55.72, 12.67] },
  { city: 'Helsinki',        country_code: 'FI', bbox: [60.10, 24.88, 60.25, 25.10] },
  { city: 'Dublin',          country_code: 'IE', bbox: [53.30, -6.37, 53.42, -6.18] },
  { city: 'Lisbon',          country_code: 'PT', bbox: [38.70, -9.22, 38.77, -9.10] },
  { city: 'Porto',           country_code: 'PT', bbox: [41.10, -8.70, 41.20, -8.55] },
  { city: 'Madrid',          country_code: 'ES', bbox: [40.33, -3.77, 40.52, -3.58] },
  { city: 'Barcelona',       country_code: 'ES', bbox: [41.33,  2.10, 41.47,  2.22] },
  { city: 'Rome',            country_code: 'IT', bbox: [41.83, 12.43, 41.98, 12.58] },
  { city: 'Milan',           country_code: 'IT', bbox: [45.42,  9.12, 45.52,  9.28] },
  { city: 'Bucharest',       country_code: 'RO', bbox: [44.37, 25.95, 44.52, 26.17] },
  { city: 'Athens',          country_code: 'GR', bbox: [37.92, 23.68, 38.05, 23.80] },
  { city: 'Belgrade',        country_code: 'RS', bbox: [44.73, 20.38, 44.87, 20.52] },
  { city: 'Zagreb',          country_code: 'HR', bbox: [45.78, 15.87, 45.87, 16.03] },
  // Phase 16 target regions — US / Canada / Australia for the target niches.
  { city: 'New York',        country_code: 'US', bbox: [40.63, -74.07, 40.82, -73.87] },
  { city: 'Los Angeles',     country_code: 'US', bbox: [33.88,-118.52, 34.10,-118.13] },
  { city: 'Chicago',         country_code: 'US', bbox: [41.78, -87.78, 42.02, -87.58] },
  { city: 'Houston',         country_code: 'US', bbox: [29.62, -95.55, 29.88, -95.27] },
  { city: 'Phoenix',         country_code: 'US', bbox: [33.28,-112.18, 33.62,-111.88] },
  { city: 'Toronto',         country_code: 'CA', bbox: [43.58, -79.52, 43.78, -79.28] },
  { city: 'Vancouver',       country_code: 'CA', bbox: [49.18,-123.22, 49.32,-122.98] },
  { city: 'Calgary',         country_code: 'CA', bbox: [50.98,-114.22, 51.12,-114.00] },
  { city: 'Sydney',          country_code: 'AU', bbox: [-33.97, 151.00,-33.83, 151.28] },
  { city: 'Melbourne',       country_code: 'AU', bbox: [-37.92, 144.88,-37.78, 145.02] },
  { city: 'Brisbane',        country_code: 'AU', bbox: [-27.58, 152.88,-27.43, 153.12] },
  // Batch 2 — fresh territory: fills TLD gaps (fr/ee/sk/za/sg/il/ae) + more mid-size
  // Western cities so the fixed city×category grid doesn't saturate as fast.
  { city: 'Paris',           country_code: 'FR', bbox: [48.80,   2.22, 48.92,   2.42] },
  { city: 'Lyon',            country_code: 'FR', bbox: [45.70,   4.78, 45.80,   4.90] },
  { city: 'Tallinn',         country_code: 'EE', bbox: [59.38,  24.60, 59.50,  24.85] },
  { city: 'Bratislava',      country_code: 'SK', bbox: [48.10,  17.05, 48.22,  17.20] },
  { city: 'Johannesburg',    country_code: 'ZA', bbox: [-26.28, 27.95,-26.10,  28.15] },
  { city: 'Cape Town',       country_code: 'ZA', bbox: [-34.00, 18.38,-33.85,  18.55] },
  { city: 'Singapore',       country_code: 'SG', bbox: [ 1.25, 103.70,  1.45, 103.95] },
  { city: 'Tel Aviv',        country_code: 'IL', bbox: [32.03,  34.73, 32.13,  34.83] },
  { city: 'Dubai',           country_code: 'AE', bbox: [25.05,  55.05, 25.30,  55.40] },
  { city: 'Auckland',        country_code: 'NZ', bbox: [-37.00,174.70,-36.80, 174.90] },
  { city: 'Wellington',      country_code: 'NZ', bbox: [-41.35,174.72,-41.25, 174.82] },
  { city: 'Cardiff',         country_code: 'GB', bbox: [51.44,  -3.25, 51.53,  -3.10] },
  { city: 'Newcastle',       country_code: 'GB', bbox: [54.94,  -1.70, 55.02,  -1.55] },
  { city: 'Belfast',         country_code: 'GB', bbox: [54.55,  -5.98, 54.63,  -5.85] },
  { city: 'Boston',          country_code: 'US', bbox: [42.30, -71.15, 42.42, -70.98] },
  { city: 'Seattle',         country_code: 'US', bbox: [47.55,-122.42, 47.72,-122.25] },
  { city: 'Denver',          country_code: 'US', bbox: [39.65,-105.05, 39.80,-104.90] },
  { city: 'Atlanta',         country_code: 'US', bbox: [33.70, -84.45, 33.85, -84.30] },
  { city: 'Miami',           country_code: 'US', bbox: [25.70, -80.30, 25.85, -80.13] },
  { city: 'San Francisco',   country_code: 'US', bbox: [37.72,-122.52, 37.82,-122.38] },
  { city: 'Dallas',          country_code: 'US', bbox: [32.72, -96.90, 32.85, -96.72] },
  { city: 'Montreal',        country_code: 'CA', bbox: [45.45, -73.65, 45.58, -73.48] },
  { city: 'Ottawa',          country_code: 'CA', bbox: [45.35, -75.78, 45.45, -75.62] },
  { city: 'Perth',           country_code: 'AU', bbox: [-32.00,115.78,-31.88, 115.92] },
  { city: 'Adelaide',        country_code: 'AU', bbox: [-34.98,138.55,-34.85, 138.68] },
  // Batch 3 — Ukraine (JobHunter B2B lead pool; NOT wired into any active
  // send campaign yet — content/offer pending, see project notes).
  { city: 'Kyiv',            country_code: 'UA', bbox: [50.35,  30.35, 50.55,  30.65] },
  { city: 'Lviv',            country_code: 'UA', bbox: [49.78,  23.95, 49.88,  24.10] },
  { city: 'Kharkiv',         country_code: 'UA', bbox: [49.90,  36.15, 50.08,  36.35] },
  { city: 'Odesa',           country_code: 'UA', bbox: [46.42,  30.65, 46.52,  30.80] },
  { city: 'Dnipro',          country_code: 'UA', bbox: [48.40,  34.90, 48.52,  35.10] },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizeUrl(raw: string): { url: string; domain: string } | null {
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return null;
    if (/(?:^|\.)(?:localhost|local|invalid|test|example|internal)$|^10\.|^127\.|^192\.168\./.test(host)) return null;
    u.hostname = host;
    u.hash = '';
    const path = u.pathname === '/' ? '' : u.pathname;
    return { url: `${u.protocol}//${host}${path}`, domain: host };
  } catch {
    return null;
  }
}

// Per-key daily counter. Index suffix keeps each key's usage independent.
function tavilyCounterKey(idx: number): string {
  return `${REDIS_TAVILY_COUNTER()}:k${idx}`;
}

async function tavilyKeyUsed(idx: number): Promise<number> {
  const val = await redis.get(tavilyCounterKey(idx));
  return parseInt(val ?? '0', 10);
}

// Sum across all keys — used for refill budgeting / logging.
async function tavilyCreditsUsedToday(): Promise<number> {
  if (TAVILY_KEYS.length === 0) return 0;
  const counts = await Promise.all(TAVILY_KEYS.map((_, i) => tavilyKeyUsed(i)));
  return counts.reduce((a, b) => a + b, 0);
}

async function incrementTavilyCredits(idx: number): Promise<void> {
  const key = tavilyCounterKey(idx);
  const ttl = await redis.ttl(key);
  await redis.incr(key);
  if (ttl < 0) await redis.expire(key, 86_400 * 2);
}

// Mark a key as fully spent for the rest of the day (auth/credit failure).
async function burnTavilyKey(idx: number): Promise<void> {
  const key = tavilyCounterKey(idx);
  await redis.set(key, String(TAVILY_USABLE), 'EX', 86_400 * 2);
}

// First key with remaining budget today; null if all keys exhausted.
async function pickTavilyKeyIdx(): Promise<number | null> {
  for (let i = 0; i < TAVILY_KEYS.length; i++) {
    if ((await tavilyKeyUsed(i)) < TAVILY_USABLE) return i;
  }
  return null;
}

async function tavilySearch(searchQuery: string): Promise<string[]> {
  if (TAVILY_KEYS.length === 0) return [];
  const idx = await pickTavilyKeyIdx();
  if (idx === null) return [];   // every key maxed for today
  const apiKey = TAVILY_KEYS[idx];

  try {
    const res = await fetch(TAVILY_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query: searchQuery,
        max_results: TAVILY_RESULTS,
        search_depth: 'basic',
        include_answer: false,
        include_images: false,
      }),
      signal: AbortSignal.timeout(TAVILY_TIMEOUT),
    });

    if (res.status === 401 || res.status === 402 || res.status === 432) {
      // 401 invalid key, 402 out of credits, 432 = Tavily "exceeds your plan's
      // usage limit". All mean the key is unusable for the rest of the period —
      // burn it so rotation skips it instead of re-hitting the same failure
      // every loop (was spinning 400+ times/day on a 432).
      logger.warn({ status: res.status, keyIdx: idx }, 'perpcol: tavily credits/plan limit — retiring key for today');
      await burnTavilyKey(idx);
      return [];
    }
    if (!res.ok) {
      // Some quota errors arrive with other 4xx codes and the reason only in the
      // body. Inspect it so we retire the key rather than spin on it all day.
      let bodyText = '';
      try { bodyText = (await res.text()).toLowerCase(); } catch { /* ignore */ }
      if (bodyText.includes('credit') || bodyText.includes('quota') || bodyText.includes('usage limit') || bodyText.includes("plan's")) {
        logger.warn({ status: res.status, keyIdx: idx }, 'perpcol: tavily quota in body — retiring key for today');
        await burnTavilyKey(idx);
        return [];
      }
      logger.warn({ status: res.status, q: searchQuery, keyIdx: idx }, 'perpcol: tavily non-ok');
      return [];
    }

    const json: any = await res.json();
    const errText = (json?.error ?? json?.message ?? json?.detail ?? '').toString().toLowerCase();
    if (errText.includes('credit') || errText.includes('quota') || errText.includes('limit')) {
      logger.warn({ q: searchQuery, keyIdx: idx }, 'perpcol: tavily quota in body — retiring key for today');
      await burnTavilyKey(idx);
      return [];
    }

    await incrementTavilyCredits(idx);

    const results: any[] = Array.isArray(json?.results) ? json.results : [];
    return results
      .map((r: any) => (typeof r.url === 'string' ? r.url : ''))
      .filter(Boolean);
  } catch (e: any) {
    logger.warn({ q: searchQuery, err: e.message }, 'perpcol: tavily fetch error');
    return [];
  }
}

async function pickOverpassEndpoint(): Promise<string> {
  if (OVERPASS_MIRRORS.length === 1) return OVERPASS_MIRRORS[0];
  const raw = await redis.get(REDIS_OSM_MIRROR_IDX);
  const idx = parseInt(raw ?? '0', 10) % OVERPASS_MIRRORS.length;
  return OVERPASS_MIRRORS[idx];
}

async function rotateOverpassEndpoint(): Promise<void> {
  if (OVERPASS_MIRRORS.length <= 1) return;
  const raw = await redis.get(REDIS_OSM_MIRROR_IDX);
  const next = (parseInt(raw ?? '0', 10) + 1) % OVERPASS_MIRRORS.length;
  await redis.set(REDIS_OSM_MIRROR_IDX, String(next), 'EX', 3600);
}

const OSM_COOLDOWN_SEC = 3600;  // skip a city for 1h after all mirrors fail/timeout
const REDIS_OSM_COOLDOWN = (city: string) => `perpcol:osm:cooldown:${city.toLowerCase()}`;

async function osmSearch(city: string, countryCode: string, bbox: [number,number,number,number], selectors: string[]): Promise<string[]> {
  // Skip "slow cities": if this city failed all mirrors recently, back off.
  if (await redis.get(REDIS_OSM_COOLDOWN(city))) {
    logger.debug({ city }, 'perpcol: skipping city on OSM cooldown');
    return [];
  }

  // Rate limit: enforce gap between requests using Redis timestamp
  const lastTs = parseInt(await redis.get(REDIS_OSM_LAST_TS) ?? '0', 10);
  const now = Date.now();
  const gap = now - lastTs;
  if (gap < OVERPASS_GAP_MS) {
    await new Promise((r) => setTimeout(r, OVERPASS_GAP_MS - gap + 100));
  }

  // bbox query — reliable; area+admin_level queries time out on public mirrors
  const [s, w, n, e] = bbox;
  const selectorStr = selectors.map((sel) => `  ${sel};`).join('\n');
  const ql = `[out:json][timeout:50][bbox:${s},${w},${n},${e}];\n(\n${selectorStr}\n);\nout center 300;`;

  // Try each mirror in order, rotate on failure
  const startIdx = parseInt(await redis.get(REDIS_OSM_MIRROR_IDX) ?? '0', 10) % OVERPASS_MIRRORS.length;
  const orderedMirrors = [
    ...OVERPASS_MIRRORS.slice(startIdx),
    ...OVERPASS_MIRRORS.slice(0, startIdx),
  ];

  for (const endpoint of orderedMirrors) {
    try {
      await redis.set(REDIS_OSM_LAST_TS, String(Date.now()), 'EX', 3600);
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': 'EmailPlatformCollector/0.1 (+https://email.clients.help/about/crawler)',
        },
        body: `data=${encodeURIComponent(ql)}`,
        signal: AbortSignal.timeout(OVERPASS_TIMEOUT),
      });

      if (res.status === 429) {
        logger.warn({ city, endpoint }, 'perpcol: overpass rate limited — trying next mirror');
        await rotateOverpassEndpoint();
        await new Promise((r) => setTimeout(r, 5_000));
        continue;
      }
      if (!res.ok) {
        logger.warn({ city, endpoint, status: res.status }, 'perpcol: overpass non-ok — trying next mirror');
        await rotateOverpassEndpoint();
        continue;
      }

      const json: any = await res.json();
      const elements: any[] = Array.isArray(json?.elements) ? json.elements : [];
      const urls: string[] = [];
      for (const el of elements) {
        const tags = el.tags ?? {};
        const site = tags.website ?? tags['contact:website'] ?? tags['contact:url'] ?? tags.url ?? '';
        if (site && typeof site === 'string') urls.push(site.trim());
      }
      logger.debug({ city, endpoint, found: urls.length }, 'perpcol: osm search ok');
      return [...new Set(urls)];
    } catch (e: any) {
      logger.warn({ city, endpoint, err: e.message }, 'perpcol: overpass error — trying next mirror');
      await rotateOverpassEndpoint();
      // small gap before trying next mirror
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }

  // All mirrors failed — put this city on cooldown so we skip it next rounds.
  await redis.set(REDIS_OSM_COOLDOWN(city), '1', 'EX', OSM_COOLDOWN_SEC);
  logger.warn({ city }, 'perpcol: all overpass mirrors failed — city on cooldown');
  return [];
}

// ─── Campaign management ─────────────────────────────────────────────────────

async function getOrCreateCampaign(tenantId: number): Promise<number> {
  const rows = await query(
    "SELECT id, status FROM collector_campaigns WHERE tenant_id=? AND name=? LIMIT 1",
    [tenantId, CAMPAIGN_NAME],
  );

  if (rows.length) {
    const row = rows[0];
    if (row.status !== 'active') {
      await query(
        "UPDATE collector_campaigns SET status='active' WHERE id=?",
        [row.id],
      );
      logger.info({ id: row.id, prevStatus: row.status }, 'perpcol: reactivated campaign');
    }
    return row.id;
  }

  const r = await query(
    `INSERT INTO collector_campaigns
       (tenant_id, name, status, mode, keywords, countries, languages, preset_codes,
        max_sources_total, max_sources_per_day, max_pages_per_source, crawl_delay_seconds,
        analyze_website, generate_draft)
     VALUES (?, ?, 'active', 'search_provider', '[]', '[]', '[]', '[]',
             999999999, 999999999, 5, 2, 0, 0)`,
    [tenantId, CAMPAIGN_NAME],
  );
  logger.info({ id: Number(r.insertId) }, 'perpcol: created perpetual campaign');
  return Number(r.insertId);
}

async function pendingCount(campaignId: number): Promise<number> {
  const r = await query(
    "SELECT COUNT(*) AS c FROM collector_campaign_sources WHERE campaign_id=? AND state='pending'",
    [campaignId],
  );
  return Number(r[0]?.c ?? 0);
}

async function ingestUrls(tenantId: number, campaignId: number, rawUrls: string[]): Promise<number> {
  let added = 0;
  for (const raw of rawUrls) {
    const norm = normalizeUrl(raw);
    if (!norm) continue;

    // Deduplicate via seen-URLs Redis set (fast path before DB hit)
    const seenKey = `${norm.domain}`;
    const already = await redis.sismember(REDIS_SEEN_URLS, seenKey);
    if (already) continue;

    try {
      // Insert or find lead_source
      const existing = await query(
        'SELECT id FROM lead_sources WHERE tenant_id=? AND url=? LIMIT 1',
        [tenantId, norm.url],
      );
      let sourceId: number;
      if (existing.length) {
        sourceId = existing[0].id;
      } else {
        const ins = await query(
          "INSERT INTO lead_sources (tenant_id, url, domain, label, status, added_by) VALUES (?, ?, ?, 'Perpetual collector', 'active', NULL)",
          [tenantId, norm.url, norm.domain],
        );
        sourceId = Number(ins.insertId);
      }

      // Attach to campaign
      await query(
        "INSERT IGNORE INTO collector_campaign_sources (tenant_id, campaign_id, lead_source_id, added_by_mode, state) VALUES (?, ?, ?, 'search_provider', 'pending')",
        [tenantId, campaignId, sourceId],
      );

      await redis.sadd(REDIS_SEEN_URLS, seenKey);
      // Keep seen set from growing unbounded — trim every ~10k entries
      const size = await redis.scard(REDIS_SEEN_URLS);
      if (size > 50_000) {
        // Remove 10k random members to stay bounded
        const members = await redis.srandmember(REDIS_SEEN_URLS, 10_000);
        if (members.length) await redis.srem(REDIS_SEEN_URLS, ...members);
      }

      added++;
    } catch {
      // duplicate key or other error — skip
    }
  }
  return added;
}

// ─── Query rotation ──────────────────────────────────────────────────────────

async function nextTavilyQueryBatch(size: number): Promise<string[]> {
  const total = INDUSTRIES.length * WORLD_CITIES.length;
  const cursorRaw = await redis.get(REDIS_QUERY_CURSOR);
  let cursor = parseInt(cursorRaw ?? '0', 10);

  const queries: string[] = [];
  for (let i = 0; i < size; i++) {
    const idx = (cursor + i) % total;
    const industryIdx = Math.floor(idx / WORLD_CITIES.length);
    const cityIdx = idx % WORLD_CITIES.length;
    const ind = INDUSTRIES[industryIdx];
    const loc = WORLD_CITIES[cityIdx];
    queries.push(`${ind} ${loc.city} ${loc.country} contact email`);
  }

  cursor = (cursor + size) % total;
  await redis.set(REDIS_QUERY_CURSOR, String(cursor));
  return queries;
}

async function nextOsmBatch(size: number): Promise<Array<{ city: string; country_code: string; bbox: [number,number,number,number]; selectors: string[]; label: string }>> {
  const total = OSM_CITIES_FOR_OVERPASS.length * OSM_TARGETS.length;
  const cursorRaw = await redis.get(REDIS_OSM_CURSOR);
  let cursor = parseInt(cursorRaw ?? '0', 10);

  const batch: Array<{ city: string; country_code: string; bbox: [number,number,number,number]; selectors: string[]; label: string }> = [];
  for (let i = 0; i < size; i++) {
    const idx = (cursor + i) % total;
    const cityIdx = Math.floor(idx / OSM_TARGETS.length);
    const catIdx = idx % OSM_TARGETS.length;
    const loc = OSM_CITIES_FOR_OVERPASS[cityIdx];
    const cat = OSM_TARGETS[catIdx];
    batch.push({ city: loc.city, country_code: loc.country_code, bbox: loc.bbox, selectors: cat.selectors, label: cat.label });
  }

  cursor = (cursor + size) % total;
  await redis.set(REDIS_OSM_CURSOR, String(cursor));
  return batch;
}

// ─── Main loop ───────────────────────────────────────────────────────────────

async function findActiveTenant(): Promise<number | null> {
  const rows = await query(
    "SELECT id FROM tenants WHERE status IN ('active','trial') ORDER BY id ASC LIMIT 1",
  );
  return rows[0]?.id ?? null;
}

async function tick(): Promise<void> {
  // 1. Find tenant
  const tenantId = await findActiveTenant();
  if (!tenantId) {
    logger.warn('perpcol: no active tenant found');
    return;
  }

  // 2. Check collector enabled
  const globalPause = await query("SELECT paused_globally FROM collector_global_settings WHERE id=1");
  if (globalPause[0]?.paused_globally) {
    logger.info('perpcol: globally paused, skipping');
    return;
  }

  // 3. Get/create perpetual campaign
  const campaignId = await getOrCreateCampaign(tenantId);

  // 4. Check how many pending sources remain
  const pending = await pendingCount(campaignId);
  logger.info({ pending, campaignId, tenantId }, 'perpcol: tick');

  if (pending >= REFILL_THRESHOLD) return; // plenty of work queued

  // 5. Refill via Tavily — budget is summed across all rotating keys.
  const tavilyUsed = await tavilyCreditsUsedToday();
  const tavilyBudgetLeft = TAVILY_USABLE_TOTAL - tavilyUsed;
  const tavilyBatchSize = Math.min(REFILL_BATCH_TAVILY, tavilyBudgetLeft);

  if (tavilyBatchSize > 0 && TAVILY_KEYS.length > 0) {
    const queries = await nextTavilyQueryBatch(tavilyBatchSize);
    let urlsAdded = 0;
    for (const q of queries) {
      const urls = await tavilySearch(q);
      const added = await ingestUrls(tenantId, campaignId, urls);
      urlsAdded += added;
      logger.debug({ q, found: urls.length, added }, 'perpcol: tavily batch');
      // Small gap between requests
      await new Promise((r) => setTimeout(r, 600));
    }
    logger.info({ queries: queries.length, urlsAdded, tavilyUsed: tavilyUsed + tavilyBatchSize }, 'perpcol: tavily refill done');
  }

  // 6. Refill via OSM Overpass
  const osmBatch = await nextOsmBatch(REFILL_BATCH_OSM);
  let osmUrlsAdded = 0;
  for (const item of osmBatch) {
    const urls = await osmSearch(item.city, item.country_code, item.bbox, item.selectors);
    const added = await ingestUrls(tenantId, campaignId, urls);
    osmUrlsAdded += added;
    logger.debug({ city: item.city, cat: item.label, found: urls.length, added }, 'perpcol: osm batch');
  }
  if (osmUrlsAdded > 0) {
    logger.info({ osmBatch: osmBatch.length, osmUrlsAdded }, 'perpcol: osm refill done');
  }

  // 7. Prevent auto-complete: ensure campaign stays active regardless of source state
  await query(
    "UPDATE collector_campaigns SET status='active' WHERE id=? AND status='completed'",
    [campaignId],
  );
}

export async function perpetualCollectorLoop(): Promise<void> {
  logger.info('perpcol: starting perpetual collector loop');
  // Stagger startup to avoid hammering Tavily right on worker boot
  await new Promise((r) => setTimeout(r, 8_000));

  while (true) {
    try {
      await tick();
    } catch (e: any) {
      logger.error({ err: e.message }, 'perpcol: tick error');
    }
    await new Promise((r) => setTimeout(r, CHECK_INTERVAL));
  }
}
