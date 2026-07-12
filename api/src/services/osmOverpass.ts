// OpenStreetMap / Overpass API adapter for Collector Mode.
// Polite usage:
//   - tight per-process rate limit (1 req / 6s)
//   - 60s in-memory result cache keyed on the canonical query
//   - explicit User-Agent identifying the platform + contact URL
//   - configurable timeout
//   - stops gracefully on 429/timeout

import { redis } from '../redis.js';

const ENDPOINT = process.env.OVERPASS_ENDPOINT ?? 'https://overpass-api.de/api/interpreter';
const UA       = process.env.OVERPASS_UA       ?? 'EmailPlatformCollector/0.1 (+https://email.clients.help/about/crawler)';
const TIMEOUT_MS = parseInt(process.env.OVERPASS_TIMEOUT_MS ?? '25000', 10);
const RL_KEY     = 'rl:overpass';
const RL_GAP_MS  = 6000;
const CACHE_TTL_S = 60 * 5;

// ---------- Category map ----------
// Each preset → Overpass element-filter (OR-of-tags). Returned as an array of
// `nwr[...]` selectors that will be unioned inside the query.
export type OsmCategory =
  | 'web_agency' | 'beauty_salon' | 'dental_clinic' | 'repair_service'
  | 'fitness_studio' | 'restaurant_cafe' | 'real_estate' | 'law_firm'
  | 'clinic' | 'ecommerce_shop' | 'local_service';

export const OSM_CATEGORIES: Record<OsmCategory, { selectors: string[]; label: { en: string; ru: string; uk: string } }> = {
  web_agency:      { selectors: ['nwr[office=it]', 'nwr["office:type"="web_design"]'],
                     label: { en: 'Web / IT agencies', ru: 'Веб / IT агентства', uk: 'Веб / IT агенції' } },
  beauty_salon:    { selectors: ['nwr[shop=beauty]', 'nwr[shop=hairdresser]'],
                     label: { en: 'Beauty salons / hairdressers', ru: 'Салоны красоты / парикмахерские', uk: 'Салони краси / перукарні' } },
  dental_clinic:   { selectors: ['nwr[amenity=dentist]', 'nwr[healthcare=dentist]'],
                     label: { en: 'Dental clinics', ru: 'Стоматологии', uk: 'Стоматології' } },
  repair_service:  { selectors: ['nwr[shop=car_repair]', 'nwr[craft=electronics_repair]', 'nwr[craft=plumber]', 'nwr[shop=mobile_phone_repair]'],
                     label: { en: 'Repair services', ru: 'Сервисы ремонта', uk: 'Сервіси ремонту' } },
  fitness_studio:  { selectors: ['nwr[leisure=fitness_centre]', 'nwr[sport=fitness]'],
                     label: { en: 'Fitness studios / gyms', ru: 'Фитнес-студии / спортзалы', uk: 'Фітнес-студії / спортзали' } },
  restaurant_cafe: { selectors: ['nwr[amenity=restaurant]', 'nwr[amenity=cafe]'],
                     label: { en: 'Restaurants / cafes', ru: 'Рестораны / кафе', uk: 'Ресторани / кафе' } },
  real_estate:     { selectors: ['nwr[office=estate_agent]'],
                     label: { en: 'Real estate agencies', ru: 'Агентства недвижимости', uk: 'Агенції нерухомості' } },
  law_firm:        { selectors: ['nwr[office=lawyer]'],
                     label: { en: 'Law firms', ru: 'Юридические фирмы', uk: 'Юридичні фірми' } },
  clinic:          { selectors: ['nwr[amenity=clinic]', 'nwr[healthcare=clinic]', 'nwr[amenity=doctors]'],
                     label: { en: 'Clinics / medical offices', ru: 'Клиники / медицинские офисы', uk: 'Клініки / медичні офіси' } },
  ecommerce_shop:  { selectors: ['nwr[shop][website]', 'nwr[shop][contact:website]'],
                     label: { en: 'Shops with websites', ru: 'Магазины с сайтами', uk: 'Магазини з сайтами' } },
  local_service:   { selectors: ['nwr[office][website]', 'nwr[craft][website]'],
                     label: { en: 'Local service offices', ru: 'Локальные сервисные офисы', uk: 'Локальні сервісні офіси' } },
};

// ---------- Public types ----------
export interface OsmQuery {
  category: OsmCategory;
  country?: string;            // ISO 3166-1 alpha-2 (e.g. UA)
  city?: string;
  bbox?: [number, number, number, number]; // [south, west, north, east]
  maxResults?: number;
  onlyWithWebsite?: boolean;
}

export interface OsmResult {
  source_provider: 'osm_overpass';
  source_external_id: string;  // "node/12345" / "way/12345" / "relation/12345"
  name: string | null;
  website: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  country: string | null;
  category: string;
  tags: Record<string, string>;
  lat: number | null;
  lon: number | null;
}

export type OsmErrorCode = 'rate_limited' | 'timeout' | 'provider_error' | 'bad_query';

export class OsmError extends Error {
  code: OsmErrorCode;
  detail: string;
  constructor(code: OsmErrorCode, detail: string) {
    super(`osm_${code}:${detail}`);
    this.code = code;
    this.detail = detail;
  }
}

// ---------- Internals ----------
function escapeOsm(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildQuery(q: OsmQuery): string {
  const timeout = Math.floor(TIMEOUT_MS / 1000);
  const cat = OSM_CATEGORIES[q.category];
  if (!cat) throw new OsmError('bad_query', 'unknown_category');

  let areaClause = '';
  let inClause = '';
  if (q.bbox) {
    inClause = `(${q.bbox[0]},${q.bbox[1]},${q.bbox[2]},${q.bbox[3]})`;
  } else if (q.city || q.country) {
    // Build area from name / ISO code. Prefer city if given.
    if (q.city) {
      const c = escapeOsm(q.city);
      // Match both English alias and native name (any name=*).
      areaClause = `area["name"="${c}"]->.searchArea;\narea["name:en"="${c}"]->.searchAreaEn;`;
      inClause = `(area.searchArea)`;
    } else if (q.country) {
      const cc = escapeOsm(q.country.toUpperCase());
      areaClause = `area["ISO3166-1"="${cc}"][admin_level=2]->.searchArea;`;
      inClause = `(area.searchArea)`;
    }
  } else {
    throw new OsmError('bad_query', 'need_country_city_or_bbox');
  }

  const selectors = cat.selectors.map((s) => `${s}${inClause};`).join('\n  ');
  // If only_with_website, repeat union of selectors but with [website] / [contact:website] presence.
  const selectorsWithWeb = q.onlyWithWebsite
    ? cat.selectors.flatMap((s) => [
        `${s}[website]${inClause};`,
        `${s}["contact:website"]${inClause};`,
      ]).join('\n  ')
    : selectors;

  return `[out:json][timeout:${timeout}];
${areaClause}
(
  ${selectorsWithWeb}
);
out tags center ${Math.max(1, Math.min(200, q.maxResults ?? 50))};`;
}

function normalizeWebsite(raw: string | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  try {
    const u = new URL(s);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return null;
    return `${u.protocol}//${host}${u.pathname.replace(/\/+$/, '')}`;
  } catch { return null; }
}

function parseElement(el: any): OsmResult | null {
  const tags = (el?.tags ?? {}) as Record<string, string>;
  const name = tags.name ?? tags['name:en'] ?? null;
  const website = normalizeWebsite(tags.website ?? tags['contact:website']);
  const email = tags['contact:email'] ?? tags.email ?? null;
  const phone = tags['contact:phone'] ?? tags.phone ?? null;
  const city  = tags['addr:city'] ?? null;
  const country = tags['addr:country'] ?? null;
  const lat = el.lat ?? el?.center?.lat ?? null;
  const lon = el.lon ?? el?.center?.lon ?? null;
  const id  = `${el.type}/${el.id}`;

  // Determine surfaced category from tags
  const category =
    tags.amenity ?? tags.shop ?? tags.office ?? tags.craft ?? tags.healthcare ?? tags.leisure ?? tags.sport ?? 'unknown';

  return {
    source_provider: 'osm_overpass',
    source_external_id: id,
    name, website, email, phone, city, country, category, tags,
    lat, lon,
  };
}

async function tokenAcquire(): Promise<void> {
  // Best-effort distributed rate limit via Redis SETNX with PX expiry.
  // If contention, sleep up to ~12s then proceed regardless.
  for (let i = 0; i < 4; i++) {
    const ok = await redis.set(RL_KEY, '1', 'PX', RL_GAP_MS, 'NX');
    if (ok) return;
    await new Promise((r) => setTimeout(r, RL_GAP_MS / 2));
  }
}

export async function osmSearch(q: OsmQuery): Promise<{ results: OsmResult[]; cached: boolean }> {
  const query = buildQuery(q);
  const cacheKey = `cache:overpass:${Buffer.from(query).toString('base64url').slice(0, 60)}`;

  const cached = await redis.get(cacheKey);
  if (cached) {
    try { return { results: JSON.parse(cached) as OsmResult[], cached: true }; } catch {}
  }

  await tokenAcquire();

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA, accept: 'application/json' },
      body: 'data=' + encodeURIComponent(query),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e: any) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new OsmError('timeout', 'fetch_aborted');
    throw new OsmError('provider_error', e?.message ?? 'fetch_failed');
  }

  if (res.status === 429) throw new OsmError('rate_limited', 'http_429');
  if (res.status === 504) throw new OsmError('timeout',     'http_504');
  if (res.status === 503) throw new OsmError('rate_limited','http_503');
  if (!res.ok)            throw new OsmError('provider_error', `http_${res.status}`);

  let json: any;
  try { json = await res.json(); }
  catch { throw new OsmError('provider_error', 'bad_json'); }
  if (json?.remark && /rate_limited|timeout/i.test(String(json.remark))) {
    throw new OsmError('rate_limited', String(json.remark).slice(0, 100));
  }

  const elements: any[] = Array.isArray(json?.elements) ? json.elements : [];
  const max = Math.max(1, Math.min(200, q.maxResults ?? 50));
  const results: OsmResult[] = [];
  for (const el of elements) {
    const r = parseElement(el);
    if (!r) continue;
    if (q.onlyWithWebsite && !r.website) continue;
    results.push(r);
    if (results.length >= max) break;
  }

  // Cache short-lived. Volume is small, OSM tolerates re-runs poorly.
  try { await redis.set(cacheKey, JSON.stringify(results), 'EX', CACHE_TTL_S); } catch {}
  return { results, cached: false };
}
