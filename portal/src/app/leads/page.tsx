'use client';

import { useEffect, useState } from 'react';
import { useLocaleClient } from '../../components/useLocaleClient';
import { t } from '../../lib/t';

type Limits = {
  enabled: boolean;
  maxLeadsMonth: number;
  maxSourcesMonth: number;
  maxVerificationsMonth: number;
  exportAllowed: boolean;
  usage: { leadsDiscovered: number; sourcesAdded: number; verifications: number; exports: number };
};

type Source = {
  id: number; url: string; domain: string; label: string | null;
  status: string; robots_allowed: number; last_crawled_at: string | null;
};

type Job = {
  id: number; source_url: string; source_domain: string;
  status: string; pages_fetched: number; leads_found: number; leads_new: number;
  error: string | null; started_at: string | null; finished_at: string | null;
};

type Lead = {
  id: number; email: string; company_domain: string | null;
  source_url: string | null; page_title: string | null; context_snippet: string | null;
  role_hint: string | null; status: string; verification_score: number | null;
  discovered_at: string;
};

function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = typeof document !== 'undefined'
    ? document.cookie.split('; ').find((c) => c.startsWith('token='))?.split('=')[1]
    : '';
  const tenantId = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('tenantId')
    : null;
  return fetch(`/api${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(tenantId ? { 'x-tenant-id': tenantId } : {}),
      ...(init?.headers ?? {}),
    },
  }).then(async (r) => {
    if (r.status === 401) {
      if (typeof window !== 'undefined') window.location.href = '/login?next=/leads';
      throw new Error('unauthorized');
    }
    if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json() as Promise<T>;
  });
}

export default function LeadsPage() {
  const locale = useLocaleClient();
  const [limits, setLimits] = useState<Limits | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newUrl, setNewUrl] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const refresh = async () => {
    try {
      const [l, s, j, ls] = await Promise.all([
        api<Limits>('/leads/limits'),
        api<{ sources: Source[] }>('/leads/sources'),
        api<{ jobs: Job[] }>('/leads/discovery-jobs'),
        api<{ leads: Lead[] }>('/leads?limit=200'),
      ]);
      setLimits(l); setSources(s.sources); setJobs(j.jobs); setLeads(ls.leads);
      setError(null);
    } catch (e: any) { setError(e.message); }
  };

  useEffect(() => { refresh(); const id = setInterval(refresh, 10000); return () => clearInterval(id); }, []);

  const addSource = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUrl) return;
    try { await api('/leads/sources', { method: 'POST', body: JSON.stringify({ url: newUrl }) }); setNewUrl(''); refresh(); }
    catch (e: any) { setError(e.message); }
  };

  const runJob = async (sourceId: number) => {
    try { await api('/leads/discovery-jobs', { method: 'POST', body: JSON.stringify({ sourceId, maxPages: 5 }) }); refresh(); }
    catch (e: any) { setError(e.message); }
  };

  const toggle = (id: number) => {
    const s = new Set(selected); s.has(id) ? s.delete(id) : s.add(id); setSelected(s);
  };

  const verifySelected = async () => {
    if (!selected.size) return;
    try { await api('/leads/verify', { method: 'POST', body: JSON.stringify({ leadIds: [...selected] }) }); setSelected(new Set()); refresh(); }
    catch (e: any) { setError(e.message); }
  };

  const importSelected = async () => {
    if (!selected.size) return;
    try {
      const r = await api<{ imported: number; skipped: number }>('/leads/import-to-contacts', {
        method: 'POST',
        body: JSON.stringify({ leadIds: [...selected], requireVerified: true }),
      });
      alert(t(locale, 'leads.import.success').replace('{count}', String(r.imported))
        + '\n\n' + t(locale, 'leads.import.pendingNotice'));
      setSelected(new Set()); refresh();
    } catch (e: any) { setError(e.message); }
  };

  if (!limits) {
    return (
      <div className="card">
        <h1>{t(locale, 'leads.title')}</h1>
        <p>{error ?? t(locale, 'common.loading')}</p>
      </div>
    );
  }

  if (!limits.enabled) {
    return (
      <div>
        <div className="card">
          <h1>{t(locale, 'leads.title')}</h1>
          <p className="badge warn" style={{ padding: 12 }}>{t(locale, 'leads.limits.disabledNotice')}</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="card">
        <h1>{t(locale, 'leads.title')}</h1>
        <p>{t(locale, 'leads.subtitle')}</p>
        <p className="badge warn" style={{ padding: 10, display: 'block', marginTop: 12 }}>
          ⚠ {t(locale, 'leads.complianceWarning')}
        </p>
      </div>

      <div className="card">
        <h2>{t(locale, 'leads.limits.title')}</h2>
        <div className="row">
          <div className="stat">
            <div className="label">{t(locale, 'leads.limits.leadsDiscovered')}</div>
            <div className="value">{limits.usage.leadsDiscovered} / {limits.maxLeadsMonth}</div>
          </div>
          <div className="stat">
            <div className="label">{t(locale, 'leads.limits.sourcesAdded')}</div>
            <div className="value">{limits.usage.sourcesAdded} / {limits.maxSourcesMonth}</div>
          </div>
          <div className="stat">
            <div className="label">{t(locale, 'leads.limits.verifications')}</div>
            <div className="value">{limits.usage.verifications} / {limits.maxVerificationsMonth}</div>
          </div>
          <div className="stat">
            <div className="label">{t(locale, 'leads.limits.exportAllowed')}</div>
            <div className="value">{limits.exportAllowed
              ? t(locale, 'leads.limits.exportAllowedYes')
              : t(locale, 'leads.limits.exportAllowedNo')}</div>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>{t(locale, 'leads.sources.title')}</h2>
        <form onSubmit={addSource} style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <div style={{ flex: 1 }}>
            <label htmlFor="src-url">{t(locale, 'leads.sources.url')}</label>
            <input id="src-url" type="url" value={newUrl} onChange={(e) => setNewUrl(e.target.value)} required placeholder="https://example.com/contact" />
          </div>
          <button className="btn" type="submit">{t(locale, 'leads.sources.add')}</button>
        </form>
        <p style={{ fontSize: 12, color: '#6b7591', marginTop: 8 }}>{t(locale, 'leads.sources.addHint')}</p>

        {sources.length === 0 ? <p>{t(locale, 'leads.sources.empty')}</p> : (
          <table style={{ width: '100%', marginTop: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th align="left">{t(locale, 'leads.sources.url')}</th>
                <th align="left">{t(locale, 'leads.sources.status')}</th>
                <th align="left">{t(locale, 'leads.sources.lastCrawled')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.id} style={{ borderTop: '1px solid #eef0f5' }}>
                  <td style={{ padding: '6px 4px' }}>{s.url}</td>
                  <td><span className={`badge ${s.status === 'active' ? 'ok' : 'pending'}`}>{s.status}</span></td>
                  <td>{s.last_crawled_at ?? '—'}</td>
                  <td><button className="btn btn-ghost" onClick={() => runJob(s.id)}>{t(locale, 'leads.jobs.run')}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>{t(locale, 'leads.jobs.title')}</h2>
        {jobs.length === 0 ? <p>{t(locale, 'leads.jobs.empty')}</p> : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th align="left">{t(locale, 'leads.sources.domain')}</th>
                <th align="left">{t(locale, 'leads.jobs.status')}</th>
                <th align="right">{t(locale, 'leads.jobs.pagesFetched')}</th>
                <th align="right">{t(locale, 'leads.jobs.leadsFound')}</th>
                <th align="right">{t(locale, 'leads.jobs.leadsNew')}</th>
                <th align="left">{t(locale, 'leads.jobs.finished')}</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id} style={{ borderTop: '1px solid #eef0f5' }}>
                  <td style={{ padding: '6px 4px' }}>{j.source_domain}</td>
                  <td>{t(locale, `leads.jobs.status${j.status.charAt(0).toUpperCase()}${j.status.slice(1).replace(/_(\w)/g, (_, c) => c.toUpperCase())}`)}</td>
                  <td align="right">{j.pages_fetched}</td>
                  <td align="right">{j.leads_found}</td>
                  <td align="right">{j.leads_new}</td>
                  <td>{j.finished_at ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>{t(locale, 'leads.list.title')}</h2>
        {leads.length === 0 ? <p>{t(locale, 'leads.list.empty')}</p> : (
          <>
            <div style={{ marginBottom: 10, display: 'flex', gap: 8 }}>
              <button className="btn" disabled={!selected.size} onClick={verifySelected}>
                {t(locale, 'leads.list.verify')} ({selected.size})
              </button>
              {limits.exportAllowed && (
                <button className="btn" disabled={!selected.size} onClick={importSelected}>
                  {t(locale, 'leads.list.importToContacts')} ({selected.size})
                </button>
              )}
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  <th></th>
                  <th align="left">{t(locale, 'leads.list.email')}</th>
                  <th align="left">{t(locale, 'leads.list.role')}</th>
                  <th align="left">{t(locale, 'leads.list.status')}</th>
                  <th align="right">{t(locale, 'leads.list.score')}</th>
                  <th align="left">{t(locale, 'leads.list.sourceUrl')}</th>
                </tr>
              </thead>
              <tbody>
                {leads.map((l) => (
                  <tr key={l.id} style={{ borderTop: '1px solid #eef0f5' }}>
                    <td><input type="checkbox" checked={selected.has(l.id)} onChange={() => toggle(l.id)} /></td>
                    <td style={{ padding: '4px' }}>{l.email}</td>
                    <td>{l.role_hint ?? ''}</td>
                    <td><span className={`badge ${l.status === 'verified' ? 'ok' : l.status === 'invalid' ? 'fail' : 'pending'}`}>{t(locale, `leads.leadStatus.${l.status}`)}</span></td>
                    <td align="right">{l.verification_score ?? '—'}</td>
                    <td style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      <a href={l.source_url ?? '#'} target="_blank" rel="noreferrer noopener">{l.source_url}</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      {error && <div className="card"><p style={{ color: '#a31818' }}>{error}</p></div>}
    </div>
  );
}
