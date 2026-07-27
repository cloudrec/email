'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '../../components/AppShell';

// Engine safety (TZ §17 Safety). Read-only aggregation of the three engine-specific
// signals: offer policy violations, stale offer terms, and paused campaigns. Existing
// /safety + /deliverability cover bounces, complaints and mailbox health. No actions
// here — this is a monitoring view.

type Violation = {
  id: number; offer_id: number | null; campaign_id: number | null;
  contact_email: string | null; created_at: string; offer_name: string | null; network_name: string | null;
};
type StaleTerm = {
  id: number; offerName: string; networkName: string;
  termsVerifiedAt: string | null; termsVerifiedBy: string | null; ageDays: number | null;
};
type PausedCampaign = {
  id: number; name: string; status: string; lifecycle_state: string;
  campaign_mode: string | null; mode_owner: string | null; updated_at: string;
};
type SafetyData = {
  termsMaxAgeDays: number;
  counts: { offerPolicyViolations: number; staleTerms: number; pausedCampaigns: number };
  offerPolicyViolations: Violation[]; staleTerms: StaleTerm[]; pausedCampaigns: PausedCampaign[];
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
    if (r.status === 401) { window.location.href = '/login?next=/engine-safety'; throw new Error('unauthorized'); }
    if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 300)}`);
    return r.json() as Promise<T>;
  });
}

export default function EngineSafetyPage() {
  const [data, setData] = useState<SafetyData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<SafetyData>('/engine/safety').then(setData).catch((e) => setError(e.message));
  }, []);

  const c = data?.counts;
  const chip = (n: number) => (n > 0 ? 'value danger' : 'value ok');

  return (
    <AppShell pageKey="engineSafety">
      <div style={{ marginBottom: 16 }}>
        <h1>Engine safety</h1>
        <p className="muted">Offer policy violations, stale terms and paused campaigns. Bounces, complaints and mailbox health live under Deliverability &amp; Safety.</p>
      </div>

      {error && <div className="notice danger" style={{ marginBottom: 12 }}>{error}</div>}

      {data && (
        <div className="stat-grid" style={{ marginBottom: 16 }}>
          <div className="stat"><span className="label">Offer policy violations</span><span className={chip(c!.offerPolicyViolations)}>{c!.offerPolicyViolations}</span></div>
          <div className="stat"><span className="label">Stale terms (&gt;{data.termsMaxAgeDays}d)</span><span className={chip(c!.staleTerms)}>{c!.staleTerms}</span></div>
          <div className="stat"><span className="label">Paused campaigns</span><span className={chip(c!.pausedCampaigns)}>{c!.pausedCampaigns}</span></div>
        </div>
      )}

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-h">Offer policy violations</div>
        {!data || data.offerPolicyViolations.length === 0 ? <div className="empty">No prohibited-claim failures recorded.</div> : (
          <table>
            <thead><tr><th>When</th><th>Offer</th><th>Network</th><th>Campaign</th><th>Contact</th></tr></thead>
            <tbody>
              {data.offerPolicyViolations.map((v) => (
                <tr key={v.id}>
                  <td>{new Date(v.created_at).toLocaleString()}</td>
                  <td>{v.offer_name || (v.offer_id ? `#${v.offer_id}` : '—')}</td>
                  <td>{v.network_name || '—'}</td>
                  <td>{v.campaign_id ?? '—'}</td>
                  <td>{v.contact_email ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-h">Stale offer terms</div>
        {!data || data.staleTerms.length === 0 ? <div className="empty">All approved offers have fresh terms.</div> : (
          <table>
            <thead><tr><th>Offer</th><th>Network</th><th>Verified</th><th>By</th><th>Age</th></tr></thead>
            <tbody>
              {data.staleTerms.map((s) => (
                <tr key={s.id}>
                  <td>{s.offerName} <span className="muted">#{s.id}</span></td>
                  <td>{s.networkName}</td>
                  <td>{s.termsVerifiedAt ? new Date(s.termsVerifiedAt).toLocaleDateString() : <span className="chip warn">never</span>}</td>
                  <td>{s.termsVerifiedBy || '—'}</td>
                  <td>{s.ageDays != null ? <span className="chip danger">{s.ageDays}d</span> : <span className="chip warn">unverified</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <div className="panel-h">Paused campaigns</div>
        {!data || data.pausedCampaigns.length === 0 ? <div className="empty">No paused campaigns.</div> : (
          <table>
            <thead><tr><th>Campaign</th><th>Mode</th><th>Owner</th><th>Lifecycle</th><th>Updated</th></tr></thead>
            <tbody>
              {data.pausedCampaigns.map((p) => (
                <tr key={p.id}>
                  <td>{p.name} <span className="muted">#{p.id}</span></td>
                  <td>{p.campaign_mode ? <span className="chip info">{p.campaign_mode === 'AFFILIATE' ? 'affiliate' : 'own'}</span> : '—'}</td>
                  <td>{p.mode_owner || '—'}</td>
                  <td><span className="chip warn">{p.lifecycle_state}</span></td>
                  <td>{p.updated_at ? new Date(p.updated_at).toLocaleString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </AppShell>
  );
}
