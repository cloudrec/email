'use client';

import { useEffect, useState } from 'react';
import { useLocaleClient } from '../../components/useLocaleClient';
import { t } from '../../lib/t';

type Profile = {
  id: number;
  name: string;
  product_url: string | null;
  description: string;
  target_customer: string | null;
  key_benefits: string[] | string | null;
  allowed_claims: string[] | string | null;
  forbidden_claims: string[] | string | null;
  preferred_tone: 'neutral' | 'friendly' | 'professional' | 'short_direct';
  default_language: 'en' | 'ru' | 'uk';
  is_default: number;
};

type Job = {
  id: number;
  target_url: string;
  target_domain: string;
  status: string;
  pages_fetched: number;
  language: string;
  started_at: string | null;
  finished_at: string | null;
};

type Result = {
  id: number;
  job_id: number;
  company_name: string | null;
  industry: string | null;
  business_type: string | null;
  offering_summary: string | null;
  pain_points: string[] | string | null;
  relevance_reason: string | null;
  relevance_warning: string | null;
  contact_emails: string[] | string | null;
  source_urls: string[] | string | null;
  page_titles: string[] | string | null;
  confidence_score: number;
  target_url: string;
  target_domain: string;
};

type Draft = {
  id: number;
  status: string;
  language: string;
  tone: string;
  confidence_score: number | null;
  subject_options: string[] | string | null;
  created_at: string;
  approved_at: string | null;
  rejected_at: string | null;
  rejection_reason: string | null;
};

type DraftDetail = Draft & {
  email_short: string;
  email_long: string;
  follow_up: string | null;
  personalization_points: string[] | string | null;
  risks_or_uncertainties: string[] | string | null;
  cited_facts: string[] | string | null;
  version_no: number;
  generator: string;
};

function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = typeof document !== 'undefined'
    ? document.cookie.split('; ').find((c) => c.startsWith('token='))?.split('=')[1]
    : '';
  const tenantId = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('tenantId')
    : null;
  return fetch(`/api${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(tenantId ? { 'x-tenant-id': tenantId } : {}),
      ...(init?.headers ?? {}),
    },
  }).then(async (r) => {
    if (r.status === 401) {
      if (typeof window !== 'undefined') window.location.href = '/login?next=/outreach';
      throw new Error('unauthorized');
    }
    if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json() as Promise<T>;
  });
}

function asArray(v: any): string[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } }
  return [];
}

export default function OutreachPage() {
  const locale = useLocaleClient();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profileForm, setProfileForm] = useState({
    name: '', productUrl: '', description: '', targetCustomer: '',
    keyBenefits: '', allowedClaims: '', forbiddenClaims: '',
    preferredTone: 'neutral' as Profile['preferred_tone'],
    defaultLanguage: 'en' as Profile['default_language'],
    isDefault: true,
  });
  const [jobs, setJobs] = useState<Job[]>([]);
  const [analysisForm, setAnalysisForm] = useState({ targetUrl: '', language: 'en' });
  const [activeResult, setActiveResult] = useState<Result | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [activeDraft, setActiveDraft] = useState<DraftDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testEmail, setTestEmail] = useState('');
  const [confirmCompliance, setConfirmCompliance] = useState(false);

  const refresh = async () => {
    try {
      const [pr, j, d] = await Promise.all([
        api<{ profiles: Profile[] }>('/product-profiles'),
        api<{ jobs: Job[] }>('/website-analysis/jobs'),
        api<{ drafts: Draft[] }>('/outreach/drafts'),
      ]);
      setProfiles(pr.profiles); setJobs(j.jobs); setDrafts(d.drafts);
      setError(null);
    } catch (e: any) { setError(e.message); }
  };
  useEffect(() => { refresh(); const id = setInterval(refresh, 10000); return () => clearInterval(id); }, []);

  const saveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api('/product-profiles', {
        method: 'POST',
        body: JSON.stringify({
          name: profileForm.name,
          productUrl: profileForm.productUrl || null,
          description: profileForm.description,
          targetCustomer: profileForm.targetCustomer || null,
          keyBenefits: profileForm.keyBenefits.split('\n').map((x) => x.trim()).filter(Boolean),
          allowedClaims: profileForm.allowedClaims.split('\n').map((x) => x.trim()).filter(Boolean),
          forbiddenClaims: profileForm.forbiddenClaims.split('\n').map((x) => x.trim()).filter(Boolean),
          preferredTone: profileForm.preferredTone,
          defaultLanguage: profileForm.defaultLanguage,
          isDefault: profileForm.isDefault,
        }),
      });
      setProfileForm({ ...profileForm, name: '', description: '' });
      refresh();
    } catch (e: any) { setError(e.message); }
  };

  const runAnalysis = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const p = profiles.find((p) => p.is_default) ?? profiles[0];
      await api('/website-analysis/jobs', {
        method: 'POST',
        body: JSON.stringify({
          targetUrl: analysisForm.targetUrl,
          productProfileId: p?.id,
          language: analysisForm.language,
        }),
      });
      setAnalysisForm({ ...analysisForm, targetUrl: '' });
      refresh();
    } catch (e: any) { setError(e.message); }
  };

  const viewResult = async (jobId: number) => {
    try {
      const r = await api<Result>(`/website-analysis/results-by-job/${jobId}`);
      setActiveResult(r);
      setActiveDraft(null);
    } catch (e: any) { setError(e.message); }
  };

  const generateDraft = async () => {
    if (!activeResult) return;
    const p = profiles.find((p) => p.is_default) ?? profiles[0];
    if (!p) return setError(t(locale, 'outreach.errProductProfileRequired'));
    try {
      const r = await api<{ draftId: number }>('/outreach/drafts/generate', {
        method: 'POST',
        body: JSON.stringify({
          analysisResultId: activeResult.id,
          productProfileId: p.id,
          language: activeResult.target_url ? (activeResult as any).language ?? 'en' : 'en',
          tone: p.preferred_tone,
          provider: 'internal',
        }),
      });
      await openDraft(r.draftId);
      refresh();
    } catch (e: any) { setError(e.message); }
  };

  const openDraft = async (id: number) => {
    try {
      const r = await api<{ draft: DraftDetail; events: any[] }>(`/outreach/drafts/${id}`);
      setActiveDraft(r.draft);
      setActiveResult(null);
    } catch (e: any) { setError(e.message); }
  };

  const approveDraft = async () => {
    if (!activeDraft) return;
    if (!confirmCompliance) { setError(t(locale, 'outreach.errComplianceRequired')); return; }
    try {
      await api(`/outreach/drafts/${activeDraft.id}/approve`, { method: 'POST' });
      await openDraft(activeDraft.id);
      refresh();
    } catch (e: any) { setError(e.message); }
  };

  const rejectDraft = async () => {
    if (!activeDraft) return;
    const reason = prompt(t(locale, 'outreach.editor.rejectReason'));
    try {
      await api(`/outreach/drafts/${activeDraft.id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) });
      await openDraft(activeDraft.id);
      refresh();
    } catch (e: any) { setError(e.message); }
  };

  const sendTest = async () => {
    if (!activeDraft || !testEmail) return;
    try {
      await api(`/outreach/drafts/${activeDraft.id}/send-test`, { method: 'POST', body: JSON.stringify({ to: testEmail }) });
      await openDraft(activeDraft.id);
      refresh();
    } catch (e: any) { setError(e.message); }
  };

  return (
    <div>
      <div className="card">
        <h1>{t(locale, 'outreach.title')}</h1>
        <p>{t(locale, 'outreach.subtitle')}</p>
        <p className="badge warn" style={{ padding: 10, display: 'block', marginTop: 12 }}>
          ⚠ {t(locale, 'outreach.honestyBanner')}
        </p>
      </div>

      {/* Product profile */}
      <div className="card">
        <h2>{t(locale, 'outreach.productProfile.title')}</h2>
        {profiles.length === 0 ? <p>{t(locale, 'outreach.productProfile.empty')}</p> : (
          <ul style={{ paddingLeft: 18 }}>
            {profiles.map((p) => (
              <li key={p.id}>
                <b>{p.name}</b> — {p.product_url ?? '—'} {p.is_default ? '★' : ''}
              </li>
            ))}
          </ul>
        )}
        <details style={{ marginTop: 12 }}>
          <summary>{t(locale, 'outreach.productProfile.create')}</summary>
          <form onSubmit={saveProfile} style={{ marginTop: 12 }}>
            <label>{t(locale, 'outreach.productProfile.name')}</label>
            <input value={profileForm.name} onChange={(e) => setProfileForm({ ...profileForm, name: e.target.value })} required />
            <label>{t(locale, 'outreach.productProfile.url')}</label>
            <input type="url" value={profileForm.productUrl} onChange={(e) => setProfileForm({ ...profileForm, productUrl: e.target.value })} />
            <label>{t(locale, 'outreach.productProfile.description')}</label>
            <textarea rows={3} value={profileForm.description} onChange={(e) => setProfileForm({ ...profileForm, description: e.target.value })} required />
            <label>{t(locale, 'outreach.productProfile.targetCustomer')}</label>
            <input value={profileForm.targetCustomer} onChange={(e) => setProfileForm({ ...profileForm, targetCustomer: e.target.value })} />
            <label>{t(locale, 'outreach.productProfile.keyBenefits')}</label>
            <textarea rows={3} value={profileForm.keyBenefits} onChange={(e) => setProfileForm({ ...profileForm, keyBenefits: e.target.value })} />
            <label>{t(locale, 'outreach.productProfile.allowedClaims')}</label>
            <textarea rows={3} value={profileForm.allowedClaims} onChange={(e) => setProfileForm({ ...profileForm, allowedClaims: e.target.value })} />
            <label>{t(locale, 'outreach.productProfile.forbiddenClaims')}</label>
            <textarea rows={3} value={profileForm.forbiddenClaims} onChange={(e) => setProfileForm({ ...profileForm, forbiddenClaims: e.target.value })} />
            <div className="row">
              <div>
                <label>{t(locale, 'outreach.productProfile.preferredTone')}</label>
                <select value={profileForm.preferredTone} onChange={(e) => setProfileForm({ ...profileForm, preferredTone: e.target.value as any })}>
                  <option value="neutral">{t(locale, 'outreach.tone.neutral')}</option>
                  <option value="friendly">{t(locale, 'outreach.tone.friendly')}</option>
                  <option value="professional">{t(locale, 'outreach.tone.professional')}</option>
                  <option value="short_direct">{t(locale, 'outreach.tone.short_direct')}</option>
                </select>
              </div>
              <div>
                <label>{t(locale, 'outreach.productProfile.defaultLanguage')}</label>
                <select value={profileForm.defaultLanguage} onChange={(e) => setProfileForm({ ...profileForm, defaultLanguage: e.target.value as any })}>
                  <option value="en">EN</option><option value="ru">RU</option><option value="uk">UK</option>
                </select>
              </div>
            </div>
            <p style={{ marginTop: 12 }}>
              <button className="btn" type="submit">{t(locale, 'outreach.productProfile.save')}</button>
            </p>
          </form>
        </details>
      </div>

      {/* Analysis */}
      <div className="card">
        <h2>{t(locale, 'outreach.analysis.title')}</h2>
        <form onSubmit={runAnalysis} style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <div style={{ flex: 1 }}>
            <label>{t(locale, 'outreach.analysis.targetUrl')}</label>
            <input type="url" value={analysisForm.targetUrl} onChange={(e) => setAnalysisForm({ ...analysisForm, targetUrl: e.target.value })} required />
          </div>
          <div>
            <label>{t(locale, 'outreach.analysis.language')}</label>
            <select value={analysisForm.language} onChange={(e) => setAnalysisForm({ ...analysisForm, language: e.target.value })}>
              <option value="en">EN</option><option value="ru">RU</option><option value="uk">UK</option>
            </select>
          </div>
          <button className="btn" type="submit" disabled={!profiles.length}>{t(locale, 'outreach.analysis.run')}</button>
        </form>

        <h3 style={{ marginTop: 16 }}>{t(locale, 'outreach.analysis.jobsTitle')}</h3>
        {jobs.length === 0 ? <p>{t(locale, 'outreach.analysis.empty')}</p> : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th align="left">{t(locale, 'outreach.analysis.targetUrl')}</th>
                <th align="left">{t(locale, 'outreach.analysis.status')}</th>
                <th align="right">{t(locale, 'outreach.analysis.pagesFetched')}</th>
                <th align="left">{t(locale, 'outreach.analysis.finished')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id} style={{ borderTop: '1px solid #eef0f5' }}>
                  <td style={{ padding: '4px' }}>{j.target_url}</td>
                  <td><span className={`badge ${j.status === 'succeeded' ? 'ok' : j.status === 'failed' ? 'fail' : 'pending'}`}>{j.status}</span></td>
                  <td align="right">{j.pages_fetched}</td>
                  <td>{j.finished_at ?? '—'}</td>
                  <td>{j.status === 'succeeded' && (
                    <button className="btn btn-ghost" onClick={() => viewResult(j.id)}>{t(locale, 'outreach.analysis.viewResult')}</button>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Active analysis result */}
      {activeResult && (
        <div className="card">
          <h2>{t(locale, 'outreach.result.title')} — {activeResult.target_domain}</h2>
          <p><b>{t(locale, 'outreach.result.companyName')}:</b> {activeResult.company_name ?? '—'}</p>
          <p><b>{t(locale, 'outreach.result.industry')}:</b> {activeResult.industry ?? '—'}</p>
          <p><b>{t(locale, 'outreach.result.businessType')}:</b> {activeResult.business_type ?? '—'}</p>
          <p><b>{t(locale, 'outreach.result.offering')}:</b> {activeResult.offering_summary ?? '—'}</p>
          <p><b>{t(locale, 'outreach.result.painPoints')}:</b></p>
          <ul>{asArray(activeResult.pain_points).map((p, i) => <li key={i}>{p}</li>)}</ul>
          <p><b>{t(locale, 'outreach.result.relevanceReason')}:</b> {activeResult.relevance_reason ?? '—'}</p>
          {activeResult.relevance_warning && (
            <p className="badge warn" style={{ padding: 10, display: 'block' }}>⚠ {activeResult.relevance_warning}</p>
          )}
          <p><b>{t(locale, 'outreach.result.confidence')}:</b> {activeResult.confidence_score}/100</p>
          <p><b>{t(locale, 'outreach.result.contactEmails')}:</b> {asArray(activeResult.contact_emails).join(', ') || '—'}</p>
          <p><b>{t(locale, 'outreach.result.sourceUrls')}:</b></p>
          <ul>{asArray(activeResult.source_urls).map((u, i) => <li key={i}><a href={u} target="_blank" rel="noreferrer noopener">{u}</a></li>)}</ul>
          <button className="btn" onClick={generateDraft} disabled={!profiles.length}>
            {t(locale, 'outreach.result.generate')}
          </button>
        </div>
      )}

      {/* Drafts list */}
      <div className="card">
        <h2>{t(locale, 'outreach.drafts.title')}</h2>
        {drafts.length === 0 ? <p>{t(locale, 'outreach.drafts.empty')}</p> : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th align="left">{t(locale, 'outreach.drafts.id')}</th>
                <th align="left">{t(locale, 'outreach.drafts.subject')}</th>
                <th align="left">{t(locale, 'outreach.drafts.status')}</th>
                <th align="right">{t(locale, 'outreach.drafts.confidence')}</th>
                <th align="left">{t(locale, 'outreach.drafts.language')}</th>
                <th align="left">{t(locale, 'outreach.drafts.createdAt')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {drafts.map((d) => (
                <tr key={d.id} style={{ borderTop: '1px solid #eef0f5' }}>
                  <td>{d.id}</td>
                  <td>{asArray(d.subject_options)[0] ?? '—'}</td>
                  <td><span className={`badge ${d.status === 'approved' ? 'ok' : d.status === 'rejected' ? 'fail' : 'pending'}`}>
                    {t(locale, `outreach.drafts.status${d.status.charAt(0).toUpperCase()}${d.status.slice(1).replace(/_(\w)/g, (_, c) => c.toUpperCase())}`)}
                  </span></td>
                  <td align="right">{d.confidence_score ?? '—'}</td>
                  <td>{d.language}</td>
                  <td>{d.created_at}</td>
                  <td><button className="btn btn-ghost" onClick={() => openDraft(d.id)}>{t(locale, 'outreach.drafts.open')}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Draft detail / editor */}
      {activeDraft && (
        <div className="card">
          <h2>{t(locale, 'outreach.editor.title')} — #{activeDraft.id} (v{activeDraft.version_no})</h2>
          <p className="badge pending" style={{ padding: 8, display: 'inline-block' }}>
            {t(locale, 'outreach.editor.approvalRequired')}
          </p>
          {(activeDraft.confidence_score ?? 0) < 40 && (
            <p className="badge warn" style={{ padding: 10, display: 'block', marginTop: 8 }}>
              ⚠ {t(locale, 'outreach.editor.lowConfidence')}
            </p>
          )}
          <p><b>{t(locale, 'outreach.drafts.confidence')}:</b> {activeDraft.confidence_score}/100 · <b>{t(locale, 'outreach.drafts.tone')}:</b> {activeDraft.tone} · <b>{t(locale, 'outreach.drafts.language')}:</b> {activeDraft.language}</p>

          <label>{t(locale, 'outreach.editor.subjectOptions')}</label>
          <ul>{asArray(activeDraft.subject_options).map((s, i) => <li key={i}>{s}</li>)}</ul>

          <label>{t(locale, 'outreach.editor.emailShort')}</label>
          <pre style={{ background: '#f8f9fc', padding: 10, whiteSpace: 'pre-wrap' }}>{activeDraft.email_short}</pre>

          <label>{t(locale, 'outreach.editor.emailLong')}</label>
          <pre style={{ background: '#f8f9fc', padding: 10, whiteSpace: 'pre-wrap' }}>{activeDraft.email_long}</pre>

          {activeDraft.follow_up && (
            <>
              <label>{t(locale, 'outreach.editor.followUp')}</label>
              <pre style={{ background: '#f8f9fc', padding: 10, whiteSpace: 'pre-wrap' }}>{activeDraft.follow_up}</pre>
            </>
          )}

          <label>{t(locale, 'outreach.editor.personalizationPoints')}</label>
          <ul>{asArray(activeDraft.personalization_points).map((p, i) => <li key={i}>{p}</li>)}</ul>

          <label>{t(locale, 'outreach.editor.risks')}</label>
          <ul>{asArray(activeDraft.risks_or_uncertainties).map((r, i) => <li key={i}>{r}</li>)}</ul>

          <div style={{ borderTop: '1px solid #e5e9f2', marginTop: 16, paddingTop: 16 }}>
            <label>
              <input type="checkbox" checked={confirmCompliance} onChange={(e) => setConfirmCompliance(e.target.checked)} />
              {' '}{t(locale, 'outreach.editor.confirmCompliance')}
            </label>
            <p style={{ marginTop: 12 }}>
              <button className="btn" onClick={approveDraft} disabled={activeDraft.status === 'approved' || !confirmCompliance}>
                {t(locale, 'outreach.editor.approve')}
              </button>
              {' '}
              <button className="btn btn-ghost" onClick={rejectDraft}>
                {t(locale, 'outreach.editor.reject')}
              </button>
            </p>

            <label>{t(locale, 'outreach.editor.sendTestTo')}</label>
            <input type="email" value={testEmail} onChange={(e) => setTestEmail(e.target.value)} />
            <p style={{ marginTop: 8 }}>
              <button className="btn btn-ghost" onClick={sendTest} disabled={!testEmail}>
                {t(locale, 'outreach.editor.sendTest')}
              </button>
            </p>
          </div>
        </div>
      )}

      {error && <div className="card"><p style={{ color: '#a31818' }}>{error}</p></div>}
      <span data-marker="SYSTEM_READY_PHASE12_VISIBLE" style={{display:'none'}}>SYSTEM_READY_PHASE12_VISIBLE</span>
    </div>
  );
}
