'use client';

import { useEffect, useState } from 'react';
import { useLocaleClient } from '../../components/useLocaleClient';
import { t } from '../../lib/t';

type Campaign = {
  id: number; name: string; status: string; mode: string;
  max_sources_total: number; max_sources_per_day: number; max_pages_per_source: number;
  crawl_delay_seconds: number; analyze_website: number; generate_draft: number;
  product_profile_id: number | null;
  keywords: any; countries: any; languages: any; preset_codes: any;
  created_at: string;
};

type Preset = { code: string; label: { en: string; ru: string; uk: string } };
type AdminSettings = {
  collector_enabled: number; max_sources_per_day: number; max_leads_per_day: number;
  max_pages_per_source: number; allow_manual_urls: number; allow_csv_import: number;
  allow_search_provider: number; paused_globally: number;
};
type SearchProviderInfo = {
  name: string;
  configured: boolean;
  enabled?: boolean;
  status?: 'ready'|'not_configured'|'credits_exhausted'|'provider_error'|'disabled';
  daily_used?: number; daily_limit?: number;
  monthly_used?: number; monthly_limit?: number;
  last_error_code?: string | null;
};
type SearchPreviewResult = {
  url: string; title: string | null; snippet: string | null;
  query: string; provider: string; discovered_at: string; domain: string; duplicate: boolean;
};
type SearchPreview = {
  provider: string; queries: string[]; results: SearchPreviewResult[];
  status: string; error_code: string | null;
  found: number; accepted: number; duplicates: number; invalid: number; blocked: number;
  tavily_daily_used: number; tavily_daily_limit: number;
  tavily_monthly_used: number; tavily_monthly_limit: number;
};
type ImportSummary = { batchId?: number; accepted: number; duplicates: number; invalid: number; blocked: number; queued: number };
type Stats = {
  campaign: { name: string; status: string };
  totals: { sources_total: number; sources_pending: number; sources_queued: number; sources_running: number; sources_succeeded: number; sources_failed: number };
  days: Array<{ date: string; sources_added: number; sources_crawled: number; leads_found: number; leads_new: number; websites_analyzed: number; drafts_generated: number }>;
};
type Profile = { id: number; name: string };

function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = document.cookie.split('; ').find((c) => c.startsWith('token='))?.split('=')[1];
  const tenantId = new URLSearchParams(window.location.search).get('tenantId');
  return fetch(`/api${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(tenantId ? { 'x-tenant-id': tenantId } : {}),
      ...(init?.headers ?? {}),
    },
  }).then(async (r) => {
    if (r.status === 401) { window.location.href = '/login?next=/collector'; throw new Error('unauthorized'); }
    if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json() as Promise<T>;
  });
}

function asArray(v: any): string[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } }
  return [];
}

export default function CollectorPage() {
  const locale = useLocaleClient();
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [providers, setProviders] = useState<SearchProviderInfo[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [agent, setAgent] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pasteUrls, setPasteUrls] = useState('');
  const [csvText, setCsvText] = useState('');
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null);
  const [searchForm, setSearchForm] = useState({
    query: '', country: '', language: '', maxResults: 5,
    presetCodes: [] as string[],
  });
  const [searchPreview, setSearchPreview] = useState<SearchPreview | null>(null);
  const [selectedUrls, setSelectedUrls] = useState<Set<string>>(new Set());
  const [searching, setSearching] = useState(false);

  // OSM free provider state
  type OsmCategoryItem = { code: string; label: { en: string; ru: string; uk: string } };
  type OsmFreeProvider = { name: string; configured: boolean; status: string; categories: OsmCategoryItem[]; notes: string };
  type OsmResultItem = {
    source_external_id: string; name: string | null; website: string | null;
    email: string | null; phone: string | null; category: string;
    city: string | null; country: string | null;
    domain: string | null; duplicate: boolean;
  };
  type OsmPreview = {
    provider: string; cached: boolean;
    total_returned: number; total_with_website: number;
    results: OsmResultItem[]; found: number; accepted: number; duplicates: number;
  };
  const [osmProvider, setOsmProvider] = useState<OsmFreeProvider | null>(null);
  const [osmForm, setOsmForm] = useState({ category: 'beauty_salon', country: '', city: '', maxResults: 10, onlyWithWebsite: true });
  const [osmPreview, setOsmPreview] = useState<OsmPreview | null>(null);
  const [osmSelected, setOsmSelected] = useState<Set<string>>(new Set());
  const [osmBusy, setOsmBusy] = useState(false);
  const [createForm, setCreateForm] = useState({
    name: '', mode: 'manual_urls' as Campaign['mode'], productProfileId: '' as string,
    presetCodes: [] as string[], keywords: '', countries: '', languages: '',
    maxSourcesTotal: 1000, maxSourcesPerDay: 100, maxPagesPerSource: 5,
    crawlDelaySeconds: 2, analyzeWebsite: true, generateDraft: false,
  });

  const refresh = async () => {
    try {
      const [s, c, p, pr, pv, fp] = await Promise.all([
        api<AdminSettings>('/collector/admin-settings'),
        api<{ campaigns: Campaign[] }>('/collector/campaigns'),
        api<{ profiles: Profile[] }>('/product-profiles'),
        api<{ presets: Preset[] }>('/collector/presets'),
        api<{ providers: SearchProviderInfo[] }>('/collector/search-providers'),
        api<{ providers: OsmFreeProvider[] }>('/collector/free-providers').catch(() => ({ providers: [] })),
      ]);
      const osm = fp.providers.find((p) => p.name === 'osm_overpass') ?? null;
      setOsmProvider(osm);
      setSettings(s); setCampaigns(c.campaigns); setProfiles(p.profiles); setPresets(pr.presets); setProviders(pv.providers);
      setError(null);
      if (!activeId && c.campaigns.length) setActiveId(c.campaigns[0].id);
    } catch (e: any) { setError(e.message); }
  };

  const refreshAgent = () => api<any>('/collector/agent-status').then(setAgent).catch(() => {});
  useEffect(() => { refresh(); refreshAgent(); const id = setInterval(() => { refresh(); refreshAgent(); }, 15000); return () => clearInterval(id); }, []);

  useEffect(() => {
    if (!activeId) return;
    api<Stats>(`/collector/campaigns/${activeId}/stats`).then(setStats).catch(() => {});
  }, [activeId]);

  const createCampaign = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const r = await api<{ id: number }>('/collector/campaigns', {
        method: 'POST',
        body: JSON.stringify({
          name: createForm.name,
          mode: createForm.mode,
          productProfileId: createForm.productProfileId ? Number(createForm.productProfileId) : null,
          presetCodes: createForm.presetCodes,
          keywords: createForm.keywords.split('\n').map((x) => x.trim()).filter(Boolean),
          countries: createForm.countries.split(',').map((x) => x.trim()).filter(Boolean),
          languages: createForm.languages.split(',').map((x) => x.trim()).filter(Boolean),
          maxSourcesTotal: Number(createForm.maxSourcesTotal),
          maxSourcesPerDay: Number(createForm.maxSourcesPerDay),
          maxPagesPerSource: Math.min(20, Number(createForm.maxPagesPerSource)),
          crawlDelaySeconds: Number(createForm.crawlDelaySeconds),
          analyzeWebsite: createForm.analyzeWebsite,
          generateDraft: createForm.generateDraft,
        }),
      });
      setActiveId(r.id);
      setCreateForm({ ...createForm, name: '', keywords: '' });
      refresh();
    } catch (e: any) { setError(e.message); }
  };

  const setStatus = async (id: number, action: 'start' | 'pause') => {
    try { await api(`/collector/campaigns/${id}/${action}`, { method: 'POST' }); refresh(); }
    catch (e: any) { setError(e.message); }
  };

  const importPaste = async () => {
    if (!activeId || !pasteUrls.trim()) return;
    const urls = pasteUrls.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    try {
      const s = await api<ImportSummary>(`/collector/campaigns/${activeId}/import-urls`, {
        method: 'POST', body: JSON.stringify({ urls }),
      });
      setImportSummary(s); setPasteUrls(''); refresh();
    } catch (e: any) { setError(e.message); }
  };

  const importCsv = async () => {
    if (!activeId || !csvText.trim()) return;
    try {
      const s = await api<ImportSummary>(`/collector/campaigns/${activeId}/import-csv`, {
        method: 'POST', body: JSON.stringify({ csv: csvText }),
      });
      setImportSummary(s); setCsvText(''); refresh();
    } catch (e: any) { setError(e.message); }
  };

  const runSearchPreview = async () => {
    setSearching(true);
    try {
      const body: any = {
        maxResults: Math.max(1, Math.min(50, Number(searchForm.maxResults))),
      };
      if (searchForm.query.trim()) body.query = searchForm.query.trim();
      if (searchForm.country.trim()) body.country = searchForm.country.trim();
      if (searchForm.language.trim()) body.language = searchForm.language.trim();
      if (searchForm.presetCodes.length) body.presetCodes = searchForm.presetCodes;
      const r = await api<SearchPreview>('/collector/search-preview', { method: 'POST', body: JSON.stringify(body) });
      setSearchPreview(r);
      // preselect accepted (non-duplicate) URLs
      const sel = new Set<string>(r.results.filter((x) => !x.duplicate).map((x) => x.url));
      setSelectedUrls(sel);
    } catch (e: any) { setError(e.message); }
    finally { setSearching(false); }
  };

  const toggleUrl = (url: string) => {
    const s = new Set(selectedUrls); s.has(url) ? s.delete(url) : s.add(url); setSelectedUrls(s);
  };

  const importSelectedSearch = async () => {
    if (!activeId || !selectedUrls.size) return;
    try {
      const s = await api<ImportSummary>('/collector/search-import', {
        method: 'POST', body: JSON.stringify({ campaignId: activeId, urls: [...selectedUrls] }),
      });
      setImportSummary(s); setSelectedUrls(new Set()); refresh();
    } catch (e: any) { setError(e.message); }
  };

  const tavilyInfo = providers.find((p) => p.name === 'tavily');

  const runOsmPreview = async () => {
    setOsmBusy(true); setOsmPreview(null); setOsmSelected(new Set());
    try {
      const body: any = {
        category: osmForm.category,
        maxResults: Math.max(1, Math.min(200, Number(osmForm.maxResults))),
        onlyWithWebsite: osmForm.onlyWithWebsite,
      };
      if (osmForm.country.trim()) body.country = osmForm.country.trim();
      if (osmForm.city.trim()) body.city = osmForm.city.trim();
      const r = await api<OsmPreview>('/collector/osm-preview', { method: 'POST', body: JSON.stringify(body) });
      setOsmPreview(r);
      const sel = new Set<string>(r.results.filter((x) => x.website && !x.duplicate).map((x) => x.website!));
      setOsmSelected(sel);
    } catch (e: any) { setError(e.message); }
    finally { setOsmBusy(false); }
  };

  const toggleOsmUrl = (url: string) => {
    const s = new Set(osmSelected); s.has(url) ? s.delete(url) : s.add(url); setOsmSelected(s);
  };

  const importOsmSelected = async () => {
    if (!activeId || !osmSelected.size) return;
    try {
      const s = await api<ImportSummary>('/collector/osm-import', {
        method: 'POST', body: JSON.stringify({ campaignId: activeId, urls: [...osmSelected] }),
      });
      setImportSummary(s); setOsmSelected(new Set()); refresh();
    } catch (e: any) { setError(e.message); }
  };

  if (!settings) {
    return <div className="card"><p>{error ?? t(locale, 'common.loading')}</p></div>;
  }

  if (!settings.collector_enabled) {
    return (
      <div>
        <div className="card">
          <h1>{t(locale, 'collector.title')}</h1>
          <p className="badge warn" style={{ padding: 10, display: 'block' }}>{t(locale, 'collector.disabled')}</p>
        </div>
      </div>
    );
  }

  const provider = providers.find((p) => p.configured);

  return (
    <div>
      <div className="card">
        <h1>{t(locale, 'collector.title')}</h1>
        <p>{t(locale, 'collector.subtitle')}</p>
        <p className="badge warn" style={{ padding: 10, display: 'block', marginTop: 10 }}>
          ⚠ {t(locale, 'collector.safetyBanner')}
        </p>
        <p style={{ fontSize: 13, color: '#4a556b', marginTop: 8 }}>{t(locale, 'collector.noSendingNotice')}</p>
      </div>

      {/* Collection Agent status */}
      {agent && (
        <div className="card" style={{ borderLeft: `3px solid ${agent.agent.running ? 'var(--ok, #2e9e5b)' : 'var(--warn)'}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <h2 style={{ margin: 0 }}>{t(locale, 'collector.agent.title')}</h2>
            <span className={`badge ${agent.agent.running ? 'ok' : 'warn'}`} style={{ padding: '2px 10px', fontSize: 12 }}>
              {agent.agent.state === 'paused_global' ? `● ${t(locale, 'collector.agent.pausedGlobal')}` : agent.agent.running ? `● ${t(locale, 'collector.agent.running')}` : `● ${t(locale, 'collector.agent.paused')}`}
            </span>
            {agent.lastActivityAt && <span style={{ fontSize: 11, color: '#7a849b', marginLeft: 'auto' }}>{t(locale, 'collector.agent.lastActivity')} {new Date(agent.lastActivityAt).toLocaleString()}</span>}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
            {[
              { label: t(locale, 'collector.agent.sourcesFoundToday'), value: agent.today.sourcesFound },
              { label: t(locale, 'collector.agent.leadsFoundToday'), value: agent.today.leadsFound },
              { label: t(locale, 'collector.agent.newLeadsToday'), value: agent.today.leadsNew },
              { label: t(locale, 'collector.agent.websitesAnalyzed'), value: agent.today.websitesAnalyzed },
              { label: t(locale, 'collector.agent.queuePending'), value: agent.queue.pending },
              { label: t(locale, 'collector.agent.queueRunning'), value: agent.queue.running },
              { label: t(locale, 'collector.agent.errors24h'), value: agent.errors.last24h, warn: agent.errors.last24h > 0 },
              { label: t(locale, 'collector.agent.activeCampaigns'), value: agent.agent.campaigns.active },
            ].map((s) => (
              <div key={s.label} style={{ background: 'var(--surface, #fff)', border: '1px solid var(--line, #e3e7ef)', borderRadius: 8, padding: '10px 12px' }}>
                <div style={{ fontSize: 11, color: '#7a849b' }}>{s.label}</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: (s as any).warn ? 'var(--warn)' : 'inherit' }}>{Number(s.value).toLocaleString()}</div>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginTop: 12, fontSize: 12, color: '#4a556b' }}>
            <span>Tavily: {agent.tavily.configured ? `${agent.tavily.dailyUsed}/${agent.tavily.dailyLimit} ${t(locale, 'collector.agent.day')} · ${agent.tavily.monthlyUsed}/${agent.tavily.monthlyLimit} ${t(locale, 'collector.agent.month')}` : t(locale, 'collector.agent.notConfigured')}</span>
            <span>OSM: {agent.osm.status} ({t(locale, 'collector.agent.free')})</span>
            {agent.errors.lastErrorCode && <span style={{ color: 'var(--warn)' }}>{t(locale, 'collector.agent.lastError')}: {agent.errors.lastErrorCode}</span>}
          </div>
          {agent.cooldownCities?.length > 0 && (
            <div style={{ marginTop: 10, fontSize: 12, color: '#7a849b' }}>
              {t(locale, 'collector.agent.cooldownCities')} ({agent.cooldownCities.length}): {agent.cooldownCities.slice(0, 12).map((c: string) => (
                <span key={c} className="badge" style={{ marginRight: 4, fontSize: 11 }}>{c}</span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Safety limits panel */}
      <div className="card" style={{ borderLeft: '3px solid var(--warn)' }}>
        <h2 style={{ marginBottom: 10 }}>{t(locale, 'collector.safetyLimits.title')}</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10, marginBottom: 12 }}>
          {[
            { label: t(locale, 'collector.safetyLimits.globalEnabled'), value: settings.collector_enabled ? t(locale, 'collector.safetyLimits.yes') : t(locale, 'collector.safetyLimits.no'), ok: !!settings.collector_enabled },
            { label: t(locale, 'collector.safetyLimits.globalPaused'), value: settings.paused_globally ? t(locale, 'collector.safetyLimits.paused') : t(locale, 'collector.safetyLimits.running'), ok: !settings.paused_globally },
            { label: t(locale, 'collector.safetyLimits.maxSourcesPerDayTenant'), value: settings.max_sources_per_day >= 500000 ? `∞ ${t(locale, 'collector.safetyLimits.unlimited')}` : String(settings.max_sources_per_day), ok: settings.max_sources_per_day < 500000 },
            { label: t(locale, 'collector.safetyLimits.maxLeadsPerDayTenant'), value: settings.max_leads_per_day >= 500000 ? `∞ ${t(locale, 'collector.safetyLimits.unlimited')}` : String(settings.max_leads_per_day), ok: settings.max_leads_per_day < 500000 },
            { label: t(locale, 'collector.safetyLimits.maxPagesPerSourceTenant'), value: String(settings.max_pages_per_source), ok: true },
          ].map(({ label, value, ok }) => (
            <div key={label} style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 6, padding: '8px 12px' }}>
              <div style={{ fontSize: 11, color: 'var(--ink-3)', marginBottom: 3 }}>{label}</div>
              <div style={{ fontSize: 14, fontWeight: 600, color: ok ? 'var(--ink)' : 'var(--warn)' }}>{value}</div>
            </div>
          ))}
        </div>
        {campaigns.some((c) => c.max_sources_per_day >= 500000) && (
          <div style={{ background: 'var(--surface-sunken)', border: '1px solid var(--warn)', borderRadius: 5, padding: '8px 14px', fontSize: 12.5 }}>
            <strong style={{ color: 'var(--warn)' }}>⚠ {t(locale, 'collector.safetyLimits.unlimitedDetected')}:</strong>{' '}
            {campaigns.filter((c) => c.max_sources_per_day >= 500000).map((c) => c.name).join(', ')} {t(locale, 'collector.safetyLimits.unlimitedDetail')}
            {' '}{t(locale, 'collector.safetyLimits.unlimitedAdvice')}
          </div>
        )}
        <p style={{ fontSize: 11.5, color: 'var(--ink-3)', marginTop: 10 }}>
          {t(locale, 'collector.safetyLimits.changeLimits1')} <code>collector_admin_settings</code> {t(locale, 'collector.safetyLimits.changeLimits2')}
        </p>
      </div>

      <div className="card">
        <h2>{t(locale, 'collector.createCampaign')}</h2>
        <form onSubmit={createCampaign} style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
          <div><label>{t(locale, 'collector.name')}</label><input value={createForm.name} onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })} required /></div>
          <div><label>{t(locale, 'collector.mode')}</label>
            <select value={createForm.mode} onChange={(e) => setCreateForm({ ...createForm, mode: e.target.value as any })}>
              <option value="manual_urls">{t(locale, 'collector.modeManual')}</option>
              <option value="csv_import">{t(locale, 'collector.modeCsv')}</option>
              <option value="search_provider">{t(locale, 'collector.modeSearch')}</option>
              <option value="mixed">{t(locale, 'collector.modeMixed')}</option>
            </select>
          </div>
          <div><label>{t(locale, 'collector.productProfile')}</label>
            <select value={createForm.productProfileId} onChange={(e) => setCreateForm({ ...createForm, productProfileId: e.target.value })}>
              <option value="">—</option>
              {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div><label>{t(locale, 'collector.maxSourcesPerDay')}</label><input type="number" min="1" max="5000" value={createForm.maxSourcesPerDay} onChange={(e) => setCreateForm({ ...createForm, maxSourcesPerDay: Number(e.target.value) })} /></div>
          <div><label>{t(locale, 'collector.maxPagesPerSource')}</label><input type="number" min="1" max="20" value={createForm.maxPagesPerSource} onChange={(e) => setCreateForm({ ...createForm, maxPagesPerSource: Math.min(20, Number(e.target.value)) })} /></div>
          <div><label>{t(locale, 'collector.crawlDelaySeconds')}</label><input type="number" min="1" max="60" value={createForm.crawlDelaySeconds} onChange={(e) => setCreateForm({ ...createForm, crawlDelaySeconds: Number(e.target.value) })} /></div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label>{t(locale, 'collector.presets')}</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {presets.map((p) => (
                <label key={p.code} style={{ fontSize: 13, display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                  <input type="checkbox" checked={createForm.presetCodes.includes(p.code)}
                    onChange={(e) => setCreateForm({
                      ...createForm,
                      presetCodes: e.target.checked
                        ? [...createForm.presetCodes, p.code]
                        : createForm.presetCodes.filter((c) => c !== p.code),
                    })}/>
                  {p.label[locale]}
                </label>
              ))}
            </div>
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label>{t(locale, 'collector.keywords')}</label>
            <textarea rows={2} value={createForm.keywords} onChange={(e) => setCreateForm({ ...createForm, keywords: e.target.value })} />
          </div>
          <div><label>{t(locale, 'collector.countries')}</label><input value={createForm.countries} onChange={(e) => setCreateForm({ ...createForm, countries: e.target.value })} placeholder="US, GB, DE" /></div>
          <div><label>{t(locale, 'collector.languages')}</label><input value={createForm.languages} onChange={(e) => setCreateForm({ ...createForm, languages: e.target.value })} placeholder="en, ru, uk" /></div>
          <div style={{ alignSelf: 'flex-end' }}>
            <label><input type="checkbox" checked={createForm.analyzeWebsite} onChange={(e) => setCreateForm({ ...createForm, analyzeWebsite: e.target.checked })} /> {t(locale, 'collector.analyzeWebsite')}</label>
          </div>
          <div style={{ alignSelf: 'flex-end' }}>
            <label><input type="checkbox" checked={createForm.generateDraft} onChange={(e) => setCreateForm({ ...createForm, generateDraft: e.target.checked })} /> {t(locale, 'collector.generateDraft')}</label>
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gridColumn: '1 / -1' }}><button className="btn" type="submit">{t(locale, 'collector.save')}</button></div>
        </form>
      </div>

      <div className="card">
        <h2>{t(locale, 'collector.campaigns')}</h2>
        {campaigns.length === 0 ? <p>{t(locale, 'collector.empty')}</p> : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr>
              <th align="left">{t(locale, 'collector.table.id')}</th>
              <th align="left">{t(locale, 'collector.name')}</th>
              <th align="left">{t(locale, 'collector.status')}</th>
              <th align="left">{t(locale, 'collector.mode')}</th>
              <th align="right">{t(locale, 'collector.maxSourcesPerDay')}</th>
              <th align="right">{t(locale, 'collector.maxPagesPerSource')}</th>
              <th></th>
            </tr></thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={c.id} style={{ borderTop: '1px solid #eef0f5', background: c.id === activeId ? '#f0f5ff' : 'transparent' }}>
                  <td>{c.id}</td>
                  <td>{c.name}</td>
                  <td><span className={`badge ${c.status === 'active' ? 'ok' : c.status === 'paused' ? 'warn' : 'pending'}`}>
                    {t(locale, `collector.status${c.status.charAt(0).toUpperCase()}${c.status.slice(1)}`)}
                  </span></td>
                  <td>{c.mode}</td>
                  <td align="right">{c.max_sources_per_day}</td>
                  <td align="right">{c.max_pages_per_source}</td>
                  <td style={{ display: 'flex', gap: 6 }}>
                    <button className="btn btn-ghost" onClick={() => setActiveId(c.id)}>{t(locale, 'collector.view')}</button>
                    {c.status !== 'active' && <button className="btn btn-ghost" onClick={() => setStatus(c.id, 'start')}>{t(locale, 'collector.start')}</button>}
                    {c.status === 'active' && <button className="btn btn-ghost" onClick={() => setStatus(c.id, 'pause')}>{t(locale, 'collector.pause')}</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {activeId && (
        <>
          <div className="card">
            <h2>{t(locale, 'collector.bulkImport.title')}</h2>
            <label>{t(locale, 'collector.bulkImport.paste')}</label>
            <textarea rows={6} value={pasteUrls} onChange={(e) => setPasteUrls(e.target.value)} placeholder="https://example.com&#10;https://another.example.org/contact" />
            <p><button className="btn" onClick={importPaste} disabled={!pasteUrls.trim()}>{t(locale, 'collector.bulkImport.submit')}</button></p>

            <h3>{t(locale, 'collector.bulkImport.csv')}</h3>
            <p style={{ fontSize: 12, color: '#6b7591' }}>{t(locale, 'collector.bulkImport.csvHint')}</p>
            <textarea rows={4} value={csvText} onChange={(e) => setCsvText(e.target.value)} placeholder="name,url&#10;Acme,https://acme.example.com" />
            <p><button className="btn" onClick={importCsv} disabled={!csvText.trim()}>{t(locale, 'collector.bulkImport.submit')}</button></p>

            {importSummary && (
              <div style={{ marginTop: 10, padding: 10, background: '#f0f5ff', borderRadius: 6 }}>
                <b>{t(locale, 'collector.bulkImport.summary')}:</b>{' '}
                <span style={{ marginRight: 12 }}>{t(locale, 'collector.bulkImport.accepted')}: {importSummary.accepted}</span>
                <span style={{ marginRight: 12 }}>{t(locale, 'collector.bulkImport.queued')}: {importSummary.queued}</span>
                <span style={{ marginRight: 12 }}>{t(locale, 'collector.bulkImport.duplicates')}: {importSummary.duplicates}</span>
                <span style={{ marginRight: 12 }}>{t(locale, 'collector.bulkImport.invalid')}: {importSummary.invalid}</span>
                <span>{t(locale, 'collector.bulkImport.blocked')}: {importSummary.blocked}</span>
              </div>
            )}
          </div>

          <div className="card">
            <h2>{t(locale, 'collector.search.title')}</h2>
            {!tavilyInfo || !tavilyInfo.configured ? (
              <p className="badge warn" style={{ padding: 10, display: 'block' }}>{t(locale, 'collector.search.providerNotConfigured')}</p>
            ) : tavilyInfo.status === 'credits_exhausted' ? (
              <p className="badge fail" style={{ padding: 10, display: 'block' }}>{t(locale, 'collector.search.providerCreditsExhausted')}</p>
            ) : tavilyInfo.status === 'provider_error' ? (
              <p className="badge warn" style={{ padding: 10, display: 'block' }}>{t(locale, 'collector.search.providerError')}{tavilyInfo.last_error_code ? ` (${tavilyInfo.last_error_code})` : ''}</p>
            ) : (
              <p className="badge ok" style={{ padding: 10, display: 'inline-block' }}>✓ {t(locale, 'collector.search.providerReady')} — <code>{tavilyInfo.name}</code></p>
            )}
            {tavilyInfo && tavilyInfo.configured && (
              <p style={{ fontSize: 13, color: '#4a556b', marginTop: 8 }}>
                {t(locale, 'collector.search.dailyCredits')}: {tavilyInfo.daily_used ?? 0} / {tavilyInfo.daily_limit ?? '—'} ·{' '}
                {t(locale, 'collector.search.monthlyCredits')}: {tavilyInfo.monthly_used ?? 0} / {tavilyInfo.monthly_limit ?? '—'}
              </p>
            )}
            <p style={{ fontSize: 12, color: '#6b7591' }}>{t(locale, 'collector.search.legalNotice')}</p>

            {tavilyInfo && tavilyInfo.enabled && (
              <div style={{ marginTop: 12 }}>
                <div style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
                  <div style={{ gridColumn: '1 / -1' }}>
                    <label>{t(locale, 'collector.search.query')}</label>
                    <input value={searchForm.query} onChange={(e) => setSearchForm({ ...searchForm, query: e.target.value })} />
                  </div>
                  <div style={{ gridColumn: '1 / -1' }}>
                    <label>{t(locale, 'collector.presets')}</label>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {presets.filter((p) => p.code.startsWith('tavily_')).map((p) => (
                        <label key={p.code} style={{ fontSize: 13, display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                          <input type="checkbox" checked={searchForm.presetCodes.includes(p.code)}
                            onChange={(e) => setSearchForm({
                              ...searchForm,
                              presetCodes: e.target.checked
                                ? [...searchForm.presetCodes, p.code]
                                : searchForm.presetCodes.filter((c) => c !== p.code),
                            })}/>
                          {p.label[locale]}
                        </label>
                      ))}
                    </div>
                  </div>
                  <div><label>{t(locale, 'collector.search.country')}</label><input value={searchForm.country} onChange={(e) => setSearchForm({ ...searchForm, country: e.target.value })} placeholder="US" /></div>
                  <div><label>{t(locale, 'collector.search.language')}</label><input value={searchForm.language} onChange={(e) => setSearchForm({ ...searchForm, language: e.target.value })} placeholder="en" /></div>
                  <div><label>{t(locale, 'collector.search.maxResults')}</label><input type="number" min="1" max="50" value={searchForm.maxResults} onChange={(e) => setSearchForm({ ...searchForm, maxResults: Number(e.target.value) })} /></div>
                  <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                    <button className="btn" onClick={runSearchPreview} disabled={searching || (!searchForm.query.trim() && !searchForm.presetCodes.length)}>
                      {searching ? '…' : t(locale, 'collector.search.preview')}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {searchPreview && (
              <div style={{ marginTop: 12 }}>
                <p>
                  <b>{t(locale, 'collector.search.found')}:</b> {searchPreview.found} ·{' '}
                  <b>{t(locale, 'collector.search.accepted')}:</b> {searchPreview.accepted} ·{' '}
                  <b>{t(locale, 'collector.search.duplicates')}:</b> {searchPreview.duplicates}
                </p>
                {searchPreview.status !== 'ok' && (
                  <p className="badge warn" style={{ padding: 8, display: 'inline-block' }}>{searchPreview.status}{searchPreview.error_code ? ` — ${searchPreview.error_code}` : ''}</p>
                )}
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 8 }}>
                  <thead><tr>
                    <th></th><th align="left">{t(locale, 'collector.table.url')}</th><th align="left">{t(locale, 'leads.list.pageTitle')}</th><th align="left">{t(locale, 'collector.search.duplicates')}</th>
                  </tr></thead>
                  <tbody>
                    {searchPreview.results.map((r) => (
                      <tr key={r.url} style={{ borderTop: '1px solid #eef0f5' }}>
                        <td><input type="checkbox" checked={selectedUrls.has(r.url)} onChange={() => toggleUrl(r.url)} disabled={r.duplicate} /></td>
                        <td style={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis' }}><a href={r.url} target="_blank" rel="noreferrer noopener">{r.url}</a></td>
                        <td>{r.title ?? '—'}</td>
                        <td>{r.duplicate ? '✓' : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p style={{ marginTop: 10 }}>
                  <button className="btn" disabled={!selectedUrls.size} onClick={importSelectedSearch}>
                    {t(locale, 'collector.search.import')} ({selectedUrls.size})
                  </button>
                </p>
              </div>
            )}
          </div>

          {/* ---------- Free Sources (OSM Overpass) ---------- */}
          <div className="card">
            <h2>{t(locale, 'collector.freeSources.title')}</h2>
            <p>{t(locale, 'collector.freeSources.subtitle')}</p>
            <p className="notice info">{t(locale, 'collector.freeSources.fallbackNote')}</p>
            <p className="notice warn">{t(locale, 'collector.freeSources.rateLimitWarning')}</p>
            <p style={{ fontSize: 12, color: 'var(--muted)' }}>{t(locale, 'collector.freeSources.legalNotice')}</p>

            {osmProvider && (
              <p className="chip ok" style={{ marginTop: 8 }}>{t(locale, 'collector.freeSources.providerReady')}</p>
            )}

            {osmProvider && (
              <div style={{ marginTop: 12, display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
                <div>
                  <label>{t(locale, 'collector.freeSources.category')}</label>
                  <select value={osmForm.category} onChange={(e) => setOsmForm({ ...osmForm, category: e.target.value })}>
                    {osmProvider.categories.map((c) => (
                      <option key={c.code} value={c.code}>{c.label[locale]}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label>{t(locale, 'collector.freeSources.country')}</label>
                  <input value={osmForm.country} onChange={(e) => setOsmForm({ ...osmForm, country: e.target.value })} placeholder="UA" />
                </div>
                <div>
                  <label>{t(locale, 'collector.freeSources.city')}</label>
                  <input value={osmForm.city} onChange={(e) => setOsmForm({ ...osmForm, city: e.target.value })} placeholder="Kyiv" />
                </div>
                <div>
                  <label>{t(locale, 'collector.freeSources.maxResults')}</label>
                  <input type="number" min="1" max="200" value={osmForm.maxResults} onChange={(e) => setOsmForm({ ...osmForm, maxResults: Number(e.target.value) })} />
                </div>
                <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                  <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
                    <input type="checkbox" checked={osmForm.onlyWithWebsite} onChange={(e) => setOsmForm({ ...osmForm, onlyWithWebsite: e.target.checked })} />
                    {t(locale, 'collector.freeSources.onlyWithWebsite')}
                  </label>
                </div>
                <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                  <button className="btn btn-primary" onClick={runOsmPreview} disabled={osmBusy || (!osmForm.city.trim() && !osmForm.country.trim())}>
                    {osmBusy ? '…' : t(locale, 'collector.freeSources.preview')}
                  </button>
                </div>
              </div>
            )}

            {osmPreview && (
              <div style={{ marginTop: 14 }}>
                <p>
                  <b>{t(locale, 'collector.freeSources.found')}:</b> {osmPreview.total_returned} ·{' '}
                  <b>{t(locale, 'collector.freeSources.withWebsite')}:</b> {osmPreview.total_with_website} ·{' '}
                  <b>{t(locale, 'collector.freeSources.accepted')}:</b> {osmPreview.accepted} ·{' '}
                  <b>{t(locale, 'collector.freeSources.duplicates')}:</b> {osmPreview.duplicates}
                </p>
                <table className="tbl" style={{ marginTop: 8 }}>
                  <thead><tr>
                    <th></th><th align="left">{t(locale, 'collector.table.name')}</th><th align="left">{t(locale, 'collector.table.website')}</th>
                    <th align="left">{t(locale, 'collector.table.category')}</th><th align="left">{t(locale, 'collector.table.city')}</th><th align="left">{t(locale, 'collector.table.dup')}</th>
                  </tr></thead>
                  <tbody>
                    {osmPreview.results.map((r) => (
                      <tr key={r.source_external_id}>
                        <td><input type="checkbox"
                          checked={r.website ? osmSelected.has(r.website) : false}
                          onChange={() => r.website && toggleOsmUrl(r.website)}
                          disabled={!r.website || r.duplicate} /></td>
                        <td>{r.name ?? '—'}</td>
                        <td style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {r.website ? <a href={r.website} target="_blank" rel="noreferrer noopener">{r.website}</a> : '—'}
                        </td>
                        <td><code>{r.category}</code></td>
                        <td>{r.city ?? '—'}</td>
                        <td>{r.duplicate ? '✓' : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p style={{ marginTop: 10 }}>
                  <button className="btn btn-primary" disabled={!osmSelected.size} onClick={importOsmSelected}>
                    {t(locale, 'collector.freeSources.import')} ({osmSelected.size})
                  </button>
                </p>
              </div>
            )}
          </div>

          {stats && (
            <div className="card">
              <h2>{t(locale, 'collector.stats.title')} — {stats.campaign.name}</h2>
              <div className="row">
                <div className="stat"><div className="label">{t(locale, 'collector.stats.sourcesAdded')}</div><div className="value">{stats.totals.sources_total}</div></div>
                <div className="stat"><div className="label">{t(locale, 'collector.stats.sourcesCrawled')}</div><div className="value">{stats.totals.sources_succeeded}</div></div>
                <div className="stat"><div className="label">{t(locale, 'collector.stats.leadsCollected')}</div><div className="value">{stats.days.reduce((a, d) => a + d.leads_new, 0)}</div></div>
                <div className="stat"><div className="label">{t(locale, 'collector.stats.websitesAnalyzed')}</div><div className="value">{stats.days.reduce((a, d) => a + d.websites_analyzed, 0)}</div></div>
                <div className="stat"><div className="label">{t(locale, 'collector.stats.draftsGenerated')}</div><div className="value">{stats.days.reduce((a, d) => a + d.drafts_generated, 0)}</div></div>
              </div>
              {stats.days.length > 0 && (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 10 }}>
                  <thead><tr>
                    <th align="left">{t(locale, 'collector.table.date')}</th>
                    <th align="right">{t(locale, 'collector.stats.sourcesAdded')}</th>
                    <th align="right">{t(locale, 'collector.stats.sourcesCrawled')}</th>
                    <th align="right">{t(locale, 'collector.stats.leadsCollected')}</th>
                    <th align="right">{t(locale, 'collector.stats.websitesAnalyzed')}</th>
                    <th align="right">{t(locale, 'collector.stats.draftsGenerated')}</th>
                  </tr></thead>
                  <tbody>
                    {stats.days.map((d) => (
                      <tr key={d.date} style={{ borderTop: '1px solid #eef0f5' }}>
                        <td>{d.date}</td>
                        <td align="right">{d.sources_added}</td>
                        <td align="right">{d.sources_crawled}</td>
                        <td align="right">{d.leads_new}</td>
                        <td align="right">{d.websites_analyzed}</td>
                        <td align="right">{d.drafts_generated}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </>
      )}

      {error && <div className="card"><p style={{ color: '#a31818' }}>{error}</p></div>}
    </div>
  );
}
