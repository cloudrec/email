// Tavily search-provider adapter for Collector Mode.
// Uses Tavily Search API (https://docs.tavily.com/). Returns normalized
// SearchResultItem[]. Never scrapes Google. Never logs the API key.
//
// Multi-key safety:
// - Reads keys via tavilyKeyring (TAVILY_API_KEY + TAVILY_API_KEYS=csv +
//   TAVILY_API_KEY_1..N). Owner is responsible for using legitimate, separate
//   accounts/keys. This rotation NEVER bypasses Tavily's per-account limits;
//   it only spreads load across keys the owner already controls.
// - On credits_exhausted from the upstream, the current key is flagged for
//   the rest of the UTC day and the next key is tried. When every key is
//   flagged, the provider raises credits_exhausted (same code as before, so
//   the CSV / manual / OSM fallback still kicks in).
//
// Behavior on errors:
//   401/403           → next key, or TavilyError code='not_configured' if last
//   402 / 432 / "credits" → next key, or TavilyError code='credits_exhausted'
//   429               → throws TavilyError code='rate_limited'
//   timeout           → throws TavilyError code='timeout'
//   anything else     → throws TavilyError code='provider_error'

import { SearchProvider, SearchQuery, SearchResultItem, registerSearchProvider } from './searchProvider.js';
import { config } from '../config.js';
import { tavilyKeyring, TavilyKeyEntry } from './tavilyKeyring.js';

export type TavilyErrorCode = 'not_configured' | 'credits_exhausted' | 'rate_limited' | 'timeout' | 'provider_error';

export class TavilyError extends Error {
  code: TavilyErrorCode;
  detail: string;
  /** Label of the last key tried (masked). Useful for surfacing in admin. */
  keyLabel?: string;
  constructor(code: TavilyErrorCode, detail: string, keyLabel?: string) {
    super(`tavily_${code}:${detail}`);
    this.code = code;
    this.detail = detail;
    if (keyLabel) this.keyLabel = keyLabel;
  }
}

const TAVILY_ENDPOINT = 'https://api.tavily.com/search';

// One-time initialisation. Re-importing the module is a no-op.
tavilyKeyring.init({
  single: config.tavily.apiKey,
  csv: config.tavily.apiKeys,
  numbered: config.tavily.apiKeysNumbered,
});

class TavilyProvider implements SearchProvider {
  readonly name = 'tavily';

  isConfigured(): boolean {
    return tavilyKeyring.hasAnyKey();
  }

  /** Public, masked status snapshot. Safe to expose to admin UI. */
  keyStatus() {
    return tavilyKeyring.status();
  }

  async search(q: SearchQuery): Promise<SearchResultItem[]> {
    if (!this.isConfigured()) throw new TavilyError('not_configured', 'no Tavily keys configured');

    const maxResults = Math.min(q.maxResults ?? 10, config.tavily.maxResultsPerQuery);

    let lastNonConfiguredLabel: string | null = null;
    let exhaustedAll = false;

    // Loop through keys until one succeeds or all are flagged.
    for (let attempt = 0; attempt < tavilyKeyring.size(); attempt++) {
      const entry: TavilyKeyEntry | null = tavilyKeyring.pick();
      if (!entry) { exhaustedAll = true; break; }

      const body: Record<string, any> = {
        api_key: entry._secret,
        query: q.query,
        max_results: maxResults,
        search_depth: 'basic',
        include_answer: false,
        include_images: false,
      };
      if (q.country) body.country = q.country;

      let res: Response;
      try {
        res = await fetch(TAVILY_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(config.tavily.timeoutMs),
        });
      } catch (e: any) {
        const name = e?.name ?? '';
        if (name === 'TimeoutError' || name === 'AbortError') throw new TavilyError('timeout', 'fetch aborted', entry.label);
        throw new TavilyError('provider_error', name || 'fetch_failed', entry.label);
      }

      if (res.status === 401 || res.status === 403) {
        tavilyKeyring.markExhausted(entry.label, `http_${res.status}_unauthorized`);
        lastNonConfiguredLabel = entry.label;
        continue;
      }
      if (res.status === 402) {
        tavilyKeyring.markExhausted(entry.label, 'http_402');
        continue;
      }
      if (res.status === 432) {
        // Tavily "exceeds your plan's set usage limit" — key is capped for the
        // billing period. Retire it and try the next (handled here explicitly so
        // we don't rely on the body-shape parse below).
        tavilyKeyring.markExhausted(entry.label, 'http_432_plan_limit');
        continue;
      }
      if (res.status === 429) throw new TavilyError('rate_limited', 'http_429', entry.label);
      if (res.status >= 500)  throw new TavilyError('provider_error', `http_${res.status}`, entry.label);

      let json: any;
      try { json = await res.json(); }
      catch { throw new TavilyError('provider_error', 'bad_json', entry.label); }

      // Tavily occasionally returns 200 with an error nested under `detail` for
      // quota / auth issues. Inspect every observed shape.
      const errText = (
        json?.error ??
        json?.message ??
        json?.detail?.error ??
        json?.detail?.message ??
        (typeof json?.detail === 'string' ? json.detail : '') ??
        ''
      ).toString().toLowerCase();
      if (errText) {
        if (errText.includes('credit') || errText.includes('quota') || errText.includes('limit')) {
          tavilyKeyring.markExhausted(entry.label, 'credits_in_body');
          continue;
        }
        if (errText.includes('unauthor') || errText.includes('api key') || errText.includes('invalid key')) {
          tavilyKeyring.markExhausted(entry.label, 'invalid_key');
          lastNonConfiguredLabel = entry.label;
          continue;
        }
        throw new TavilyError('provider_error', errText.slice(0, 120), entry.label);
      }

      const results: any[] = Array.isArray(json?.results) ? json.results : [];
      return results
        .map((r) => ({
          url: typeof r.url === 'string' ? r.url : '',
          title: typeof r.title === 'string' ? r.title : null,
          snippet: typeof r.content === 'string' ? r.content
                 : typeof r.snippet === 'string' ? r.snippet : null,
        }))
        .filter((r) => r.url);
    }

    if (exhaustedAll || tavilyKeyring.status().every((s) => s.exhausted)) {
      throw new TavilyError('credits_exhausted', 'all_keys_exhausted');
    }
    if (lastNonConfiguredLabel) {
      throw new TavilyError('not_configured', 'all keys returned unauthorized', lastNonConfiguredLabel);
    }
    throw new TavilyError('provider_error', 'no_key_picked');
  }
}

export const tavilyProvider = new TavilyProvider();
registerSearchProvider(tavilyProvider);
