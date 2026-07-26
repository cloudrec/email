'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '../../components/AppShell';

// Affiliate offers admin (TZ §17). Registry over the /affiliate/offers API: network,
// advertiser, traffic permissions, geographies, terms verification, approval, payout,
// tracking configuration. Approval is the only path to APPROVED and requires an explicit
// cold-email confirmation + verifier name — this page surfaces that gate, nothing more.
// No sending happens here.

type OfferRow = {
  id: number; network_name: string; advertiser_name: string; offer_name: string;
  external_offer_id: string | null; status: string; cold_email_allowed: number;
  payout_type: string | null; payout_amount: string | number | null; payout_currency: string | null;
  terms_verified_at: string | null; terms_verified_by: string | null; created_at: string;
};
type OfferDetail = OfferRow & {
  destination_url: string | null; tracking_url_template: string | null;
  allowed_geos_json: string | null; blocked_geos_json: string | null;
  allowed_traffic_sources_json: string | null; incentive_allowed: number;
  brand_bidding_allowed: number; direct_linking_allowed: number;
  required_disclosure: string | null; prohibited_claims_json: string | null;
  cookie_window_days: number | null; terms_source: string | null;
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
    if (r.status === 401) { window.location.href = '/login?next=/affiliate-offers'; throw new Error('unauthorized'); }
    if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 300)}`);
    return r.json() as Promise<T>;
  });
}

const statusChip = (s: string) =>
  s === 'APPROVED' ? 'chip ok'
  : s === 'PAUSED' || s === 'PENDING_REVIEW' ? 'chip warn'
  : s === 'REJECTED' || s === 'EXPIRED' ? 'chip danger'
  : 'chip muted';

const parseList = (j: string | null): string[] => {
  if (!j) return [];
  try { const v = JSON.parse(j); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
};

export default function AffiliateOffersPage() {
  const [offers, setOffers] = useState<OfferRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [detail, setDetail] = useState<OfferDetail | null>(null);
  const [approveFor, setApproveFor] = useState<OfferRow | null>(null);

  const [form, setForm] = useState({
    networkName: '', advertiserName: '', offerName: '', externalOfferId: '',
    destinationUrl: '', trackingUrlTemplate: '', allowedGeos: '', blockedGeos: '',
    allowedTrafficSources: '', requiredDisclosure: '', prohibitedClaims: '',
    payoutType: '', payoutAmount: '', payoutCurrency: '',
    incentiveAllowed: false, brandBiddingAllowed: false, directLinkingAllowed: false,
  });
  const [approve, setApprove] = useState({ coldEmailAllowed: false, verifiedBy: '' });

  const reload = async () => {
    try { setOffers((await api<{ offers: OfferRow[] }>('/affiliate/offers')).offers); setError(null); }
    catch (e: any) { setError(e.message); }
  };
  useEffect(() => { reload(); }, []);

  const csv = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

  const submitCreate = async () => {
    setError(null);
    try {
      await api('/affiliate/offers', {
        method: 'POST',
        body: JSON.stringify({
          networkName: form.networkName, advertiserName: form.advertiserName, offerName: form.offerName,
          externalOfferId: form.externalOfferId || null,
          destinationUrl: form.destinationUrl || null,
          trackingUrlTemplate: form.trackingUrlTemplate || null,
          allowedGeos: csv(form.allowedGeos), blockedGeos: csv(form.blockedGeos),
          allowedTrafficSources: csv(form.allowedTrafficSources),
          requiredDisclosure: form.requiredDisclosure || null,
          prohibitedClaims: csv(form.prohibitedClaims),
          payoutType: form.payoutType || null,
          payoutAmount: form.payoutAmount ? Number(form.payoutAmount) : null,
          payoutCurrency: form.payoutCurrency || null,
          incentiveAllowed: form.incentiveAllowed, brandBiddingAllowed: form.brandBiddingAllowed,
          directLinkingAllowed: form.directLinkingAllowed,
        }),
      });
      setShowCreate(false); setNotice('Offer created as DRAFT.'); reload();
    } catch (e: any) { setError(e.message); }
  };

  const submitApprove = async () => {
    if (!approveFor) return;
    setError(null);
    try {
      await api(`/affiliate/offers/${approveFor.id}/approve`, {
        method: 'POST',
        body: JSON.stringify({ coldEmailAllowed: approve.coldEmailAllowed, termsVerified: true, verifiedBy: approve.verifiedBy }),
      });
      setApproveFor(null); setApprove({ coldEmailAllowed: false, verifiedBy: '' });
      setNotice(`Offer #${approveFor.id} approved.`); reload();
    } catch (e: any) { setError(e.message); }
  };

  const setStatus = async (id: number, status: 'PAUSED' | 'REJECTED') => {
    setError(null);
    try { await api(`/affiliate/offers/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) }); setNotice(`Offer #${id} → ${status}.`); reload(); }
    catch (e: any) { setError(e.message); }
  };

  const openDetail = async (id: number) => {
    try { setDetail((await api<{ offer: OfferDetail }>(`/affiliate/offers/${id}`)).offer); }
    catch (e: any) { setError(e.message); }
  };

  return (
    <AppShell pageKey="affiliateOffers">
      <div className="between" style={{ marginBottom: 16 }}>
        <div>
          <h1>Affiliate offers</h1>
          <p className="muted">Registry, terms verification and approval. Approval is required before an offer can ever be used for email.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowCreate((v) => !v)}>New offer</button>
      </div>

      {error && <div className="notice danger" style={{ marginBottom: 12 }}>{error}</div>}
      {notice && <div className="notice ok" style={{ marginBottom: 12 }}>{notice}</div>}

      {showCreate && (
        <div className="panel" style={{ marginBottom: 16 }}>
          <div className="panel-h">Create offer (lands in DRAFT)</div>
          <div style={{ padding: 16 }}>
            <div className="row">
              <div className="field-group"><label>Network *</label><input value={form.networkName} onChange={(e) => setForm({ ...form, networkName: e.target.value })} /></div>
              <div className="field-group"><label>Advertiser *</label><input value={form.advertiserName} onChange={(e) => setForm({ ...form, advertiserName: e.target.value })} /></div>
              <div className="field-group"><label>Offer name *</label><input value={form.offerName} onChange={(e) => setForm({ ...form, offerName: e.target.value })} /></div>
              <div className="field-group"><label>External offer id</label><input value={form.externalOfferId} onChange={(e) => setForm({ ...form, externalOfferId: e.target.value })} /></div>
            </div>
            <div className="row">
              <div className="field-group"><label>Destination URL</label><input value={form.destinationUrl} onChange={(e) => setForm({ ...form, destinationUrl: e.target.value })} placeholder="https://…" /></div>
              <div className="field-group"><label>Tracking URL template</label><input value={form.trackingUrlTemplate} onChange={(e) => setForm({ ...form, trackingUrlTemplate: e.target.value })} placeholder="https://…" /></div>
            </div>
            <div className="row">
              <div className="field-group"><label>Allowed geos (CSV)</label><input value={form.allowedGeos} onChange={(e) => setForm({ ...form, allowedGeos: e.target.value })} placeholder="GB, US" /></div>
              <div className="field-group"><label>Blocked geos (CSV)</label><input value={form.blockedGeos} onChange={(e) => setForm({ ...form, blockedGeos: e.target.value })} /></div>
              <div className="field-group"><label>Allowed traffic sources (CSV)</label><input value={form.allowedTrafficSources} onChange={(e) => setForm({ ...form, allowedTrafficSources: e.target.value })} placeholder="email, search" /></div>
            </div>
            <div className="row">
              <div className="field-group"><label>Payout type</label><input value={form.payoutType} onChange={(e) => setForm({ ...form, payoutType: e.target.value })} placeholder="CPA / RevShare" /></div>
              <div className="field-group"><label>Payout amount</label><input value={form.payoutAmount} onChange={(e) => setForm({ ...form, payoutAmount: e.target.value })} type="number" /></div>
              <div className="field-group"><label>Payout currency</label><input value={form.payoutCurrency} onChange={(e) => setForm({ ...form, payoutCurrency: e.target.value })} placeholder="USD" maxLength={3} /></div>
            </div>
            <div className="field-group"><label>Required disclosure</label><input value={form.requiredDisclosure} onChange={(e) => setForm({ ...form, requiredDisclosure: e.target.value })} placeholder="This is an advertisement." /></div>
            <div className="field-group"><label>Prohibited claims (CSV)</label><input value={form.prohibitedClaims} onChange={(e) => setForm({ ...form, prohibitedClaims: e.target.value })} placeholder="guaranteed income, risk free" /></div>
            <div className="cluster" style={{ marginTop: 8 }}>
              <label><input type="checkbox" checked={form.incentiveAllowed} onChange={(e) => setForm({ ...form, incentiveAllowed: e.target.checked })} /> Incentive allowed</label>
              <label><input type="checkbox" checked={form.brandBiddingAllowed} onChange={(e) => setForm({ ...form, brandBiddingAllowed: e.target.checked })} /> Brand bidding allowed</label>
              <label><input type="checkbox" checked={form.directLinkingAllowed} onChange={(e) => setForm({ ...form, directLinkingAllowed: e.target.checked })} /> Direct linking allowed</label>
            </div>
            <div className="cluster" style={{ marginTop: 12 }}>
              <button className="btn btn-primary" onClick={submitCreate}>Create</button>
              <button className="btn btn-ghost" onClick={() => setShowCreate(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      <div className="panel">
        <div className="panel-h">Offers ({offers.length})</div>
        {offers.length === 0 ? <div className="empty">No offers yet.</div> : (
          <table>
            <thead><tr><th>Offer</th><th>Network</th><th>Advertiser</th><th>Status</th><th>Cold email</th><th>Payout</th><th>Terms verified</th><th></th></tr></thead>
            <tbody>
              {offers.map((o) => (
                <tr key={o.id}>
                  <td><a href="#" onClick={(e) => { e.preventDefault(); openDetail(o.id); }}>{o.offer_name}</a><br /><span className="muted">#{o.id} {o.external_offer_id || ''}</span></td>
                  <td>{o.network_name}</td>
                  <td>{o.advertiser_name}</td>
                  <td><span className={statusChip(o.status)}>{o.status}</span></td>
                  <td>{o.cold_email_allowed ? <span className="chip ok">yes</span> : <span className="chip muted">no</span>}</td>
                  <td>{o.payout_amount != null ? `${o.payout_amount} ${o.payout_currency || ''} ${o.payout_type ? `(${o.payout_type})` : ''}` : '—'}</td>
                  <td>{o.terms_verified_at ? <>{new Date(o.terms_verified_at).toLocaleDateString()}<br /><span className="muted">{o.terms_verified_by}</span></> : <span className="chip warn">unverified</span>}</td>
                  <td>
                    <div className="cluster">
                      {o.status !== 'APPROVED' && <button className="btn btn-primary" onClick={() => setApproveFor(o)}>Approve</button>}
                      {o.status === 'APPROVED' && <button className="btn btn-ghost" onClick={() => setStatus(o.id, 'PAUSED')}>Pause</button>}
                      {o.status !== 'REJECTED' && <button className="btn btn-danger" onClick={() => setStatus(o.id, 'REJECTED')}>Reject</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {approveFor && (
        <div className="panel" style={{ marginTop: 16 }}>
          <div className="panel-h">Approve offer #{approveFor.id} — {approveFor.offer_name}</div>
          <div style={{ padding: 16 }}>
            <div className="notice warn" style={{ marginBottom: 12 }}>
              Approval stamps terms verification and lets this offer be used for cold email. It does not send anything.
            </div>
            <label style={{ display: 'block', marginBottom: 8 }}>
              <input type="checkbox" checked={approve.coldEmailAllowed} onChange={(e) => setApprove({ ...approve, coldEmailAllowed: e.target.checked })} />
              {' '}I confirm cold email is permitted for this offer (required)
            </label>
            <div className="field-group"><label>Verified by *</label><input value={approve.verifiedBy} onChange={(e) => setApprove({ ...approve, verifiedBy: e.target.value })} placeholder="Your name" /></div>
            <div className="cluster" style={{ marginTop: 12 }}>
              <button className="btn btn-primary" disabled={!approve.coldEmailAllowed || !approve.verifiedBy} onClick={submitApprove}>Confirm approval</button>
              <button className="btn btn-ghost" onClick={() => setApproveFor(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {detail && (
        <div className="panel" style={{ marginTop: 16 }}>
          <div className="panel-h between"><span>Offer #{detail.id} — {detail.offer_name}</span><button className="btn btn-ghost" onClick={() => setDetail(null)}>Close</button></div>
          <div style={{ padding: 16 }}>
            <dl className="kv">
              <dt>Status</dt><dd><span className={statusChip(detail.status)}>{detail.status}</span> {detail.cold_email_allowed ? <span className="chip ok">cold email OK</span> : <span className="chip muted">no cold email</span>}</dd>
              <dt>Network / advertiser</dt><dd>{detail.network_name} / {detail.advertiser_name}</dd>
              <dt>Destination URL</dt><dd>{detail.destination_url || '—'}</dd>
              <dt>Tracking template</dt><dd>{detail.tracking_url_template || '—'}</dd>
              <dt>Allowed geos</dt><dd>{parseList(detail.allowed_geos_json).join(', ') || '—'}</dd>
              <dt>Blocked geos</dt><dd>{parseList(detail.blocked_geos_json).join(', ') || '—'}</dd>
              <dt>Traffic sources</dt><dd>{parseList(detail.allowed_traffic_sources_json).join(', ') || '—'}</dd>
              <dt>Permissions</dt><dd>
                {detail.incentive_allowed ? <span className="chip info">incentive</span> : null}{' '}
                {detail.brand_bidding_allowed ? <span className="chip info">brand bidding</span> : null}{' '}
                {detail.direct_linking_allowed ? <span className="chip info">direct linking</span> : null}
                {!detail.incentive_allowed && !detail.brand_bidding_allowed && !detail.direct_linking_allowed ? '—' : null}
              </dd>
              <dt>Required disclosure</dt><dd>{detail.required_disclosure || '—'}</dd>
              <dt>Prohibited claims</dt><dd>{parseList(detail.prohibited_claims_json).join(', ') || '—'}</dd>
              <dt>Payout</dt><dd>{detail.payout_amount != null ? `${detail.payout_amount} ${detail.payout_currency || ''} (${detail.payout_type || '—'})` : '—'}{detail.cookie_window_days != null ? `, cookie ${detail.cookie_window_days}d` : ''}</dd>
              <dt>Terms verified</dt><dd>{detail.terms_verified_at ? `${new Date(detail.terms_verified_at).toLocaleString()} by ${detail.terms_verified_by}` : 'unverified'}</dd>
              <dt>Terms source</dt><dd>{detail.terms_source || '—'}</dd>
            </dl>
          </div>
        </div>
      )}
    </AppShell>
  );
}
