'use client';

import { useEffect, useState } from 'react';
import { useLocaleClient } from '../../components/useLocaleClient';
import { t } from '../../lib/t';

type Domain = { id: number; domain: string; type: string; status: string; dkim_selector: string; last_checked_at: string | null; };
type Detected = { domain: string; mailboxCount: number; activeCount: number; registrable: boolean };

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
    if (r.status === 401) { window.location.href = '/login?next=/domains'; throw new Error('unauthorized'); }
    if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json() as Promise<T>;
  });
}

export default function DomainsPage() {
  const locale = useLocaleClient();
  const [domains, setDomains] = useState<Domain[]>([]);
  const [detected, setDetected] = useState<Detected[]>([]);
  const [newDomain, setNewDomain] = useState('');
  const [records, setRecords] = useState<any[] | null>(null);
  const [activeDomain, setActiveDomain] = useState<string | null>(null);
  const [lastStatusDetail, setLastStatusDetail] = useState<any[] | null>(null);
  const [verifying, setVerifying] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const r = await api<{ domains: Domain[]; detected?: Detected[] }>('/domains');
      setDomains(r.domains);
      setDetected(r.detected ?? []);
      setError(null);
    } catch (e: any) { setError(e.message); }
  };

  const register = async (domain: string) => {
    try {
      const r = await api<{ id: number; domain: string; records: any[] }>('/domains', { method: 'POST', body: JSON.stringify({ domain }) });
      setRecords(r.records); setActiveDomain(r.domain); setLastStatusDetail(null);
      refresh();
    } catch (e: any) { setError(e.message); }
  };
  useEffect(() => { refresh(); const id = setInterval(refresh, 10000); return () => clearInterval(id); }, []);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const r = await api<{ id: number; domain: string; records: any[] }>('/domains', { method: 'POST', body: JSON.stringify({ domain: newDomain }) });
      setRecords(r.records);
      setActiveDomain(r.domain);
      setLastStatusDetail(null);
      setNewDomain('');
      refresh();
    } catch (e: any) { setError(e.message); }
  };

  const showRecords = async (id: number) => {
    try {
      const r = await api<{ domain: string; records: any[]; lastStatusDetail: any[] | null }>(`/domains/${id}/dns-records`);
      setRecords(r.records); setActiveDomain(r.domain); setLastStatusDetail(r.lastStatusDetail);
    } catch (e: any) { setError(e.message); }
  };

  const verify = async (id: number) => {
    setVerifying(id);
    try {
      const r = await api<{ status: string; detail: any[] }>(`/domains/${id}/verify`, { method: 'POST' });
      setLastStatusDetail(r.detail);
      await refresh();
    } catch (e: any) { setError(e.message); }
    finally { setVerifying(null); }
  };

  return (
    <div>
      <div className="card">
        <h1>{t(locale, 'domains.title')}</h1>
        <p className="badge warn" style={{ padding: 10, display: 'block' }}>⚠ {t(locale, 'domains.cannotSendUnverified')}</p>
        <p style={{ fontSize: 13, color: '#4a556b', marginTop: 8 }}>{t(locale, 'domains.tipNoAutoChange')}</p>
        <p style={{ fontSize: 13, color: '#4a556b' }}>{t(locale, 'domains.tipPropagation')}</p>
      </div>

      <div className="card">
        <h2>{t(locale, 'domains.addDomain')}</h2>
        <form onSubmit={add} style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <div style={{ flex: 1 }}>
            <label>{t(locale, 'domains.domain')}</label>
            <input value={newDomain} onChange={(e) => setNewDomain(e.target.value)} required placeholder="mail.example.com" />
          </div>
          <button className="btn" type="submit">{t(locale, 'domains.addDomain')}</button>
        </form>

        {records && (
          <div style={{ marginTop: 16 }}>
            <h3>{t(locale, 'domains.dnsRecords')}{activeDomain ? ` — ${activeDomain}` : ''}</h3>
            <p>{t(locale, 'domains.dnsInstructions')}</p>
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
              <thead><tr><th align="left">{t(locale, 'domains.colPurpose')}</th><th align="left">{t(locale, 'domains.colType')}</th><th align="left">{t(locale, 'domains.colHost')}</th><th align="left">{t(locale, 'domains.colValue')}</th></tr></thead>
              <tbody>
                {records.map((r, i) => (
                  <tr key={i} style={{ borderTop: '1px solid #eef0f5' }}>
                    <td>{r.purpose}</td>
                    <td>{r.type}</td>
                    <td><code>{r.host}</code></td>
                    <td><code style={{ wordBreak: 'break-all' }}>{r.expected}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {lastStatusDetail && (
              <div style={{ marginTop: 12 }}>
                <h4>{t(locale, 'domains.lastVerifyDetail')}</h4>
                <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                  <thead><tr><th align="left">{t(locale, 'domains.colPurpose')}</th><th align="left">{t(locale, 'domains.colOk')}</th><th align="left">{t(locale, 'domains.colGot')}</th></tr></thead>
                  <tbody>
                    {lastStatusDetail.map((d: any, i: number) => (
                      <tr key={i} style={{ borderTop: '1px solid #eef0f5' }}>
                        <td>{d.purpose}</td>
                        <td>{d.ok ? '✓' : <span style={{ color: '#a31818' }}>✗</span>}</td>
                        <td><code style={{ wordBreak: 'break-all' }}>{Array.isArray(d.got) ? d.got.join(' / ') : '—'}</code></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {detected.length > 0 && (
        <div className="card" style={{ borderLeft: '3px solid #d99100' }}>
          <h2>{t(locale, 'domains.detectedTitle')}</h2>
          <p style={{ fontSize: 13, color: '#4a556b' }}>{t(locale, 'domains.detectedHint')}</p>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr><th align="left">{t(locale, 'domains.domain')}</th><th align="left">{t(locale, 'domains.detectedMailboxes')}</th><th></th></tr></thead>
            <tbody>
              {detected.map((d) => (
                <tr key={d.domain} style={{ borderTop: '1px solid #eef0f5' }}>
                  <td>{d.domain}</td>
                  <td>{d.mailboxCount} ({d.activeCount} {t(locale, 'domains.detectedActive')})</td>
                  <td><button className="btn" onClick={() => register(d.domain)}>{t(locale, 'domains.detectedRegister')}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <h2>{t(locale, 'domains.title')}</h2>
        {domains.length === 0 ? <p>—</p> : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr><th align="left">{t(locale, 'domains.domain')}</th><th align="left">{t(locale, 'domains.type')}</th><th align="left">{t(locale, 'domains.status')}</th><th></th></tr></thead>
            <tbody>
              {domains.map((d) => (
                <tr key={d.id} style={{ borderTop: '1px solid #eef0f5' }}>
                  <td>{d.domain}</td>
                  <td>{d.type}</td>
                  <td><span className={`badge ${d.status === 'verified' ? 'ok' : d.status === 'failed' ? 'fail' : d.status === 'warning' ? 'warn' : 'pending'}`}>{d.status}</span></td>
                  <td style={{ display: 'flex', gap: 6 }}>
                    <button className="btn btn-ghost" onClick={() => showRecords(d.id)}>{t(locale, 'domains.dnsRecords')}</button>
                    <button className="btn btn-ghost" onClick={() => verify(d.id)} disabled={verifying === d.id}>
                      {verifying === d.id ? '…' : t(locale, 'domains.verify')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {error && <div className="card"><p style={{ color: '#a31818' }}>{error}</p></div>}
    </div>
  );
}
