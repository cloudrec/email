// Search-provider adapter contract for the Collector module.
// Platform never scrapes Google directly. Implementations call official APIs
// (DataForSEO, Bing Web Search, SerpAPI, etc.) when credentials are present.

export interface SearchQuery {
  query: string;
  country?: string;
  language?: string;
  maxResults?: number;
}

export interface SearchResultItem {
  url: string;
  title?: string | null;
  snippet?: string | null;
}

export interface SearchProvider {
  readonly name: string;
  /** True only if credentials/env are present. UI hides "search-import" when false. */
  isConfigured(): boolean;
  search(q: SearchQuery): Promise<SearchResultItem[]>;
}

const providers = new Map<string, SearchProvider>();
export function registerSearchProvider(p: SearchProvider) { providers.set(p.name, p); }
export function getSearchProvider(name: string): SearchProvider | null {
  return providers.get(name) ?? null;
}
export function defaultConfiguredProvider(): SearchProvider | null {
  for (const p of providers.values()) if (p.isConfigured()) return p;
  return null;
}
export function listSearchProviders(): Array<{ name: string; configured: boolean }> {
  return [...providers.values()].map((p) => ({ name: p.name, configured: p.isConfigured() }));
}

// ------- Internal stub provider for testing only -------
// Returns no results unless STUB_SEARCH_RESULTS env is set (JSON array).
// NEVER pretends to be a real source — always reports as "stub".
class StubProvider implements SearchProvider {
  readonly name = 'stub';
  isConfigured(): boolean {
    // Considered "configured" only when stub data is explicitly seeded.
    return !!process.env.STUB_SEARCH_RESULTS;
  }
  async search(q: SearchQuery): Promise<SearchResultItem[]> {
    try {
      const raw = process.env.STUB_SEARCH_RESULTS ?? '[]';
      const items = JSON.parse(raw) as SearchResultItem[];
      return items.slice(0, q.maxResults ?? 20);
    } catch { return []; }
  }
}
registerSearchProvider(new StubProvider());

// ------- Real provider placeholders -------
// Implementations are intentionally NOT here yet. Add when credentials arrive:
//   - DataForSEO  → DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD
//   - SerpAPI     → SERPAPI_KEY
//   - Bing Web    → BING_SEARCH_KEY
//
// Each adapter must:
//   1. return [] when isConfigured() is false (never throw on missing creds);
//   2. respect maxResults;
//   3. translate provider-specific shapes into SearchResultItem;
//   4. log via parent (caller passes a logger if needed).
