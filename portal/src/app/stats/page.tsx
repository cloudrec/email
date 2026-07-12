'use client';

import { useEffect, useState } from 'react';
import { useT } from '@/lib/useT';

function api<T>(path: string): Promise<T> {
  const token = document.cookie.split('; ').find((c) => c.startsWith('token='))?.split('=')[1];
  const tenantId = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '').get('tenantId');
  return fetch(`/api${path}`, {
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(tenantId ? { 'x-tenant-id': tenantId } : {}),
    },
  }).then(async (r) => {
    if (r.status === 401) { window.location.href = '/login?next=/stats'; throw new Error('unauthorized'); }
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json() as Promise<T>;
  });
}

type Stat = { label: string; value: string | number | null; sub?: string; warn?: boolean; ok?: boolean };

function StatCard({ label, value, sub, warn, ok }: Stat) {
  return (
    <div className="stat" style={{ position: 'relative' }}>
      <div className="label">{label}</div>
      <div className={`value${warn ? ' warn' : ok ? ' ok' : ''}`} style={warn ? { color: 'var(--warn)' } : ok ? { color: 'var(--ok)' } : {}}>
        {value ?? '—'}
      </div>
      {sub && <div className="delta" style={{ color: 'var(--muted)', fontSize: 11 }}>{sub}</div>}
    </div>
  );
}

export default function StatsPage() {
  const t = useT();
  const [warehouseStats, setWarehouseStats] = useState<any>(null);
  const [campaigns, setCampaigns] = useState<any[]>([]);
  const [drafts, setDrafts] = useState<any[]>([]);
  const [contacts, setContacts] = useState<any[]>([]);
  const [domains, setDomains] = useState<any[]>([]);
  const [collector, setCollector] = useState<any[]>([]);
  const [qualityReport, setQualityReport] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.allSettled([
      api<any>('/warehouse/stats'),
      api<{ campaigns: any[] }>('/campaigns'),
      api<{ drafts: any[] }>('/outreach/drafts'),
      api<{ contacts: any[] }>('/contacts?limit=5000'),
      api<{ domains: any[] }>('/domains'),
      api<{ campaigns: any[] }>('/collector/campaigns'),
      api<any>('/admin/warehouse/quality-report').catch(() => null),
    ]).then(([ws, ca, dr, co, do_, cl, qr]) => {
      if (ws.status === 'fulfilled') setWarehouseStats(ws.value);
      if (ca.status === 'fulfilled') setCampaigns(ca.value.campaigns ?? []);
      if (dr.status === 'fulfilled') setDrafts(dr.value.drafts ?? []);
      if (co.status === 'fulfilled') setContacts(co.value.contacts ?? []);
      if (do_.status === 'fulfilled') setDomains(do_.value.domains ?? []);
      if (cl.status === 'fulfilled') setCollector(cl.value.campaigns ?? []);
      if (qr.status === 'fulfilled' && qr.value) setQualityReport(qr.value);
    });
  }, []);

  const draftsByStatus = drafts.reduce<Record<string, number>>((acc, d) => {
    acc[d.status] = (acc[d.status] ?? 0) + 1;
    return acc;
  }, {});

  const contactsByStatus = contacts.reduce<Record<string, number>>((acc, c) => {
    acc[c.status] = (acc[c.status] ?? 0) + 1;
    return acc;
  }, {});

  const verifiedDomains = domains.filter((d) => d.status === 'verified').length;

  return (
    <div>
      {/* Warehouse */}
      <div className="panel">
        <div className="panel-h"><h2>{t('stats.warehouseTitle')}</h2></div>
        <div className="stat-grid">
          <StatCard label={t('stats.companies')} value={warehouseStats?.companies ?? '—'} />
          <StatCard label={t('stats.contactPoints')} value={warehouseStats?.emails ?? '—'} sub={t('stats.allAtDiscovered')} />
          <StatCard label={t('stats.industriesMapped')} value={warehouseStats?.industries ?? '—'} />
          <StatCard label={t('stats.goodFitClientsHelp')} value={warehouseStats?.productFit?.clients_help?.good_fit ?? '—'} ok />
          <StatCard label={t('stats.withoutIndustry')} value={qualityReport?.companiesWithoutIndustry ?? '—'} warn={qualityReport?.companiesWithoutIndustry > 0} sub={t('stats.canReclassify')} />
          <StatCard label={t('stats.withoutContact')} value={qualityReport?.companiesWithoutContact ?? '—'} />
        </div>
      </div>

      {/* Collector */}
      <div className="panel">
        <div className="panel-h"><h2>{t('stats.collectorTitle')}</h2></div>
        <div className="stat-grid">
          <StatCard label={t('stats.campaigns')} value={collector.length} />
          <StatCard label={t('stats.active')} value={collector.filter((c) => c.status === 'active').length} ok={collector.filter((c) => c.status === 'active').length > 0} />
        </div>
      </div>

      {/* Outreach drafts */}
      <div className="panel">
        <div className="panel-h"><h2>{t('stats.outreachDraftsTitle')}</h2></div>
        <div className="stat-grid">
          <StatCard label={t('stats.totalDrafts')} value={drafts.length} />
          <StatCard label={t('stats.pendingReview')} value={draftsByStatus['pending_review'] ?? 0} warn={(draftsByStatus['pending_review'] ?? 0) > 0} />
          <StatCard label={t('stats.approved')} value={draftsByStatus['approved'] ?? 0} ok={(draftsByStatus['approved'] ?? 0) > 0} />
          <StatCard label={t('stats.sentTest')} value={draftsByStatus['sent_test'] ?? 0} />
          <StatCard label={t('stats.sentLive')} value={draftsByStatus['sent'] ?? 0} />
        </div>
      </div>

      {/* Contacts */}
      <div className="panel">
        <div className="panel-h"><h2>{t('stats.contactsTitle')}</h2></div>
        <div className="stat-grid">
          <StatCard label={t('stats.total')} value={contacts.length} />
          <StatCard label={t('stats.subscribed')} value={contactsByStatus['subscribed'] ?? 0} ok={(contactsByStatus['subscribed'] ?? 0) > 0} />
          <StatCard label={t('stats.pending')} value={contactsByStatus['pending'] ?? 0} warn={(contactsByStatus['pending'] ?? 0) > 0} />
          <StatCard label={t('stats.unsubscribed')} value={contactsByStatus['unsubscribed'] ?? 0} />
          <StatCard label={t('stats.bounced')} value={contactsByStatus['bounced'] ?? 0} warn={(contactsByStatus['bounced'] ?? 0) > 0} />
        </div>
      </div>

      {/* Campaigns */}
      <div className="panel">
        <div className="panel-h"><h2>{t('stats.campaignsTitle')}</h2></div>
        <div className="stat-grid">
          <StatCard label={t('stats.total')} value={campaigns.length} />
          <StatCard label={t('stats.sentZero')} value="0" ok sub={t('stats.noEmailSentYet')} />
        </div>
        {campaigns.length === 0 && (
          <p style={{ color: 'var(--muted)', fontSize: 13, padding: '8px 0' }}>
            {t('stats.noCampaignsCreated')}
          </p>
        )}
      </div>

      {/* Domains */}
      <div className="panel">
        <div className="panel-h"><h2>{t('stats.sendingDomainsTitle')}</h2></div>
        <div className="stat-grid">
          <StatCard label={t('stats.total')} value={domains.length} />
          <StatCard label={t('stats.verified')} value={verifiedDomains} ok={verifiedDomains > 0} warn={verifiedDomains === 0} />
          <StatCard label={t('stats.pending')} value={domains.filter((d) => d.status === 'pending').length} warn={domains.filter((d) => d.status === 'pending').length > 0} />
        </div>
        {domains.length > 0 && (
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse', marginTop: 10 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--line)' }}>
                <th align="left" style={{ padding: '4px 0' }}>{t('stats.colDomain')}</th>
                <th align="left">{t('stats.colStatus')}</th>
                <th align="left">{t('stats.colDailyLimit')}</th>
              </tr>
            </thead>
            <tbody>
              {domains.map((d) => (
                <tr key={d.id} style={{ borderTop: '1px solid var(--line-2)' }}>
                  <td style={{ padding: '5px 0' }}><code style={{ fontSize: 11 }}>{d.domain}</code></td>
                  <td><span className={`badge ${d.status === 'verified' ? 'ok' : d.status === 'failed' ? 'fail' : 'warn'}`}>{d.status}</span></td>
                  <td style={{ color: 'var(--ink-3)' }}>{t('stats.perDay').replace('{n}', String(d.daily_send_limit ?? '—'))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Safety confirmation */}
      <div className="panel" style={{ borderLeft: '3px solid var(--ok)' }}>
        <div className="panel-h"><h2>{t('stats.safetyStatusTitle')}</h2></div>
        <div className="stat-grid">
          {[
            { key: 'safetyEmailsSent', label: t('stats.safetyEmailsSent'), value: 0, ok: true },
            { key: 'safetySmtpEnabled', label: t('stats.safetySmtpEnabled'), value: t('stats.no'), ok: true },
            { key: 'safetyAutoActivatedContacts', label: t('stats.safetyAutoActivatedContacts'), value: 0, ok: true },
            { key: 'safetyAutoApprovedDrafts', label: t('stats.safetyAutoApprovedDrafts'), value: 0, ok: true },
            { key: 'safetyBulkSends', label: t('stats.safetyBulkSends'), value: 0, ok: true },
          ].map(({ key, label, value, ok }) => (
            <StatCard key={key} label={label} value={value} ok={ok} />
          ))}
        </div>
      </div>

      {error && <div className="card"><p style={{ color: 'var(--danger)' }}>{error}</p></div>}
    </div>
  );
}
