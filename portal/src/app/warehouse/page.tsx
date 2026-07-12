'use client';

import { useEffect, useState, useCallback } from 'react';
import { AppShell } from '../../components/AppShell';
import { useLocaleClient } from '../../components/useLocaleClient';
import { t } from '../../lib/t';

type Tab = 'search' | 'companies' | 'contacts' | 'review' | 'analytics' | 'sequences' | 'stats';

type Company = {
  id: number;
  canonical_domain: string;
  name: string | null;
  country: string | null;
  city: string | null;
  category_primary: string | null;
  industries: string | null;
  status: string;
  source_count: number;
  contact_count: number;
  email_count: number;
  website_count: number;
  best_fit_score: number | null;
  best_fit_product: string | null;
  fit_score_100: number | null;
  fit_label: string;
  fit_product_label: string;
  fit_reasons: string[];
  last_seen_at: string;
};

type Contact = {
  id: number; type: string; value: string; normalized_value: string; role_type: string;
  status: string; verification_score: number | null; source_url: string | null;
  company_id: number; canonical_domain: string; company_name: string | null;
  country: string | null; city: string | null; category_primary: string | null;
  globally_suppressed: number; first_seen_at: string; last_seen_at: string;
};

type Industry = { id: number; parent_id: number | null; slug: string; name_en: string; name_ru: string; name_uk: string; };
type Stats = { companies: number; websites: number; contactPoints: number; emails: number; globalSuppressions: number; industryTaxonomyEntries: number; productFitsScored: number; };

function getToken(): string {
  if (typeof document === 'undefined') return '';
  return document.cookie.split('; ').find(c => c.startsWith('token='))?.split('=')[1] ?? '';
}
function authHeaders() { return { authorization: `Bearer ${getToken()}`, 'content-type': 'application/json' }; }
function on401(status: number) {
  if (status === 401 && typeof window !== 'undefined') {
    window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname);
  }
}

function statusChip(status: string) {
  if (['discovered', 'active', 'verified'].includes(status)) return <span className="chip ok">{status}</span>;
  if (['do_not_contact', 'bounced', 'complained', 'legal_deleted'].includes(status)) return <span className="chip warn">{status.replace(/_/g, ' ')}</span>;
  return <span className="chip muted">{status.replace(/_/g, ' ')}</span>;
}

const FIT_LABELS: Record<string, string> = {
  excellent_fit: 'excellent fit', good_fit: 'good fit', weak_fit: 'weak fit', not_fit: 'not fit', unknown: 'unscored',
};
function fitChip(label: string, score100: number | null, product?: string | null) {
  const cls = label === 'excellent_fit' || label === 'good_fit' ? 'chip ok' : label === 'weak_fit' ? 'chip warn' : 'chip muted';
  const txt = FIT_LABELS[label] ?? label;
  return <span className={cls} title={product ?? ''} style={{ fontSize: 11 }}>{txt}{score100 != null ? ` · ${score100}` : ''}</span>;
}
function reasonBadges(reasons: string[]) {
  if (!reasons?.length) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
      {reasons.slice(0, 5).map((r, i) => (
        <span key={i} className="chip muted" style={{ fontSize: 10, padding: '1px 6px' }}>{r}</span>
      ))}
    </div>
  );
}

export default function WarehousePage() {
  const locale = useLocaleClient();
  const [tab, setTab] = useState<Tab>('search');
  const [stats, setStats] = useState<Stats | null>(null);
  const [industries, setIndustries] = useState<Industry[]>([]);
  const [view, setView] = useState<'table' | 'cards'>('cards');

  // NL search
  const [nlQuery, setNlQuery] = useState('');
  const [nlResults, setNlResults] = useState<Company[]>([]);
  const [nlInterpreted, setNlInterpreted] = useState<string[]>([]);
  const [nlTotal, setNlTotal] = useState(0);
  const [nlLoading, setNlLoading] = useState(false);
  const [nlRan, setNlRan] = useState(false);

  // Companies
  const [companies, setCompanies] = useState<Company[]>([]);
  const [coTotal, setCoTotal] = useState(0);
  const [coPage, setCoPage] = useState(1);
  const [coFilter, setCoFilter] = useState({ industry: '', country: '', q: '' });
  const [coLoading, setCoLoading] = useState(false);

  // Contacts
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [ctTotal, setCtTotal] = useState(0);
  const [ctPage, setCtPage] = useState(1);
  const [ctFilter, setCtFilter] = useState({ type: '', status: '', industry: '', q: '' });
  const [ctLoading, setCtLoading] = useState(false);

  // Review / analytics
  const [review, setReview] = useState<any | null>(null);
  const [analytics, setAnalytics] = useState<any | null>(null);
  const [wErr, setWErr] = useState('');

  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildMsg, setRebuildMsg] = useState('');

  // Company drawer (smart profile)
  const [drawerId, setDrawerId] = useState<number | null>(null);
  const [profile, setProfile] = useState<any | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [noteText, setNoteText] = useState('');

  // Preference modal
  const [prefModal, setPrefModal] = useState<{ contactId: number; value: string } | null>(null);
  const [prefProduct, setPrefProduct] = useState('clients_help');
  const [prefStatus, setPrefStatus] = useState('not_interested');

  useEffect(() => {
    fetch('/api/warehouse/stats', { headers: authHeaders() }).then(r => { on401(r.status); return r.ok ? r.json() : null; }).then(j => { if (j) setStats(j); });
    fetch('/api/warehouse/industries', { headers: authHeaders() }).then(r => { on401(r.status); return r.ok ? r.json() : null; }).then(j => { if (j) setIndustries(j.industries ?? []); });
  }, []);

  const runSearch = useCallback(async (page = 1) => {
    setNlLoading(true); setNlRan(true);
    const r = await fetch('/api/warehouse/search', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ q: nlQuery, page, limit: 50 }) });
    on401(r.status);
    if (r.ok) { const j = await r.json(); setNlResults(j.companies ?? []); setNlInterpreted(j.interpreted ?? []); setNlTotal(j.total ?? 0); setWErr(''); }
    else setWErr(t(locale, 'warehouse.loadError'));
    setNlLoading(false);
  }, [nlQuery]);

  const loadCompanies = useCallback(async (page = 1, filter = coFilter) => {
    setCoLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: '50', sort: 'recent' });
    if (filter.industry) params.set('industry', filter.industry);
    if (filter.country) params.set('country', filter.country);
    if (filter.q) params.set('q', filter.q);
    const r = await fetch(`/api/warehouse/companies?${params}`, { headers: authHeaders() });
    on401(r.status);
    if (r.ok) { const j = await r.json(); setCompanies(j.companies ?? []); setCoTotal(j.total ?? 0); setCoPage(page); setWErr(''); }
    else setWErr(t(locale, 'warehouse.loadError'));
    setCoLoading(false);
  }, [coFilter]);

  const loadContacts = useCallback(async (page = 1, filter = ctFilter) => {
    setCtLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: '50' });
    if (filter.type) params.set('type', filter.type);
    if (filter.status) params.set('status', filter.status);
    if (filter.industry) params.set('industry', filter.industry);
    if (filter.q) params.set('q', filter.q);
    const r = await fetch(`/api/warehouse/contacts?${params}`, { headers: authHeaders() });
    on401(r.status);
    if (r.ok) { const j = await r.json(); setContacts(j.contacts ?? []); setCtTotal(j.total ?? 0); setCtPage(page); setWErr(''); }
    else setWErr(t(locale, 'warehouse.loadError'));
    setCtLoading(false);
  }, [ctFilter]);

  useEffect(() => { if (tab === 'companies') loadCompanies(1, coFilter); }, [tab]);
  useEffect(() => { if (tab === 'contacts') loadContacts(1, ctFilter); }, [tab]);
  useEffect(() => {
    if (tab === 'review' && !review) fetch('/api/warehouse/review-queue', { headers: authHeaders() }).then(r => { on401(r.status); return r.ok ? r.json() : null; }).then(j => { if (j) setReview(j); });
    if (tab === 'analytics' && !analytics) fetch('/api/warehouse/analytics', { headers: authHeaders() }).then(r => { on401(r.status); return r.ok ? r.json() : null; }).then(j => { if (j) setAnalytics(j); });
  }, [tab]);

  // Load profile when drawer opens
  useEffect(() => {
    if (drawerId == null) { setProfile(null); return; }
    setProfileLoading(true); setProfile(null);
    fetch(`/api/warehouse/companies/${drawerId}`, { headers: authHeaders() })
      .then(r => { on401(r.status); return r.ok ? r.json() : null; })
      .then(j => { setProfile(j); setProfileLoading(false); })
      .catch(() => setProfileLoading(false));  // network throw must not leave the drawer spinning
  }, [drawerId]);

  const rootIndustries = industries.filter(i => !i.parent_id);
  const childIndustries = industries.filter(i => i.parent_id);
  const locName = (ind: Industry) => locale === 'ru' ? ind.name_ru : locale === 'uk' ? ind.name_uk : ind.name_en;

  const rebuild = async () => {
    setRebuilding(true); setRebuildMsg('');
    const r = await fetch('/api/warehouse/rebuild-from-existing-data', { method: 'POST', headers: authHeaders() });
    const j = await r.json(); setRebuildMsg(j.message ?? t(locale, 'warehouse.started')); setRebuilding(false);
    setTimeout(() => { fetch('/api/warehouse/stats', { headers: authHeaders() }).then(r => { on401(r.status); return r.ok ? r.json() : null; }).then(j => { if (j) setStats(j); }); }, 3000);
  };

  const savePref = async () => {
    if (!prefModal) return;
    await fetch(`/api/warehouse/contacts/${prefModal.contactId}/preference`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ productKey: prefProduct, preferenceStatus: prefStatus }) });
    setPrefModal(null);
    if (tab === 'contacts') loadContacts(ctPage, ctFilter);
  };

  const saveNote = async () => {
    if (!drawerId || !noteText.trim()) return;
    await fetch(`/api/warehouse/companies/${drawerId}/note`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ note: noteText.trim() }) });
    setNoteText('');
    fetch(`/api/warehouse/companies/${drawerId}`, { headers: authHeaders() }).then(r => { on401(r.status); return r.ok ? r.json() : null; }).then(j => setProfile(j));
  };

  const tabStyle = (active: boolean): React.CSSProperties => ({
    padding: '7px 14px', border: 'none', borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
    background: 'none', color: active ? 'var(--accent)' : 'var(--ink-3)', fontWeight: active ? 600 : 400, fontSize: 13.5, cursor: 'pointer', whiteSpace: 'nowrap',
  });

  const inputStyle: React.CSSProperties = { padding: '6px 10px', border: '1px solid var(--line)', borderRadius: 6, fontSize: 13, background: 'var(--surface)', color: 'var(--ink)' };

  // ── Company card (premium lead-intel look) ──
  const CompanyCard = (co: Company) => (
    <div key={co.id} onClick={() => setDrawerId(co.id)}
      style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 10, padding: 14, cursor: 'pointer', transition: 'border-color .15s' }}
      onMouseEnter={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
      onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--line)')}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{co.name ?? co.canonical_domain}</div>
          <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>{co.canonical_domain}</div>
        </div>
        {fitChip(co.fit_label, co.fit_score_100, co.fit_product_label)}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8, fontSize: 11, color: 'var(--ink-3)' }}>
        {[co.city, co.country].filter(Boolean).join(', ') && <span>📍 {[co.city, co.country].filter(Boolean).join(', ')}</span>}
        {co.industries && <span className="chip muted" style={{ fontSize: 10 }}>{co.industries.split(',')[0]}</span>}
        <span>✉ {co.email_count}</span>
        <span>👥 {co.contact_count}</span>
        {co.website_count > 0 && <span style={{ color: 'var(--accent)' }}>● {t(locale, 'warehouse.website')}</span>}
      </div>
      {reasonBadges(co.fit_reasons)}
    </div>
  );

  const CompanyTable = (list: Company[]) => (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead><tr style={{ borderBottom: '2px solid var(--line)' }}>
          {[t(locale, 'warehouse.col.company'), t(locale, 'warehouse.col.location'), t(locale, 'warehouse.col.industry'), t(locale, 'warehouse.col.email'), t(locale, 'warehouse.col.fitShort'), t(locale, 'warehouse.col.why')].map(h => (
            <th key={h} style={{ textAlign: 'left', padding: '6px 10px', color: 'var(--ink-3)', fontWeight: 500, whiteSpace: 'nowrap' }}>{h}</th>
          ))}
        </tr></thead>
        <tbody>
          {list.map(co => (
            <tr key={co.id} style={{ borderBottom: '1px solid var(--line)', cursor: 'pointer' }} onClick={() => setDrawerId(co.id)}>
              <td style={{ padding: '8px 10px' }}>
                <div style={{ fontWeight: 500 }}>{co.name ?? co.canonical_domain}</div>
                <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>{co.canonical_domain}</div>
              </td>
              <td style={{ padding: '8px 10px', color: 'var(--ink-3)', whiteSpace: 'nowrap' }}>{[co.city, co.country].filter(Boolean).join(', ') || '—'}</td>
              <td style={{ padding: '8px 10px' }}>{co.industries ? <span className="chip muted" style={{ fontSize: 11 }}>{co.industries.split(',')[0]}</span> : '—'}</td>
              <td style={{ padding: '8px 10px', textAlign: 'center' }}>{co.email_count}</td>
              <td style={{ padding: '8px 10px' }}>{fitChip(co.fit_label, co.fit_score_100, co.fit_product_label)}</td>
              <td style={{ padding: '8px 10px', maxWidth: 240 }}>{reasonBadges(co.fit_reasons)}</td>
            </tr>
          ))}
          {list.length === 0 && <tr><td colSpan={6} style={{ padding: '20px 10px', color: 'var(--ink-3)', textAlign: 'center' }}>{t(locale, 'warehouse.empty')}</td></tr>}
        </tbody>
      </table>
    </div>
  );

  const viewToggle = (
    <div style={{ display: 'flex', gap: 4 }}>
      <button onClick={() => setView('cards')} style={{ ...inputStyle, cursor: 'pointer', fontWeight: view === 'cards' ? 600 : 400, color: view === 'cards' ? 'var(--accent)' : 'var(--ink-3)' }}>▦ {t(locale, 'warehouse.viewCards')}</button>
      <button onClick={() => setView('table')} style={{ ...inputStyle, cursor: 'pointer', fontWeight: view === 'table' ? 600 : 400, color: view === 'table' ? 'var(--accent)' : 'var(--ink-3)' }}>☰ {t(locale, 'warehouse.viewTable')}</button>
    </div>
  );

  const renderCompanyList = (list: Company[]) => view === 'cards'
    ? <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>{list.map(CompanyCard)}</div>
    : CompanyTable(list);

  const EXAMPLES = [
    t(locale, 'warehouse.example.cleaning'),
    t(locale, 'warehouse.example.dental'),
    t(locale, 'warehouse.example.webAgencies'),
    t(locale, 'warehouse.example.beauty'),
  ];

  return (
    <AppShell pageKey="warehouse" pageTitle={t(locale, 'warehouse.title')} pageSub={t(locale, 'warehouse.subtitle')}
      actions={<button className="btn btn-ghost" onClick={rebuild} disabled={rebuilding} style={{ fontSize: 13 }}>{rebuilding ? t(locale, 'common.loading') : t(locale, 'warehouse.rebuild')}</button>}>
      <span data-marker="SYSTEM_READY_PHASE12_VISIBLE" style={{ display: 'none' }}>SYSTEM_READY_PHASE12_VISIBLE</span>
      <span data-marker="PHASE18_LEAD_INTELLIGENCE" style={{ display: 'none' }}>PHASE18_LEAD_INTELLIGENCE</span>

      <div className="chip warn" style={{ marginBottom: 16, display: 'block', fontSize: 12.5, padding: '8px 12px' }}>{t(locale, 'warehouse.safetyNotice')}</div>
      <div style={{ marginBottom: 12, fontSize: 12.5 }}>{t(locale, 'warehouse.zeroBudgetPre')}<a href="/manual-outreach">{t(locale, 'warehouse.zeroBudgetLink')}</a>{t(locale, 'warehouse.zeroBudgetPost')}</div>
      {rebuildMsg && <div className="chip ok" style={{ marginBottom: 12, display: 'block', fontSize: 12 }}>{rebuildMsg}</div>}
      {wErr && <div className="chip warn" style={{ marginBottom: 12, display: 'block', fontSize: 12.5, padding: '8px 12px' }}>{wErr}</div>}

      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--line)', marginBottom: 20, gap: 2, overflowX: 'auto' }}>
        {([
          ['search', t(locale, 'warehouse.tab.leadSearch')], ['companies', t(locale, 'warehouse.tab.companies')], ['contacts', t(locale, 'warehouse.tab.contacts')],
          ['review', t(locale, 'warehouse.tab.reviewQueue')], ['analytics', t(locale, 'warehouse.tab.analytics')], ['sequences', t(locale, 'warehouse.tab.sequences')], ['stats', t(locale, 'warehouse.tab.stats')],
        ] as [Tab, string][]).map(([tb, label]) => (
          <button key={tb} style={tabStyle(tab === tb)} onClick={() => setTab(tb)}>{label}</button>
        ))}
      </div>

      {/* ── LEAD SEARCH ── */}
      {tab === 'search' && (
        <div>
          <div style={{ marginBottom: 6, fontSize: 15, fontWeight: 600 }}>{t(locale, 'warehouse.search.heading')}</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            <input value={nlQuery} onChange={e => setNlQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') runSearch(1); }}
              placeholder={t(locale, 'warehouse.search.placeholder')}
              style={{ ...inputStyle, flex: 1, minWidth: 260, padding: '10px 14px', fontSize: 14 }} />
            <button className="btn btn-primary" onClick={() => runSearch(1)} disabled={nlLoading}>{nlLoading ? '…' : t(locale, 'warehouse.search.button')}</button>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
            {EXAMPLES.map(ex => (
              <button key={ex} onClick={() => { setNlQuery(ex); setTimeout(() => runSearch(1), 0); }}
                className="chip muted" style={{ fontSize: 11, cursor: 'pointer', border: '1px dashed var(--line)' }}>{ex}</button>
            ))}
          </div>
          {nlInterpreted.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <span style={{ fontSize: 11, color: 'var(--ink-3)', marginRight: 6 }}>{t(locale, 'warehouse.search.understoodAs')}</span>
              {nlInterpreted.map((c, i) => <span key={i} className="chip ok" style={{ fontSize: 11, marginRight: 4 }}>{c}</span>)}
            </div>
          )}
          {nlRan && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>{t(locale, 'warehouse.search.matches').replace('{n}', nlTotal.toLocaleString())}</span>
              {viewToggle}
            </div>
          )}
          {nlLoading ? <div style={{ color: 'var(--ink-3)' }}>{t(locale, 'common.loading')}</div>
            : nlRan ? renderCompanyList(nlResults)
            : <div style={{ color: 'var(--ink-3)', fontSize: 13, padding: '30px 0', textAlign: 'center' }}>{t(locale, 'warehouse.search.intro')}</div>}
        </div>
      )}

      {/* ── COMPANIES ── */}
      {tab === 'companies' && (
        <div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12, alignItems: 'center' }}>
            <input placeholder={t(locale, 'warehouse.filter.search')} value={coFilter.q} onChange={e => setCoFilter(f => ({ ...f, q: e.target.value }))} style={{ ...inputStyle, minWidth: 180 }} />
            <select value={coFilter.industry} onChange={e => setCoFilter(f => ({ ...f, industry: e.target.value }))} style={inputStyle}>
              <option value="">{t(locale, 'warehouse.filter.allIndustries')}</option>
              {rootIndustries.map(root => <optgroup key={root.id} label={locName(root)}>{childIndustries.filter(c => c.parent_id === root.id).map(child => <option key={child.id} value={child.slug}>{locName(child)}</option>)}</optgroup>)}
            </select>
            <input placeholder={t(locale, 'warehouse.filter.country')} value={coFilter.country} maxLength={2} onChange={e => setCoFilter(f => ({ ...f, country: e.target.value.toUpperCase() }))} style={{ ...inputStyle, width: 80 }} />
            <button className="btn btn-primary" style={{ fontSize: 13 }} onClick={() => loadCompanies(1, coFilter)}>{t(locale, 'warehouse.filter.apply')}</button>
            <div style={{ marginLeft: 'auto' }}>{viewToggle}</div>
          </div>
          <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 8 }}>{coTotal.toLocaleString()} {t(locale, 'warehouse.total')}</div>
          {coLoading ? <div style={{ color: 'var(--ink-3)' }}>{t(locale, 'common.loading')}</div> : renderCompanyList(companies)}
          {coTotal > 50 && (
            <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
              <button className="btn btn-ghost" disabled={coPage <= 1} onClick={() => loadCompanies(coPage - 1, coFilter)} style={{ fontSize: 12 }}>←</button>
              <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>{t(locale, 'warehouse.page')} {coPage} / {Math.ceil(coTotal / 50)}</span>
              <button className="btn btn-ghost" disabled={coPage * 50 >= coTotal} onClick={() => loadCompanies(coPage + 1, coFilter)} style={{ fontSize: 12 }}>→</button>
            </div>
          )}
        </div>
      )}

      {/* ── CONTACTS ── */}
      {tab === 'contacts' && (
        <div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            <input placeholder={t(locale, 'warehouse.filter.search')} value={ctFilter.q} onChange={e => setCtFilter(f => ({ ...f, q: e.target.value }))} style={{ ...inputStyle, minWidth: 180 }} />
            <select value={ctFilter.type} onChange={e => setCtFilter(f => ({ ...f, type: e.target.value }))} style={inputStyle}>
              <option value="">{t(locale, 'warehouse.filter.allTypes')}</option><option value="email">email</option><option value="phone">phone</option><option value="telegram">telegram</option><option value="whatsapp">whatsapp</option>
            </select>
            <select value={ctFilter.status} onChange={e => setCtFilter(f => ({ ...f, status: e.target.value }))} style={inputStyle}>
              <option value="">{t(locale, 'warehouse.filter.allStatuses')}</option><option value="discovered">discovered</option><option value="verified">verified</option><option value="invalid">invalid</option><option value="bounced">bounced</option>
            </select>
            <button className="btn btn-primary" style={{ fontSize: 13 }} onClick={() => loadContacts(1, ctFilter)}>{t(locale, 'warehouse.filter.apply')}</button>
          </div>
          <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 8 }}>{ctTotal.toLocaleString()} {t(locale, 'warehouse.total')}</div>
          {ctLoading ? <div style={{ color: 'var(--ink-3)' }}>{t(locale, 'common.loading')}</div> : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead><tr style={{ borderBottom: '2px solid var(--line)' }}>{[t(locale, 'warehouse.col.contact'), t(locale, 'warehouse.col.company'), t(locale, 'warehouse.col.role'), t(locale, 'warehouse.col.status'), t(locale, 'warehouse.col.score'), t(locale, 'warehouse.col.actions')].map(h => <th key={h} style={{ textAlign: 'left', padding: '6px 10px', color: 'var(--ink-3)', fontWeight: 500, whiteSpace: 'nowrap' }}>{h}</th>)}</tr></thead>
                <tbody>
                  {contacts.map(ct => (
                    <tr key={ct.id} style={{ borderBottom: '1px solid var(--line)' }}>
                      <td style={{ padding: '8px 10px' }}><div style={{ fontWeight: 500, fontSize: 12.5 }}>{ct.value}</div>{ct.globally_suppressed ? <span className="chip warn" style={{ fontSize: 10 }}>{t(locale, 'warehouse.globallySuppressed')}</span> : null}</td>
                      <td style={{ padding: '8px 10px', color: 'var(--accent)', fontSize: 12, cursor: 'pointer' }} onClick={() => setDrawerId(ct.company_id)}>{ct.company_name ?? ct.canonical_domain}</td>
                      <td style={{ padding: '8px 10px', color: 'var(--ink-3)', fontSize: 12 }}>{ct.role_type}</td>
                      <td style={{ padding: '8px 10px' }}>{statusChip(ct.status)}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'center', color: 'var(--ink-3)' }}>{ct.verification_score != null ? `${ct.verification_score}%` : '—'}</td>
                      <td style={{ padding: '8px 10px' }}><button className="btn btn-ghost" style={{ fontSize: 11, padding: '3px 8px' }} onClick={() => { setPrefModal({ contactId: ct.id, value: ct.value }); setPrefProduct('clients_help'); setPrefStatus('not_interested'); }}>{t(locale, 'warehouse.setPref')}</button></td>
                    </tr>
                  ))}
                  {contacts.length === 0 && <tr><td colSpan={6} style={{ padding: '20px 10px', color: 'var(--ink-3)', textAlign: 'center' }}>{t(locale, 'warehouse.empty')}</td></tr>}
                </tbody>
              </table>
            </div>
          )}
          {ctTotal > 50 && (
            <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
              <button className="btn btn-ghost" disabled={ctPage <= 1} onClick={() => loadContacts(ctPage - 1, ctFilter)} style={{ fontSize: 12 }}>←</button>
              <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>{t(locale, 'warehouse.page')} {ctPage} / {Math.ceil(ctTotal / 50)}</span>
              <button className="btn btn-ghost" disabled={ctPage * 50 >= ctTotal} onClick={() => loadContacts(ctPage + 1, ctFilter)} style={{ fontSize: 12 }}>→</button>
            </div>
          )}
        </div>
      )}

      {/* ── REVIEW QUEUE ── */}
      {tab === 'review' && (
        <div>
          <div className="chip muted" style={{ display: 'block', fontSize: 12, marginBottom: 14, padding: '8px 12px' }}>{t(locale, 'warehouse.review.triageNotice')}</div>
          {!review ? <div style={{ color: 'var(--ink-3)' }}>{t(locale, 'common.loading')}</div> : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px,1fr))', gap: 12, marginBottom: 20 }}>
                {[[t(locale, 'warehouse.review.companiesReady'), review.counts.companiesReady], [t(locale, 'warehouse.review.draftsToReview'), review.counts.draftsToReview], [t(locale, 'warehouse.review.contactsToActivate'), review.counts.contactsToActivate]].map(([l, v]) => (
                  <div key={l as string} style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, padding: '12px 16px' }}>
                    <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>{l}</div><div style={{ fontSize: 22, fontWeight: 700 }}>{Number(v).toLocaleString()}</div>
                  </div>
                ))}
              </div>
              <h3 style={{ fontSize: 14, marginBottom: 10 }}>{t(locale, 'warehouse.review.highFitHeading')}</h3>
              {renderCompanyList(review.companies ?? [])}
            </>
          )}
        </div>
      )}

      {/* ── ANALYTICS ── */}
      {tab === 'analytics' && (
        <div>
          {!analytics ? <div style={{ color: 'var(--ink-3)' }}>{t(locale, 'common.loading')}</div> : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(170px,1fr))', gap: 12 }}>
                {Object.entries(analytics.metrics).map(([k, v]) => (
                  <div key={k} style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, padding: '12px 16px' }}>
                    <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>{k.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase())}</div>
                    <div style={{ fontSize: 22, fontWeight: 700 }}>{v == null ? <span style={{ color: 'var(--ink-3)', fontSize: 14 }}>{t(locale, 'warehouse.notTracked')}</span> : Number(v).toLocaleString()}</div>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 12 }}>{analytics.notes}</div>
            </>
          )}
        </div>
      )}

      {/* ── SEQUENCES (preview only) ── */}
      {tab === 'sequences' && (
        <div>
          <div className="chip warn" style={{ display: 'block', fontSize: 12, marginBottom: 16, padding: '8px 12px' }}>{t(locale, 'warehouse.sequences.previewNotice')}</div>
          <div style={{ display: 'grid', gap: 12, maxWidth: 720 }}>
            {[
              { step: t(locale, 'warehouse.sequences.step1'), day: t(locale, 'warehouse.sequences.day0'), desc: t(locale, 'warehouse.sequences.desc1') },
              { step: t(locale, 'warehouse.sequences.step2'), day: t(locale, 'warehouse.sequences.day3'), desc: t(locale, 'warehouse.sequences.desc2') },
              { step: t(locale, 'warehouse.sequences.step3'), day: t(locale, 'warehouse.sequences.day7'), desc: t(locale, 'warehouse.sequences.desc3') },
              { step: t(locale, 'warehouse.sequences.step4'), day: '—', desc: t(locale, 'warehouse.sequences.desc4') },
              { step: t(locale, 'warehouse.sequences.step5'), day: '—', desc: t(locale, 'warehouse.sequences.desc5') },
            ].map((s, i) => (
              <div key={i} style={{ display: 'flex', gap: 12, background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, padding: 14 }}>
                <div style={{ minWidth: 56, fontSize: 11, color: 'var(--ink-3)' }}>{s.day}</div>
                <div><div style={{ fontWeight: 600, fontSize: 13 }}>{s.step}</div><div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 2 }}>{s.desc}</div></div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── STATS ── */}
      {tab === 'stats' && (
        <div>
          <div className="kpis" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12, marginBottom: 24 }}>
            {stats ? [
              { label: t(locale, 'warehouse.stat.companies'), value: stats.companies },
              { label: t(locale, 'warehouse.stat.websites'), value: stats.websites },
              { label: t(locale, 'warehouse.stat.contacts'), value: stats.contactPoints },
              { label: t(locale, 'warehouse.stat.emails'), value: stats.emails },
              { label: t(locale, 'warehouse.stat.suppressed'), value: stats.globalSuppressions },
              { label: t(locale, 'warehouse.stat.industries'), value: stats.industryTaxonomyEntries },
              { label: t(locale, 'warehouse.stat.productFits'), value: stats.productFitsScored },
            ].map(s => (
              <div key={s.label} style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, padding: '12px 16px' }}>
                <div style={{ fontSize: 11, color: 'var(--ink-3)', marginBottom: 4 }}>{s.label}</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--ink)' }}>{s.value.toLocaleString()}</div>
              </div>
            )) : <div style={{ color: 'var(--ink-3)' }}>{t(locale, 'common.loading')}</div>}
          </div>
          <h3 style={{ fontSize: 14, marginBottom: 12 }}>{t(locale, 'warehouse.industryTree')}</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
            {rootIndustries.map(root => (
              <div key={root.id} style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, padding: '10px 14px' }}>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>{locName(root)}</div>
                {childIndustries.filter(c => c.parent_id === root.id).map(child => <div key={child.id} style={{ fontSize: 12, color: 'var(--ink-3)', paddingLeft: 8, lineHeight: '1.8' }}>· {locName(child)}</div>)}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── COMPANY DRAWER (smart profile) ── */}
      {drawerId != null && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 9998, display: 'flex', justifyContent: 'flex-end' }} onClick={() => setDrawerId(null)}>
          <div onClick={e => e.stopPropagation()} style={{ width: 'min(560px, 100%)', height: '100%', background: 'var(--bg)', borderLeft: '1px solid var(--line)', overflowY: 'auto', padding: 24 }}>
            {profileLoading || !profile ? <div style={{ color: 'var(--ink-3)' }}>{t(locale, 'common.loading')}</div> : (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
                  <div style={{ fontSize: 18, fontWeight: 700 }}>{profile.company.name ?? profile.company.canonical_domain}</div>
                  <button className="btn btn-ghost" onClick={() => setDrawerId(null)} style={{ fontSize: 18, padding: '0 8px' }}>×</button>
                </div>
                <a href={`https://${profile.company.canonical_domain}`} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', fontSize: 13 }}>{profile.company.canonical_domain}</a>
                <div style={{ fontSize: 12, color: 'var(--ink-3)', margin: '6px 0' }}>{[profile.company.city, profile.company.country].filter(Boolean).join(', ')}</div>
                {profile.fitSummary && <div style={{ margin: '8px 0' }}>{fitChip(profile.fitSummary.fit_label, profile.fitSummary.fit_score_100, profile.fitSummary.product_label)}</div>}

                {profile.whyMatch?.length > 0 && (
                  <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, padding: 12, margin: '12px 0' }}>
                    <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>{t(locale, 'warehouse.drawer.whyMatch')}</div>
                    {reasonBadges(profile.whyMatch)}
                  </div>
                )}

                <Section title={t(locale, 'warehouse.drawer.safetyStatus')}>
                  <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>
                    {t(locale, 'warehouse.drawer.sendable')} <b>{String(profile.safety?.sendable)}</b> · {t(locale, 'warehouse.drawer.suppressedContacts')} {profile.safety?.suppressed_contacts}
                    <div style={{ marginTop: 4 }}>{profile.safety?.note}</div>
                  </div>
                </Section>

                <Section title={`${t(locale, 'warehouse.drawer.contacts')} (${profile.contacts.length})`}>
                  {profile.contacts.slice(0, 30).map((c: any) => (
                    <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '3px 0', borderBottom: '1px solid var(--line)' }}>
                      <span>{c.value} <span style={{ color: 'var(--ink-3)' }}>· {c.role_type}</span></span>{statusChip(c.status)}
                    </div>
                  ))}
                  {profile.contacts.length === 0 && <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>{t(locale, 'warehouse.drawer.noContacts')}</div>}
                </Section>

                <Section title={`${t(locale, 'warehouse.drawer.industries')} (${profile.industries.length})`}>
                  {profile.industries.map((i: any) => <span key={i.slug} className="chip muted" style={{ fontSize: 11, marginRight: 4 }}>{i.name_en}{i.is_primary ? ' ★' : ''}</span>)}
                </Section>

                <Section title={t(locale, 'warehouse.drawer.productFit')}>
                  {profile.fits.map((f: any) => (
                    <div key={f.product_key} style={{ fontSize: 12, padding: '4px 0' }}>
                      <b>{f.product_key}</b> — {Math.round(Number(f.fit_score) * 100)} · {f.status}
                      {f.fit_reason && <div style={{ color: 'var(--ink-3)' }}>{f.fit_reason}</div>}
                    </div>
                  ))}
                  {profile.fits.length === 0 && <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>{t(locale, 'warehouse.drawer.notScored')}</div>}
                </Section>

                <Section title={`${t(locale, 'warehouse.drawer.websites')} (${profile.websites.length})`}>
                  {profile.websites.slice(0, 10).map((w: any) => (
                    <div key={w.id} style={{ fontSize: 12, padding: '2px 0' }}><a href={w.url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>{w.domain}</a> <span style={{ color: 'var(--ink-3)' }}>· {w.status}{w.analyzed_at ? ' · analyzed' : ''}</span></div>
                  ))}
                </Section>

                {profile.drafts?.length > 0 && (
                  <Section title={`${t(locale, 'warehouse.drawer.drafts')} (${profile.drafts.length})`}>
                    {profile.drafts.map((d: any) => <div key={d.id} style={{ fontSize: 12, padding: '2px 0' }}>#{d.id} · {d.status} · {d.language}/{d.tone}</div>)}
                  </Section>
                )}

                <Section title={t(locale, 'warehouse.drawer.sourceHistory')}>
                  {profile.events.slice(0, 12).map((e: any, i: number) => (
                    <div key={i} style={{ fontSize: 11, color: 'var(--ink-3)', padding: '2px 0' }}>{new Date(e.created_at).toLocaleDateString()} · {e.event_type}</div>
                  ))}
                  {profile.events.length === 0 && <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>{t(locale, 'warehouse.drawer.noEvents')}</div>}
                </Section>

                <Section title={`${t(locale, 'warehouse.drawer.notes')} (${profile.notes.length})`}>
                  {profile.notes.map((n: any) => <div key={n.id} style={{ fontSize: 12, padding: '4px 0', borderBottom: '1px solid var(--line)' }}>{n.note}<div style={{ fontSize: 10, color: 'var(--ink-3)' }}>{new Date(n.created_at).toLocaleString()}</div></div>)}
                  <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                    <input value={noteText} onChange={e => setNoteText(e.target.value)} placeholder={t(locale, 'warehouse.drawer.addNotePlaceholder')} style={{ ...inputStyle, flex: 1 }} onKeyDown={e => { if (e.key === 'Enter') saveNote(); }} />
                    <button className="btn btn-primary" style={{ fontSize: 12 }} onClick={saveNote}>{t(locale, 'warehouse.drawer.add')}</button>
                  </div>
                </Section>
              </>
            )}
          </div>
        </div>
      )}

      {/* Preference modal */}
      {prefModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 10, padding: 24, minWidth: 340, maxWidth: 420 }}>
            <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>{t(locale, 'warehouse.prefModal.title')}</div>
            <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 16 }}>{prefModal.value}</div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 12, color: 'var(--ink-3)', display: 'block', marginBottom: 4 }}>{t(locale, 'warehouse.prefModal.product')}</label>
              <select value={prefProduct} onChange={e => setPrefProduct(e.target.value)} style={{ width: '100%', padding: '7px 10px', border: '1px solid var(--line)', borderRadius: 6, fontSize: 13, background: 'var(--bg)', color: 'var(--ink)' }}>
                <option value="clients_help">Clients.Help</option><option value="beautybot">BeautyBot</option><option value="manualpay">ManualPay</option>
              </select>
            </div>
            <div style={{ marginBottom: 20 }}>
              <label style={{ fontSize: 12, color: 'var(--ink-3)', display: 'block', marginBottom: 4 }}>{t(locale, 'warehouse.prefModal.status')}</label>
              <select value={prefStatus} onChange={e => setPrefStatus(e.target.value)} style={{ width: '100%', padding: '7px 10px', border: '1px solid var(--line)', borderRadius: 6, fontSize: 13, background: 'var(--bg)', color: 'var(--ink)' }}>
                <option value="unknown">{t(locale, 'warehouse.pref.unknown')}</option><option value="interested">{t(locale, 'warehouse.pref.interested')}</option><option value="not_interested">{t(locale, 'warehouse.pref.notInterested')}</option><option value="maybe_later">{t(locale, 'warehouse.pref.maybeLater')}</option><option value="rejected_offer">{t(locale, 'warehouse.pref.rejectedOffer')}</option><option value="customer">{t(locale, 'warehouse.pref.customer')}</option>
              </select>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setPrefModal(null)}>{t(locale, 'common.cancel')}</button>
              <button className="btn btn-primary" onClick={savePref}>{t(locale, 'common.save')}</button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ margin: '14px 0' }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 6 }}>{title}</div>
      {children}
    </div>
  );
}
