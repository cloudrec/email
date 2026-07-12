'use client';

import { useEffect, useState } from 'react';
import { useLocaleClient } from '../../components/useLocaleClient';
import { t } from '../../lib/t';

type Counters = {
  contacts: number | null;
  contactsPending: number | null;
  domains: number | null;
  domainsVerified: number | null;
  campaigns: number | null;
  leadsDiscoveredMonth: number | null;
  leadsLimitMonth: number | null;
  draftsPending: number | null;
  draftsTotal: number | null;
  collectorActive: number | null;
  collectorTotal: number | null;
  inviteLinks: number | null;
  smtpState: string | null;
  warehouseCompanies: number | null;
  warehouseContacts: number | null;
};

function api<T>(path: string): Promise<T> {
  const token = document.cookie.split('; ').find((c) => c.startsWith('token='))?.split('=')[1];
  const tenantId = new URLSearchParams(window.location.search).get('tenantId');
  return fetch(`/api${path}`, {
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(tenantId ? { 'x-tenant-id': tenantId } : {}),
    },
  }).then(async (r) => {
    if (r.status === 401) { window.location.href = '/login?next=/dashboard'; throw new Error('unauthorized'); }
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
  });
}

export default function DashboardPage() {
  const locale = useLocaleClient();
  const [c, setC] = useState<Counters>({
    contacts: null, contactsPending: null, domains: null, domainsVerified: null,
    campaigns: null, leadsDiscoveredMonth: null, leadsLimitMonth: null,
    draftsPending: null, draftsTotal: null, collectorActive: null, collectorTotal: null,
    inviteLinks: null, smtpState: null, warehouseCompanies: null, warehouseContacts: null,
  });
  const [error, setError] = useState<string | null>(null);
  const [dc, setDc] = useState<any>(null);  // deliverability + warmup snapshot

  useEffect(() => { api<any>('/deliverability/center').then(setDc).catch(() => {}); }, []);

  useEffect(() => {
    Promise.allSettled([
      api<{ contacts: any[] }>('/contacts?limit=500'),
      api<{ domains: any[] }>('/domains'),
      api<{ campaigns: any[] }>('/campaigns'),
      api<any>('/leads/limits'),
      api<{ drafts: any[] }>('/outreach/drafts'),
      api<{ campaigns: any[] }>('/collector/campaigns'),
      api<{ links: any[] }>('/invite-links'),
      api<any>('/system/smtp-status').catch(() => null),
      api<any>('/warehouse/stats').catch(() => null),
    ]).then(([co, d, ca, l, dr, cc, il, sm, ws]) => {
      const next: Counters = { ...c };
      if (co.status === 'fulfilled') {
        next.contacts = co.value.contacts.length;
        next.contactsPending = co.value.contacts.filter((x: any) => x.status === 'pending').length;
      }
      if (d.status === 'fulfilled') {
        next.domains = d.value.domains.length;
        next.domainsVerified = d.value.domains.filter((x: any) => x.status === 'verified').length;
      }
      if (ca.status === 'fulfilled') next.campaigns = ca.value.campaigns.length;
      if (l.status === 'fulfilled') {
        next.leadsDiscoveredMonth = l.value.usage?.leadsDiscovered ?? 0;
        next.leadsLimitMonth = l.value.maxLeadsMonth ?? 0;
      }
      if (dr.status === 'fulfilled') {
        next.draftsTotal = dr.value.drafts.length;
        next.draftsPending = dr.value.drafts.filter((x: any) => x.status === 'pending_review').length;
      }
      if (cc.status === 'fulfilled') {
        next.collectorTotal = cc.value.campaigns.length;
        next.collectorActive = cc.value.campaigns.filter((x: any) => x.status === 'active').length;
      }
      if (il.status === 'fulfilled') next.inviteLinks = il.value.links.length;
      if (sm.status === 'fulfilled' && sm.value) next.smtpState = sm.value.state ?? null;
      if (ws && ws.status === 'fulfilled' && ws.value) {
        next.warehouseCompanies = ws.value.companies ?? 0;
        next.warehouseContacts = ws.value.emails ?? 0;
      }
      const first = [co, d, ca, l, dr, cc].find((x) => x.status === 'rejected');
      if (first && first.status === 'rejected') setError((first.reason as Error).message);
      setC(next);
    });
  }, []);

  const tenantSearch = typeof window !== 'undefined' ? window.location.search : '';

  // Next-actions checklist — derived, not random.
  const tasks: Array<{ done: boolean; label: string; href: string }> = [];
  if (c.domains !== null) {
    tasks.push({
      done: (c.domainsVerified ?? 0) > 0,
      label: t(locale, 'dashboard.todoVerifyDomain'),
      href: `/domains${tenantSearch}`,
    });
  }
  tasks.push({
    done: c.smtpState === 'ready',
    label: t(locale, 'dashboard.todoConfigureSmtp'),
    href: `/admin`,
  });
  if (c.draftsPending !== null) {
    tasks.push({
      done: c.draftsPending === 0 && (c.draftsTotal ?? 0) > 0,
      label: t(locale, 'dashboard.todoReviewDrafts'),
      href: `/outreach${tenantSearch}`,
    });
  }
  if (c.contactsPending !== null) {
    tasks.push({
      done: c.contactsPending === 0,
      label: t(locale, 'dashboard.todoActivatePending'),
      href: `/contacts${tenantSearch}`,
    });
  }

  // Plain-language "one next step" derived from the deliverability advisor.
  const BLOCKER_HREF: Record<string, string> = {
    spf_missing: '/domains', dkim_missing: '/domains', dmarc_missing: '/domains', return_path_dns: '/domains',
    no_working_provider: '/mailboxes', no_active_mailbox: '/mailboxes', no_imap: '/mailboxes',
    high_bounce: '/deliverability', high_complaint: '/deliverability', worker_down: '/deliverability',
    spamhaus_listed: '/deliverability', barracuda_listed: '/deliverability', ptr: '/deliverability',
  };
  const topBlocker = dc?.advisor?.find((a: any) => a.severity === 'blocker') || dc?.advisor?.find((a: any) => a.severity === 'warning');
  const verdictColor: Record<string, string> = { READY_FOR_LOW_VOLUME_WARMUP: 'var(--ok)', READY_FOR_CONTROLLED_TEST_SEND: 'var(--warn)', NOT_READY: 'var(--danger)' };

  return (
    <>
      {error && <div className="notice danger">{error}</div>}

      {/* ── Your next step (plain, one action) ── */}
      {dc && (
        <div className="panel" style={{ borderLeft: `4px solid ${verdictColor[dc.verdict] ?? 'var(--line)'}` }}>
          <div className="panel-h"><h2>{t(locale, 'dashboard.nextStep')}</h2>
            <span className="right" style={{ color: verdictColor[dc.verdict] }}>{t(locale, `deliverability.verdict.${dc.verdict}`)} · {dc.readinessScore}/100</span>
          </div>
          {topBlocker ? (
            <div style={{ fontSize: 15 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>{topBlocker.message}</div>
              {topBlocker.action && <div className="muted" style={{ marginBottom: 8 }}>→ {topBlocker.action}</div>}
              <a className="btn btn-primary" href={`${BLOCKER_HREF[topBlocker.code] ?? '/deliverability'}${tenantSearch}`}>{t(locale, 'dashboard.fixNow')}</a>
            </div>
          ) : (
            <div style={{ fontSize: 15 }}>
              <div style={{ fontWeight: 600, color: 'var(--ok)', marginBottom: 6 }}>✓ {t(locale, 'dashboard.allSetWarming')}</div>
              <a href={`/deliverability${tenantSearch}`}>{t(locale, 'dashboard.openDeliverability')} →</a>
            </div>
          )}
        </div>
      )}

      {/* ── Warmup & sending today ── */}
      {dc && (
        <div className="stat-grid" style={{ marginBottom: 4 }}>
          <div className="stat"><div className="label">{t(locale, 'dashboard.warmupSent')}</div><div className="value">{dc.rates?.sentToday ?? 0}</div></div>
          <div className="stat"><div className="label">{t(locale, 'dashboard.warmupDelivered')}</div><div className="value">{dc.postalDelivery?.available ? `${dc.postalDelivery.deliveredRate}%` : '—'}</div><div className="delta muted" style={{ fontSize: 11 }}>{dc.postalDelivery?.available ? `${t(locale, 'dashboard.last24h')}` : ''}</div></div>
          <div className="stat"><div className="label">{t(locale, 'dashboard.warmupReplies')}</div><div className="value">{dc.rates?.replyRate ?? 0}%</div></div>
          <div className="stat"><div className="label">{t(locale, 'deliverability.bounceRate')}</div><div className="value" style={{ color: (dc.rates?.bounceRate ?? 0) > 3 ? 'var(--danger)' : undefined }}>{dc.rates?.bounceRate ?? 0}%</div></div>
          <div className="stat"><div className="label">{t(locale, 'deliverability.complaintRate')}</div><div className="value" style={{ color: (dc.rates?.complaintRate ?? 0) > 0.1 ? 'var(--danger)' : undefined }}>{dc.rates?.complaintRate ?? 0}%</div></div>
          <div className="stat"><div className="label">{t(locale, 'deliverability.blacklist')}</div><div className="value" style={{ fontSize: 15 }}>{dc.blacklist?.spamhaus === 'listed' || dc.blacklist?.barracuda === 'listed' ? <span className="chip warn">listed</span> : <span className="chip ok">clean</span>}</div></div>
        </div>
      )}

      <div className="stat-grid">
        <div className="stat kpi">
          <div className="label">{t(locale, 'dashboard.stats.contacts')}</div>
          <div className="value">{c.contacts ?? '—'}</div>
          <div className="delta">
            {c.contactsPending !== null && c.contactsPending > 0 && (
              <span className="chip warn" style={{ marginRight: 6 }}>{c.contactsPending} {t(locale, 'dashboard.stats.pending')}</span>
            )}
          </div>
        </div>

        <div className="stat kpi">
          <div className="label">{t(locale, 'dashboard.stats.leadsThisMonth')}</div>
          <div className="value">
            {c.leadsDiscoveredMonth ?? '—'}
            {c.leadsLimitMonth ? <span className="muted" style={{ fontSize: 14, fontWeight: 500 }}> / {c.leadsLimitMonth}</span> : null}
          </div>
        </div>

        <div className="stat kpi">
          <div className="label">{t(locale, 'dashboard.stats.draftsPending')}</div>
          <div className="value">{c.draftsPending ?? '—'}</div>
          {c.draftsPending !== null && c.draftsPending > 0 && (
            <div className="delta"><a href={`/outreach${tenantSearch}`}>{t(locale, 'dashboard.openReview')}</a></div>
          )}
        </div>

        <div className="stat kpi">
          <div className="label">{t(locale, 'dashboard.stats.collector')}</div>
          <div className="value">
            {c.collectorActive ?? '—'}
            {c.collectorTotal !== null ? <span className="muted" style={{ fontSize: 14, fontWeight: 500 }}> / {c.collectorTotal}</span> : null}
          </div>
        </div>

        <div className="stat">
          <div className="label">{t(locale, 'dashboard.stats.domains')}</div>
          <div className="value">
            {c.domainsVerified ?? '—'}
            {c.domains !== null ? <span className="muted" style={{ fontSize: 14, fontWeight: 500 }}> / {c.domains}</span> : null}
          </div>
        </div>

        <div className="stat">
          <div className="label">{t(locale, 'dashboard.stats.inviteLinks')}</div>
          <div className="value">{c.inviteLinks ?? '—'}</div>
        </div>

        <div className="stat">
          <div className="label">{t(locale, 'dashboard.stats.sending')}</div>
          <div className="value muted">{t(locale, 'dashboard.sendingDisabled')}</div>
          <div className="delta">
            {c.smtpState === 'ready' ? <span className="chip ok">{t(locale, 'dashboard.smtpReady')}</span> :
             c.smtpState ? <span className="chip warn">{c.smtpState.replace(/_/g, ' ')}</span> :
             <span className="chip muted">{t(locale, 'dashboard.smtpUnknown')}</span>}
          </div>
        </div>

        <div className="stat">
          <div className="label">{t(locale, 'dashboard.warehouseCompanies')}</div>
          <div className="value">{c.warehouseCompanies ?? '—'}</div>
          <div className="delta"><a href={`/warehouse${tenantSearch}`}>{t(locale, 'dashboard.view')}</a></div>
        </div>
        <div className="stat">
          <div className="label">{t(locale, 'dashboard.warehouseEmails')}</div>
          <div className="value">{c.warehouseContacts ?? '—'}</div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-h">
          <h2>{t(locale, 'dashboard.nextActions')}</h2>
          <span className="right">{tasks.filter((x) => x.done).length} / {tasks.length}</span>
        </div>
        <ol style={{ margin: 0, paddingLeft: 18 }}>
          {tasks.map((task, i) => (
            <li key={i} style={{ margin: '6px 0', color: task.done ? 'var(--muted)' : 'var(--ink)' }}>
              <span style={{ marginRight: 6, color: task.done ? 'var(--ok)' : 'var(--warn)' }}>
                {task.done ? '✓' : '○'}
              </span>
              {task.done ? <s>{task.label}</s> : <a href={task.href}>{task.label}</a>}
            </li>
          ))}
        </ol>
      </div>

      <div className="panel">
        <div className="panel-h">
          <h2>{t(locale, 'dashboard.activity')}</h2>
        </div>
        <div className="row">
          <div>
            <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
              {t(locale, 'dashboard.recentCampaigns')}
            </div>
            {c.campaigns === null ? <div className="muted">—</div> :
             c.campaigns === 0 ? <div className="empty"><strong>{t(locale, 'dashboard.noCampaigns')}</strong></div> :
             <div>{c.campaigns} {t(locale, 'dashboard.recentCampaigns')}</div>}
          </div>
          <div>
            <div className="muted" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
              {t(locale, 'dashboard.recentDrafts')}
            </div>
            {c.draftsTotal === null ? <div className="muted">—</div> :
             c.draftsTotal === 0 ? <div className="empty"><strong>{t(locale, 'dashboard.noDrafts')}</strong></div> :
             <div>{c.draftsTotal} {t(locale, 'dashboard.draftsTotal')}, {c.draftsPending} {t(locale, 'dashboard.pendingReview')}</div>}
          </div>
        </div>
      </div>
      <span data-marker="SYSTEM_READY_PHASE12_VISIBLE" style={{display:'none'}}>SYSTEM_READY_PHASE12_VISIBLE</span>
    </>
  );
}
