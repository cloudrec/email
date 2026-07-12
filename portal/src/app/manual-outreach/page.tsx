'use client';

// Phase 22 — Own Outreach Runtime.
// Provider-neutral manual outreach: Today dashboard, provider setup, cohort,
// queue, reply inbox 2.0, safe follow-up tasks, warmup/health, templates with
// clear REPLACE fields. Operator-driven, one-by-one. NO bulk send, NO scheduler.
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

const TABS = ['Today', 'Setup', 'Providers', 'Cohort', 'Queue', 'Drip', 'Replies', 'Follow-ups', 'Warmup', 'Templates'] as const;
type Tab = typeof TABS[number];
const TAB_KEYS: Record<Tab, string> = {
  'Today': 'tabs.today', 'Setup': 'tabs.setup', 'Providers': 'tabs.providers', 'Cohort': 'tabs.cohort',
  'Queue': 'tabs.queue', 'Drip': 'tabs.drip', 'Replies': 'tabs.replies', 'Follow-ups': 'tabs.followups', 'Warmup': 'tabs.warmup', 'Templates': 'tabs.templates',
};

const card: React.CSSProperties = { border: '1px solid #ddd', borderRadius: 8, padding: 14, marginTop: 12 };
const btn: React.CSSProperties = { padding: '6px 12px', cursor: 'pointer', borderRadius: 6, border: '1px solid #bbb', background: '#fff' };
const btnPrimary: React.CSSProperties = { ...btn, background: '#1d4ed8', color: '#fff', borderColor: '#1d4ed8' };
const hcolor = (h: string) => h === 'safe' ? '#15803d' : h === 'warning' ? '#b45309' : '#b91c1c';

export default function ManualOutreachPage() {
  const t = useT();
  const [tab, setTab] = useState<Tab>('Today');
  const [msg, setMsg] = useState('');
  return (
    <AppShell pageKey="manualOutreach" pageTitle={t('manualOutreach.pageTitle')}>
      <div style={{ maxWidth: 1040, margin: '0 auto', padding: 16 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700 }}>{t('manualOutreach.heading')}</h1>
        <p style={{ color: '#92400e', fontWeight: 600, fontSize: 14 }}>
          {t('manualOutreach.intro')}
        </p>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '12px 0' }}>
          {TABS.map(tb => (
            <button key={tb} onClick={() => { setTab(tb); setMsg(''); }}
              style={tab === tb ? btnPrimary : btn}>{t('manualOutreach.' + TAB_KEYS[tb])}</button>
          ))}
        </div>
        {msg && <p style={{ color: '#1d4ed8', whiteSpace: 'pre-wrap' }}>{msg}</p>}
        {tab === 'Today' && <TodayTab setMsg={setMsg} />}
        {tab === 'Setup' && <SetupTab setMsg={setMsg} />}
        {tab === 'Providers' && <ProvidersTab setMsg={setMsg} />}
        {tab === 'Cohort' && <CohortTab setMsg={setMsg} />}
        {tab === 'Queue' && <QueueTab setMsg={setMsg} />}
        {tab === 'Drip' && <DripTab setMsg={setMsg} />}
        {tab === 'Replies' && <RepliesTab setMsg={setMsg} />}
        {tab === 'Follow-ups' && <FollowupsTab setMsg={setMsg} />}
        {tab === 'Warmup' && <WarmupTab setMsg={setMsg} />}
        {tab === 'Templates' && <TemplatesTab setMsg={setMsg} />}
      </div>
    </AppShell>
  );
}

function DripTab({ setMsg }: { setMsg: (s: string) => void }) {
  const t = useT();
  const [d, setD] = useState<any>(null);
  const [f, setF] = useState<any>(null);
  const load = async () => {
    const r = await api('/manual-outreach/drip');
    if (r.ok) { setD(r.json); setF(r.json.settings); }
  };
  useEffect(() => { load(); const i = setInterval(load, 20000); return () => clearInterval(i); }, []);
  if (!d || !f) return <div style={card}>{t('manualOutreach.common.loading') || '…'}</div>;
  const setK = (k: string, v: any) => setF((s: any) => ({ ...s, [k]: v }));
  const saveConfig = async () => {
    const r = await api('/manual-outreach/drip', 'POST', {
      daily_per_mailbox: Number(f.daily_per_mailbox), hourly_per_mailbox: Number(f.hourly_per_mailbox),
      min_interval_min: Number(f.min_interval_min), window_start_hour: Number(f.window_start_hour), window_end_hour: Number(f.window_end_hour),
    });
    setMsg(r.ok ? t('manualOutreach.drip.saved') : t('manualOutreach.common.failed') + JSON.stringify(r.json)); load();
  };
  const enable = async () => {
    if (typeof window !== 'undefined' && !window.confirm(t('manualOutreach.drip.confirmEnable'))) return;
    const r = await api('/manual-outreach/drip', 'POST', { enabled: true, confirm: true });
    setMsg(r.ok ? t('manualOutreach.drip.enabled') : t('manualOutreach.common.blockedPrefix') + JSON.stringify(r.json)); load();
  };
  const disable = async () => {
    const r = await api('/manual-outreach/drip', 'POST', { enabled: false });
    setMsg(r.ok ? t('manualOutreach.drip.disabled') : t('manualOutreach.common.failed')); load();
  };
  const s = d.snapshot;
  const on = f.enabled;
  return (
    <div>
      <div style={{ ...card, background: on ? '#ecfdf5' : '#fff7ed', borderColor: on ? '#6ee7b7' : '#fdba74' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <b style={{ fontSize: 16 }}>{t('manualOutreach.drip.title')}</b>
            <div style={{ fontSize: 13, marginTop: 2 }}>
              {t('manualOutreach.drip.state')}: <b style={{ color: on ? '#15803d' : '#b45309' }}>{on ? t('manualOutreach.drip.running') : t('manualOutreach.drip.off')}</b>
            </div>
          </div>
          {on
            ? <button style={{ ...btn, color: '#b91c1c', borderColor: '#fca5a5' }} onClick={disable}>{t('manualOutreach.drip.btnDisable')}</button>
            : <button style={btnPrimary} onClick={enable}>{t('manualOutreach.drip.btnEnable')}</button>}
        </div>
        <p style={{ fontSize: 12, color: '#7c2d12', margin: '8px 0 0' }}>{t('manualOutreach.drip.warn')}</p>
      </div>

      <div style={card}>
        <b>{t('manualOutreach.drip.snapshot')}</b>
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 8, fontSize: 13 }}>
          <div><b style={{ fontSize: 20 }}>{s.ready}</b><div style={{ color: '#888' }}>{t('manualOutreach.drip.ready')}</div></div>
          <div><b style={{ fontSize: 20 }}>{s.sent_today}</b><div style={{ color: '#888' }}>{t('manualOutreach.drip.sentToday')}</div></div>
          <div><b style={{ fontSize: 20 }}>{s.active_mailboxes}</b><div style={{ color: '#888' }}>{t('manualOutreach.drip.activeMb')}</div></div>
          <div><b style={{ fontSize: 20 }}>{s.unassigned}</b><div style={{ color: '#888' }}>{t('manualOutreach.drip.unassigned')}</div></div>
        </div>
        {s.unassigned > 0 && <p style={{ fontSize: 12, color: '#b45309', marginTop: 6 }}>{t('manualOutreach.drip.unassignedHint')}</p>}
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8, fontSize: 12 }}>
          <thead><tr>
            <th style={{ textAlign: 'left', color: '#666', padding: 4 }}>{t('manualOutreach.drip.mailbox')}</th>
            <th style={{ textAlign: 'left', color: '#666', padding: 4 }}>{t('manualOutreach.drip.colSentToday')}</th>
            <th style={{ textAlign: 'left', color: '#666', padding: 4 }}>{t('manualOutreach.drip.colQueued')}</th>
            <th style={{ textAlign: 'left', color: '#666', padding: 4 }}>{t('manualOutreach.drip.colCaps')}</th>
          </tr></thead>
          <tbody>
            {(s.mailboxes || []).map((m: any) => (
              <tr key={m.id}><td style={{ padding: 4 }}>{m.from_email}</td><td style={{ padding: 4 }}>{m.sent_today}</td>
                <td style={{ padding: 4 }}>{m.approved_assigned}</td><td style={{ padding: 4 }}>{m.daily_send_limit}/d · {m.hourly_send_limit}/h</td></tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={card}>
        <b>{t('manualOutreach.drip.config')}</b>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 8 }}>
          {[['hourly_per_mailbox', t('manualOutreach.drip.hourly')], ['daily_per_mailbox', t('manualOutreach.drip.daily')],
            ['min_interval_min', t('manualOutreach.drip.interval')], ['window_start_hour', t('manualOutreach.drip.winStart')],
            ['window_end_hour', t('manualOutreach.drip.winEnd')]].map(([k, lbl]) => (
            <div key={k}><label style={{ fontSize: 11, color: '#555', display: 'block' }}>{lbl}</label>
              <input style={{ padding: '6px 8px', border: '1px solid #ccc', borderRadius: 6, width: 80 }} value={f[k] ?? ''} onChange={e => setK(k, e.target.value)} /></div>
          ))}
          <div style={{ alignSelf: 'flex-end' }}><button style={btnPrimary} onClick={saveConfig}>{t('manualOutreach.drip.btnSave')}</button></div>
        </div>
        <p style={{ fontSize: 11, color: '#888', marginTop: 6 }}>{t('manualOutreach.drip.configHint')}</p>
      </div>
    </div>
  );
}

function TodayTab({ setMsg }: { setMsg: (s: string) => void }) {
  const t = useT();
  const [d, setD] = useState<any>(null);
  const [email, setEmail] = useState('');
  const [why, setWhy] = useState<any>(null);
  const load = async () => { const r = await api('/manual-outreach/today'); setD(r.json); };
  useEffect(() => { load(); }, []);
  const checkWhy = async () => { const r = await api(`/manual-outreach/why-blocked?email=${encodeURIComponent(email)}`); setWhy(r.json); setMsg(r.ok ? '' : t('manualOutreach.today.lookupFailed') + JSON.stringify(r.json)); };
  if (!d) return <p>{t('manualOutreach.common.loading')}</p>;
  const stat = (label: string, val: any, color?: string) => (
    <div style={{ ...card, marginTop: 0, minWidth: 120, flex: '1 1 120px' }}>
      <div style={{ fontSize: 24, fontWeight: 700, color: color ?? '#111' }}>{val}</div>
      <div style={{ fontSize: 12, color: '#666' }}>{label}</div>
    </div>
  );
  return (
    <div>
      <div style={{ ...card, background: '#eff6ff', borderColor: '#bfdbfe' }}>
        <b>{t('manualOutreach.today.nextAction')}</b> {d.nextRecommendedAction}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
        {stat(t('manualOutreach.today.allowedToday'), d.allowedToday)}
        {stat(t('manualOutreach.today.sentToday'), d.sentManuallyToday)}
        {stat(t('manualOutreach.today.remaining'), d.remainingToday, d.remainingToday === 0 ? '#b45309' : '#15803d')}
        {stat(t('manualOutreach.today.repliesToday'), d.repliesToday)}
        {stat(t('manualOutreach.today.interested'), d.interestedReplies, '#15803d')}
        {stat(t('manualOutreach.today.negative'), d.negativeReplies, '#b45309')}
        {stat(t('manualOutreach.today.bounceLike'), d.bounceLikeToday, d.bounceLikeToday ? '#b91c1c' : undefined)}
        {stat(t('manualOutreach.today.suppressionsToday'), d.suppressionsToday)}
        {stat(t('manualOutreach.today.followupsDue'), d.followupsDueToday)}
        {stat(t('manualOutreach.today.followupsBlocked'), d.followupsBlocked)}
        {stat(t('manualOutreach.today.queueReady'), d.queueReady)}
        {stat(t('manualOutreach.today.queuePending'), d.queuePending)}
        {stat(t('manualOutreach.today.queueBlocked'), d.queueBlocked, d.queueBlocked ? '#b91c1c' : undefined)}
      </div>
      <div style={card}>
        <b>{t('manualOutreach.today.mailboxHealth')}</b>
        {(d.mailboxHealth || []).map((m: any) => (
          <div key={m.mailboxId} style={{ fontSize: 13, marginTop: 4 }}>
            {m.email} · <span style={{ color: hcolor(m.health) }}>{m.health}</span> · {m.used}/{m.limit} · {m.status}
          </div>
        ))}
        {(!d.mailboxHealth || !d.mailboxHealth.length) && <p style={{ fontSize: 13, color: '#666' }}>{t('manualOutreach.today.noMailbox')}</p>}
      </div>
      <div style={card}>
        <b>{t('manualOutreach.today.whyBlockedTitle')}</b>
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          <input placeholder={t('manualOutreach.today.emailPlaceholder')} value={email} onChange={e => setEmail(e.target.value)} style={{ flex: 1 }} />
          <button style={btn} onClick={checkWhy}>{t('manualOutreach.today.check')}</button>
        </div>
        {why && (
          <div style={{ marginTop: 8, fontSize: 13 }}>
            <b style={{ color: why.blocked ? '#b91c1c' : '#15803d' }}>{why.blocked ? t('manualOutreach.today.blocked') : t('manualOutreach.today.contactable')}</b>
            {why.reasons?.length > 0 && <> — {why.reasons.join(', ')}</>}
            <div style={{ color: '#666', fontSize: 12 }}>{why.note}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function SetupTab({ setMsg }: { setMsg: (s: string) => void }) {
  const t = useT();
  const [s, setS] = useState<any>(null);
  const load = async () => { const r = await api('/manual-outreach/zoho/status'); setS(r.json); };
  useEffect(() => { load(); }, []);
  const connect = async () => { const r = await api('/manual-outreach/zoho/connect', 'POST', {}); setMsg(r.ok ? t('manualOutreach.setup.connected') : t('manualOutreach.setup.connectFailed') + JSON.stringify(r.json)); load(); };
  const test = async (kind: 'smtp' | 'imap') => {
    const r = await api(`/manual-outreach/zoho/test-${kind}`, 'POST', {});
    setMsg(`${kind.toUpperCase()} ${t('manualOutreach.setup.testLabel')}: ${r.json?.ok ? t('manualOutreach.common.ok') : t('manualOutreach.common.failed')} — ${r.json?.detail ?? ''} (${r.json?.note ?? ''})`);
    load();
  };
  if (!s) return <p>{t('manualOutreach.common.loading')}</p>;
  return (
    <div style={card}>
      <h3 style={{ fontWeight: 700 }}>{t('manualOutreach.setup.title')}</h3>
      <p>{t('manualOutreach.setup.bridgeStatus')} <b>{s.bridgeStatus}</b> · {t('manualOutreach.setup.copyPasteMode')} <b style={{ color: '#15803d' }}>{t('manualOutreach.setup.alwaysAvailable')}</b></p>
      <p style={{ fontSize: 13, color: '#555' }}>
        {t('manualOutreach.setup.setTheseIn')} <code>/opt/email/.env</code> {t('manualOutreach.setup.valuesNeverShown')}<br />
        {t('manualOutreach.setup.smtpUser')} <code>{s.envVars.smtpUser}</code> {s.smtp.userPresent ? '✅' : '❌'} ·
        {t('manualOutreach.setup.smtpPassword')} <code>{s.envVars.smtpPassword}</code> {s.smtp.passwordPresent ? '✅' : '❌'}<br />
        {t('manualOutreach.setup.imapUser')} <code>{s.envVars.imapUser}</code> {s.imap.userPresent ? '✅' : '❌'} ·
        {t('manualOutreach.setup.imapPassword')} <code>{s.envVars.imapPassword}</code> {s.imap.passwordPresent ? '✅' : '❌'}
      </p>
      <p style={{ fontSize: 13 }}>SMTP {s.smtp.host}:{s.smtp.port} (STARTTLS) · IMAP {s.imap.host}:{s.imap.port} (SSL)</p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
        <button style={btnPrimary} onClick={connect}>{t('manualOutreach.setup.connectBridge')}</button>
        <button style={btn} onClick={() => test('smtp')} disabled={!s.smtp.configured}>{t('manualOutreach.setup.testSmtp')}</button>
        <button style={btn} onClick={() => test('imap')} disabled={!s.imap.configured}>{t('manualOutreach.setup.testImap')}</button>
      </div>
      {s.mailbox && (
        <p style={{ fontSize: 13, marginTop: 8 }}>
          {t('manualOutreach.setup.mailbox')} #{s.mailbox.id}: {s.mailbox.from_email} · {t('manualOutreach.setup.statusLabel')} {s.mailbox.status} · {t('manualOutreach.setup.dailyLimit')} {s.mailbox.daily_send_limit} ·
          IMAP {s.mailbox.imap_enabled ? t('manualOutreach.common.enabled') : t('manualOutreach.common.disabled')}
        </p>
      )}
      <p style={{ fontSize: 12, color: '#888', marginTop: 8 }}>{s.note} {t('manualOutreach.setup.otherProviders')}</p>
    </div>
  );
}

function ProvidersTab({ setMsg }: { setMsg: (s: string) => void }) {
  const t = useT();
  const [d, setD] = useState<any>(null);
  const [f, setF] = useState<any>({ providerType: 'generic_smtp_imap', name: '', smtpHost: '', smtpPort: 587, imapHost: '', imapPort: 993,
    smtpUserRef: '', smtpSecretRef: '', imapUserRef: '', imapSecretRef: '', inboundEnabled: true, outboundEnabled: true });
  const load = async () => { const r = await api('/manual-outreach/providers'); setD(r.json); };
  useEffect(() => { load(); }, []);
  const create = async () => { const r = await api('/manual-outreach/providers', 'POST', f); setMsg(r.ok ? t('manualOutreach.providers.created') : t('manualOutreach.common.failedPrefix') + JSON.stringify(r.json)); load(); };
  const test = async (id: number, kind: 'smtp' | 'imap') => { const r = await api(`/manual-outreach/providers/${id}/test-${kind}`, 'POST', {}); setMsg(`${kind.toUpperCase()}: ${r.json?.ok ? t('manualOutreach.common.ok') : t('manualOutreach.common.failed')} — ${r.json?.detail}`); load(); };
  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }));
  if (!d) return <p>{t('manualOutreach.common.loading')}</p>;
  return (
    <div>
      <div style={card}>
        <h3 style={{ fontWeight: 700 }}>{t('manualOutreach.providers.title')}</h3>
        <p style={{ fontSize: 13, color: '#555' }}>{t('manualOutreach.providers.dbNote')}</p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 8, marginTop: 8 }}>
          <select value={f.providerType} onChange={e => set('providerType', e.target.value)}>
            {(d.supportedTypes || []).map((tp: string) => <option key={tp} value={tp}>{tp}</option>)}
          </select>
          <input placeholder={t('manualOutreach.providers.displayName')} value={f.name} onChange={e => set('name', e.target.value)} />
          <input placeholder={t('manualOutreach.providers.smtpHost')} value={f.smtpHost} onChange={e => set('smtpHost', e.target.value)} />
          <input type="number" placeholder={t('manualOutreach.providers.smtpPort')} value={f.smtpPort} onChange={e => set('smtpPort', parseInt(e.target.value || '587', 10))} />
          <input placeholder={t('manualOutreach.providers.imapHost')} value={f.imapHost} onChange={e => set('imapHost', e.target.value)} />
          <input type="number" placeholder={t('manualOutreach.providers.imapPort')} value={f.imapPort} onChange={e => set('imapPort', parseInt(e.target.value || '993', 10))} />
          <input placeholder={t('manualOutreach.providers.smtpUserRef')} value={f.smtpUserRef} onChange={e => set('smtpUserRef', e.target.value)} />
          <input placeholder={t('manualOutreach.providers.smtpSecretRef')} value={f.smtpSecretRef} onChange={e => set('smtpSecretRef', e.target.value)} />
          <input placeholder={t('manualOutreach.providers.imapUserRef')} value={f.imapUserRef} onChange={e => set('imapUserRef', e.target.value)} />
          <input placeholder={t('manualOutreach.providers.imapSecretRef')} value={f.imapSecretRef} onChange={e => set('imapSecretRef', e.target.value)} />
        </div>
        <label style={{ fontSize: 13, marginRight: 12 }}><input type="checkbox" checked={f.inboundEnabled} onChange={e => set('inboundEnabled', e.target.checked)} /> {t('manualOutreach.providers.inbound')}</label>
        <label style={{ fontSize: 13 }}><input type="checkbox" checked={f.outboundEnabled} onChange={e => set('outboundEnabled', e.target.checked)} /> {t('manualOutreach.providers.outbound')}</label>
        <div style={{ marginTop: 8 }}><button style={btnPrimary} onClick={create}>{t('manualOutreach.providers.connect')}</button></div>
        <p style={{ fontSize: 12, color: '#888', marginTop: 6 }}>{d.note}</p>
      </div>
      {(d.providers || []).map((p: any) => (
        <div key={p.id} style={card}>
          <b>{p.name || p.providerType}</b> · <code>{p.providerType}</code> · {t('manualOutreach.providers.testStatus')} {p.testStatus}
          <div style={{ fontSize: 13, color: '#555', marginTop: 4 }}>
            SMTP {p.smtp.host}:{p.smtp.port} · {t('manualOutreach.providers.user')} <code>{p.smtp.userRef}</code> {p.smtp.userPresent ? '✅' : '❌'} · {t('manualOutreach.providers.secret')} <code>{p.smtp.secretRef}</code> {p.smtp.secretPresent ? '✅' : '❌'} · {t('manualOutreach.providers.configured')} {p.smtp.configured ? '✅' : '❌'}<br />
            IMAP {p.imap.host}:{p.imap.port} · {t('manualOutreach.providers.user')} <code>{p.imap.userRef}</code> {p.imap.userPresent ? '✅' : '❌'} · {t('manualOutreach.providers.secret')} <code>{p.imap.secretRef}</code> {p.imap.secretPresent ? '✅' : '❌'} · {t('manualOutreach.providers.configured')} {p.imap.configured ? '✅' : '❌'}<br />
            {t('manualOutreach.providers.inbound')} {p.inboundEnabled ? t('manualOutreach.common.on') : t('manualOutreach.common.off')} · {t('manualOutreach.providers.outbound')} {p.outboundEnabled ? t('manualOutreach.common.on') : t('manualOutreach.common.off')} {p.lastError && <>· <span style={{ color: '#b91c1c' }}>{t('manualOutreach.providers.err')} {p.lastError}</span></>}
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button style={btn} onClick={() => test(p.id, 'smtp')} disabled={!p.smtp.configured}>{t('manualOutreach.setup.testSmtp')}</button>
            <button style={btn} onClick={() => test(p.id, 'imap')} disabled={!p.imap.configured}>{t('manualOutreach.setup.testImap')}</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function CohortTab({ setMsg }: { setMsg: (s: string) => void }) {
  const t = useT();
  const [country, setCountry] = useState('GB');
  const [industries, setIndustries] = useState('cleaning,dental,plumb,electric');
  const [max, setMax] = useState(20);
  const [templateKey, setTemplateKey] = useState('clients_help_first_touch');
  const [preview, setPreview] = useState<any>(null);
  const body = () => ({ country, industries: industries.split(',').map(s => s.trim()).filter(Boolean), max, templateKey });
  const doPreview = async () => { const r = await api('/manual-outreach/cohort/preview', 'POST', body()); setPreview(r.json); setMsg(r.ok ? '' : t('manualOutreach.cohort.previewFailed')); };
  const doBuild = async () => { const r = await api('/manual-outreach/cohort/build', 'POST', body()); setMsg(r.ok ? t('manualOutreach.cohort.queued').replace('{n}', String(r.json.inserted)) + ' ' + (r.json.warning ?? '') : t('manualOutreach.cohort.buildFailed') + JSON.stringify(r.json)); };
  return (
    <div style={card}>
      <h3 style={{ fontWeight: 700 }}>{t('manualOutreach.cohort.title')}</h3>
      <p style={{ fontSize: 13, color: '#555' }}>{t('manualOutreach.cohort.subtitle')}</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8, margin: '8px 0' }}>
        <input placeholder={t('manualOutreach.cohort.countryPlaceholder')} value={country} onChange={e => setCountry(e.target.value)} />
        <input placeholder={t('manualOutreach.cohort.industriesPlaceholder')} value={industries} onChange={e => setIndustries(e.target.value)} style={{ gridColumn: 'span 2' }} />
        <input type="number" min={1} max={50} value={max} onChange={e => setMax(Math.min(50, parseInt(e.target.value || '1', 10)))} />
        <select value={templateKey} onChange={e => setTemplateKey(e.target.value)} style={{ gridColumn: 'span 2' }}>
          <option value="clients_help_first_touch">clients_help_first_touch</option>
          <option value="remote_it_ps">remote_it_ps (A/B P.S.)</option>
          <option value="no_ps_ab">no_ps_ab (A/B control)</option>
          <option value="clients_help_chat">clients_help_chat</option>
          <option value="seo_growth">seo_growth</option>
        </select>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button style={btn} onClick={doPreview}>{t('manualOutreach.cohort.preview')}</button>
        <button style={btnPrimary} onClick={doBuild}>{t('manualOutreach.cohort.buildQueue')}</button>
      </div>
      {preview && (
        <div style={{ marginTop: 10, fontSize: 13 }}>
          {t('manualOutreach.cohort.matched')} <b>{preview.matched}</b>
          <pre style={{ fontSize: 11, overflow: 'auto', maxHeight: 240 }}>{JSON.stringify(preview.sample, null, 1)}</pre>
        </div>
      )}
    </div>
  );
}

function QueueTab({ setMsg }: { setMsg: (s: string) => void }) {
  const t = useT();
  const [data, setData] = useState<any>(null);
  const [copy, setCopy] = useState<any>(null);
  const load = async () => { const r = await api('/manual-outreach/queue'); setData(r.json); };
  useEffect(() => { load(); }, []);
  const act = async (id: number, action: string) => { const r = await api(`/manual-outreach/queue/${id}`, 'PATCH', { action }); setMsg(r.ok ? `${action} ${t('manualOutreach.common.ok')}` : t('manualOutreach.common.blockedPrefix') + JSON.stringify(r.json)); load(); };
  const send = async (id: number) => { const r = await api(`/manual-outreach/queue/${id}/send`, 'POST', {}); setMsg(r.ok ? t('manualOutreach.queue.sentSmtp') : t('manualOutreach.queue.sendBlocked') + JSON.stringify(r.json)); load(); };
  const markManual = async (id: number) => { const r = await api(`/manual-outreach/queue/${id}/mark-sent-manual`, 'POST', {}); setMsg(r.ok ? t('manualOutreach.queue.markedManual') : t('manualOutreach.common.blockedPrefix') + JSON.stringify(r.json)); load(); };
  const followup = async (id: number) => { const r = await api('/manual-outreach/followups', 'POST', { queueItemId: id, step: 1 }); setMsg(r.ok ? t('manualOutreach.queue.followupCreated').replace('{id}', String(r.json.id)).replace('{status}', String(r.json.status)) : t('manualOutreach.common.failedPrefix') + JSON.stringify(r.json)); };
  const showCopy = async (id: number) => { const r = await api(`/manual-outreach/queue/${id}/copy`); setCopy(r.json); };
  const copyText = (txt: string) => { navigator.clipboard?.writeText(txt); setMsg(t('manualOutreach.common.copiedClipboard')); };
  if (!data) return <p>{t('manualOutreach.common.loading')}</p>;
  return (
    <div>
      <div style={card}>
        <b>{t('manualOutreach.queue.queueLabel')}</b> {t('manualOutreach.queue.pending')} {String(data.counts?.pending_review ?? 0)} · {t('manualOutreach.queue.approved')} {String(data.counts?.approved ?? 0)} ·
        {t('manualOutreach.queue.sent')} {String((Number(data.counts?.sent_manual) || 0) + (Number(data.counts?.sent_smtp) || 0))} ·
        {t('manualOutreach.queue.doNotContact')} {String(data.counts?.do_not_contact ?? 0)} · {t('manualOutreach.queue.hardMax')} {data.limits.hardMax}
      </div>
      {copy && (
        <div style={{ ...card, background: '#f8fafc' }}>
          <h4 style={{ fontWeight: 700 }}>{t('manualOutreach.queue.copyToWebmail')} — {copy.recipient}</h4>
          <p style={{ fontSize: 12, color: '#b91c1c' }}>{copy.gate?.blockers?.length ? t('manualOutreach.common.blockersLabel') + copy.gate.blockers.join(', ') : t('manualOutreach.queue.readyToSend')}</p>
          <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
            <button style={btn} onClick={() => copyText(copy.recipient)}>{t('manualOutreach.queue.copyRecipient')}</button>
            <button style={btn} onClick={() => copyText(copy.subject || '')}>{t('manualOutreach.queue.copySubject')}</button>
            <button style={btn} onClick={() => copyText(copy.body || '')}>{t('manualOutreach.queue.copyBody')}</button>
            <button style={btn} onClick={() => setCopy(null)}>{t('manualOutreach.common.close')}</button>
          </div>
          <p style={{ fontSize: 12 }}><b>{t('manualOutreach.common.subject')}</b> {copy.subject}</p>
          <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{copy.body}</pre>
        </div>
      )}
      {(data.items || []).map((it: any) => (
        <div key={it.id} style={{ ...card, borderLeft: `4px solid ${it.safety_status === 'ok' ? '#15803d' : '#b91c1c'}` }}>
          <div>
            <b>{it.company_name || it.email}</b> · {it.email} · <span style={{ color: '#666' }}>{it.status}</span>
            {it.website && <> · <a href={`https://${it.website}`} target="_blank" rel="noreferrer">{it.website}</a></>}
            <div style={{ fontSize: 12, color: '#666' }}>{it.reason} · {t('manualOutreach.queue.safety')} {it.safety_status} {it.source_url && <>· <a href={it.source_url} target="_blank" rel="noreferrer">{t('manualOutreach.queue.source')}</a></>}</div>
          </div>
          <details style={{ marginTop: 4 }}>
            <summary style={{ fontSize: 12, cursor: 'pointer' }}>{t('manualOutreach.common.draft')} {it.draft_subject}</summary>
            <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{it.draft_body}</pre>
          </details>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
            {it.status === 'pending_review' && <button style={btn} onClick={() => act(it.id, 'approve')}>{t('manualOutreach.queue.approve')}</button>}
            {it.status === 'approved' && <>
              <button style={btnPrimary} onClick={() => send(it.id)}>{t('manualOutreach.queue.sendViaSmtp')}</button>
              <button style={btn} onClick={() => markManual(it.id)}>{t('manualOutreach.queue.markSentManually')}</button>
              <button style={btn} onClick={() => act(it.id, 'unapprove')}>{t('manualOutreach.queue.unapprove')}</button>
            </>}
            {(it.status === 'sent_manual' || it.status === 'sent_smtp') && <button style={btn} onClick={() => followup(it.id)}>{t('manualOutreach.queue.createFollowup')}</button>}
            <button style={btn} onClick={() => showCopy(it.id)}>{t('manualOutreach.queue.copyToWebmail')}</button>
            <button style={btn} onClick={() => act(it.id, 'skip')}>{t('manualOutreach.queue.skip')}</button>
            <button style={{ ...btn, color: '#b91c1c' }} onClick={() => act(it.id, 'do_not_contact')}>{t('manualOutreach.queue.doNotContactBtn')}</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function RepliesTab({ setMsg }: { setMsg: (s: string) => void }) {
  const t = useT();
  const [threads, setThreads] = useState<any[]>([]);
  const load = async () => { const r = await api('/manual-outreach/replies/threads'); setThreads(r.json?.threads || []); };
  useEffect(() => { load(); }, []);
  const imp = async () => { const r = await api('/manual-outreach/replies/import', 'POST', {}); setMsg(r.ok ? t('manualOutreach.replies.imported').replace('{n}', String(r.json.imported)).replace('{s}', String(r.json.suppressedAuto)) : t('manualOutreach.replies.importBlocked') + JSON.stringify(r.json)); load(); };
  const reclass = async (id: number, classification: string) => { await api(`/manual-outreach/replies/${id}`, 'PATCH', { classification, handled: true }); load(); };
  const suppress = async (id: number) => { const r = await api(`/manual-outreach/replies/${id}/suppress`, 'POST', {}); setMsg(r.ok ? t('manualOutreach.replies.suppressedEverywhere') : t('manualOutreach.common.failedPrefix') + JSON.stringify(r.json)); load(); };
  const mkFollowup = async (id: number) => { const r = await api(`/manual-outreach/replies/${id}/create-followup`, 'POST', {}); setMsg(r.ok ? t('manualOutreach.replies.followupCreated') : t('manualOutreach.common.failedPrefix') + JSON.stringify(r.json)); load(); };
  const CLS = ['interested', 'not_interested', 'wrong_person', 'out_of_office', 'auto_reply', 'bounce_like', 'unsubscribe', 'do_not_contact'];
  return (
    <div>
      <div style={card}>
        <button style={btnPrimary} onClick={imp}>{t('manualOutreach.replies.importBtn')}</button>
        <span style={{ fontSize: 12, color: '#666', marginLeft: 8 }}>{t('manualOutreach.replies.importHelper')}</span>
      </div>
      {threads.length === 0 && <p style={{ marginTop: 10 }}>{t('manualOutreach.replies.noReplies')}</p>}
      {threads.map(th => (
        <div key={th.key} style={card}>
          <b>{th.company || th.contactEmail}</b> {th.contactEmail && <span style={{ color: '#666' }}>· {th.contactEmail}</span>}
          {th.lastOutbound && (
            <details style={{ marginTop: 4 }}>
              <summary style={{ fontSize: 12, cursor: 'pointer', color: '#555' }}>{t('manualOutreach.replies.lastOutbound')} {th.lastOutbound.subject} ({th.lastOutbound.queueStatus})</summary>
              <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap' }}>{th.lastOutbound.body}</pre>
            </details>
          )}
          {th.replies.map((r: any) => (
            <div key={r.id} style={{ borderTop: '1px solid #eee', paddingTop: 6, marginTop: 6 }}>
              <div style={{ fontSize: 13 }}>
                <b>{r.subject || t('manualOutreach.replies.noSubject')}</b> · <span style={{ color: '#1d4ed8' }}>{r.classification}</span>
                <span style={{ color: '#888', fontSize: 11 }}> ({r.source}, {t('manualOutreach.replies.conf')} {Number(r.confidence).toFixed(2)}{r.reason ? `, ${r.reason}` : ''})</span> {r.handled ? '✓' : ''}
              </div>
              <div style={{ fontSize: 12, color: '#555' }}>{r.snippet}</div>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
                {CLS.map(c => <button key={c} style={{ ...btn, padding: '2px 8px', fontSize: 11 }} onClick={() => reclass(r.id, c)}>{c}</button>)}
                <button style={{ ...btn, padding: '2px 8px', fontSize: 11 }} onClick={() => mkFollowup(r.id)}>{t('manualOutreach.replies.addFollowup')}</button>
                <button style={{ ...btn, padding: '2px 8px', fontSize: 11, color: '#b91c1c' }} onClick={() => suppress(r.id)}>{t('manualOutreach.replies.suppress')}</button>
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function FollowupsTab({ setMsg }: { setMsg: (s: string) => void }) {
  const t = useT();
  const [d, setD] = useState<any>(null);
  const [copy, setCopy] = useState<any>(null);
  const load = async () => { const r = await api('/manual-outreach/followups'); setD(r.json); };
  useEffect(() => { load(); }, []);
  const gen = async () => { const r = await api('/manual-outreach/followups/generate', 'POST', {}); setMsg(r.ok ? t('manualOutreach.followups.generated').replace('{c}', String(r.json.created)).replace('{b}', String(r.json.blocked)).replace('{s}', String(r.json.scanned)) : t('manualOutreach.common.failedPrefix') + JSON.stringify(r.json)); load(); };
  const showCopy = async (id: number) => { const r = await api(`/manual-outreach/followups/${id}/copy`); setCopy({ id, ...r.json }); load(); };
  const markSent = async (id: number) => { const r = await api(`/manual-outreach/followups/${id}/mark-sent`, 'POST', {}); setMsg(r.ok ? t('manualOutreach.followups.markedSent') : t('manualOutreach.common.blockedPrefix') + JSON.stringify(r.json)); load(); };
  const skip = async (id: number) => { await api(`/manual-outreach/followups/${id}/skip`, 'POST', {}); setMsg(t('manualOutreach.followups.skipped')); load(); };
  const cancel = async (id: number) => { await api(`/manual-outreach/followups/${id}/cancel`, 'POST', {}); setMsg(t('manualOutreach.followups.sequenceCancelled')); load(); };
  const suppress = async (id: number) => { const r = await api(`/manual-outreach/followups/${id}/suppress`, 'POST', {}); setMsg(r.ok ? t('manualOutreach.followups.suppressed') : t('manualOutreach.common.failed') + '.'); load(); };
  const copyText = (txt: string) => { navigator.clipboard?.writeText(txt); setMsg(t('manualOutreach.common.copied')); };
  if (!d) return <p>{t('manualOutreach.common.loading')}</p>;
  const row = (tk: any) => (
    <div key={tk.id} style={{ ...card, borderLeft: `4px solid ${tk.status === 'blocked' ? '#b91c1c' : tk.status === 'sent_manually' ? '#15803d' : '#b45309'}` }}>
      <b>{tk.company_name || tk.email}</b> · {t('manualOutreach.followups.step')} {tk.followup_step} · <span style={{ color: '#666' }}>{tk.status}</span> · {t('manualOutreach.followups.due')} {tk.due_at ? new Date(tk.due_at).toLocaleDateString() : '—'}
      {tk.blockers_json && <div style={{ fontSize: 12, color: '#b91c1c' }}>{t('manualOutreach.followups.blockers')} {(() => { try { return JSON.parse(tk.blockers_json).join(', '); } catch { return tk.blockers_json; } })()}</div>}
      <details style={{ marginTop: 4 }}><summary style={{ fontSize: 12, cursor: 'pointer' }}>{t('manualOutreach.common.draft')} {tk.subject}</summary><pre style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{tk.body}</pre></details>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
        <button style={btn} onClick={() => showCopy(tk.id)}>{t('manualOutreach.followups.copy')}</button>
        {tk.status !== 'sent_manually' && <button style={btnPrimary} onClick={() => markSent(tk.id)}>{t('manualOutreach.followups.markSent')}</button>}
        <button style={btn} onClick={() => skip(tk.id)}>{t('manualOutreach.followups.skip')}</button>
        <button style={btn} onClick={() => cancel(tk.id)}>{t('manualOutreach.followups.cancelSequence')}</button>
        <button style={{ ...btn, color: '#b91c1c' }} onClick={() => suppress(tk.id)}>{t('manualOutreach.followups.suppress')}</button>
      </div>
    </div>
  );
  return (
    <div>
      <div style={card}>
        <b>{t('manualOutreach.followups.title')}</b> {t('manualOutreach.followups.subtitle')}
        {' '}{t('manualOutreach.followups.timing').replace('{s1}', String(d.timing?.step1Days)).replace('{s2}', String(d.timing?.step2Days)).replace('{max}', String(d.timing?.maxFollowups))}
        <div style={{ marginTop: 8 }}><button style={btnPrimary} onClick={gen}>{t('manualOutreach.followups.generateBtn')}</button></div>
      </div>
      {copy && (
        <div style={{ ...card, background: '#f8fafc' }}>
          <h4 style={{ fontWeight: 700 }}>{t('manualOutreach.followups.copyFollowup')} — {copy.recipient}</h4>
          <p style={{ fontSize: 12, color: '#b91c1c' }}>{copy.blockers?.length ? t('manualOutreach.common.blockersLabel') + copy.blockers.join(', ') : t('manualOutreach.followups.ready')}</p>
          <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
            <button style={btn} onClick={() => copyText(copy.recipient)}>{t('manualOutreach.followups.recipient')}</button>
            <button style={btn} onClick={() => copyText(copy.subject || '')}>{t('manualOutreach.followups.subject')}</button>
            <button style={btn} onClick={() => copyText(copy.body || '')}>{t('manualOutreach.followups.body')}</button>
            <button style={btn} onClick={() => setCopy(null)}>{t('manualOutreach.common.close')}</button>
          </div>
          <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{copy.body}</pre>
        </div>
      )}
      <h4 style={{ fontWeight: 700, marginTop: 12 }}>{t('manualOutreach.followups.dueTodaySoon')} ({d.counts?.dueToday ?? 0})</h4>{(d.groups?.dueToday || []).map(row)}
      <h4 style={{ fontWeight: 700, marginTop: 12 }}>{t('manualOutreach.followups.blockedGroup')} ({d.counts?.blocked ?? 0})</h4>{(d.groups?.blocked || []).map(row)}
      <h4 style={{ fontWeight: 700, marginTop: 12 }}>{t('manualOutreach.followups.upcoming')} ({d.counts?.upcoming ?? 0})</h4>{(d.groups?.upcoming || []).map(row)}
      <h4 style={{ fontWeight: 700, marginTop: 12 }}>{t('manualOutreach.followups.sent')} ({d.counts?.sent ?? 0}) · {t('manualOutreach.followups.skippedGroup')} ({d.counts?.skipped ?? 0}) · {t('manualOutreach.followups.cancelled')} ({d.counts?.cancelled ?? 0})</h4>
      {(d.groups?.sent || []).map(row)}
    </div>
  );
}

function WarmupTab({ setMsg }: { setMsg: (s: string) => void }) {
  const t = useT();
  const [data, setData] = useState<any>(null);
  const load = async () => { const r = await api('/manual-outreach/warmup'); setData(r.json); };
  useEffect(() => { load(); }, []);
  const toggleImap = async (id: number, on: boolean) => { await api(`/manual-outreach/mailbox/${id}`, 'PATCH', { imapEnabled: on }); setMsg(on ? t('manualOutreach.warmup.imapEnabled') : t('manualOutreach.warmup.imapDisabled')); load(); };
  if (!data) return <p>{t('manualOutreach.common.loading')}</p>;
  return (
    <div>
      <div style={card}>
        <b>{t('manualOutreach.warmup.scheduleTitle')}</b> {t('manualOutreach.warmup.scheduleDesc')}
      </div>
      {(data.mailboxes || []).map((m: any) => (
        <div key={m.mailboxId} style={{ ...card, borderLeft: `4px solid ${hcolor(m.health)}` }}>
          <b>{m.email}</b> ({m.provider}) · <span style={{ color: hcolor(m.health) }}>{m.health}</span> <span style={{ fontSize: 12, color: '#666' }}>({m.reason})</span>
          <div style={{ fontSize: 13, marginTop: 4 }}>
            {t('manualOutreach.warmup.day')} {m.dayIndex} · {t('manualOutreach.warmup.limit')} {m.dailyLimit} · {t('manualOutreach.warmup.sentToday')} {m.sentToday} (smtp {m.smtpSentToday}/{t('manualOutreach.warmup.copy')} {m.copySentToday}) · {t('manualOutreach.warmup.remaining')} {m.remainingToday}
          </div>
          <div style={{ fontSize: 13 }}>{t('manualOutreach.warmup.replies')} {m.repliesToday} · {t('manualOutreach.warmup.interested')} {m.interestedToday} · {t('manualOutreach.warmup.negative')} {m.negativeToday} · {t('manualOutreach.warmup.bounceLike')} {m.bounceLikeToday}</div>
          <div style={{ fontSize: 13 }}>{t('manualOutreach.warmup.recommendedTomorrow')} <b>{m.recommendedLimitTomorrow}/{t('manualOutreach.warmup.perDay')}</b> · {t('manualOutreach.warmup.lastSent')} {m.lastSentAt ?? '—'}</div>
          <div style={{ marginTop: 6, display: 'flex', gap: 6 }}>
            <button style={btn} onClick={() => toggleImap(m.mailboxId, true)}>{t('manualOutreach.warmup.enableImap')}</button>
            <button style={btn} onClick={() => toggleImap(m.mailboxId, false)}>{t('manualOutreach.warmup.disableImap')}</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function TemplatesTab({ setMsg }: { setMsg: (s: string) => void }) {
  const t = useT();
  const [rows, setRows] = useState<any[]>([]);
  const [mode, setMode] = useState<'variable' | 'human'>('variable');
  const [render, setRender] = useState<Record<number, any>>({});
  const load = async () => { const r = await api('/manual-outreach/templates'); setRows(r.json?.templates || []); };
  useEffect(() => { load(); }, []);
  const approve = async (id: number, approved: boolean) => { await api(`/manual-outreach/templates/${id}`, 'PATCH', { approved }); setMsg(approved ? t('manualOutreach.templates.approved') : t('manualOutreach.templates.approvalRevoked')); load(); };
  const doRender = async (id: number, m: 'variable' | 'human') => { const r = await api(`/manual-outreach/templates/${id}/render?mode=${m}`); setRender(p => ({ ...p, [id]: r.json })); };
  const switchMode = (m: 'variable' | 'human') => { setMode(m); setRender({}); };
  return (
    <div>
      <div style={card}>
        <b>{t('manualOutreach.templates.title')}</b> {t('manualOutreach.templates.subtitle')}
        <div style={{ marginTop: 6 }}>
          ✏️ {t('manualOutreach.templates.editorNote')}{' '}
          <a href="/sender-studio" style={{ color: '#1d4ed8', fontWeight: 600 }}>{t('manualOutreach.templates.senderStudio')}</a>
        </div>
        <div style={{ marginTop: 8 }}>
          {t('manualOutreach.templates.viewMode')} <button style={mode === 'variable' ? btnPrimary : btn} onClick={() => switchMode('variable')}>{t('manualOutreach.templates.replaceFields')}</button>{' '}
          <button style={mode === 'human' ? btnPrimary : btn} onClick={() => switchMode('human')}>{t('manualOutreach.templates.humanPreview')}</button>
        </div>
      </div>
      {rows.map(tpl => {
        const rv = render[tpl.id];
        return (
          <div key={tpl.id} style={{ ...card, borderLeft: `4px solid ${tpl.approved ? '#15803d' : '#b45309'}` }}>
            <b>{tpl.name}</b> · <code>{tpl.template_key}</code> · {tpl.approved ? <span style={{ color: '#15803d' }}>{t('manualOutreach.templates.approvedLabel')}</span> : <span style={{ color: '#b45309' }}>{t('manualOutreach.templates.notApproved')}</span>}
            <div style={{ marginTop: 4 }}><button style={btn} onClick={() => doRender(tpl.id, mode)}>{t('manualOutreach.templates.showIn').replace('{mode}', mode === 'variable' ? t('manualOutreach.templates.replaceFieldsMode') : t('manualOutreach.templates.humanPreviewMode'))}</button></div>
            {rv ? (
              <>
                <div style={{ fontSize: 13, marginTop: 6 }}><b>{t('manualOutreach.common.subject')}</b> {rv.subject}</div>
                <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap', background: mode === 'variable' ? '#fffbeb' : '#f0fdf4', padding: 8, borderRadius: 6 }}>{rv.body}</pre>
                {rv.fields?.length > 0 && <div style={{ fontSize: 12, color: '#666' }}>{t('manualOutreach.templates.fields')} {rv.fields.map((fld: any) => fld.label).join(', ')}</div>}
              </>
            ) : (
              <>
                <div style={{ fontSize: 13, marginTop: 4 }}><b>{t('manualOutreach.common.subject')}</b> {tpl.subject}</div>
                <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{tpl.body}</pre>
              </>
            )}
            <button style={tpl.approved ? btn : btnPrimary} onClick={() => approve(tpl.id, !tpl.approved)}>{tpl.approved ? t('manualOutreach.templates.revokeApproval') : t('manualOutreach.templates.approveTemplate')}</button>
          </div>
        );
      })}
    </div>
  );
}
