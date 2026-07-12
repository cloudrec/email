'use client';

import { useEffect, useState } from 'react';
import { useLocaleClient } from '../../components/useLocaleClient';
import { t } from '../../lib/t';

type InviteLink = {
  id: number; token: string; destination_url: string; landing_mode: 'redirect' | 'personal_page';
  status: 'active'|'paused'|'expired'|'disabled'|'unsubscribed'|'suppressed';
  click_count: number; last_clicked_at: string | null; created_at: string;
  expires_at: string | null;
  tracking_domain: string | null;
  public_url: string; fallback_url: string;
  outreach_draft_id: number | null; lead_id: number | null; contact_id: number | null;
};
type TrackingDomain = { id: number; domain: string; status: string; dns_records_json: any; last_status_detail: any; verified_at: string | null; };
type Click = { id: number; clicked_at: string; country: string | null; referrer: string | null; bot_score: number | null; metadata_json: any; };

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
    if (r.status === 401) { window.location.href = '/login?next=/invites'; throw new Error('unauthorized'); }
    if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json() as Promise<T>;
  });
}

export default function InvitesPage() {
  const locale = useLocaleClient();
  const [links, setLinks] = useState<InviteLink[]>([]);
  const [trackingDomains, setTrackingDomains] = useState<TrackingDomain[]>([]);
  const [form, setForm] = useState({ destinationUrl: '', landingMode: 'redirect' as 'redirect' | 'personal_page', trackingDomainId: '' });
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [openClicksId, setOpenClicksId] = useState<number | null>(null);
  const [clicks, setClicks] = useState<Click[]>([]);
  const [newTrackingDomain, setNewTrackingDomain] = useState('');

  const refresh = async () => {
    try {
      const [l, d] = await Promise.all([
        api<{ links: InviteLink[] }>('/invite-links'),
        api<{ domains: TrackingDomain[] }>('/tracking-domains').catch(() => ({ domains: [] })),
      ]);
      setLinks(l.links); setTrackingDomains(d.domains); setError(null);
    } catch (e: any) { setError(e.message); }
  };
  useEffect(() => { refresh(); const id = setInterval(refresh, 15000); return () => clearInterval(id); }, []);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api<InviteLink>('/invite-links', {
        method: 'POST',
        body: JSON.stringify({
          destinationUrl: form.destinationUrl,
          landingMode: form.landingMode,
          trackingDomainId: form.trackingDomainId ? Number(form.trackingDomainId) : null,
        }),
      });
      setForm({ destinationUrl: '', landingMode: 'redirect', trackingDomainId: '' });
      refresh();
    } catch (e: any) { setError(e.message); }
  };

  const pauseLink = async (id: number) => { try { await api(`/invite-links/${id}/pause`, { method: 'POST' }); refresh(); } catch (e: any) { setError(e.message); } };
  const resumeLink = async (id: number) => { try { await api(`/invite-links/${id}/resume`, { method: 'POST' }); refresh(); } catch (e: any) { setError(e.message); } };

  const copy = async (id: number, url: string) => {
    try { await navigator.clipboard.writeText(url); setCopiedId(id); setTimeout(() => setCopiedId(null), 1500); } catch {}
  };

  const showClicks = async (id: number) => {
    try {
      const r = await api<{ clicks: Click[] }>(`/invite-links/${id}/clicks`);
      setClicks(r.clicks); setOpenClicksId(id);
    } catch (e: any) { setError(e.message); }
  };

  const addTd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTrackingDomain.trim()) return;
    try {
      await api('/tracking-domains', { method: 'POST', body: JSON.stringify({ domain: newTrackingDomain.trim() }) });
      setNewTrackingDomain(''); refresh();
    } catch (e: any) { setError(e.message); }
  };

  const verifyTd = async (id: number) => { try { await api(`/tracking-domains/${id}/verify`, { method: 'POST' }); refresh(); } catch (e: any) { setError(e.message); } };
  const disableTd = async (id: number) => { try { await api(`/tracking-domains/${id}/disable`, { method: 'PATCH', body: JSON.stringify({ reason: 'manual_disable' }) }); refresh(); } catch (e: any) { setError(e.message); } };

  return (
    <div>
      <div className="card">
        <h1>{t(locale, 'invites.title')}</h1>
        <p>{t(locale, 'invites.subtitle')}</p>
        <p className="badge warn" style={{ padding: 10, display: 'block', marginTop: 10 }}>⚠ {t(locale, 'invites.safetyBanner')}</p>
        <p style={{ fontSize: 13, color: '#4a556b', marginTop: 8 }}>{t(locale, 'invites.placeholderHint')}</p>
      </div>

      <div className="card">
        <h2>{t(locale, 'invites.create')}</h2>
        <form onSubmit={create} style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
          <div style={{ gridColumn: '1 / -1' }}>
            <label>{t(locale, 'invites.destinationUrl')}</label>
            <input type="url" value={form.destinationUrl} onChange={(e) => setForm({ ...form, destinationUrl: e.target.value })} required placeholder="https://clients.help" />
          </div>
          <div>
            <label>{t(locale, 'invites.landingMode')}</label>
            <select value={form.landingMode} onChange={(e) => setForm({ ...form, landingMode: e.target.value as any })}>
              <option value="redirect">{t(locale, 'invites.modeRedirect')}</option>
              <option value="personal_page">{t(locale, 'invites.modePersonalPage')}</option>
            </select>
          </div>
          <div>
            <label>{t(locale, 'invites.trackingDomain')}</label>
            <select value={form.trackingDomainId} onChange={(e) => setForm({ ...form, trackingDomainId: e.target.value })}>
              <option value="">{t(locale, 'invites.noTrackingDomain')}</option>
              {trackingDomains.filter((d) => d.status === 'verified').map((d) => <option key={d.id} value={d.id}>{d.domain}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end' }}><button className="btn" type="submit">{t(locale, 'invites.save')}</button></div>
        </form>
      </div>

      <div className="card">
        <h2>{t(locale, 'invites.list')}</h2>
        {links.length === 0 ? <p>{t(locale, 'invites.empty')}</p> : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr>
              <th align="left">ID</th>
              <th align="left">{t(locale, 'invites.publicUrl')}</th>
              <th align="left">{t(locale, 'invites.status')}</th>
              <th align="right">{t(locale, 'invites.clicks')}</th>
              <th align="left">{t(locale, 'invites.lastClick')}</th>
              <th></th>
            </tr></thead>
            <tbody>
              {links.map((l) => (
                <tr key={l.id} style={{ borderTop: '1px solid #eef0f5' }}>
                  <td>{l.id}</td>
                  <td>
                    <code style={{ fontSize: 11 }}>{l.public_url}</code>
                    <div style={{ fontSize: 10, color: '#6b7591' }}>{t(locale, 'invites.fallbackUrl')}: <code>{l.fallback_url}</code></div>
                  </td>
                  <td><span className={`badge ${l.status === 'active' ? 'ok' : l.status === 'paused' ? 'warn' : 'fail'}`}>
                    {t(locale, `invites.status${l.status.charAt(0).toUpperCase()}${l.status.slice(1)}`)}
                  </span></td>
                  <td align="right">{l.click_count}</td>
                  <td>{l.last_clicked_at ?? '—'}</td>
                  <td style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button className="btn btn-ghost" onClick={() => copy(l.id, l.public_url)}>
                      {copiedId === l.id ? t(locale, 'invites.copied') : t(locale, 'invites.copy')}
                    </button>
                    <button className="btn btn-ghost" onClick={() => showClicks(l.id)}>{t(locale, 'invites.clicksLog')}</button>
                    {l.status === 'active' && <button className="btn btn-ghost" onClick={() => pauseLink(l.id)}>{t(locale, 'invites.pause')}</button>}
                    {l.status === 'paused' && <button className="btn btn-ghost" onClick={() => resumeLink(l.id)}>{t(locale, 'invites.resume')}</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {openClicksId && (
          <div style={{ marginTop: 16 }}>
            <h3>{t(locale, 'invites.clicksLog')} — #{openClicksId}</h3>
            {clicks.length === 0 ? <p>{t(locale, 'invites.noClicksYet')}</p> : (
              <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                <thead><tr><th align="left">{t(locale, 'invites.when')}</th><th align="left">{t(locale, 'invites.country')}</th><th align="left">{t(locale, 'invites.referrer')}</th></tr></thead>
                <tbody>
                  {clicks.map((c) => (
                    <tr key={c.id} style={{ borderTop: '1px solid #eef0f5' }}>
                      <td>{c.clicked_at}</td>
                      <td>{c.country ?? '—'}</td>
                      <td><code style={{ fontSize: 11 }}>{c.referrer ?? '—'}</code></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      <div className="card">
        <h2>{t(locale, 'invites.trackingDomains.title')}</h2>
        <p>{t(locale, 'invites.trackingDomains.subtitle')}</p>
        <p style={{ fontSize: 12, color: '#6b7591' }}>{t(locale, 'invites.trackingDomains.dnsHint')}</p>
        <form onSubmit={addTd} style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginTop: 10 }}>
          <div style={{ flex: 1 }}>
            <label>{t(locale, 'invites.trackingDomains.domain')}</label>
            <input value={newTrackingDomain} onChange={(e) => setNewTrackingDomain(e.target.value)} placeholder="go.your-domain.com" />
          </div>
          <button className="btn" type="submit">{t(locale, 'invites.trackingDomains.add')}</button>
        </form>
        {trackingDomains.length === 0 ? <p>{t(locale, 'invites.trackingDomains.empty')}</p> : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 10 }}>
            <thead><tr><th align="left">{t(locale, 'invites.trackingDomains.domain')}</th><th align="left">{t(locale, 'invites.trackingDomains.status')}</th><th></th></tr></thead>
            <tbody>
              {trackingDomains.map((d) => (
                <tr key={d.id} style={{ borderTop: '1px solid #eef0f5' }}>
                  <td>{d.domain}</td>
                  <td><span className={`badge ${d.status === 'verified' ? 'ok' : d.status === 'failed' ? 'fail' : 'pending'}`}>{d.status}</span></td>
                  <td style={{ display: 'flex', gap: 6 }}>
                    <button className="btn btn-ghost" onClick={() => verifyTd(d.id)}>{t(locale, 'invites.trackingDomains.verify')}</button>
                    {d.status !== 'disabled' && <button className="btn btn-ghost" onClick={() => disableTd(d.id)}>{t(locale, 'invites.trackingDomains.disable')}</button>}
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
