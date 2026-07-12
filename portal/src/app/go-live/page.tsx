'use client';

// Phase 22E — Go-Live Wizard / First Outreach Control Center.
// Operator-first. Shows what is ready, blocked, and the exact next step.
// Lead step = SELECT EXISTING Warehouse leads only. NO discovery, NO mass send,
// NO send-all button. "Create safe first queue" makes pending_review items only.
// Fully i18n via useT (en/ru/uk).
import { useEffect, useState } from 'react';
import { AppShell } from '../../components/AppShell';
import { useT } from '@/lib/useT';

function getToken(): string {
  if (typeof document === 'undefined') return '';
  return document.cookie.split('; ').find(c => c.startsWith('token='))?.split('=')[1] ?? '';
}
function authHeaders() { return { authorization: `Bearer ${getToken()}`, 'content-type': 'application/json' }; }
async function api(path: string, method = 'GET', body?: any) {
  const r = await fetch(`/api${path}`, { method, headers: authHeaders(), body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (r.status === 401 && typeof window !== 'undefined') {
    window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname);
  }
  return { ok: r.ok, status: r.status, json };
}

const card: React.CSSProperties = { border: '1px solid #ddd', borderRadius: 8, padding: 14, marginTop: 12 };
const btn: React.CSSProperties = { padding: '6px 12px', cursor: 'pointer', borderRadius: 6, border: '1px solid #bbb', background: '#fff' };
const btnPrimary: React.CSSProperties = { ...btn, background: '#1d4ed8', color: '#fff', borderColor: '#1d4ed8' };

const PILL_COLOR: Record<string, { bg: string; fg: string }> = {
  ready: { bg: '#dcfce7', fg: '#15803d' },
  needs_action: { bg: '#fef9c3', fg: '#a16207' },
  blocked: { bg: '#fee2e2', fg: '#b91c1c' },
};
function Yn({ v }: { v: boolean }) {
  return <span style={{ color: v ? '#15803d' : '#b91c1c', fontWeight: 700 }}>{v ? '✔' : '✘'}</span>;
}

export default function GoLivePage() {
  const t = useT();
  const [d, setD] = useState<any>(null);
  const [loadErr, setLoadErr] = useState(false);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [dry, setDry] = useState<any>(null);
  const [plan, setPlan] = useState<any>(null);
  const [source, setSource] = useState<'existing_warehouse' | 'manual'>('existing_warehouse');
  const [emails, setEmails] = useState('');

  const Pill = ({ s }: { s: string }) => {
    const c = PILL_COLOR[s] ?? { bg: '#e5e7eb', fg: '#374151' };
    return <span style={{ background: c.bg, color: c.fg, borderRadius: 12, padding: '2px 10px', fontSize: 12, fontWeight: 700 }}>{t(`goLive.pill.${s}`)}</span>;
  };

  const load = async () => {
    try {
      const r = await api('/go-live/status');
      if (r.ok && r.json) { setD(r.json); setLoadErr(false); }
      else setLoadErr(true);
    } catch { setLoadErr(true); }
  };
  useEffect(() => { load(); }, []);

  const selectionBody = () => source === 'manual'
    ? { source: 'manual', emails: emails.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean) }
    : { source: 'existing_warehouse' };

  const runDryRun = async () => {
    setBusy(true); setMsg('');
    const r = await api('/go-live/dry-run', 'POST', selectionBody());
    setDry(r.json); setBusy(false);
    setMsg(r.ok ? '' : t('goLive.dryFail') + JSON.stringify(r.json));
  };
  const runPlan = async () => {
    setBusy(true); setMsg('');
    const r = await api('/go-live/plan', 'POST', { dayNumber: 1 });
    setPlan(r.json); setBusy(false);
  };
  const createQueue = async () => {
    if (!confirm(t('goLive.confirmCreate'))) return;
    setBusy(true); setMsg('');
    const r = await api('/go-live/create-first-queue', 'POST', { ...selectionBody(), acknowledge: true });
    setBusy(false);
    if (r.ok) { setMsg(t('goLive.createdMsg').replace('{n}', r.json.inserted).replace('{a}', r.json.assigned)); load(); }
    else setMsg(t('goLive.blockedMsg') + (r.json?.detail || r.json?.error || JSON.stringify(r.json)));
  };

  if (!d) return <AppShell pageKey="goLive" pageTitle={t('goLive.pageTitle')}><div style={{ padding: 16 }}>{loadErr ? t('goLive.loadError') : t('goLive.loading')}</div></AppShell>;

  const rd = d.readiness ?? {};
  const scoreColor = rd.score >= 70 ? '#15803d' : rd.score >= 40 ? '#b45309' : '#b91c1c';

  return (
    <AppShell pageKey="goLive" pageTitle={t('goLive.pageTitle')}>
      <div style={{ maxWidth: 1040, margin: '0 auto', padding: 16 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700 }}>{t('goLive.heading')}</h1>
        <p style={{ color: '#92400e', fontWeight: 600, fontSize: 14 }}>{t('goLive.intro')}</p>
        {msg && <p style={{ color: '#1d4ed8', whiteSpace: 'pre-wrap' }}>{msg}</p>}

        {/* Readiness score + status */}
        <div style={{ ...card, display: 'flex', gap: 20, alignItems: 'center', background: '#f8fafc' }}>
          <div style={{ textAlign: 'center', minWidth: 110 }}>
            <div style={{ fontSize: 44, fontWeight: 800, color: scoreColor }}>{rd.score}</div>
            <div style={{ fontSize: 12, color: '#666' }}>{t('goLive.readinessOf100')}</div>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{t(`goLive.status.${rd.status}`)}</div>
            <div style={{ marginTop: 6, padding: 8, background: '#eff6ff', borderRadius: 6 }}>
              <b>{t('goLive.nextStep')}</b> {rd.nextAction}
            </div>
            {rd.topBlockers?.length > 0 && (
              <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 13 }}>
                {rd.topBlockers.map((b: any, i: number) => (
                  <li key={i}>{b.text} {b.href && <a href={b.href} style={{ color: '#1d4ed8' }}>→ {t('goLive.open')}</a>}</li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Today */}
        <div style={card}>
          <h3 style={{ margin: 0 }}>{t('goLive.today')}</h3>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 8, fontSize: 13 }}>
            <span>{t('goLive.activeMailboxes')}: <b>{d.today.activeMailboxes}</b></span>
            <span>{t('goLive.safeDay1')}: <b>{d.today.recommendedDay1}</b></span>
            <span>{t('goLive.sentToday')}: <b>{d.today.sentToday}</b></span>
            <span style={{ color: d.today.remainingToday === 0 ? '#b45309' : '#15803d' }}>{t('goLive.remaining')}: <b>{d.today.remainingToday}</b></span>
            <span>{t('goLive.queueReady')}: <b>{d.today.queueReady}</b></span>
            <span>{t('goLive.pending')}: <b>{d.today.queuePending}</b></span>
            <span>{t('goLive.followupsDue')}: <b>{d.today.followupsDue}</b></span>
            <span>{t('goLive.repliesToReview')}: <b>{d.today.repliesToReview}</b></span>
          </div>
        </div>

        {/* 7-step checklist */}
        <h3 style={{ marginTop: 20 }}>{t('goLive.checklist')}</h3>
        {d.steps.map((s: any, i: number) => (
          <div key={s.key} style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <b>{t('goLive.step')} {i + 1} — {t(`goLive.steps.${s.key}`)}</b>
              <Pill s={s.status} />
            </div>
            <div style={{ marginTop: 8, fontSize: 13, color: '#374151', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              {Object.entries(s.checks).map(([k, v]) => (
                <span key={k}><Yn v={!!v} /> {t(`goLive.checks.${k}`)}</span>
              ))}
            </div>
            {s.key === 'select_leads' && (
              <div style={{ marginTop: 8, fontSize: 13 }}>
                <div>{t('goLive.eligibleLeads')}: <b>{s.detail.eligibleExistingTotal}</b> ({t('goLive.presetShort')}: <b>{s.detail.eligibleClientsHelpPreset}</b>)</div>
                <div style={{ color: '#666' }}>{t('goLive.recommendedFirst')}: <b>{s.detail.recommendedFirstSelection}</b></div>
                <div style={{ color: '#92400e', marginTop: 4 }}>{s.detail.note}</div>
              </div>
            )}
            {s.fix && <div style={{ marginTop: 8, fontSize: 13, color: '#b45309' }}>→ {s.fix.text} {s.fix.href && <a href={s.fix.href} style={{ color: '#1d4ed8' }}>{t('goLive.open')}</a>}</div>}
          </div>
        ))}

        {/* Step 3 actions — select existing leads */}
        <div style={{ ...card, background: '#f8fafc' }}>
          <h3 style={{ margin: 0 }}>{t('goLive.panelTitle')}</h3>
          <p style={{ fontSize: 13, color: '#666' }}>{t('goLive.panelDesc')}</p>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <label><input type="radio" checked={source === 'existing_warehouse'} onChange={() => setSource('existing_warehouse')} /> {t('goLive.srcWarehouse')}</label>
            <label><input type="radio" checked={source === 'manual'} onChange={() => setSource('manual')} /> {t('goLive.srcManual')}</label>
          </div>
          {source === 'manual' && (
            <textarea value={emails} onChange={e => setEmails(e.target.value)} placeholder={t('goLive.manualPlaceholder')}
              style={{ width: '100%', minHeight: 70, marginTop: 8, fontFamily: 'monospace', fontSize: 12 }} />
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <button style={btn} disabled={busy} onClick={runDryRun}>{t('goLive.btnPreview')}</button>
            <button style={btn} disabled={busy} onClick={runPlan}>{t('goLive.btnPlan')}</button>
            <button style={btnPrimary} disabled={busy} onClick={createQueue}>{t('goLive.btnCreate')}</button>
          </div>
          <p style={{ fontSize: 12, color: '#b91c1c', marginTop: 6 }}>{t('goLive.noSendAll')}</p>
        </div>

        {/* Plan output */}
        {plan && (
          <div style={card}>
            <h3 style={{ margin: 0 }}>{t('goLive.planTitle')}</h3>
            <div style={{ fontSize: 13 }}>{t('goLive.safeTotalToday')}: <b>{plan.safeRecommendedTotal}</b> · {t('goLive.warmupHint')}: <b>{plan.warmupSuggested}/{t('goLive.perMailbox')}</b></div>
            <table style={{ fontSize: 13, marginTop: 6, borderCollapse: 'collapse' }}>
              <tbody>{plan.allocation.map((a: any, i: number) => (
                <tr key={i}><td style={{ paddingRight: 14 }}>{a.mailbox}</td><td>{a.healthStatus}</td><td style={{ paddingLeft: 14 }}><b>{a.recommendedToday}</b></td></tr>
              ))}</tbody>
            </table>
            {plan.warnings?.length > 0 && <ul style={{ color: '#b45309', fontSize: 13 }}>{plan.warnings.map((w: string, i: number) => <li key={i}>{w}</li>)}</ul>}
            <ol style={{ fontSize: 13 }}>{plan.nextActions.map((n: string, i: number) => <li key={i}>{n}</li>)}</ol>
          </div>
        )}

        {/* Dry run output */}
        {dry && (
          <div style={card}>
            <h3 style={{ margin: 0 }}>{t('goLive.dryRunTitle')} — {dry.source}</h3>
            <div style={{ fontSize: 13 }}>
              {t('goLive.template')}: <b>{dry.template ? dry.template.key + (dry.template.approved ? ` (${t('goLive.approved')})` : ` (${t('goLive.notApproved')})`) : t('goLive.noApproved')}</b> ·
              {t('goLive.wouldQueue')}: <b>{dry.wouldQueueCount}</b> · {t('goLive.blocked')}: <b>{dry.blockedCount}</b>
            </div>
            {dry.warnings?.length > 0 && <ul style={{ color: '#b45309', fontSize: 13 }}>{dry.warnings.map((w: string, i: number) => <li key={i}>{w}</li>)}</ul>}
            <table style={{ fontSize: 12, marginTop: 6, borderCollapse: 'collapse', width: '100%' }}>
              <thead><tr style={{ textAlign: 'left', color: '#666' }}><th>{t('goLive.colEmail')}</th><th>{t('goLive.colCompany')}</th><th>{t('goLive.colCountry')}</th><th>{t('goLive.colMailbox')}</th><th>{t('goLive.colMissing')}</th></tr></thead>
              <tbody>{dry.wouldQueue.map((r: any, i: number) => (
                <tr key={i} style={{ borderTop: '1px solid #eee' }}>
                  <td>{r.email}</td><td>{r.company}</td><td>{r.country}</td><td>{r.mailbox ?? '—'}</td><td style={{ color: '#b45309' }}>{r.missingFields.join(', ')}</td>
                </tr>
              ))}</tbody>
            </table>
            <p style={{ fontSize: 12, color: '#15803d', marginTop: 6 }}>{dry.note}</p>
          </div>
        )}

        {/* Clients.Help preset + safety footer */}
        <div style={{ ...card, background: '#f0fdf4', borderColor: '#bbf7d0' }}>
          <b>{t('goLive.presetTitle')}</b> {t('goLive.firstSelection')} {d.clientsHelpPreset.firstSelectionSize}, {t('goLive.day1Cap')} {d.clientsHelpPreset.day1Cap},
          {' '}{t('goLive.target')} {d.clientsHelpPreset.target}; {t('goLive.industries')}: {d.clientsHelpPreset.industries.join(', ')}.
        </div>
        <div style={{ fontSize: 12, color: '#666', marginTop: 12 }}>
          {t('goLive.safetyLabel')} — {t('goLive.realSent')}: <b>{d.safety.realEmailsSent}</b> · {t('goLive.prodSmtp')}: <b>{d.safety.productionSmtpEnabled ? t('goLive.yes') : t('goLive.no')}</b> ·
          {' '}{t('goLive.campaignsScheduled')}: <b>{d.safety.campaignScheduled}</b> · {t('goLive.sendAllBtn')}: <b>{t('goLive.no')}</b> · {t('goLive.discovery')}: <b>{t('goLive.no')}</b>.
        </div>
      </div>
    </AppShell>
  );
}
