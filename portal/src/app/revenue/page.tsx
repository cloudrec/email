'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '../../components/AppShell';

// Revenue admin (TZ §17 Revenue). Read-only view of the revenue_events ledger:
// own-product revenue, pending vs approved affiliate commission, refunds, net.
// Figures are grouped by currency. Nothing here writes or moves money.

type CurrencyRow = {
  currency: string; ownProductRevenue: number; pendingCommission: number;
  approvedCommission: number; refunds: number; netRevenue: number; events: number;
};
type RevEvent = {
  id: number; campaign_id: number | null; offer_id: number | null; mode: string;
  event_type: string; amount: string | number; currency: string | null;
  contact_email: string | null; occurred_at: string | null;
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
    if (r.status === 401) { window.location.href = '/login?next=/revenue'; throw new Error('unauthorized'); }
    if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 300)}`);
    return r.json() as Promise<T>;
  });
}

const money = (n: number, cur: string) => `${n.toFixed(2)} ${cur === '—' ? '' : cur}`.trim();
const eventChip = (t: string) =>
  t === 'commission_approved' || t === 'revenue' ? 'chip ok'
  : t === 'commission_pending' ? 'chip warn'
  : t === 'refund' || t === 'chargeback' || t === 'commission_rejected' ? 'chip danger'
  : 'chip muted';

export default function RevenuePage() {
  const [rows, setRows] = useState<CurrencyRow[]>([]);
  const [recent, setRecent] = useState<RevEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ byCurrency: CurrencyRow[]; recent: RevEvent[] }>('/affiliate/revenue/summary')
      .then((d) => { setRows(d.byCurrency); setRecent(d.recent); })
      .catch((e) => setError(e.message));
  }, []);

  return (
    <AppShell pageKey="revenue">
      <div style={{ marginBottom: 16 }}>
        <h1>Revenue</h1>
        <p className="muted">Read-only ledger from postback events. Pending commission is shown but excluded from net (not booked until approved).</p>
      </div>

      {error && <div className="notice danger" style={{ marginBottom: 12 }}>{error}</div>}

      {rows.length === 0 && !error && <div className="empty">No revenue events recorded yet.</div>}

      {rows.map((r) => (
        <div key={r.currency} className="panel" style={{ marginBottom: 16 }}>
          <div className="panel-h">{r.currency === '—' ? 'Unspecified currency' : r.currency} · {r.events} events</div>
          <div className="stat-grid" style={{ padding: 16 }}>
            <div className="stat"><span className="label">Own-product revenue</span><span className="value">{money(r.ownProductRevenue, r.currency)}</span></div>
            <div className="stat"><span className="label">Pending commission</span><span className="value warn">{money(r.pendingCommission, r.currency)}</span></div>
            <div className="stat"><span className="label">Approved commission</span><span className="value ok">{money(r.approvedCommission, r.currency)}</span></div>
            <div className="stat"><span className="label">Refunds / chargebacks</span><span className="value danger">{money(r.refunds, r.currency)}</span></div>
            <div className="stat kpi"><span className="label">Net revenue</span><span className="value">{money(r.netRevenue, r.currency)}</span></div>
          </div>
        </div>
      ))}

      <div className="panel">
        <div className="panel-h">Recent events ({recent.length})</div>
        {recent.length === 0 ? <div className="empty">No events.</div> : (
          <table>
            <thead><tr><th>When</th><th>Mode</th><th>Type</th><th>Amount</th><th>Campaign</th><th>Offer</th><th>Contact</th></tr></thead>
            <tbody>
              {recent.map((e) => (
                <tr key={e.id}>
                  <td>{e.occurred_at ? new Date(e.occurred_at).toLocaleString() : '—'}</td>
                  <td><span className="chip muted">{e.mode === 'AFFILIATE' ? 'affiliate' : 'own'}</span></td>
                  <td><span className={eventChip(e.event_type)}>{e.event_type}</span></td>
                  <td>{money(Number(e.amount), e.currency || '—')}</td>
                  <td>{e.campaign_id ?? '—'}</td>
                  <td>{e.offer_id ?? '—'}</td>
                  <td>{e.contact_email ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </AppShell>
  );
}
