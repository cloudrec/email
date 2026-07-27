'use client';

import { useEffect, useState } from 'react';
import { useLocaleClient } from '../../components/useLocaleClient';
import { t } from '../../lib/t';

type Contact = { id: number; email: string; first_name: string | null; last_name: string | null; status: string; created_at: string; };
type ContactDetail = {
  contact: { id: number; email: string; status: string };
  source: { consentSource: string | null; tags: unknown; sourceUrl: string | null; company: string | null };
  relevanceReason: string | null;
  suppression: { suppressed: boolean; reason: string | null; at: string | null; scope: string | null };
  campaignHistory: {
    broadcastEvents: Array<{ campaign_id: number | null; campaign_name: string | null; event_type: string; occurred_at: string }>;
    touchpoints: Array<{ campaign_id: number | null; channel: string; direction: string; touch_type: string; status: string; subject: string | null; created_at: string }>;
  };
};

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
    if (r.status === 401) { window.location.href = '/login?next=/contacts'; throw new Error('unauthorized'); }
    if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json() as Promise<T>;
  });
}

export default function ContactsPage() {
  const locale = useLocaleClient();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [status, setStatusFilter] = useState<string>('');
  const [form, setForm] = useState({ email: '', firstName: '', lastName: '' });
  const [error, setError] = useState<string | null>(null);
  const [pendingIds, setPendingIds] = useState<Set<number>>(new Set());
  const [detail, setDetail] = useState<ContactDetail | null>(null);
  const [detailFor, setDetailFor] = useState<number | null>(null);

  const openDetail = async (id: number) => {
    setDetailFor(id); setDetail(null);
    try { setDetail(await api<ContactDetail>(`/contacts/${id}/detail`)); }
    catch (e: any) { setError(e.message); }
  };

  const refresh = async () => {
    try { setContacts((await api<{ contacts: Contact[] }>(`/contacts?limit=200${status ? `&status=${status}` : ''}`)).contacts); setError(null); }
    catch (e: any) { setError(e.message); }
  };
  useEffect(() => { refresh(); }, [status]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api('/contacts', { method: 'POST', body: JSON.stringify(form) });
      setForm({ email: '', firstName: '', lastName: '' });
      refresh();
    } catch (e: any) { setError(e.message); }
  };

  const togglePending = (id: number) => {
    const s = new Set(pendingIds); s.has(id) ? s.delete(id) : s.add(id); setPendingIds(s);
  };

  const activatePending = async () => {
    if (!pendingIds.size) return;
    if (!confirm(t(locale, 'leads.import.activateConfirm'))) return;
    try {
      await api('/contacts/activate-pending', { method: 'POST', body: JSON.stringify({ contactIds: [...pendingIds], confirmCompliance: true }) });
      setPendingIds(new Set());
      refresh();
    } catch (e: any) { setError(e.message); }
  };

  const pending = contacts.filter((c) => c.status === 'pending');

  return (
    <div>
      <div className="card">
        <h1>{t(locale, 'contacts.title')}</h1>
      </div>

      <div className="card">
        <h2>{t(locale, 'contacts.addContact')}</h2>
        <form onSubmit={add} style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
          <div><label>{t(locale, 'contacts.email')}</label><input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required /></div>
          <div><label>{t(locale, 'contacts.firstName')}</label><input value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} /></div>
          <div><label>{t(locale, 'contacts.lastName')}</label><input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} /></div>
          <div style={{ display: 'flex', alignItems: 'flex-end' }}><button className="btn" type="submit">{t(locale, 'common.save')}</button></div>
        </form>
      </div>

      {pending.length > 0 && (
        <div className="card">
          <p className="badge warn" style={{ padding: 10, display: 'block' }}>⚠ {t(locale, 'leads.import.pendingNotice')}</p>
          <p>
            <button className="btn" disabled={!pendingIds.size} onClick={activatePending}>
              {t(locale, 'leads.import.activate')} ({pendingIds.size})
            </button>
          </p>
        </div>
      )}

      <div className="card">
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          <select value={status} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">{t(locale, 'contacts.all')}</option>
            <option value="subscribed">{t(locale, 'contacts.subscribed')}</option>
            <option value="pending">{t(locale, 'contacts.pending')}</option>
            <option value="unsubscribed">{t(locale, 'contacts.unsubscribed')}</option>
            <option value="bounced">{t(locale, 'contacts.bounced')}</option>
            <option value="complained">{t(locale, 'contacts.complained')}</option>
          </select>
          <span style={{ alignSelf: 'center', color: '#6b7591' }}>{contacts.length} {t(locale, 'contacts.title').toLowerCase()}</span>
        </div>
        {contacts.length === 0 ? <p>—</p> : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead><tr><th></th><th align="left">{t(locale, 'contacts.email')}</th><th align="left">{t(locale, 'contacts.firstName')}</th><th align="left">{t(locale, 'contacts.status')}</th><th align="left">{t(locale, 'campaigns.createdAt')}</th><th></th></tr></thead>
            <tbody>
              {contacts.map((c) => (
                <tr key={c.id} style={{ borderTop: '1px solid #eef0f5' }}>
                  <td>{c.status === 'pending' && <input type="checkbox" checked={pendingIds.has(c.id)} onChange={() => togglePending(c.id)} />}</td>
                  <td>{c.email}</td>
                  <td>{c.first_name ?? ''}</td>
                  <td><span className={`badge ${c.status === 'subscribed' ? 'ok' : c.status === 'pending' ? 'warn' : c.status === 'bounced' || c.status === 'complained' ? 'fail' : 'pending'}`}>{c.status}</span></td>
                  <td>{c.created_at}</td>
                  <td><button className="btn btn-ghost" style={{ fontSize: 11, padding: '3px 8px' }} onClick={() => openDetail(c.id)}>Details</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {detailFor !== null && (
        <div className="panel" style={{ marginTop: 16 }}>
          <div className="panel-h between">
            <span>Contact detail{detail ? ` — ${detail.contact.email}` : ''}</span>
            <button className="btn btn-ghost" onClick={() => { setDetailFor(null); setDetail(null); }}>Close</button>
          </div>
          <div style={{ padding: 16 }}>
            {!detail ? <div className="empty">Loading…</div> : (
              <>
                <dl className="kv">
                  <dt>Status</dt><dd><span className="chip muted">{detail.contact.status}</span></dd>
                  <dt>Source</dt><dd>
                    {detail.source.consentSource || '—'}
                    {detail.source.company ? ` · ${detail.source.company}` : ''}
                    {detail.source.sourceUrl ? <> · <a href={detail.source.sourceUrl} target="_blank" rel="noopener">source</a></> : null}
                    {Array.isArray(detail.source.tags) && detail.source.tags.length ? ` · tags: ${(detail.source.tags as string[]).join(', ')}` : ''}
                  </dd>
                  <dt>Relevance reason</dt><dd>{detail.relevanceReason || '—'}</dd>
                  <dt>Suppression</dt><dd>
                    {detail.suppression.suppressed
                      ? <span className="chip danger">suppressed{detail.suppression.reason ? ` · ${detail.suppression.reason}` : ''}{detail.suppression.scope ? ` (${detail.suppression.scope})` : ''}</span>
                      : <span className="chip ok">not suppressed</span>}
                  </dd>
                </dl>

                <div className="panel-h" style={{ marginTop: 12 }}>Campaign history</div>
                {detail.campaignHistory.broadcastEvents.length === 0 && detail.campaignHistory.touchpoints.length === 0 ? (
                  <div className="empty">No campaign activity for this contact.</div>
                ) : (
                  <table>
                    <thead><tr><th>When</th><th>Type</th><th>Channel / event</th><th>Campaign</th><th>Subject</th></tr></thead>
                    <tbody>
                      {detail.campaignHistory.touchpoints.map((tp, i) => (
                        <tr key={`tp${i}`}>
                          <td>{tp.created_at ? new Date(tp.created_at).toLocaleString() : '—'}</td>
                          <td><span className="chip info">{tp.direction}</span></td>
                          <td>{tp.channel} · {tp.touch_type} · {tp.status}</td>
                          <td>{tp.campaign_id ?? '—'}</td>
                          <td>{tp.subject || '—'}</td>
                        </tr>
                      ))}
                      {detail.campaignHistory.broadcastEvents.map((ev, i) => (
                        <tr key={`be${i}`}>
                          <td>{ev.occurred_at ? new Date(ev.occurred_at).toLocaleString() : '—'}</td>
                          <td><span className="chip muted">broadcast</span></td>
                          <td>{ev.event_type}</td>
                          <td>{ev.campaign_name || ev.campaign_id || '—'}</td>
                          <td>—</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {error && <div className="card"><p style={{ color: '#a31818' }}>{error}</p></div>}
    </div>
  );
}
