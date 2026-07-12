'use client';

// Phase 22G — Partner Directory Contact-Form Outreach Queue.
// Operator-controlled, NON-EMAIL outreach. Save companies from a partner
// directory, generate a short partner message, open the directory contact form,
// copy/paste, submit yourself, then track the reply. NOTHING is sent or submitted
// automatically. No login/captcha bypass. Fully i18n via useT (en/ru/uk).
import { useEffect, useState, useCallback } from 'react';
import { AppShell } from '../../components/AppShell';
import { useT } from '@/lib/useT';

function getToken(): string {
  if (typeof document === 'undefined') return '';
  return document.cookie.split('; ').find(c => c.startsWith('token='))?.split('=')[1] ?? '';
}
function authHeaders() { return { authorization: `Bearer ${getToken()}`, 'content-type': 'application/json' }; }
async function api(path: string, method = 'GET', body?: any) {
  const r = await fetch(`/api/partner-outreach${path}`, { method, headers: authHeaders(), body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (r.status === 401 && typeof window !== 'undefined') {
    window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname);
  }
  return { ok: r.ok, status: r.status, json };
}

const card: React.CSSProperties = { border: '1px solid #ddd', borderRadius: 8, padding: 14, marginTop: 12, background: '#fff' };
const btn: React.CSSProperties = { padding: '5px 10px', cursor: 'pointer', borderRadius: 6, border: '1px solid #bbb', background: '#fff', fontSize: 12, marginRight: 6, marginTop: 4 };
const btnPrimary: React.CSSProperties = { ...btn, background: '#1d4ed8', color: '#fff', borderColor: '#1d4ed8' };
const btnDanger: React.CSSProperties = { ...btn, color: '#b91c1c', borderColor: '#fca5a5' };
const input: React.CSSProperties = { padding: '6px 8px', borderRadius: 6, border: '1px solid #ccc', fontSize: 13, boxSizing: 'border-box', width: '100%' };
const label: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: '#555', display: 'block', margin: '6px 0 2px' };
const th: React.CSSProperties = { textAlign: 'left', fontSize: 11, color: '#666', padding: '4px 6px', borderBottom: '1px solid #eee' };
const td: React.CSSProperties = { fontSize: 12, padding: '4px 6px', borderBottom: '1px solid #f3f3f3', verticalAlign: 'top' };
const tabBtn = (active: boolean): React.CSSProperties => ({ ...btn, background: active ? '#1d4ed8' : '#fff', color: active ? '#fff' : '#333', borderColor: active ? '#1d4ed8' : '#bbb' });

const STATUS_COLOR: Record<string, string> = {
  new: '#888', selected: '#2563eb', queued: '#7c3aed', contacted: '#0891b2', replied: '#16a34a',
  interested: '#16a34a', not_interested: '#d97706', do_not_contact: '#dc2626', skipped: '#999', blocked: '#dc2626',
  pending_review: '#d97706', ready: '#16a34a', opened: '#2563eb', copied: '#7c3aed', submitted_manually: '#0891b2',
};
function chip(text: string) {
  return <span style={{ background: STATUS_COLOR[text] ?? '#888', color: '#fff', borderRadius: 10, padding: '1px 8px', fontSize: 11 }}>{text}</span>;
}

type Tab = 'today' | 'sources' | 'targets' | 'tasks' | 'templates';

export default function PartnerOutreachPage() {
  const t = useT();
  const fill = (key: string, v: Record<string, any> = {}) =>
    t(key).replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ''));
  const [tab, setTab] = useState<Tab>('today');
  const [msg, setMsg] = useState('');
  const [today, setToday] = useState<any>(null);
  const [sources, setSources] = useState<any[]>([]);
  const [targets, setTargets] = useState<any[]>([]);
  const [tasks, setTasks] = useState<any[]>([]);
  const [templates, setTemplates] = useState<any[]>([]);

  // forms
  const [srcForm, setSrcForm] = useState<any>({ name: '', source_url: '', platform: 'manual', status: 'active', notes: '' });
  const [showSrc, setShowSrc] = useState(false);
  const [importSource, setImportSource] = useState<number | ''>('');
  const [importText, setImportText] = useState('');
  const [importPreview, setImportPreview] = useState<any>(null);
  const [selTargets, setSelTargets] = useState<Record<number, boolean>>({});
  const [tmplId, setTmplId] = useState<number | ''>('');
  const [vars, setVars] = useState<Record<string, string>>({ sender_name: '', website___project: '', website_project: '', partner_program___directory_name: '' });

  const flash = (s: string) => { setMsg(s); };

  const load = useCallback(async () => {
    const [td, sr, tg, tk, tm] = await Promise.all([api('/today'), api('/sources'), api('/targets'), api('/tasks'), api('/templates')]);
    if (td.ok) setToday(td.json);
    if (sr.ok) setSources(sr.json.sources ?? []);
    if (tg.ok) setTargets(tg.json.targets ?? []);
    if (tk.ok) setTasks(tk.json.tasks ?? []);
    if (tm.ok) setTemplates(tm.json.templates ?? []);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function seed() {
    const r = await api('/seed', 'POST', {});
    flash(r.ok ? fill('partnerOutreach.msgSeeded', { n: r.json.templates }) : fill('partnerOutreach.msgError', { e: r.json?.error }));
    load();
  }
  async function createSource() {
    const r = await api('/sources', 'POST', srcForm);
    if (r.ok) { setShowSrc(false); setSrcForm({ name: '', source_url: '', platform: 'manual', status: 'active', notes: '' }); load(); }
    else flash(fill('partnerOutreach.msgError', { e: r.json?.error }));
  }
  async function preview() {
    const r = await api('/targets/import', 'POST', { source_id: importSource || null, text: importText, dryRun: true });
    if (r.ok) { setImportPreview(r.json); flash(fill('partnerOutreach.msgPreview', { n: r.json.parsed })); } else flash(fill('partnerOutreach.msgError', { e: r.json?.error }));
  }
  async function confirmImport() {
    const r = await api('/targets/import', 'POST', { source_id: importSource || null, text: importText, dryRun: false, confirm: true });
    if (r.ok) { flash(fill('partnerOutreach.msgImported', { created: r.json.created, duplicates: r.json.duplicates })); setImportText(''); setImportPreview(null); load(); }
    else flash(fill('partnerOutreach.msgError', { e: r.json?.error }));
  }
  async function createTasks() {
    const ids = Object.entries(selTargets).filter(([, v]) => v).map(([k]) => Number(k));
    if (!ids.length) { flash(t('partnerOutreach.msgSelectTargets')); return; }
    const r = await api('/tasks', 'POST', { target_ids: ids, template_id: tmplId || undefined, vars });
    if (r.ok) { flash(fill('partnerOutreach.msgTasksCreated', { created: r.json.created_count, skipped: r.json.skipped?.length ?? 0 })); setSelTargets({}); load(); setTab('tasks'); }
    else flash(fill('partnerOutreach.msgError', { e: r.json?.error }) + (r.status === 429 ? t('partnerOutreach.errDailyTaskLimit') : ''));
  }
  async function taskAction(id: number, action: string, body?: any) {
    const r = await api(`/tasks/${id}/${action}`, 'POST', body ?? {});
    if (action === 'copy' && r.ok) { try { await navigator.clipboard.writeText(r.json.body ?? ''); } catch {} }
    if (action === 'open' && r.ok && r.json.contact_form_url) { try { window.open(r.json.contact_form_url, '_blank', 'noopener'); } catch {} }
    flash(r.ok ? fill('partnerOutreach.msgOkAction', { action }) : fill('partnerOutreach.msgError', { e: r.json?.error }) + (r.status === 429 ? t('partnerOutreach.errDailySubmissionLimit') : ''));
    load();
  }
  async function targetAction(id: number, status: string) {
    const r = await api(`/targets/${id}`, 'PATCH', { status });
    flash(r.ok ? t('partnerOutreach.msgOk') : fill('partnerOutreach.msgError', { e: r.json?.error })); load();
  }

  return (
    <AppShell pageKey="partnerOutreach" pageTitle={t('partnerOutreach.pageTitle')}>
      <div style={{ maxWidth: 1000, margin: '0 auto' }}>
        <h1 style={{ fontSize: 22, marginBottom: 4 }}>{t('partnerOutreach.pageTitle')}</h1>
        <p style={{ fontSize: 13, color: '#555' }}>{t('partnerOutreach.intro')}</p>
        <div style={{ ...card, background: '#fffbeb', borderColor: '#fcd34d', fontSize: 12 }}>⚠ {t('partnerOutreach.safetyBanner')}</div>

        <div style={{ marginTop: 12 }}>
          {(['today', 'sources', 'targets', 'tasks', 'templates'] as Tab[]).map(x => (
            <button key={x} style={tabBtn(tab === x)} onClick={() => setTab(x)}>{t(`partnerOutreach.tab${x.charAt(0).toUpperCase() + x.slice(1)}`)}</button>
          ))}
          <button style={btn} onClick={load}>{t('partnerOutreach.btnRefresh')}</button>
          <button style={btn} onClick={seed}>{t('partnerOutreach.btnSeed')}</button>
        </div>
        {msg && <div style={{ ...card, fontSize: 12, display: 'flex', justifyContent: 'space-between' }}><span>{msg}</span><span style={{ cursor: 'pointer' }} onClick={() => setMsg('')}>✕</span></div>}

        {/* TODAY */}
        {tab === 'today' && today && (
          <div style={card}>
            <div style={{ fontSize: 13, marginBottom: 8 }}><b>{t('partnerOutreach.nextAction')}:</b> {today.next_action}</div>
            <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 13 }}>
              <div>{t('partnerOutreach.tasksToday')}: <b>{today.tasks_created_today}</b> / {today.limits?.max_tasks_per_day}</div>
              <div>{t('partnerOutreach.subsToday')}: <b>{today.submissions_today}</b> (max {today.limits?.max_submissions_per_source_per_day}/source)</div>
            </div>
            <div style={{ marginTop: 10, fontSize: 12 }}>
              <b>{t('partnerOutreach.lblTargets')}:</b> {Object.entries(today.targets_by_status || {}).map(([k, v]) => <span key={k} style={{ marginRight: 8 }}>{chip(k)} {String(v)}</span>)}
            </div>
            <div style={{ marginTop: 6, fontSize: 12 }}>
              <b>{t('partnerOutreach.lblTasks')}:</b> {Object.entries(today.tasks_by_status || {}).map(([k, v]) => <span key={k} style={{ marginRight: 8 }}>{chip(k)} {String(v)}</span>)}
            </div>
            <p style={{ fontSize: 11, color: '#16a34a', marginTop: 10 }}>✓ {t('partnerOutreach.noAutoSubmit')}</p>
          </div>
        )}

        {/* SOURCES */}
        {tab === 'sources' && (
          <div style={card}>
            <button style={btnPrimary} onClick={() => setShowSrc(!showSrc)}>{t('partnerOutreach.btnAddSource')}</button>
            {showSrc && (
              <div style={{ ...card, background: '#f9fafb' }}>
                <label style={label}>{t('partnerOutreach.sourceName')}</label>
                <input style={input} value={srcForm.name} onChange={e => setSrcForm({ ...srcForm, name: e.target.value })} />
                <label style={label}>{t('partnerOutreach.sourceUrl')}</label>
                <input style={input} value={srcForm.source_url} onChange={e => setSrcForm({ ...srcForm, source_url: e.target.value })} />
                <label style={label}>{t('partnerOutreach.platform')}</label>
                <select style={input} value={srcForm.platform} onChange={e => setSrcForm({ ...srcForm, platform: e.target.value })}>
                  <option value="manual">manual</option><option value="ziftone">ziftone</option><option value="other">other</option>
                </select>
                <div style={{ marginTop: 8 }}>
                  <button style={btnPrimary} onClick={createSource}>{t('partnerOutreach.btnSave')}</button>
                  <button style={btn} onClick={() => setShowSrc(false)}>{t('partnerOutreach.btnCancel')}</button>
                </div>
              </div>
            )}
            <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 10 }}>
              <thead><tr><th style={th}>id</th><th style={th}>{t('partnerOutreach.sourceName')}</th><th style={th}>{t('partnerOutreach.platform')}</th><th style={th}>{t('partnerOutreach.status')}</th><th style={th}>URL</th></tr></thead>
              <tbody>{sources.map(s => (
                <tr key={s.id}><td style={td}>{s.id}</td><td style={td}>{s.name}</td><td style={td}>{s.platform}</td><td style={td}>{chip(s.status)}</td><td style={td}><a href={s.source_url} target="_blank" rel="noopener noreferrer">{s.source_url}</a></td></tr>
              ))}{!sources.length && <tr><td style={td} colSpan={5}>{t('partnerOutreach.empty')}</td></tr>}</tbody>
            </table>
          </div>
        )}

        {/* TARGETS */}
        {tab === 'targets' && (
          <div style={card}>
            <h3 style={{ fontSize: 14 }}>{t('partnerOutreach.importTitle')}</h3>
            <p style={{ fontSize: 11, color: '#666' }}>{t('partnerOutreach.importHint')}</p>
            <p style={{ fontSize: 11, color: '#b45309' }}>ℹ {t('partnerOutreach.discoverHint')}</p>
            <label style={label}>{t('partnerOutreach.sourceName')}</label>
            <select style={input} value={importSource} onChange={e => setImportSource(e.target.value ? Number(e.target.value) : '')}>
              <option value="">—</option>{sources.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <textarea style={{ ...input, height: 90, marginTop: 6, fontFamily: 'monospace' }} value={importText} onChange={e => setImportText(e.target.value)} placeholder={'company_name,website_url,profile_url,category,country\nAcme Inc,https://acme.com,,Accounting,US'} />
            <div><button style={btn} onClick={preview}>{t('partnerOutreach.btnDryRun')}</button>
              {importPreview && <button style={btnPrimary} onClick={confirmImport}>{t('partnerOutreach.btnImportConfirm')} ({importPreview.parsed})</button>}</div>
            {importPreview && <pre style={{ fontSize: 11, background: '#f6f6f6', padding: 8, overflowX: 'auto', maxHeight: 160 }}>{JSON.stringify(importPreview.sample, null, 1)}</pre>}

            <h3 style={{ fontSize: 14, marginTop: 14 }}>{t('partnerOutreach.tabTargets')}</h3>
            <div style={{ marginBottom: 6 }}>
              <label style={label}>{t('partnerOutreach.selectTemplate')}</label>
              <select style={input} value={tmplId} onChange={e => setTmplId(e.target.value ? Number(e.target.value) : '')}>
                <option value="">—</option>{templates.map(tm => <option key={tm.id} value={tm.id}>{tm.name}</option>)}
              </select>
              <p style={{ fontSize: 11, color: '#666', margin: '4px 0' }}>{t('partnerOutreach.varsHint')}</p>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <input style={{ ...input, width: 200 }} placeholder={t('partnerOutreach.phSenderName')} value={vars.sender_name} onChange={e => setVars({ ...vars, sender_name: e.target.value })} />
                <input style={{ ...input, width: 200 }} placeholder={t('partnerOutreach.phWebsiteProject')} value={vars.website___project} onChange={e => setVars({ ...vars, website___project: e.target.value, website_project: e.target.value })} />
                <input style={{ ...input, width: 240 }} placeholder={t('partnerOutreach.phPartnerProgram')} value={vars.partner_program___directory_name} onChange={e => setVars({ ...vars, partner_program___directory_name: e.target.value })} />
              </div>
              <button style={btnPrimary} onClick={createTasks}>{t('partnerOutreach.btnCreateTasks')}</button>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr><th style={th}></th><th style={th}>{t('partnerOutreach.colCompany')}</th><th style={th}>{t('partnerOutreach.colCategory')}</th><th style={th}>{t('partnerOutreach.colCountry')}</th><th style={th}>{t('partnerOutreach.colStatus')}</th><th style={th}>{t('partnerOutreach.colActions')}</th></tr></thead>
              <tbody>{targets.map(g => (
                <tr key={g.id}>
                  <td style={td}><input type="checkbox" checked={!!selTargets[g.id]} onChange={e => setSelTargets({ ...selTargets, [g.id]: e.target.checked })} /></td>
                  <td style={td}>{g.company_name}{g.website_url && <div><a href={g.website_url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11 }}>{g.website_url}</a></div>}</td>
                  <td style={td}>{g.category}</td><td style={td}>{g.country}</td><td style={td}>{chip(g.status)}</td>
                  <td style={td}><button style={btnDanger} onClick={() => targetAction(g.id, 'do_not_contact')}>{t('partnerOutreach.btnDnc')}</button></td>
                </tr>
              ))}{!targets.length && <tr><td style={td} colSpan={6}>{t('partnerOutreach.empty')}</td></tr>}</tbody>
            </table>
          </div>
        )}

        {/* TASKS */}
        {tab === 'tasks' && (
          <div style={card}>
            <p style={{ fontSize: 11, color: '#16a34a' }}>✓ {t('partnerOutreach.noAutoSubmit')}</p>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr><th style={th}>{t('partnerOutreach.colCompany')}</th><th style={th}>{t('partnerOutreach.colMessage')}</th><th style={th}>{t('partnerOutreach.colStatus')}</th><th style={th}>{t('partnerOutreach.colActions')}</th></tr></thead>
              <tbody>{tasks.map(tk => (
                <tr key={tk.id}>
                  <td style={td}>{tk.company_name}{tk.contact_form_url && <div><a href={tk.contact_form_url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11 }}>{t('partnerOutreach.linkForm')}</a></div>}</td>
                  <td style={td}><div style={{ fontWeight: 600 }}>{tk.message_subject}</div><pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', margin: 0, maxWidth: 360 }}>{tk.message_body}</pre>{tk.blockers?.length ? <div style={{ fontSize: 11, color: '#dc2626' }}>⚠ {tk.blockers.join(', ')}</div> : null}</td>
                  <td style={td}>{chip(tk.status)}</td>
                  <td style={td}>
                    <button style={btn} onClick={() => taskAction(tk.id, 'open')}>{t('partnerOutreach.btnOpenForm')}</button>
                    <button style={btn} onClick={() => taskAction(tk.id, 'copy')}>{t('partnerOutreach.btnCopy')}</button>
                    <button style={btnPrimary} onClick={() => taskAction(tk.id, 'mark-submitted')}>{t('partnerOutreach.btnMarkSubmitted')}</button>
                    <button style={btn} onClick={() => taskAction(tk.id, 'reply', { outcome: 'replied' })}>{t('partnerOutreach.btnReplied')}</button>
                    <button style={btn} onClick={() => taskAction(tk.id, 'reply', { outcome: 'interested' })}>{t('partnerOutreach.btnInterested')}</button>
                    <button style={btn} onClick={() => taskAction(tk.id, 'reply', { outcome: 'not_interested' })}>{t('partnerOutreach.btnNotInterested')}</button>
                    <button style={btn} onClick={() => taskAction(tk.id, 'skip')}>{t('partnerOutreach.btnSkip')}</button>
                    <button style={btnDanger} onClick={() => taskAction(tk.id, 'do-not-contact')}>{t('partnerOutreach.btnDnc')}</button>
                  </td>
                </tr>
              ))}{!tasks.length && <tr><td style={td} colSpan={4}>{t('partnerOutreach.empty')}</td></tr>}</tbody>
            </table>
          </div>
        )}

        {/* TEMPLATES */}
        {tab === 'templates' && (
          <div style={card}>
            {templates.map(tm => (
              <div key={tm.id} style={{ ...card, background: '#f9fafb' }}>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{tm.name} <span style={{ fontSize: 11, color: '#888' }}>({tm.use_case})</span></div>
                <div style={{ fontSize: 12, color: '#555' }}>{tm.subject}</div>
                <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', background: '#fff', padding: 8, border: '1px solid #eee', marginTop: 6 }}>{tm.body}</pre>
              </div>
            ))}{!templates.length && <p style={{ fontSize: 12 }}>{t('partnerOutreach.empty')}</p>}
          </div>
        )}
      </div>
    </AppShell>
  );
}
