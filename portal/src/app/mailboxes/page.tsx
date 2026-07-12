'use client';

// Phase 22D — Mailbox Fleet Manager.
// Provider Profiles + Mailboxes + Fleet dashboard. Manage 1→100+ mailboxes
// safely: add provider profile → add mailbox → put env vars → restart → test →
// activate. Secrets NEVER shown; only env-var NAMES + empty .env snippets.
// NO send button here. Fully i18n via useT (en/ru/uk).
import { useEffect, useState, useCallback } from 'react';
import { AppShell } from '../../components/AppShell';
import { useT } from '@/lib/useT';

function getToken(): string {
  if (typeof document === 'undefined') return '';
  return document.cookie.split('; ').find(c => c.startsWith('token='))?.split('=')[1] ?? '';
}
function authHeaders() { return { authorization: `Bearer ${getToken()}`, 'content-type': 'application/json' }; }
async function api(path: string, method = 'GET', body?: any) {
  const r = await fetch(`/api/mailboxes${path}`, { method, headers: authHeaders(), body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (r.status === 401 && typeof window !== 'undefined') {
    window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname);
  }
  return { ok: r.ok, status: r.status, json };
}

const card: React.CSSProperties = { border: '1px solid #ddd', borderRadius: 8, padding: 14, marginTop: 12, background: '#fff' };
const btn: React.CSSProperties = { padding: '5px 10px', cursor: 'pointer', borderRadius: 6, border: '1px solid #bbb', background: '#fff', fontSize: 12, marginRight: 6 };
const btnPrimary: React.CSSProperties = { ...btn, background: '#1d4ed8', color: '#fff', borderColor: '#1d4ed8' };
const input: React.CSSProperties = { padding: '6px 8px', borderRadius: 6, border: '1px solid #ccc', fontSize: 13, boxSizing: 'border-box' };
const label: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: '#555', display: 'block', margin: '6px 0 2px' };
const th: React.CSSProperties = { textAlign: 'left', fontSize: 11, color: '#666', padding: '4px 6px', borderBottom: '1px solid #eee' };
const td: React.CSSProperties = { fontSize: 12, padding: '4px 6px', borderBottom: '1px solid #f3f3f3' };

const HEALTH_COLOR: Record<string, string> = { safe: '#16a34a', warning: '#d97706', danger: '#dc2626', unknown: '#888' };
const STATUS_COLOR: Record<string, string> = { active: '#16a34a', draft: '#888', paused: '#d97706', disabled: '#999', error: '#dc2626' };
function chip(text: string, color: string) {
  return <span style={{ background: color, color: '#fff', borderRadius: 10, padding: '1px 8px', fontSize: 11 }}>{text}</span>;
}
// `t` typed loosely so helper subcomponents can receive it.
type TFn = (k: string) => string;
const fill = (s: string, vars: Record<string, any>) => s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));

export default function MailboxesPage() {
  const t = useT();
  const [tab, setTab] = useState<'fleet' | 'mailboxes' | 'providers'>('fleet');
  const [msg, setMsg] = useState<string | null>(null);
  // Persistent banner — stays until the operator dismisses it or runs another
  // action. (Previously auto-hid after 4s, so test/activate results just blinked.)
  const flash = (m: string) => setMsg(m);

  return (
    <AppShell pageKey="mailboxes" pageTitle={t('mailboxesPage.pageTitle')}>
      <div style={{ padding: 4 }}>
        <p style={{ fontSize: 13, color: '#555', marginTop: 0 }}>
          {t('mailboxesPage.intro')}<b>{t('mailboxesPage.flow')}</b>{t('mailboxesPage.introTail')}
        </p>
        {msg && (
          <div style={{ ...card, position: 'sticky', top: 0, zIndex: 5, background: '#eef6ff', borderColor: '#9cc3f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
            <span style={{ whiteSpace: 'pre-wrap' }}>{msg}</span>
            <button style={{ ...btn, marginRight: 0 }} onClick={() => setMsg(null)}>{t('mailboxesPage.dismiss')} ✕</button>
          </div>
        )}
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          {(['fleet', 'mailboxes', 'providers'] as const).map(tb => (
            <button key={tb} style={tab === tb ? btnPrimary : btn} onClick={() => setTab(tb)}>
              {tb === 'fleet' ? t('mailboxesPage.tabFleet') : tb === 'mailboxes' ? t('mailboxesPage.tabMailboxes') : t('mailboxesPage.tabProviders')}
            </button>
          ))}
        </div>
        {tab === 'fleet' && <FleetTab t={t} flash={flash} />}
        {tab === 'mailboxes' && <MailboxesTab t={t} flash={flash} />}
        {tab === 'providers' && <ProvidersTab t={t} flash={flash} />}
      </div>
    </AppShell>
  );
}

// ── Fleet dashboard ──────────────────────────────────────────────────────────
function FleetTab({ t, flash }: { t: TFn; flash: (m: string) => void }) {
  const [f, setF] = useState<any>(null);
  const [assign, setAssign] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await api('/fleet');
    if (r.ok) { setF(r.json); setErr(null); }
    else setErr(r.json?.error ?? ('HTTP ' + r.status)); // don't leave the spinner stuck on failure
  }, []);
  useEffect(() => { load(); }, [load]);
  if (err) return <div style={card}>{t('mailboxesPage.loadError')}: {err}</div>;
  if (!f) return <div style={card}>{t('mailboxesPage.loading')}</div>;
  const stat = (k: string, v: any) => <div style={{ flex: '1 1 120px' }}><div style={{ fontSize: 22, fontWeight: 700 }}>{v}</div><div style={{ fontSize: 11, color: '#666' }}>{k}</div></div>;
  const dryRun = async () => {
    const r = await api('/assign-queue', 'POST', { strategy: 'healthiest_first', dryRun: true });
    if (r.ok) { setAssign(r.json); flash(fill(t('mailboxesPage.mDryRun'), { a: r.json.assigned, n: r.json.total })); } else flash(t('mailboxesPage.mAssignFail') + (r.json?.error ?? r.status));
  };
  return (
    <div>
      <div style={{ ...card, display: 'flex', flexWrap: 'wrap', gap: 14 }}>
        {stat(t('mailboxesPage.totalMailboxes'), f.total)}
        {stat(t('mailboxesPage.active'), f.byStatus?.active ?? 0)}
        {stat(t('mailboxesPage.draft'), f.byStatus?.draft ?? 0)}
        {stat(t('mailboxesPage.paused'), f.byStatus?.paused ?? 0)}
        {stat(t('mailboxesPage.error'), f.byStatus?.error ?? 0)}
        {stat(t('mailboxesPage.dailyCapacity'), f.capacity?.totalDaily ?? 0)}
        {stat(t('mailboxesPage.usedToday'), f.capacity?.usedToday ?? 0)}
        {stat(t('mailboxesPage.remainingToday'), f.capacity?.remainingToday ?? 0)}
        {stat(t('mailboxesPage.repliesToday'), f.repliesToday ?? 0)}
        {stat(t('mailboxesPage.followupsDue'), f.followupsDue ?? 0)}
        {stat(t('mailboxesPage.queueAssigned'), f.queueAssigned ?? 0)}
      </div>
      <div style={{ ...card, display: 'flex', gap: 14 }}>
        <div>{t('mailboxesPage.health')} — {chip(`safe ${f.byHealth?.safe ?? 0}`, HEALTH_COLOR.safe)} {chip(`warning ${f.byHealth?.warning ?? 0}`, HEALTH_COLOR.warning)} {chip(`danger ${f.byHealth?.danger ?? 0}`, HEALTH_COLOR.danger)} {chip(`unknown ${f.byHealth?.unknown ?? 0}`, HEALTH_COLOR.unknown)}</div>
      </div>
      <div style={card}>
        <b>{t('mailboxesPage.needAttention')}</b>
        {(!f.needAttention || !f.needAttention.length) && <p style={{ color: '#666', fontSize: 12 }}>{t('mailboxesPage.none')}</p>}
        {f.needAttention?.map((m: any) => (
          <div key={m.id} style={{ fontSize: 12, padding: '3px 0', borderBottom: '1px solid #f3f3f3' }}>
            #{m.id} {m.email} {chip(m.status, STATUS_COLOR[m.status] ?? '#888')} {chip(m.health, HEALTH_COLOR[m.health] ?? '#888')}
            {m.blockers?.length ? <span style={{ color: '#b45309' }}> · {m.blockers.join(', ')}</span> : null}
          </div>
        ))}
      </div>
      <div style={card}>
        <b>{t('mailboxesPage.assignmentEngine')}</b>
        <p style={{ fontSize: 12, color: '#666' }}>{t('mailboxesPage.assignDesc')}</p>
        <button style={btn} onClick={dryRun}>{t('mailboxesPage.dryRunAssign')}</button>
        {assign && <pre style={{ fontSize: 11, background: '#f7f7f7', padding: 8, borderRadius: 6, maxHeight: 220, overflow: 'auto' }}>{JSON.stringify(assign.results, null, 2)}</pre>}
      </div>
    </div>
  );
}

// ── Mailboxes tab ────────────────────────────────────────────────────────────
function MailboxesTab({ t, flash }: { t: TFn; flash: (m: string) => void }) {
  const [boxes, setBoxes] = useState<any[]>([]);
  const [providers, setProviders] = useState<any[]>([]);
  const [snippet, setSnippet] = useState<string | null>(null);
  const [csv, setCsv] = useState('');
  const [credBox, setCredBox] = useState<any>(null);   // mailbox row whose creds are being edited
  const [cred, setCred] = useState<any>({ smtp_user: '', smtp_password: '', imap_user: '', imap_password: '', imap_same_as_smtp: true });
  const [form, setForm] = useState<any>({ email: '', display_name: '', provider_profile_id: '', purpose: 'cold_outreach', inbound_enabled: false });

  const load = useCallback(async () => {
    const [b, p] = await Promise.all([api('/'), api('/providers')]);
    if (b.ok) setBoxes(b.json.mailboxes); if (p.ok) setProviders(p.json.profiles);
  }, []);
  useEffect(() => { load(); }, [load]);

  const create = async () => {
    if (!form.email || !form.provider_profile_id) return flash(t('mailboxesPage.mEmailProvReq'));
    const r = await api('/', 'POST', { ...form, provider_profile_id: Number(form.provider_profile_id) });
    // Primary path: open the credentials form immediately (UI entry, no .env).
    if (r.ok) { flash(t('mailboxesPage.credsFirst')); load(); openCreds({ id: r.json.id, email: form.email }); }
    else flash(t('mailboxesPage.mCreateFail') + (r.json?.error ?? r.status));
  };
  const act = async (id: number, path: string, body?: any) => {
    const r = await api(`/${id}/${path}`, 'POST', body ?? {});
    const j = r.json || {};
    if (path === 'test-smtp' || path === 'test-imap') {
      // HTTP 200 only means the test RAN; the real verdict is j.ok. A "not
      // configured" mailbox returns 200 + ok:false — must not look like success.
      const okTest = r.ok && j.ok === true;
      const okMsg = path === 'test-smtp' ? t('mailboxesPage.smtpOk') : t('mailboxesPage.imapOk');
      const failMsg = path === 'test-smtp' ? t('mailboxesPage.smtpFail') : t('mailboxesPage.imapFail');
      const detail = j.detail === 'not_configured' ? t('mailboxesPage.notConfigured') : (j.detail || j.error || `HTTP ${r.status}`);
      flash(okTest ? okMsg : `${failMsg}: ${detail}`);
    } else if (path === 'activate') {
      if (r.ok) flash(t('mailboxesPage.activated'));
      else flash(`${t('mailboxesPage.activateFail')}: ${j.error ?? r.status}${j.blockers ? ' — ' + j.blockers.join(', ') : ''}`);
    } else {
      flash(r.ok ? `${path}: ok` : `${path}: ${j.error ?? r.status}${j.blockers ? ' — ' + j.blockers.join(', ') : ''}`);
    }
    load();
  };
  const del = async (id: number, email: string) => {
    if (typeof window !== 'undefined' && !window.confirm(fill(t('mailboxesPage.deleteConfirm'), { email }))) return;
    const r = await api(`/${id}`, 'DELETE');
    if (r.ok) { flash(t('mailboxesPage.deleted')); load(); }
    else flash(`${t('mailboxesPage.deleteFail')}: ${r.json?.detail ?? r.json?.error ?? r.status}`);
  };
  const showSnippet = async (id: number) => { const r = await api(`/${id}/env-snippet`); if (r.ok) setSnippet(r.json.snippet); };
  const importCsv = async () => {
    if (!csv.trim()) return flash(t('mailboxesPage.mPasteCsv'));
    const r = await api('/import/csv', 'POST', { csv });
    if (r.ok) { flash(fill(t('mailboxesPage.mImported'), { a: r.json.created, n: r.json.total })); load(); }
    else flash(t('mailboxesPage.mCreateFail') + (r.json?.error ?? r.status));
  };
  const bulkSnippet = async () => { const r = await api('/bulk-env-snippet', 'POST', {}); if (r.ok) setSnippet(r.json.snippet); };
  const [limits, setLimits] = useState<Record<number, string>>({});
  const saveLimit = async (id: number) => {
    const v = Number(limits[id]); if (!v || v < 1) return;
    const r = await api(`/${id}/set-limit`, 'POST', { daily: v });
    if (r.ok) { flash(t('mailboxesPage.limitSaved')); load(); }
    else flash(t('mailboxesPage.mFailed') + (r.json?.error ?? r.status));
  };
  const openCreds = (m: any) => { setCredBox(m); setCred({ smtp_user: m.email, smtp_password: '', imap_user: m.email, imap_password: '', imap_same_as_smtp: true }); };
  const saveCreds = async () => {
    const r = await api(`/${credBox.id}/credentials`, 'PUT', cred);
    if (r.ok) { flash(t('mailboxesPage.credsSaved')); setCredBox(null); load(); }
    else flash(t('mailboxesPage.mFailed') + (r.json?.error ?? r.status));
  };

  return (
    <div>
      <div style={card}>
        <b>{t('mailboxesPage.addMailbox')}</b>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 6 }}>
          <div><label style={label}>{t('mailboxesPage.email')}</label><input style={input} value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} placeholder="sales1@example.com" /></div>
          <div><label style={label}>{t('mailboxesPage.displayName')}</label><input style={input} value={form.display_name} onChange={e => setForm({ ...form, display_name: e.target.value })} /></div>
          <div><label style={label}>{t('mailboxesPage.providerProfile')}</label>
            <select style={input} value={form.provider_profile_id} onChange={e => setForm({ ...form, provider_profile_id: e.target.value })}>
              <option value="">{t('mailboxesPage.selectDash')}</option>
              {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div><label style={label}>{t('mailboxesPage.purpose')}</label>
            <select style={input} value={form.purpose} onChange={e => setForm({ ...form, purpose: e.target.value })}>
              {['cold_outreach', 'internal_test', 'transactional', 'support'].map(x => <option key={x}>{x}</option>)}
            </select>
          </div>
          <div><label style={label}>{t('mailboxesPage.inboundImap')}</label><input type="checkbox" checked={form.inbound_enabled} onChange={e => setForm({ ...form, inbound_enabled: e.target.checked })} /></div>
          <div style={{ alignSelf: 'flex-end' }}><button style={btnPrimary} onClick={create}>{t('mailboxesPage.addMailbox')}</button></div>
        </div>
        <p style={{ fontSize: 11, color: '#888' }}>{t('mailboxesPage.defaultsNote1')}<b>{t('mailboxesPage.draftWord')}</b>{t('mailboxesPage.defaultsNote2')}</p>
      </div>

      {snippet && (
        <div style={{ ...card, background: '#fffbe9', borderColor: '#e6d27a' }}>
          <b>⚙ {t('mailboxesPage.envTitle')}</b>
          <p style={{ fontSize: 12, color: '#b45309', margin: '4px 0' }}>{t('mailboxesPage.envAdvNote')}</p>
          <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap', userSelect: 'all' }}>{snippet}</pre>
          <p style={{ fontSize: 12, color: '#7a5b00', lineHeight: 1.5 }}>{t('mailboxesPage.envHow')}</p>
          <button style={btn} onClick={() => { navigator.clipboard?.writeText(snippet); flash(t('mailboxesPage.copied')); }}>{t('mailboxesPage.copy')}</button>
          <button style={btn} onClick={() => setSnippet(null)}>{t('mailboxesPage.hide')}</button>
        </div>
      )}

      {credBox && (
        <div style={{ ...card, background: '#eef9f0', borderColor: '#9bd4ad' }}>
          <b>{t('mailboxesPage.credsTitle')} {credBox.email}</b>
          <p style={{ fontSize: 12, color: '#3f6b4d' }}>{t('mailboxesPage.credsHelp')}</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            <div><label style={label}>{t('mailboxesPage.smtpUser')}</label><input style={input} value={cred.smtp_user} onChange={e => setCred({ ...cred, smtp_user: e.target.value })} /></div>
            <div><label style={label}>{t('mailboxesPage.smtpPass')}</label><input style={input} type="password" autoComplete="new-password" value={cred.smtp_password} onChange={e => setCred({ ...cred, smtp_password: e.target.value })} /></div>
          </div>
          <label style={{ display: 'block', fontSize: 12, margin: '8px 0' }}>
            <input type="checkbox" checked={cred.imap_same_as_smtp} onChange={e => setCred({ ...cred, imap_same_as_smtp: e.target.checked })} /> {t('mailboxesPage.imapSame')}
          </label>
          {!cred.imap_same_as_smtp && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              <div><label style={label}>{t('mailboxesPage.imapUser')}</label><input style={input} value={cred.imap_user} onChange={e => setCred({ ...cred, imap_user: e.target.value })} /></div>
              <div><label style={label}>{t('mailboxesPage.imapPass')}</label><input style={input} type="password" autoComplete="new-password" value={cred.imap_password} onChange={e => setCred({ ...cred, imap_password: e.target.value })} /></div>
            </div>
          )}
          <div style={{ marginTop: 10 }}>
            <button style={btnPrimary} onClick={saveCreds}>{t('mailboxesPage.saveCreds')}</button>
            <button style={btn} onClick={() => setCredBox(null)}>{t('mailboxesPage.cancel')}</button>
          </div>
        </div>
      )}

      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <b>{t('mailboxesPage.mailboxesCount')} ({boxes.length})</b>
          <button style={btn} onClick={bulkSnippet}>{t('mailboxesPage.bulkEnv')}</button>
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 6 }}>
          <thead><tr><th style={th}>{t('mailboxesPage.cNum')}</th><th style={th}>{t('mailboxesPage.cEmail')}</th><th style={th}>{t('mailboxesPage.cProvider')}</th><th style={th}>{t('mailboxesPage.cStatus')}</th><th style={th}>{t('mailboxesPage.cHealth')}</th><th style={th}>{t('mailboxesPage.cDaily')}</th><th style={th}>{t('mailboxesPage.cUsedRem')}</th><th style={th}>{t('mailboxesPage.cReplies')}</th><th style={th}>{t('mailboxesPage.cTests')}</th><th style={th}>{t('mailboxesPage.cActions')}</th></tr></thead>
          <tbody>
            {boxes.map(m => (
              <tr key={m.id}>
                <td style={td}>{m.id}</td>
                <td style={td}>{m.email}{m.blockers?.length ? <div style={{ color: '#b45309', fontSize: 10 }}>{m.blockers.join(', ')}</div> : null}</td>
                <td style={td}>{m.provider_profile_name ?? '—'}</td>
                <td style={td}>{chip(m.status, STATUS_COLOR[m.status] ?? '#888')}</td>
                <td style={td}>{chip(m.health_status, HEALTH_COLOR[m.health_status] ?? '#888')}</td>
                <td style={td}>
                  <input style={{ ...input, width: 52, padding: '2px 4px' }} type="number" min={1}
                    defaultValue={m.daily_send_limit} onChange={e => setLimits({ ...limits, [m.id]: e.target.value })}
                    title={t('mailboxesPage.limitHint')} />
                  <button style={{ ...btn, padding: '2px 6px', marginLeft: 4 }} onClick={() => saveLimit(m.id)}>{t('mailboxesPage.setLimit')}</button>
                  <div style={{ fontSize: 10, color: '#999' }}>/{m.hourly_send_limit}h</div>
                </td>
                <td style={td}>{(m.smtp_sent_today || 0) + (m.manual_sent_today || 0)} / {m.daily_remaining}</td>
                <td style={td}>{m.replies_today || 0}</td>
                <td style={td}>{m.last_smtp_test_at ? 'S' : '·'}{m.last_imap_test_at ? 'I' : '·'}{m.creds_stored?.smtp ? ' 🔑' : ''}</td>
                <td style={td}>
                  <button style={btn} onClick={() => openCreds(m)}>{t('mailboxesPage.credsBtn')}</button>
                  <button style={btn} onClick={() => act(m.id, 'test-smtp')}>SMTP</button>
                  <button style={btn} onClick={() => act(m.id, 'test-imap')}>IMAP</button>
                  {m.status !== 'active' && <button style={btn} onClick={() => act(m.id, 'activate')}>{t('mailboxesPage.activate')}</button>}
                  {m.status === 'active' && <button style={btn} onClick={() => act(m.id, 'pause', { reason: 'operator' })}>{t('mailboxesPage.pause')}</button>}
                  <button style={{ ...btn, opacity: 0.6 }} title={t('mailboxesPage.envAdvNote')} onClick={() => showSnippet(m.id)}>⚙ .env</button>
                  <button style={{ ...btn, color: '#b91c1c', borderColor: '#fca5a5' }} onClick={() => del(m.id, m.email)}>{t('mailboxesPage.delete')}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={card}>
        <b>{t('mailboxesPage.csvTitle')}</b>
        <p style={{ fontSize: 11, color: '#888' }}>{t('mailboxesPage.csvCols')}</p>
        <textarea style={{ ...input, width: '100%', minHeight: 90, fontFamily: 'monospace' }} value={csv} onChange={e => setCsv(e.target.value)} placeholder="email,display_name,provider_profile_name,purpose..." />
        <div style={{ marginTop: 6 }}>
          <button style={btnPrimary} onClick={importCsv}>{t('mailboxesPage.importCsv')}</button>
          <a style={{ ...btn, textDecoration: 'none' }} href="/api/mailboxes/export/csv" onClick={async (e) => {
            e.preventDefault();
            const r = await fetch('/api/mailboxes/export/csv', { headers: { authorization: `Bearer ${getToken()}` } });
            const blob = await r.blob(); const u = URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = u; a.download = 'mailboxes.csv'; a.click(); URL.revokeObjectURL(u);
          }}>{t('mailboxesPage.exportCsv')}</a>
        </div>
      </div>
    </div>
  );
}

// ── Provider profiles tab ────────────────────────────────────────────────────
function ProvidersTab({ t, flash }: { t: TFn; flash: (m: string) => void }) {
  const [list, setList] = useState<any[]>([]);
  const [form, setForm] = useState<any>({ name: '', provider_type: 'generic_smtp_imap', smtp_host: '', smtp_port: 587, smtp_secure: false, imap_host: '', imap_port: 993, imap_secure: true, default_daily_limit: 5, default_hourly_limit: 2 });
  const load = useCallback(async () => { const r = await api('/providers'); if (r.ok) setList(r.json.profiles); }, []);
  useEffect(() => { load(); }, [load]);
  const seedZoho = async () => { const r = await api('/providers/seed-zoho-eu', 'POST', {}); if (r.ok) { flash(r.json.alreadyExists ? t('mailboxesPage.zohoExists') : t('mailboxesPage.zohoSeeded')); load(); } };
  // Prefill the create form with a known provider's host/port (any provider works).
  const PRESETS: Record<string, any> = {
    gmail:    { name: 'Gmail / Workspace', provider_type: 'generic_smtp_imap', smtp_host: 'smtp.gmail.com', smtp_port: 587, smtp_secure: false, imap_host: 'imap.gmail.com', imap_port: 993, imap_secure: true, default_daily_limit: 5, default_hourly_limit: 2 },
    outlook:  { name: 'Outlook / Microsoft 365', provider_type: 'generic_smtp_imap', smtp_host: 'smtp.office365.com', smtp_port: 587, smtp_secure: false, imap_host: 'outlook.office365.com', imap_port: 993, imap_secure: true, default_daily_limit: 5, default_hourly_limit: 2 },
    zohocom:  { name: 'Zoho.com (global)', provider_type: 'zoho_smtp_imap', smtp_host: 'smtp.zoho.com', smtp_port: 587, smtp_secure: false, imap_host: 'imap.zoho.com', imap_port: 993, imap_secure: true, default_daily_limit: 5, default_hourly_limit: 2 },
    spacemail: { name: 'Spacemail', provider_type: 'generic_smtp_imap', smtp_host: 'mail.spacemail.com', smtp_port: 465, smtp_secure: true, imap_host: 'mail.spacemail.com', imap_port: 993, imap_secure: true, default_daily_limit: 5, default_hourly_limit: 2 },
    generic:  { name: '', provider_type: 'generic_smtp_imap', smtp_host: '', smtp_port: 587, smtp_secure: false, imap_host: '', imap_port: 993, imap_secure: true, default_daily_limit: 5, default_hourly_limit: 2 },
  };
  const create = async () => {
    if (!form.name) return flash(t('mailboxesPage.mNameReq'));
    const r = await api('/providers', 'POST', { ...form, smtp_port: Number(form.smtp_port), imap_port: Number(form.imap_port), default_daily_limit: Number(form.default_daily_limit), default_hourly_limit: Number(form.default_hourly_limit) });
    if (r.ok) { flash(t('mailboxesPage.mProfCreated')); load(); } else flash(t('mailboxesPage.mFailed') + (r.json?.error ?? r.status));
  };
  // Preset buttons CREATE the profile immediately (it appears in the list at once).
  const addPreset = async (key: string) => {
    const pr = PRESETS[key];
    if (!pr.name) { setForm({ ...pr }); flash(t('mailboxesPage.presetFillForm')); return; }  // "generic" → just prefill
    const r = await api('/providers', 'POST', { ...pr });
    if (r.ok) { flash(t('mailboxesPage.mProfCreated') + ' — ' + pr.name); load(); } else flash(t('mailboxesPage.mFailed') + (r.json?.error ?? r.status));
  };
  const toggle = async (id: number, enable: boolean) => { const r = await api(`/providers/${id}/disable`, 'POST', { enable }); if (r.ok) load(); };
  return (
    <div>
      <div style={card}>
        <b>{t('mailboxesPage.providerProfiles')}</b> <span style={{ fontSize: 11, color: '#888' }}>{t('mailboxesPage.provDesc')}</span>
        <p style={{ fontSize: 12, color: '#3f6b4d', margin: '6px 0' }}>{t('mailboxesPage.provAddAny')}</p>
        <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button style={btnPrimary} onClick={seedZoho}>{t('mailboxesPage.seedZoho')}</button>
          <button style={btnPrimary} onClick={() => addPreset('gmail')}>+ {t('mailboxesPage.presetGmail')}</button>
          <button style={btnPrimary} onClick={() => addPreset('outlook')}>+ {t('mailboxesPage.presetOutlook')}</button>
          <button style={btnPrimary} onClick={() => addPreset('zohocom')}>+ Zoho.com</button>
          <button style={btnPrimary} onClick={() => addPreset('spacemail')}>+ Spacemail</button>
          <button style={btn} onClick={() => addPreset('generic')}>{t('mailboxesPage.presetGeneric')}</button>
        </div>
        <p style={{ fontSize: 11, color: '#888', marginTop: 4 }}>{t('mailboxesPage.presetHint')}</p>
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
          <thead><tr><th style={th}>{t('mailboxesPage.cNum')}</th><th style={th}>{t('mailboxesPage.pName')}</th><th style={th}>{t('mailboxesPage.pType')}</th><th style={th}>{t('mailboxesPage.pSmtp')}</th><th style={th}>{t('mailboxesPage.pImap')}</th><th style={th}>{t('mailboxesPage.pDefaults')}</th><th style={th}>{t('mailboxesPage.cStatus')}</th><th style={th}></th></tr></thead>
          <tbody>
            {list.map(p => (
              <tr key={p.id}>
                <td style={td}>{p.id}</td><td style={td}>{p.name}</td><td style={td}>{p.provider_type}</td>
                <td style={td}>{p.smtp_host}:{p.smtp_port}</td><td style={td}>{p.imap_host}:{p.imap_port}</td>
                <td style={td}>{p.default_daily_limit}/d · {p.default_hourly_limit}/h</td>
                <td style={td}>{chip(p.status, p.status === 'active' ? '#16a34a' : '#999')}</td>
                <td style={td}><button style={btn} onClick={() => toggle(p.id, p.status !== 'active')}>{p.status === 'active' ? t('mailboxesPage.disable') : t('mailboxesPage.enable')}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={card}>
        <b>{t('mailboxesPage.createProfile')}</b>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 6 }}>
          <div><label style={label}>{t('mailboxesPage.pName')}</label><input style={input} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Zoho EU" /></div>
          <div><label style={label}>{t('mailboxesPage.pType')}</label>
            <select style={input} value={form.provider_type} onChange={e => setForm({ ...form, provider_type: e.target.value })}>
              {['generic_smtp_imap', 'zoho_smtp_imap', 'gmail_workspace_later', 'microsoft_365_later', 'self_hosted_smtp_imap_later'].map(x => <option key={x}>{x}</option>)}
            </select>
          </div>
          <div><label style={label}>{t('mailboxesPage.smtpHost')}</label><input style={input} value={form.smtp_host} onChange={e => setForm({ ...form, smtp_host: e.target.value })} placeholder="smtp.zoho.eu" /></div>
          <div><label style={label}>{t('mailboxesPage.smtpPort')}</label><input style={{ ...input, width: 70 }} value={form.smtp_port} onChange={e => setForm({ ...form, smtp_port: e.target.value })} /></div>
          <div style={{ alignSelf: 'flex-end' }}><label style={{ fontSize: 11 }}><input type="checkbox" checked={!!form.smtp_secure} onChange={e => setForm({ ...form, smtp_secure: e.target.checked })} /> {t('mailboxesPage.smtpSecure')}</label></div>
          <div><label style={label}>{t('mailboxesPage.imapHost')}</label><input style={input} value={form.imap_host} onChange={e => setForm({ ...form, imap_host: e.target.value })} placeholder="imap.zoho.eu" /></div>
          <div><label style={label}>{t('mailboxesPage.imapPort')}</label><input style={{ ...input, width: 70 }} value={form.imap_port} onChange={e => setForm({ ...form, imap_port: e.target.value })} /></div>
          <div style={{ alignSelf: 'flex-end' }}><label style={{ fontSize: 11 }}><input type="checkbox" checked={!!form.imap_secure} onChange={e => setForm({ ...form, imap_secure: e.target.checked })} /> {t('mailboxesPage.imapSecure')}</label></div>
          <div><label style={label}>{t('mailboxesPage.defaultDaily')}</label><input style={{ ...input, width: 70 }} value={form.default_daily_limit} onChange={e => setForm({ ...form, default_daily_limit: e.target.value })} /></div>
          <div><label style={label}>{t('mailboxesPage.defaultHourly')}</label><input style={{ ...input, width: 70 }} value={form.default_hourly_limit} onChange={e => setForm({ ...form, default_hourly_limit: e.target.value })} /></div>
          <div style={{ alignSelf: 'flex-end' }}><button style={btnPrimary} onClick={create}>{t('mailboxesPage.create')}</button></div>
        </div>
      </div>
    </div>
  );
}
