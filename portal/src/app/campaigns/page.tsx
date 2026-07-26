'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '../../components/AppShell';
import { useLocaleClient } from '../../components/useLocaleClient';
import { t } from '../../lib/t';

type Campaign = {
  id: number; uuid: string; name: string; subject: string; status: string;
  scheduled_at: string | null; total_recipients: number;
  sent_count: number; opened_count: number; clicked_count: number; bounced_count: number; created_at: string;
  // Engine fields (TZ §17) — read-only surface; all nullable on legacy campaigns.
  campaign_mode?: string | null; lifecycle_state?: string | null;
  affiliate_offer_id?: number | null; mode_owner?: string | null; max_send_volume?: number | null;
};
type SenderIdentity = { id: number; from_email: string; from_name: string; domain: string; domain_status: string; is_default: number; };
type CList = { id: number; name: string; contact_count: number; };

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
    if (r.status === 401) { window.location.href = '/login?next=/campaigns'; throw new Error('unauthorized'); }
    if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 300)}`);
    return r.json() as Promise<T>;
  });
}

const statusColor = (s: string) =>
  s === 'sent' ? 'chip ok' : s === 'sending' || s === 'scheduled' ? 'chip warn' : 'chip muted';

export default function CampaignsPage() {
  const locale = useLocaleClient();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [identities, setIdentities] = useState<SenderIdentity[]>([]);
  const [lists, setLists] = useState<CList[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showIdForm, setShowIdForm] = useState(false);
  const [showListForm, setShowListForm] = useState(false);
  const [smtpState, setSmtpState] = useState<string | null>(null);
  const [testTarget, setTestTarget] = useState<number | null>(null);
  const [testEmail, setTestEmail] = useState('');
  const [testResult, setTestResult] = useState('');

  // Create campaign form
  const [form, setForm] = useState({
    name: '', subject: '', preheader: '', htmlBody: '', textBody: '',
    senderIdentityId: '', listId: '',
  });
  // Create sender identity form
  const [idForm, setIdForm] = useState({ fromEmail: '', fromName: '', domainId: '', replyTo: '' });
  const [domains, setDomains] = useState<{ id: number; domain: string; status: string }[]>([]);
  // Create list form
  const [listForm, setListForm] = useState({ name: '', industry: '', country: '', productFit: '', contactType: 'email', minScore: '0' });
  const [listConfirmed, setListConfirmed] = useState(false);
  const [listPreview, setListPreview] = useState<{ eligible?: number; wouldImport?: number } | null>(null);

  const reload = async () => {
    try {
      const [ca, id, li] = await Promise.all([
        api<{ campaigns: Campaign[] }>('/campaigns'),
        api<{ identities: SenderIdentity[] }>('/sender-identities'),
        api<{ lists: CList[] }>('/contacts/lists'),
      ]);
      setCampaigns(ca.campaigns);
      setIdentities(id.identities);
      setLists(li.lists);
      setError(null);
    } catch (e: any) { setError(e.message); }
    // Fetch SMTP state (super admin only; ignore failure for regular tenants)
    try {
      const s = await api<{ state: string }>('/system/smtp-status');
      setSmtpState(s.state ?? null);
    } catch { /* non-admin — leave null */ }
  };
  const loadDomains = async () => {
    try { const r = await api<{ domains: any[] }>('/domains'); setDomains(r.domains); } catch {}
  };

  useEffect(() => { reload(); }, []);

  const createCampaign = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api('/campaigns', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name, subject: form.subject, preheader: form.preheader || undefined,
          htmlBody: form.htmlBody, textBody: form.textBody || undefined,
          senderIdentityId: parseInt(form.senderIdentityId, 10),
          listId: parseInt(form.listId, 10),
        }),
      });
      setShowCreate(false);
      setForm({ name: '', subject: '', preheader: '', htmlBody: '', textBody: '', senderIdentityId: '', listId: '' });
      reload();
    } catch (e: any) { setError(e.message); }
  };

  const createIdentity = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api('/sender-identities', {
        method: 'POST',
        body: JSON.stringify({
          fromEmail: idForm.fromEmail, fromName: idForm.fromName,
          domainId: parseInt(idForm.domainId, 10),
          replyTo: idForm.replyTo || undefined, isDefault: true,
        }),
      });
      setShowIdForm(false);
      setIdForm({ fromEmail: '', fromName: '', domainId: '', replyTo: '' });
      reload();
    } catch (e: any) { setError(e.message); }
  };

  const previewList = async () => {
    try {
      const r = await api<any>('/contacts/lists/from-warehouse', {
        method: 'POST',
        body: JSON.stringify({
          name: listForm.name || 'preview',
          industry: listForm.industry || undefined,
          country: listForm.country || undefined,
          productFit: listForm.productFit || undefined,
          contactType: listForm.contactType || 'email',
          minScore: parseInt(listForm.minScore, 10) || 0,
          dryRun: true,
        }),
      });
      setListPreview(r);
    } catch (e: any) { setError(e.message); }
  };

  const createList = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!listForm.name) return;
    if (!listConfirmed) { setError(t(locale, 'campaigns.confirmComplianceFirst')); return; }
    try {
      const r = await api<any>('/contacts/lists/from-warehouse', {
        method: 'POST',
        body: JSON.stringify({
          name: listForm.name,
          industry: listForm.industry || undefined,
          country: listForm.country || undefined,
          productFit: listForm.productFit || undefined,
          contactType: listForm.contactType || 'email',
          minScore: parseInt(listForm.minScore, 10) || 0,
          dryRun: false, limit: 500,
        }),
      });
      setShowListForm(false);
      setListForm({ name: '', industry: '', country: '', productFit: '', contactType: 'email', minScore: '0' });
      setListConfirmed(false);
      setListPreview(null);
      reload();
      setError(null);
      alert(t(locale, 'campaigns.listCreatedAlert').replace('{n}', String(r.imported)).replace('{b}', String(r.blocked)));
    } catch (e: any) { setError(e.message); }
  };

  const schedule = async (id: number) => {
    try { await api(`/campaigns/${id}/schedule`, { method: 'POST', body: '{}' }); reload(); }
    catch (e: any) { setError(e.message); }
  };
  const pause = async (id: number) => {
    try { await api(`/campaigns/${id}/pause`, { method: 'POST', body: '{}' }); reload(); }
    catch (e: any) { setError(e.message); }
  };
  const cancel = async (id: number) => {
    if (!confirm(t(locale, 'campaigns.confirmCancel'))) return;
    try { await api(`/campaigns/${id}/cancel`, { method: 'POST', body: '{}' }); reload(); }
    catch (e: any) { setError(e.message); }
  };
  const sendTest = async () => {
    if (!testTarget || !testEmail) return;
    try {
      await api(`/campaigns/${testTarget}/test`, { method: 'POST', body: JSON.stringify({ to: testEmail }) });
      setTestResult(t(locale, 'campaigns.testQueued'));
    } catch (e: any) { setTestResult(t(locale, 'campaigns.errorPrefix').replace('{m}', e.message)); }
  };

  const inp = (style?: React.CSSProperties): React.CSSProperties => ({
    padding: '7px 10px', border: '1px solid var(--line)', borderRadius: 6,
    fontSize: 13, background: 'var(--surface)', color: 'var(--ink)', width: '100%',
    boxSizing: 'border-box', ...style,
  });

  const verifiedDomains = domains.filter(d => d.status === 'verified');
  const hasVerifiedIdentity = identities.some(i => i.domain_status === 'verified');

  return (
    <AppShell pageKey="campaigns" pageTitle={t(locale, 'campaigns.title')}
      actions={
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={() => { setShowIdForm(v => !v); loadDomains(); }}>
            + {t(locale, 'campaigns.senderIdentity')}
          </button>
          <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={() => setShowListForm(v => !v)}>
            + {t(locale, 'campaigns.listFromWarehouse')}
          </button>
          <button className="btn btn-primary" style={{ fontSize: 13 }} onClick={() => setShowCreate(v => !v)}>
            {t(locale, 'campaigns.create')}
          </button>
        </div>
      }
    >
      <span data-marker="SYSTEM_READY_PHASE12_VISIBLE" style={{display:'none'}}>SYSTEM_READY_PHASE12_VISIBLE</span>

      {smtpState === 'test_only_mailhog' && (
        <div style={{ background: 'var(--surface-sunken)', border: '1px solid var(--warn)', borderRadius: 6, padding: '10px 14px', marginBottom: 14, fontSize: 12.5 }}>
          <strong style={{ color: 'var(--warn)' }}>{t(locale, 'campaigns.smtpMailhogTitle')}</strong> {t(locale, 'campaigns.smtpMailhogBody')}
        </div>
      )}
      {smtpState && smtpState !== 'ready' && smtpState !== 'test_only_mailhog' && (
        <div style={{ background: 'var(--surface-sunken)', border: '1px solid var(--warn)', borderRadius: 6, padding: '10px 14px', marginBottom: 14, fontSize: 12.5 }}>
          <strong style={{ color: 'var(--warn)' }}>{t(locale, 'campaigns.smtpNotReadyTitle').replace('{s}', smtpState.replace(/_/g, ' '))}</strong> {t(locale, 'campaigns.smtpNotReadyBody')}
        </div>
      )}

      <div className="chip warn" style={{ display: 'block', marginBottom: 16, fontSize: 12.5, padding: '8px 12px' }}>
        {t(locale, 'campaigns.segmentDisabled')}
      </div>

      {error && <div className="chip warn" style={{ display: 'block', marginBottom: 12 }}>{error}</div>}

      {/* Sender identity form */}
      {showIdForm && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, padding: 20, marginBottom: 16 }}>
          <h3 style={{ fontSize: 14, marginBottom: 12 }}>{t(locale, 'campaigns.createSenderIdentity')}</h3>
          <p style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 12 }}>
            {t(locale, 'campaigns.identityRequiresDomainPre')}<a href="/domains">{t(locale, 'campaigns.domainsLink')}</a>{t(locale, 'campaigns.identityRequiresDomainPost')}
          </p>
          {verifiedDomains.length === 0 && (
            <div className="chip warn" style={{ display: 'block', marginBottom: 10 }}>{t(locale, 'campaigns.noVerifiedDomains')}</div>
          )}
          <form onSubmit={createIdentity} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <label style={{ fontSize: 12, color: 'var(--ink-3)' }}>{t(locale, 'campaigns.fromEmail')}</label>
              <input style={inp()} value={idForm.fromEmail} onChange={e => setIdForm(f => ({ ...f, fromEmail: e.target.value }))} required placeholder="hello@yourdomain.com" />
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--ink-3)' }}>{t(locale, 'campaigns.fromName')}</label>
              <input style={inp()} value={idForm.fromName} onChange={e => setIdForm(f => ({ ...f, fromName: e.target.value }))} required placeholder={t(locale, 'campaigns.fromNamePlaceholder')} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--ink-3)' }}>{t(locale, 'campaigns.domain')}</label>
              <select style={inp()} value={idForm.domainId} onChange={e => setIdForm(f => ({ ...f, domainId: e.target.value }))} required>
                <option value="">{t(locale, 'campaigns.selectVerifiedDomain')}</option>
                {verifiedDomains.map(d => <option key={d.id} value={d.id}>{d.domain} ({t(locale, 'campaigns.verifiedLabel')})</option>)}
                {domains.filter(d => d.status !== 'verified').map(d => <option key={d.id} value={d.id} disabled>{d.domain} ({d.status})</option>)}
              </select>
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--ink-3)' }}>{t(locale, 'campaigns.replyToOptional')}</label>
              <input style={inp()} value={idForm.replyTo} onChange={e => setIdForm(f => ({ ...f, replyTo: e.target.value }))} placeholder="reply@yourdomain.com" />
            </div>
            <div style={{ gridColumn: '1/-1', display: 'flex', gap: 8 }}>
              <button className="btn btn-primary" type="submit" disabled={verifiedDomains.length === 0} style={{ fontSize: 13 }}>{t(locale, 'campaigns.createBtn')}</button>
              <button className="btn btn-ghost" type="button" onClick={() => setShowIdForm(false)} style={{ fontSize: 13 }}>{t(locale, 'campaigns.cancelBtn')}</button>
            </div>
          </form>
        </div>
      )}

      {/* List from warehouse form */}
      {showListForm && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, padding: 20, marginBottom: 16 }}>
          <h3 style={{ fontSize: 14, marginBottom: 12 }}>{t(locale, 'campaigns.buildListTitle')}</h3>
          <p style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 12 }}>
            {t(locale, 'campaigns.buildListDesc')}
          </p>
          <form onSubmit={createList} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 10 }}>
            <div style={{ gridColumn: '1/-1' }}>
              <label style={{ fontSize: 12, color: 'var(--ink-3)' }}>{t(locale, 'campaigns.listNameLabel')}</label>
              <input style={inp()} value={listForm.name} onChange={e => setListForm(f => ({ ...f, name: e.target.value }))} required placeholder={t(locale, 'campaigns.listNamePlaceholder')} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--ink-3)' }}>{t(locale, 'campaigns.industrySlug')}</label>
              <input style={inp()} value={listForm.industry} onChange={e => setListForm(f => ({ ...f, industry: e.target.value }))} placeholder="beauty_salon, dental_clinic…" />
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--ink-3)' }}>{t(locale, 'campaigns.countryIso2')}</label>
              <input style={inp()} value={listForm.country} onChange={e => setListForm(f => ({ ...f, country: e.target.value.toUpperCase() }))} maxLength={2} placeholder="GB, DE, UA…" />
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--ink-3)' }}>{t(locale, 'campaigns.productFitKey')}</label>
              <input style={inp()} value={listForm.productFit} onChange={e => setListForm(f => ({ ...f, productFit: e.target.value }))} placeholder="clients_help, beautybot…" />
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--ink-3)' }}>{t(locale, 'campaigns.contactType')}</label>
              <select style={inp()} value={listForm.contactType} onChange={e => setListForm(f => ({ ...f, contactType: e.target.value }))}>
                <option value="email">email</option>
                <option value="phone">phone</option>
                <option value="telegram">telegram</option>
                <option value="whatsapp">whatsapp</option>
              </select>
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--ink-3)' }}>{t(locale, 'campaigns.minScoreLabel')}</label>
              <input style={inp()} type="number" min={0} max={100} value={listForm.minScore} onChange={e => setListForm(f => ({ ...f, minScore: e.target.value }))} placeholder={t(locale, 'campaigns.minScorePlaceholder')} />
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end' }}>
              <button className="btn btn-ghost" type="button" onClick={previewList} style={{ fontSize: 13, width: '100%' }}>{t(locale, 'campaigns.previewCount')}</button>
            </div>
            {listPreview && (
              <div style={{ gridColumn: '1/-1', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 6, padding: '10px 14px', fontSize: 12.5 }}>
                <strong>{t(locale, 'campaigns.previewLabel')}</strong> {t(locale, 'campaigns.previewEligible').replace('{n}', String(listPreview.eligible))}{' '}
                {t(locale, 'campaigns.previewWouldImport').replace('{n}', String(listPreview.wouldImport))}{' '}
                {listPreview.eligible != null && listPreview.wouldImport != null && listPreview.eligible - listPreview.wouldImport > 0
                  ? <span style={{ color: 'var(--muted)' }}>{t(locale, 'campaigns.previewBlocked').replace('{n}', String(listPreview.eligible - listPreview.wouldImport))}</span>
                  : null}
              </div>
            )}
            <div style={{ gridColumn: '1/-1', borderTop: '1px solid var(--line)', paddingTop: 10, marginTop: 4 }}>
              <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5, cursor: 'pointer' }}>
                <input type="checkbox" checked={listConfirmed} onChange={e => setListConfirmed(e.target.checked)} style={{ marginTop: 2, flexShrink: 0 }} />
                <span>{t(locale, 'campaigns.complianceConfirm')}</span>
              </label>
            </div>
            <div style={{ gridColumn: '1/-1', display: 'flex', gap: 8 }}>
              <button className="btn btn-primary" type="submit" disabled={!listConfirmed} style={{ fontSize: 13 }}>{t(locale, 'campaigns.buildListBtn')}</button>
              <button className="btn btn-ghost" type="button" onClick={() => { setShowListForm(false); setListPreview(null); setListConfirmed(false); }} style={{ fontSize: 13 }}>{t(locale, 'campaigns.cancelBtn')}</button>
            </div>
          </form>
        </div>
      )}

      {/* Create campaign form */}
      {showCreate && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, padding: 20, marginBottom: 16 }}>
          <h3 style={{ fontSize: 14, marginBottom: 8 }}>{t(locale, 'campaigns.newCampaign')}</h3>
          {!hasVerifiedIdentity && (
            <div className="chip warn" style={{ display: 'block', marginBottom: 10 }}>
              {t(locale, 'campaigns.noVerifiedIdentity')}
            </div>
          )}
          {lists.length === 0 && (
            <div className="chip warn" style={{ display: 'block', marginBottom: 10 }}>
              {t(locale, 'campaigns.noRecipientLists')}
            </div>
          )}
          <form onSubmit={createCampaign} style={{ display: 'grid', gap: 10 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <label style={{ fontSize: 12, color: 'var(--ink-3)' }}>{t(locale, 'campaigns.campaignNameLabel')}</label>
                <input style={inp()} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required />
              </div>
              <div>
                <label style={{ fontSize: 12, color: 'var(--ink-3)' }}>{t(locale, 'campaigns.subjectLineLabel')}</label>
                <input style={inp()} value={form.subject} onChange={e => setForm(f => ({ ...f, subject: e.target.value }))} required />
              </div>
              <div>
                <label style={{ fontSize: 12, color: 'var(--ink-3)' }}>{t(locale, 'campaigns.senderIdentityLabel')}</label>
                <select style={inp()} value={form.senderIdentityId} onChange={e => setForm(f => ({ ...f, senderIdentityId: e.target.value }))} required>
                  <option value="">{t(locale, 'campaigns.selectEllipsis')}</option>
                  {identities.map(i => (
                    <option key={i.id} value={i.id} disabled={i.domain_status !== 'verified'}>
                      {i.from_name} &lt;{i.from_email}&gt; — {i.domain} {i.domain_status !== 'verified' ? t(locale, 'campaigns.unverifiedSuffix') : '✓'}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label style={{ fontSize: 12, color: 'var(--ink-3)' }}>{t(locale, 'campaigns.recipientListLabel')}</label>
                <select style={inp()} value={form.listId} onChange={e => setForm(f => ({ ...f, listId: e.target.value }))} required>
                  <option value="">{t(locale, 'campaigns.selectList')}</option>
                  {lists.map(l => <option key={l.id} value={l.id}>{l.name} ({t(locale, 'campaigns.contactsCount').replace('{n}', String(l.contact_count))})</option>)}
                </select>
                <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 4 }}>
                  {t(locale, 'campaigns.pendingContactsNote')}
                </div>
              </div>
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--ink-3)' }}>{t(locale, 'campaigns.preheaderOptional')}</label>
              <input style={inp()} value={form.preheader} onChange={e => setForm(f => ({ ...f, preheader: e.target.value }))} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--ink-3)' }}>{t(locale, 'campaigns.htmlBodyLabel')}</label>
              <textarea
                style={{ ...inp(), height: 200, fontFamily: 'monospace', fontSize: 12, resize: 'vertical' }}
                value={form.htmlBody}
                onChange={e => setForm(f => ({ ...f, htmlBody: e.target.value }))}
                required
                placeholder={t(locale, 'campaigns.htmlBodyPlaceholder')}
              />
              <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 4 }}>
                {t(locale, 'campaigns.unsubscribeHintPre')}<code>{'{{unsubscribe_url}}'}</code>{t(locale, 'campaigns.unsubscribeHintPost')}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-primary" type="submit" style={{ fontSize: 13 }}>{t(locale, 'campaigns.createCampaignBtn')}</button>
              <button className="btn btn-ghost" type="button" onClick={() => setShowCreate(false)} style={{ fontSize: 13 }}>{t(locale, 'campaigns.cancelBtn')}</button>
            </div>
          </form>
        </div>
      )}

      {/* Sender identities + lists summary */}
      {(identities.length > 0 || lists.length > 0) && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, padding: 14 }}>
            <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 8 }}>{t(locale, 'campaigns.senderIdentitiesHeading')}</div>
            {identities.map(i => (
              <div key={i.id} style={{ fontSize: 12, marginBottom: 4, display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ flex: 1 }}>{i.from_name} &lt;{i.from_email}&gt;</span>
                <span className={i.domain_status === 'verified' ? 'chip ok' : 'chip warn'} style={{ fontSize: 10 }}>
                  {i.domain} {i.domain_status}
                </span>
              </div>
            ))}
            {identities.length === 0 && <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>{t(locale, 'campaigns.noneYet')}</div>}
          </div>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, padding: 14 }}>
            <div style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 8 }}>{t(locale, 'campaigns.recipientListsHeading')}</div>
            {lists.map(l => (
              <div key={l.id} style={{ fontSize: 12, marginBottom: 4 }}>
                {l.name} — <strong>{l.contact_count}</strong> {t(locale, 'campaigns.contactsWord')}
              </div>
            ))}
            {lists.length === 0 && <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>{t(locale, 'campaigns.noneYetBuildWarehouse')}</div>}
          </div>
        </div>
      )}

      {/* Test send modal */}
      {testTarget !== null && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 10, padding: 24, minWidth: 340 }}>
            <div style={{ fontWeight: 600, marginBottom: 12 }}>{t(locale, 'campaigns.testSendHeading').replace('{n}', String(testTarget))}</div>
            {smtpState === 'test_only_mailhog'
              ? <div style={{ background: 'var(--surface-sunken)', border: '1px solid var(--warn)', borderRadius: 5, padding: '7px 12px', fontSize: 12, marginBottom: 10, color: 'var(--ink-2)' }}>
                  <strong style={{ color: 'var(--warn)' }}>{t(locale, 'campaigns.mailhogModeTitle')}</strong> {t(locale, 'campaigns.mailhogModeBody')}
                </div>
              : smtpState === 'ready'
              ? <div style={{ background: 'var(--surface-sunken)', border: '1px solid var(--ok)', borderRadius: 5, padding: '7px 12px', fontSize: 12, marginBottom: 10 }}>
                  <strong style={{ color: 'var(--ok)' }}>{t(locale, 'campaigns.realSmtpTitle')}</strong> {t(locale, 'campaigns.realSmtpBody')}
                </div>
              : <p style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 12 }}>{t(locale, 'campaigns.testRequiresSmtp')}</p>
            }
            <input
              type="email" placeholder="test@example.com" value={testEmail}
              onChange={e => setTestEmail(e.target.value)}
              style={{ ...inp(), marginBottom: 8 }}
            />
            {testResult && <div className="chip ok" style={{ display: 'block', marginBottom: 8 }}>{testResult}</div>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-primary" onClick={sendTest} style={{ fontSize: 13 }}>{t(locale, 'campaigns.sendTest')}</button>
              <button className="btn btn-ghost" onClick={() => { setTestTarget(null); setTestEmail(''); setTestResult(''); }} style={{ fontSize: 13 }}>{t(locale, 'campaigns.close')}</button>
            </div>
          </div>
        </div>
      )}

      {/* Campaigns table */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: '2px solid var(--line)' }}>
              {['name','subject','statusCol','recipients','sentCol','open','click','bounce','actions'].map(h => (
                <th key={h} style={{ textAlign: 'left', padding: '6px 10px', color: 'var(--ink-3)', fontWeight: 500, whiteSpace: 'nowrap' }}>{t(locale, `campaigns.col.${h}`)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {campaigns.map(c => (
              <tr key={c.id} style={{ borderBottom: '1px solid var(--line)' }}>
                <td style={{ padding: '8px 10px', fontWeight: 500 }}>
                  {c.name}
                  {c.campaign_mode && (
                    <div className="cluster" style={{ marginTop: 4, gap: 4, fontWeight: 400 }}>
                      <span className="chip info">{c.campaign_mode === 'AFFILIATE' ? 'affiliate' : 'own product'}</span>
                      {c.lifecycle_state && <span className="chip muted">{c.lifecycle_state}</span>}
                      {c.affiliate_offer_id && <span className="chip muted">offer #{c.affiliate_offer_id}</span>}
                      {c.mode_owner && <span className="chip muted">{c.mode_owner}</span>}
                      {c.max_send_volume != null && <span className="chip muted">≤{c.max_send_volume}/day</span>}
                    </div>
                  )}
                </td>
                <td style={{ padding: '8px 10px', color: 'var(--ink-3)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.subject}</td>
                <td style={{ padding: '8px 10px' }}><span className={statusColor(c.status)}>{t(locale, `campaigns.${c.status}`)}</span></td>
                <td style={{ padding: '8px 10px', textAlign: 'right' }}>{c.total_recipients}</td>
                <td style={{ padding: '8px 10px', textAlign: 'right' }}>{c.sent_count}</td>
                <td style={{ padding: '8px 10px', textAlign: 'right' }}>{c.opened_count}</td>
                <td style={{ padding: '8px 10px', textAlign: 'right' }}>{c.clicked_count}</td>
                <td style={{ padding: '8px 10px', textAlign: 'right' }}>{c.bounced_count}</td>
                <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
                  {c.status === 'draft' && (
                    <>
                      <button
                        className="btn btn-primary"
                        onClick={() => schedule(c.id)}
                        disabled={smtpState !== null && smtpState !== 'ready'}
                        title={smtpState && smtpState !== 'ready' ? t(locale, 'campaigns.smtpNotReadyTooltip').replace('{s}', smtpState.replace(/_/g, ' ')) : undefined}
                        style={{ fontSize: 11, padding: '3px 8px', marginRight: 4 }}
                      >{t(locale, 'campaigns.scheduleNow')}</button>
                      <button className="btn btn-ghost" onClick={() => { setTestTarget(c.id); }} style={{ fontSize: 11, padding: '3px 8px', marginRight: 4 }}>{t(locale, 'campaigns.test')}</button>
                      <button className="btn btn-ghost" onClick={() => cancel(c.id)} style={{ fontSize: 11, padding: '3px 8px' }}>{t(locale, 'campaigns.cancelBtn')}</button>
                    </>
                  )}
                  {(c.status === 'scheduled' || c.status === 'sending') && (
                    <button className="btn btn-ghost" onClick={() => pause(c.id)} style={{ fontSize: 11, padding: '3px 8px' }}>{t(locale, 'campaigns.pause')}</button>
                  )}
                  {c.status === 'paused' && (
                    <>
                      <button
                        className="btn btn-primary"
                        onClick={() => schedule(c.id)}
                        disabled={smtpState !== null && smtpState !== 'ready'}
                        title={smtpState && smtpState !== 'ready' ? t(locale, 'campaigns.smtpNotReadyTooltip').replace('{s}', smtpState.replace(/_/g, ' ')) : undefined}
                        style={{ fontSize: 11, padding: '3px 8px', marginRight: 4 }}
                      >{t(locale, 'campaigns.resume')}</button>
                      <button className="btn btn-ghost" onClick={() => cancel(c.id)} style={{ fontSize: 11, padding: '3px 8px' }}>{t(locale, 'campaigns.cancelBtn')}</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {campaigns.length === 0 && (
              <tr><td colSpan={9} style={{ padding: '20px 10px', color: 'var(--ink-3)', textAlign: 'center' }}>{t(locale, 'campaigns.noCampaignsYet')}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </AppShell>
  );
}
