'use client';

import { useEffect, useState } from 'react';
import { useLocaleClient } from '../../components/useLocaleClient';
import { t } from '../../lib/t';

type Tenant = {
  id: number; uuid: string; slug: string; name: string; status: string;
  plan_id: number | null; default_locale: string; trial_ends_at: string | null; created_at: string;
};

type Invoice = { id: number; tenant_id: number; number: string; amount_cents: number; currency: string; status: string; issued_at: string; due_at: string | null; };

function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = document.cookie.split('; ').find((c) => c.startsWith('token='))?.split('=')[1];
  return fetch(`/api${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  }).then(async (r) => {
    if (r.status === 401) { window.location.href = '/login?next=/admin'; throw new Error('unauthorized'); }
    if (r.status === 403) throw new Error('forbidden — super admin only');
    if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json() as Promise<T>;
  });
}

type SmtpStatus = {
  configured: boolean;
  host: string;
  port: number;
  user_set: boolean;
  from_address: string;
  reachable: boolean | null;
  reachable_detail: string | null;
  warnings: string[];
  ready_for_send: boolean;
};

export default function AdminPage() {
  const locale = useLocaleClient();
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [smtp, setSmtp] = useState<SmtpStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createForm, setCreateForm] = useState({ name: '', ownerEmail: '', planCode: 'starter', locale: 'en' });

  const refresh = async () => {
    try {
      setTenants((await api<{ tenants: Tenant[] }>('/tenants')).tenants);
      try { setSmtp(await api<SmtpStatus>('/system/smtp-status')); } catch {}
      setError(null);
    } catch (e: any) { setError(e.message); }
  };
  useEffect(() => { refresh(); const id = setInterval(refresh, 15000); return () => clearInterval(id); }, []);

  const setStatus = async (id: number, action: 'suspend' | 'activate' | 'cancel') => {
    try {
      await api(`/tenants/${id}/${action}`, { method: 'POST', body: action === 'suspend' ? JSON.stringify({ reason: 'admin_action' }) : undefined });
      refresh();
    } catch (e: any) { setError(e.message); }
  };

  const toggleLeads = async (id: number, enabled: boolean) => {
    try {
      await api(`/tenants/${id}/lead-discovery`, { method: 'PATCH', body: JSON.stringify({ enabled }) });
      refresh();
    } catch (e: any) { setError(e.message); }
  };

  const createTenant = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api('/tenants', { method: 'POST', body: JSON.stringify(createForm) });
      setCreateForm({ ...createForm, name: '', ownerEmail: '' });
      refresh();
    } catch (e: any) { setError(e.message); }
  };

  return (
    <div>
      <div className="card">
        <h1>{t(locale, 'admin.title')}</h1>
        <p>{t(locale, 'admin.subtitle')}</p>
      </div>

      {/* Domain strategy note */}
      <div className="card" style={{ borderLeft: '3px solid var(--warn)', background: 'var(--surface-sunken)' }}>
        <h2 style={{ marginBottom: 8 }}>{t(locale, 'admin.domain.title')}</h2>
        <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8, fontSize: 13, color: 'var(--ink-2)' }}>
          <li><span className="badge ok" style={{ fontSize: 11 }}>{t(locale, 'admin.domain.registered')}</span> <strong>emails.cheap</strong> — {t(locale, 'admin.domain.rootDesc')}</li>
          <li><span className="badge warn" style={{ fontSize: 11 }}>{t(locale, 'admin.domain.pending')}</span> <strong>mail.emails.cheap</strong> — {t(locale, 'admin.domain.mailDesc')}</li>
          <li><span className="badge" style={{ fontSize: 11, background: 'var(--surface-2)', color: 'var(--ink-3)' }}>{t(locale, 'admin.domain.planned')}</span> <strong>go.emails.cheap</strong> — {t(locale, 'admin.domain.goDesc')}</li>
          <li><span className="badge" style={{ fontSize: 11, background: 'var(--surface-2)', color: 'var(--ink-3)' }}>{t(locale, 'admin.domain.planned')}</span> <strong>bounce.emails.cheap</strong> — {t(locale, 'admin.domain.bounceDesc')}</li>
        </ul>
        <div style={{ marginTop: 10, padding: '8px 12px', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 4, fontSize: 12 }}>
          <strong style={{ color: 'var(--warn)' }}>⚠ {t(locale, 'admin.domain.recommended')}:</strong>{' '}
          <span style={{ color: 'var(--ink-3)' }}>{t(locale, 'admin.domain.recommendBody')}</span>
        </div>
        <div style={{ marginTop: 8 }}>
          <a className="btn btn-ghost" style={{ fontSize: 12 }} href="/setup">{t(locale, 'admin.domain.setupCenter')} →</a>
        </div>
      </div>

      {smtp && (
        <div className="card">
          <h2>{t(locale, 'admin.smtp.title')}</h2>
          {!smtp.ready_for_send && (
            <p className="badge warn" style={{ padding: 10, display: 'block' }}>
              ⚠ {smtp.configured ? t(locale, 'admin.smtp.notReachable') : t(locale, 'admin.smtp.notConfigured')}
            </p>
          )}
          {smtp.host === 'postal' && (
            <p className="badge warn" style={{ padding: 10, display: 'block', marginTop: 8 }}>
              ⚠ {t(locale, 'admin.smtp.postalPlaceholder')}
            </p>
          )}
          {smtp.ready_for_send && <p className="badge ok" style={{ padding: 10, display: 'inline-block' }}>✓ {t(locale, 'admin.smtp.ready')}</p>}
          <table style={{ width: '100%', fontSize: 13, marginTop: 10 }}>
            <tbody>
              <tr><td>{t(locale, 'admin.smtp.host')}</td><td><code>{smtp.host || '—'}</code></td></tr>
              <tr><td>{t(locale, 'admin.smtp.port')}</td><td>{smtp.port}</td></tr>
              <tr><td>{t(locale, 'admin.smtp.from')}</td><td><code>{smtp.from_address || '—'}</code></td></tr>
              <tr><td>{t(locale, 'admin.smtp.userSet')}</td><td>{smtp.user_set ? '✓' : '—'}</td></tr>
              <tr><td>{t(locale, 'admin.smtp.reachable')}</td><td>{smtp.reachable === null ? '—' : (smtp.reachable ? '✓' : `✗ ${smtp.reachable_detail ?? ''}`)}</td></tr>
            </tbody>
          </table>
          {smtp.warnings.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <b>{t(locale, 'admin.smtp.warnings')}:</b>
              <ul>{smtp.warnings.map((w, i) => <li key={i} style={{ fontSize: 13, color: '#8a6300' }}>{w}</li>)}</ul>
            </div>
          )}
        </div>
      )}

      <div className="card">
        <h2>{t(locale, 'admin.createTenant.title')}</h2>
        <form onSubmit={createTenant} style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
          <div><label>{t(locale, 'admin.createTenant.name')}</label>
            <input value={createForm.name} onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })} required /></div>
          <div><label>{t(locale, 'admin.createTenant.ownerEmail')}</label>
            <input type="email" value={createForm.ownerEmail} onChange={(e) => setCreateForm({ ...createForm, ownerEmail: e.target.value })} required /></div>
          <div><label>{t(locale, 'admin.createTenant.plan')}</label>
            <select value={createForm.planCode} onChange={(e) => setCreateForm({ ...createForm, planCode: e.target.value })}>
              <option value="free">free</option><option value="starter">starter</option><option value="pro">pro</option><option value="agency">agency</option>
            </select></div>
          <div><label>{t(locale, 'admin.createTenant.locale')}</label>
            <select value={createForm.locale} onChange={(e) => setCreateForm({ ...createForm, locale: e.target.value })}>
              <option value="en">EN</option><option value="ru">RU</option><option value="uk">UK</option>
            </select></div>
          <div style={{ display: 'flex', alignItems: 'flex-end' }}><button className="btn" type="submit">{t(locale, 'admin.createTenant.submit')}</button></div>
        </form>
        <p style={{ fontSize: 12, color: '#6b7591', marginTop: 8 }}>{t(locale, 'admin.createTenant.hint')}</p>
      </div>

      <div className="card">
        <h2>{t(locale, 'admin.tenants.title')}</h2>
        {tenants.length === 0 ? <p>{t(locale, 'admin.tenants.empty')}</p> : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th align="left">ID</th>
                <th align="left">{t(locale, 'admin.tenants.name')}</th>
                <th align="left">{t(locale, 'admin.tenants.slug')}</th>
                <th align="left">{t(locale, 'admin.tenants.status')}</th>
                <th align="left">{t(locale, 'admin.tenants.locale')}</th>
                <th align="left">{t(locale, 'admin.tenants.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {tenants.map((tn) => (
                <tr key={tn.id} style={{ borderTop: '1px solid #eef0f5' }}>
                  <td>{tn.id}</td>
                  <td>{tn.name}</td>
                  <td><code style={{ fontSize: 11 }}>{tn.slug}</code></td>
                  <td><span className={`badge ${tn.status === 'active' ? 'ok' : tn.status === 'trial' ? 'pending' : 'fail'}`}>{tn.status}</span></td>
                  <td>{tn.default_locale}</td>
                  <td style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <a className="btn btn-ghost" href={`/dashboard?tenantId=${tn.id}`}>{t(locale, 'admin.tenants.view')}</a>
                    {tn.status !== 'active' && <button className="btn btn-ghost" onClick={() => setStatus(tn.id, 'activate')}>{t(locale, 'admin.tenants.activate')}</button>}
                    {tn.status !== 'suspended' && <button className="btn btn-ghost" onClick={() => setStatus(tn.id, 'suspend')}>{t(locale, 'admin.tenants.suspend')}</button>}
                    <button className="btn btn-ghost" onClick={() => toggleLeads(tn.id, true)}>{t(locale, 'admin.tenants.leadsOn')}</button>
                    <button className="btn btn-ghost" onClick={() => toggleLeads(tn.id, false)}>{t(locale, 'admin.tenants.leadsOff')}</button>
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
