'use client';

// Phase 18 — Cohort Builder + ESP Export (operator-controlled, no send).
import { useEffect, useState } from 'react';
import { AppShell } from '../../../components/AppShell';
import { useT } from '@/lib/useT';

function getToken(): string {
  if (typeof document === 'undefined') return '';
  return document.cookie.split('; ').find(c => c.startsWith('token='))?.split('=')[1] ?? '';
}
function authHeaders() { return { authorization: `Bearer ${getToken()}`, 'content-type': 'application/json' }; }
function on401(status: number) {
  if (status === 401 && typeof window !== 'undefined') {
    window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname);
  }
}

type Filters = {
  industry: string; country: string; city: string; productFit: string;
  roleType: string; sourceProvider: string; hasWebsite: string; minScore: string; maxAgeDays: string;
};
const EMPTY: Filters = { industry: '', country: '', city: '', productFit: '', roleType: '', sourceProvider: '', hasWebsite: '', minScore: '', maxAgeDays: '' };

function cleanFilters(f: Filters): Record<string, any> {
  const out: Record<string, any> = {};
  if (f.industry) out.industry = f.industry;
  if (f.country) out.country = f.country.toUpperCase().slice(0, 2);
  if (f.city) out.city = f.city;
  if (f.productFit) out.productFit = f.productFit;
  if (f.roleType) out.roleType = f.roleType;
  if (f.sourceProvider) out.sourceProvider = f.sourceProvider;
  if (f.hasWebsite) out.hasWebsite = f.hasWebsite === 'yes';
  if (f.minScore) out.minScore = parseInt(f.minScore, 10);
  if (f.maxAgeDays) out.maxAgeDays = parseInt(f.maxAgeDays, 10);
  return out;
}

export default function CohortsPage() {
  const t = useT();
  const [f, setF] = useState<Filters>(EMPTY);
  const [preview, setPreview] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);
  const [format, setFormat] = useState('csv');
  const [limit, setLimit] = useState(100);
  const [ack, setAck] = useState(false);
  const [msg, setMsg] = useState('');
  const set = (k: keyof Filters) => (e: any) => setF({ ...f, [k]: e.target.value });

  async function runPreview() {
    setLoading(true); setMsg('');
    try {
      const r = await fetch('/api/warehouse/cohorts/preview', { method: 'POST', headers: authHeaders(), body: JSON.stringify(cleanFilters(f)) });
      on401(r.status);
      setPreview(r.ok ? await r.json() : null);
      if (!r.ok) setMsg(t('warehouseCohorts.previewFailed'));
    } finally { setLoading(false); }
  }

  async function download(url: string, body: any | null, fallbackName: string) {
    setMsg('');
    const r = await fetch(url, { method: body ? 'POST' : 'GET', headers: authHeaders(), body: body ? JSON.stringify(body) : undefined });
    on401(r.status);
    if (!r.ok) { setMsg(t('warehouseCohorts.exportBlocked') + (await r.text())); return; }
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fallbackName;
    a.click();
    setMsg(t('warehouseCohorts.downloaded').replace('{n}', fallbackName));
  }

  function exportCohort() {
    if (!ack) { setMsg(t('warehouseCohorts.ackRequired')); return; }
    download('/api/warehouse/cohorts/export', { ...cleanFilters(f), format, limit, acknowledge: true }, `cohort_${format}.csv`);
  }

  return (
    <AppShell pageKey="warehouse" pageTitle={t('warehouseCohorts.pageTitle')}>
      <div style={{ maxWidth: 1000, margin: '0 auto', padding: 16 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700 }}>{t('warehouseCohorts.heading')}</h1>
        <p style={{ color: '#b91c1c', fontWeight: 600 }}>
          {t('warehouseCohorts.warning')}
        </p>

        <section style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8, margin: '12px 0' }}>
          <input placeholder={t('warehouseCohorts.phIndustry')} value={f.industry} onChange={set('industry')} />
          <input placeholder={t('warehouseCohorts.phCountry')} value={f.country} onChange={set('country')} />
          <input placeholder={t('warehouseCohorts.phCity')} value={f.city} onChange={set('city')} />
          <input placeholder={t('warehouseCohorts.phProductFit')} value={f.productFit} onChange={set('productFit')} />
          <input placeholder={t('warehouseCohorts.phRoleType')} value={f.roleType} onChange={set('roleType')} />
          <input placeholder={t('warehouseCohorts.phSourceProvider')} value={f.sourceProvider} onChange={set('sourceProvider')} />
          <select value={f.hasWebsite} onChange={set('hasWebsite')}>
            <option value="">{t('warehouseCohorts.websiteAny')}</option><option value="yes">{t('warehouseCohorts.websiteHas')}</option><option value="no">{t('warehouseCohorts.websiteNo')}</option>
          </select>
          <input placeholder={t('warehouseCohorts.phMinScore')} value={f.minScore} onChange={set('minScore')} />
          <input placeholder={t('warehouseCohorts.phMaxAgeDays')} value={f.maxAgeDays} onChange={set('maxAgeDays')} />
        </section>
        <button onClick={runPreview} disabled={loading} style={{ padding: '8px 16px' }}>{loading ? t('warehouseCohorts.loading') : t('warehouseCohorts.previewCohort')}</button>

        {preview && (
          <section style={{ marginTop: 16, border: '1px solid #ddd', borderRadius: 8, padding: 12 }}>
            <div style={{ display: 'flex', gap: 24, fontSize: 15 }}>
              <span>{t('warehouseCohorts.matched')} <b>{preview.matched}</b></span>
              <span style={{ color: '#15803d' }}>{t('warehouseCohorts.eligible')} <b>{preview.eligible}</b></span>
              <span style={{ color: '#b91c1c' }}>{t('warehouseCohorts.blocked')} <b>{preview.blocked}</b></span>
            </div>
            <div style={{ fontSize: 13, color: '#555', marginTop: 6 }}>
              {t('warehouseCohorts.blockedReasons')} {Object.entries(preview.blockedReasons).map(([k, v]) => `${k}=${v}`).join(' · ')}
            </div>
            <div style={{ fontSize: 13, marginTop: 6 }}>
              {t('warehouseCohorts.country')} {preview.breakdowns.byCountry.map((x: any) => `${x.k ?? '∅'}:${x.c}`).join('  ')}
            </div>
            <div style={{ fontSize: 13 }}>
              {t('warehouseCohorts.role')} {preview.breakdowns.byRole.map((x: any) => `${x.k ?? '∅'}:${x.c}`).join('  ')}
            </div>
            <div style={{ fontSize: 13 }}>
              {t('warehouseCohorts.source')} {preview.breakdowns.bySource.map((x: any) => `${x.k ?? '∅'}:${x.c}`).join('  ')}
            </div>
            <p style={{ fontSize: 12, color: '#666' }}>{t('warehouseCohorts.recommendedFirstExport')} {preview.recommendedFirstExport} · {t('warehouseCohorts.maxExport')} {preview.maxExport}</p>
            <details>
              <summary>{t('warehouseCohorts.sampleSummary')}</summary>
              <pre style={{ fontSize: 11, overflow: 'auto', maxHeight: 260 }}>{JSON.stringify(preview.sample, null, 1)}</pre>
            </details>

            <hr style={{ margin: '12px 0' }} />
            <h3 style={{ fontWeight: 700 }}>{t('warehouseCohorts.exportToEsp')}</h3>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <select value={format} onChange={e => setFormat(e.target.value)}>
                <option value="csv">{t('warehouseCohorts.formatGenericCsv')}</option>
                <option value="instantly">Instantly</option>
                <option value="smartlead">Smartlead</option>
                <option value="lemlist">Lemlist</option>
              </select>
              <input type="number" min={1} max={500} value={limit} onChange={e => setLimit(Math.min(500, parseInt(e.target.value || '1', 10)))} style={{ width: 90 }} />
            </div>
            <label style={{ display: 'block', margin: '8px 0', fontSize: 13 }}>
              <input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} />{' '}
              {t('warehouseCohorts.ackLabel')}
            </label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button onClick={exportCohort} style={{ padding: '8px 16px' }}>{t('warehouseCohorts.exportCohortCsv')}</button>
              <button onClick={() => download('/api/warehouse/suppression-export', null, 'suppression.csv')}>{t('warehouseCohorts.downloadSuppression')}</button>
              <button onClick={() => download('/api/warehouse/bounce-check/export', { ...cleanFilters(f), limit: 1000 }, 'bounce_check.csv')}>{t('warehouseCohorts.exportBounceCheck')}</button>
            </div>
          </section>
        )}
        {msg && <p style={{ marginTop: 12, color: '#1d4ed8' }}>{msg}</p>}
      </div>
    </AppShell>
  );
}
