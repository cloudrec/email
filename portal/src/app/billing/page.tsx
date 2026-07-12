'use client';

import { useEffect, useState } from 'react';
import { useLocaleClient } from '../../components/useLocaleClient';
import { t } from '../../lib/t';

function api<T>(path: string): Promise<T> {
  const token = document.cookie.split('; ').find((c) => c.startsWith('token='))?.split('=')[1];
  const tenantId = new URLSearchParams(window.location.search).get('tenantId');
  return fetch(`/api${path}`, {
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(tenantId ? { 'x-tenant-id': tenantId } : {}),
    },
  }).then(async (r) => {
    if (r.status === 401) { window.location.href = '/login?next=/billing'; throw new Error('unauthorized'); }
    if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json() as Promise<T>;
  });
}

export default function BillingPage() {
  const locale = useLocaleClient();
  const [plans, setPlans] = useState<any[]>([]);
  const [invoices, setInvoices] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ plans: any[] }>('/billing/plans').then((j) => setPlans(j.plans)).catch((e) => setError(e.message));
    api<{ invoices: any[] }>('/billing/invoices').then((j) => setInvoices(j.invoices)).catch(() => {});
  }, []);

  return (
    <div>
      <div className="card"><h1>{t(locale, 'billing.title')}</h1></div>

      <div className="card">
        <h2>{t(locale, 'billing.plan')}</h2>
        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
          <thead><tr><th align="left">{t(locale, 'billing.table.code')}</th><th align="left">{t(locale, 'billing.table.name')}</th><th align="right">{t(locale, 'billing.table.price')}</th><th align="right">{t(locale, 'billing.table.contacts')}</th><th align="right">{t(locale, 'billing.table.sendsMonth')}</th><th align="right">{t(locale, 'billing.table.domains')}</th></tr></thead>
          <tbody>
            {plans.map((p) => (
              <tr key={p.code} style={{ borderTop: '1px solid #eef0f5' }}>
                <td><code>{p.code}</code></td>
                <td>{p.name}</td>
                <td align="right">{(p.price_cents / 100).toFixed(2)} {p.currency}</td>
                <td align="right">{p.max_contacts}</td>
                <td align="right">{p.max_sends_month}</td>
                <td align="right">{p.max_domains}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>{t(locale, 'billing.invoices')}</h2>
        <p>{t(locale, 'billing.manualInstructions')}</p>
        {invoices.length === 0 ? <p>—</p> : (
          <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
            <thead><tr><th align="left">{t(locale, 'billing.table.number')}</th><th align="right">{t(locale, 'billing.table.amount')}</th><th align="left">{t(locale, 'billing.status')}</th><th align="left">{t(locale, 'billing.table.issued')}</th></tr></thead>
            <tbody>
              {invoices.map((i: any) => (
                <tr key={i.id} style={{ borderTop: '1px solid #eef0f5' }}>
                  <td>{i.number}</td>
                  <td align="right">{(i.amount_cents / 100).toFixed(2)} {i.currency}</td>
                  <td><span className={`badge ${i.status === 'paid' ? 'ok' : 'pending'}`}>{i.status}</span></td>
                  <td>{i.issued_at}</td>
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
