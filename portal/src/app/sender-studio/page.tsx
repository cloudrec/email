'use client';

// Phase 22C — Sender Studio.
// Create / edit / preview / validate / approve / version email templates before
// any real sending. Three editor modes (plain / html / visual-lite), live HTML
// preview (desktop / mobile / dark / plain / source), variable panel with clear
// <<< REPLACE: Label >>> fields, footer builder, spam + link checker, badges,
// import / export, version history. NO sending happens from this page.
import { useEffect, useMemo, useRef, useState } from 'react';
import { AppShell } from '../../components/AppShell';
import { useT } from '@/lib/useT';

function getToken(): string {
  if (typeof document === 'undefined') return '';
  return document.cookie.split('; ').find(c => c.startsWith('token='))?.split('=')[1] ?? '';
}
function authHeaders() { return { authorization: `Bearer ${getToken()}`, 'content-type': 'application/json' }; }

// Lightweight conversions used when switching editor modes so the body text
// stays visible instead of silently moving to a hidden field.
function plainToHtml(s: string): string {
  const esc = (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.split(/\n{2,}/).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('\n');
}
function htmlToPlain(s: string): string {
  return (s || '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|h[1-6]|li|tr)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/\n{3,}/g, '\n\n').trim();
}
async function api(path: string, method = 'GET', body?: any) {
  const r = await fetch(`/api/sender-studio${path}`, { method, headers: authHeaders(), body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (r.status === 401 && typeof window !== 'undefined') {
    window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname);
  }
  return { ok: r.ok, status: r.status, json };
}

const card: React.CSSProperties = { border: '1px solid #ddd', borderRadius: 8, padding: 14, marginTop: 12, background: '#fff' };
const btn: React.CSSProperties = { padding: '6px 12px', cursor: 'pointer', borderRadius: 6, border: '1px solid #bbb', background: '#fff', fontSize: 13 };
const btnPrimary: React.CSSProperties = { ...btn, background: '#1d4ed8', color: '#fff', borderColor: '#1d4ed8' };
const btnDanger: React.CSSProperties = { ...btn, color: '#b91c1c', borderColor: '#fca5a5' };
const input: React.CSSProperties = { width: '100%', padding: '7px 9px', borderRadius: 6, border: '1px solid #ccc', fontSize: 13, boxSizing: 'border-box' };
const label: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: '#555', display: 'block', margin: '8px 0 3px' };

const sevColor = (s: string) => s === 'safe' ? '#15803d' : s === 'warning' ? '#b45309' : '#b91c1c';
const badgeStyle = (txt: string): React.CSSProperties => {
  const danger = ['Needs address', 'Needs opt-out', 'Unapproved', 'Archived'].includes(txt);
  const warn = ['Has risky wording', 'Too many links', 'Draft version'].includes(txt);
  const ok = ['Ready', 'Approved'].includes(txt);
  const bg = ok ? '#dcfce7' : warn ? '#fef3c7' : danger ? '#fee2e2' : '#e5e7eb';
  const fg = ok ? '#15803d' : warn ? '#b45309' : danger ? '#b91c1c' : '#374151';
  return { display: 'inline-block', padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700, background: bg, color: fg, marginRight: 4, marginBottom: 4 };
};

interface Tpl {
  id: number; template_key: string; name: string; subject: string; preheader: string | null;
  body: string; html_body: string | null; blocks_json: string | null; category: string;
  language: string; status: string; editor_mode: string; use_case: string | null;
  version: number; approved: number; statusBadge?: string;
  validation?: { status: string; canApprove: boolean; badges: string[]; issueCount: number };
}
interface Meta {
  categories: string[]; editorModes: string[]; languages: string[];
  variables: { key: string; label: string; demo: string | null }[];
  footers: { cold: string; unsubscribe: string };
}

// Map server-returned badge/status strings to senderStudio.* key suffixes.
const BADGE_KEY: Record<string, string> = {
  'Needs address': 'badgeNeedsAddress',
  'Needs opt-out': 'badgeNeedsOptOut',
  'Unapproved': 'badgeUnapproved',
  'Archived': 'badgeArchived',
  'Has risky wording': 'badgeRiskyWording',
  'Too many links': 'badgeTooManyLinks',
  'Draft version': 'badgeDraftVersion',
  'Ready': 'badgeReady',
  'Approved': 'badgeApproved',
  'safe': 'statusSafe',
  'warning': 'statusWarning',
  'blocked': 'statusBlocked',
};

// Translate a server badge/status string for display; unmapped strings shown raw.
function badgeText(t: (k: string) => string, s: string): string {
  if (!s) return '';
  const key = BADGE_KEY[s];
  return key ? t(`senderStudio.${key}`) : s;
}

export default function SenderStudioPage() {
  const t = useT();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [list, setList] = useState<Tpl[]>([]);
  const [selId, setSelId] = useState<number | null>(null);
  const [msg, setMsg] = useState('');

  async function loadMeta() { const r = await api('/meta'); if (r.ok) setMeta(r.json); }
  async function loadList() { const r = await api('/templates?includeArchived=1'); if (r.ok) setList(r.json.templates); }
  useEffect(() => { loadMeta(); loadList(); }, []);

  return (
    <AppShell pageKey="senderStudio" pageTitle={t('senderStudio.pageTitle')}>
      <div style={{ maxWidth: 1280, margin: '0 auto', padding: 16 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700 }}>{t('senderStudio.pageTitle')}</h1>
        <p style={{ color: '#92400e', fontWeight: 600, fontSize: 13 }}>
          {t('senderStudio.intro')}
        </p>
        {msg && <p style={{ color: '#1d4ed8', whiteSpace: 'pre-wrap', fontSize: 13 }}>{msg}</p>}
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ flex: '0 0 320px', minWidth: 280 }}>
            <TemplateList list={list} selId={selId} onSelect={setSelId} meta={meta}
              reload={loadList} setMsg={setMsg} />
          </div>
          <div style={{ flex: '1 1 600px', minWidth: 480 }}>
            {selId
              ? <Editor key={selId} id={selId} meta={meta} reload={loadList} setMsg={setMsg}
                  onDeleted={() => { setSelId(null); loadList(); }} />
              : <div style={{ ...card, color: '#666' }}>{t('senderStudio.emptyState')}</div>}
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function TemplateList({ list, selId, onSelect, meta, reload, setMsg }: any) {
  const t = useT();
  const [importing, setImporting] = useState(false);
  const [importText, setImportText] = useState('');

  async function createNew() {
    const r = await api('/templates', 'POST', { name: 'New template', category: 'generic_service', editorMode: 'plain', body: '', subject: '' });
    if (r.ok) { setMsg(t('senderStudio.msgCreatedDraft')); await reload(); onSelect(r.json.id); }
    else setMsg(t('senderStudio.msgCreateFailed').replace('{e}', String(r.json?.error)));
  }
  async function doImport() {
    let parsed: any;
    try { parsed = JSON.parse(importText); } catch { setMsg(t('senderStudio.msgImportInvalidJson')); return; }
    const r = await api('/import', 'POST', parsed);
    if (r.ok) { setMsg(r.json.note); setImporting(false); setImportText(''); await reload(); onSelect(r.json.id); }
    else setMsg(t('senderStudio.msgImportFailed').replace('{e}', JSON.stringify(r.json?.detail ?? r.json?.error)));
  }
  async function seedPack() { const r = await api('/seed-clients-help', 'POST', {}); if (r.ok) { setMsg(r.json.note); reload(); } }

  return (
    <div style={card}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        <button style={btnPrimary} onClick={createNew}>{t('senderStudio.btnNew')}</button>
        <button style={btn} onClick={() => setImporting(v => !v)}>{t('senderStudio.btnImportJson')}</button>
        <button style={btn} onClick={seedPack}>{t('senderStudio.btnSeedClientsHelp')}</button>
      </div>
      {importing && (
        <div style={{ marginBottom: 10 }}>
          <textarea style={{ ...input, height: 120, fontFamily: 'monospace' }} placeholder='{"name":"...","subject":"...","body":"..."}'
            value={importText} onChange={e => setImportText(e.target.value)} />
          <button style={btnPrimary} onClick={doImport}>{t('senderStudio.btnImportAsDraft')}</button>
        </div>
      )}
      <div style={{ maxHeight: 620, overflowY: 'auto' }}>
        {list.map((tpl: Tpl) => (
          <div key={tpl.id} onClick={() => onSelect(tpl.id)}
            style={{ padding: 9, borderRadius: 6, cursor: 'pointer', marginBottom: 6,
              border: selId === tpl.id ? '2px solid #1d4ed8' : '1px solid #e5e7eb', background: selId === tpl.id ? '#eff6ff' : '#fff' }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>{tpl.name}</div>
            <div style={{ fontSize: 11, color: '#777', margin: '2px 0' }}>{tpl.category} · v{tpl.version}</div>
            <div>
              <span style={badgeStyle(tpl.statusBadge ?? '')}>{badgeText(t, tpl.statusBadge ?? '')}</span>
              {tpl.validation && <span style={badgeStyle(tpl.validation.status === 'safe' ? 'Ready' : tpl.validation.status)}>{badgeText(t, tpl.validation.status)}</span>}
              {tpl.validation?.badges.filter((b: string) => b !== 'Ready').map((b: string) => <span key={b} style={badgeStyle(b)}>{badgeText(t, b)}</span>)}
            </div>
          </div>
        ))}
        {!list.length && <div style={{ color: '#888', fontSize: 13 }}>{t('senderStudio.noTemplatesYet')}</div>}
      </div>
    </div>
  );
}

const EMPTY_BLOCK: Record<string, any> = {
  heading: { type: 'heading', text: 'Heading' },
  paragraph: { type: 'paragraph', text: 'Paragraph text...' },
  button: { type: 'button', text: 'Open', href: 'https://' },
  divider: { type: 'divider' },
  list: { type: 'list', items: ['First point', 'Second point'] },
  signature: { type: 'signature', text: 'Best,\n{{sender_name}}\n{{sender_company}}' },
  footer: { type: 'footer', text: 'If this is not relevant, reply "no" and I won\'t contact you again.\nBusiness address: {{business_address}}' },
  image: { type: 'image', src: 'https://via.placeholder.com/600x180', alt: 'image' },
};

function Editor({ id, meta, reload, setMsg, onDeleted }: any) {
  const T = useT();
  const [t, setT] = useState<Tpl | null>(null);
  const [dirty, setDirty] = useState(false);
  const [validation, setValidation] = useState<any>(null);
  const [previewHtml, setPreviewHtml] = useState('');
  const [previewText, setPreviewText] = useState('');
  const [previewSubject, setPreviewSubject] = useState('');
  const [device, setDevice] = useState<'desktop' | 'mobile' | 'dark' | 'plain' | 'source'>('desktop');
  const [dataMode, setDataMode] = useState<'variable' | 'human'>('variable');
  const [versions, setVersions] = useState<any[]>([]);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  async function load() {
    const r = await api(`/templates/${id}`);
    if (r.ok) { setT(r.json.template); setValidation(r.json.validation); setDirty(false); }
  }
  useEffect(() => { load(); }, [id]);

  const blocks = useMemo(() => { try { return t?.blocks_json ? JSON.parse(t.blocks_json) : []; } catch { return []; } }, [t?.blocks_json]);

  // Live validate + preview whenever the editor content changes.
  async function refreshPreview(cur: Tpl) {
    const payload: any = { subject: cur.subject, preheader: cur.preheader, body: cur.body, htmlBody: cur.html_body, category: cur.category, editorMode: cur.editor_mode };
    if (cur.editor_mode === 'visual_lite') { try { payload.blocks = JSON.parse(cur.blocks_json || '[]'); } catch {} }
    const [v, p] = await Promise.all([
      api('/validate', 'POST', payload),
      api(`/preview?data=${dataMode}`, 'POST', payload),
    ]);
    if (v.ok) setValidation(v.json);
    if (p.ok) { setPreviewHtml(p.json.html); setPreviewText(p.json.text); setPreviewSubject(p.json.subject); }
  }
  useEffect(() => { if (t) refreshPreview(t); /* eslint-disable-next-line */ }, [t, dataMode]);

  function patch(p: Partial<Tpl>) { setT(prev => prev ? { ...prev, ...p } : prev); setDirty(true); }

  function insertVar(key: string) {
    const token = `{{${key}}}`;
    if (t?.editor_mode === 'html') { patch({ html_body: (t.html_body ?? '') + token }); return; }
    const el = bodyRef.current;
    if (el && t) {
      const s = el.selectionStart ?? t.body.length, e = el.selectionEnd ?? t.body.length;
      patch({ body: t.body.slice(0, s) + token + t.body.slice(e) });
    } else if (t) patch({ body: (t.body ?? '') + token });
  }
  function insertFooter() {
    if (!meta || !t) return;
    const f = t.category === 'newsletter' ? meta.footers.unsubscribe : meta.footers.cold;
    patch({ body: (t.body ? t.body + '\n\n' : '') + f });
  }

  async function save() {
    if (!t) return;
    const payload: any = {
      name: t.name, subject: t.subject, preheader: t.preheader, body: t.body,
      htmlBody: t.html_body, category: t.category, language: t.language,
      editorMode: t.editor_mode, useCase: t.use_case,
    };
    if (t.editor_mode === 'visual_lite') { try { payload.blocks = JSON.parse(t.blocks_json || '[]'); } catch { payload.blocks = []; } }
    const r = await api(`/templates/${id}`, 'PATCH', payload);
    if (r.ok) { setMsg(r.json.versioned ? T('senderStudio.msgSavedVersioned').replace('{prev}', String(r.json.newVersion - 1)).replace('{new}', String(r.json.newVersion)) : T('senderStudio.msgSaved')); await load(); await reload(); }
    else setMsg(T('senderStudio.msgSaveFailed').replace('{e}', JSON.stringify(r.json?.detail ?? r.json?.error)));
  }
  async function approve() {
    const r = await api(`/templates/${id}/approve`, 'POST', {});
    if (r.ok) { setMsg(T('senderStudio.msgApproved').replace('{status}', String(r.json.status)).replace('{warn}', r.json.warnings?.length ? T('senderStudio.msgApprovedWarnSuffix').replace('{n}', String(r.json.warnings.length)) : '')); await load(); await reload(); }
    else setMsg(T('senderStudio.msgApprovalBlocked').replace('{msgs}', (r.json.blockers || []).map((b: any) => b.message).join(' ')));
  }
  async function act(path: string, ok: string) { const r = await api(`/templates/${id}/${path}`, 'POST', {}); if (r.ok) { setMsg(ok); await load(); await reload(); } else setMsg(T('senderStudio.msgActionFailed').replace('{e}', String(r.json?.error))); }
  async function duplicate() { const r = await api(`/templates/${id}/duplicate`, 'POST', {}); if (r.ok) { setMsg(T('senderStudio.msgDuplicated')); await reload(); } }
  async function loadVersions() { const r = await api(`/templates/${id}/versions`); if (r.ok) setVersions(r.json.versions); }

  // Export must go through fetch with the Bearer token — a plain <a href> browser
  // navigation sends no Authorization header and the API returns 401 unauthorized.
  async function downloadExport(fmt: 'json' | 'html' | 'txt') {
    const r = await fetch(`/api/sender-studio/templates/${id}/export?format=${fmt}`, { headers: { authorization: `Bearer ${getToken()}` } });
    if (!r.ok) { setMsg(T('senderStudio.msgExportFailed').replace('{e}', String(r.status))); return; }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(t?.name || 'template').replace(/[^a-z0-9_-]+/gi, '_')}.${fmt}`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  // Switching editor mode must not "lose" the visible body: each mode stores text
  // in a different field (plain→body, html→html_body, visual_lite→blocks_json).
  // Seed the target field from the current content when it is empty (never overwrite).
  function changeEditorMode(mode: string) {
    if (!t || mode === t.editor_mode) return;
    const p: Partial<Tpl> = { editor_mode: mode };
    const plain = (t.body ?? '').trim();
    const html = (t.html_body ?? '').trim();
    let hasBlocks = false; try { hasBlocks = JSON.parse(t.blocks_json || '[]').length > 0; } catch {}
    if (mode === 'html' && !html && plain) p.html_body = plainToHtml(t.body);
    if (mode === 'plain' && !plain && html) p.body = htmlToPlain(t.html_body!);
    if (mode === 'visual_lite' && !hasBlocks) {
      const seed = plain || (html ? htmlToPlain(t.html_body!) : '');
      if (seed) p.blocks_json = JSON.stringify([{ type: 'paragraph', text: seed }]);
    }
    patch(p);
  }

  if (!t || !meta) return <div style={card}>{T('senderStudio.loading')}</div>;
  const blocked = validation && validation.status === 'blocked';

  return (
    <div>
      {/* Header + actions */}
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <input style={{ ...input, fontWeight: 700, fontSize: 15, maxWidth: 380 }} value={t.name} onChange={e => patch({ name: e.target.value })} />
          <div>
            {validation && <span style={badgeStyle(validation.status === 'safe' ? 'Ready' : validation.status)}>{badgeText(T, validation.status)}</span>}
            <span style={badgeStyle(t.approved ? 'Approved' : 'Unapproved')}>{t.approved ? T('senderStudio.badgeApproved') : T('senderStudio.badgeUnapproved')}</span>
            <span style={badgeStyle('Draft version')}>v{t.version}</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
          <button style={btnPrimary} onClick={save} disabled={!dirty}>{T('senderStudio.btnSave')}</button>
          {!t.approved
            ? <button style={{ ...btn, opacity: blocked ? 0.5 : 1 }} onClick={approve} disabled={blocked} title={blocked ? T('senderStudio.titleFixBlocking') : T('senderStudio.titleApprove')}>{T('senderStudio.btnApprove')}</button>
            : <button style={btn} onClick={() => act('unapprove', T('senderStudio.msgUnapproved'))}>{T('senderStudio.btnUnapprove')}</button>}
          <button style={btn} onClick={duplicate}>{T('senderStudio.btnDuplicate')}</button>
          {t.status !== 'archived'
            ? <button style={btnDanger} onClick={() => act('archive', T('senderStudio.msgArchived'))}>{T('senderStudio.btnArchive')}</button>
            : <button style={btn} onClick={() => act('unarchive', T('senderStudio.msgUnarchived'))}>{T('senderStudio.btnUnarchive')}</button>}
          <button style={btn} onClick={() => downloadExport('json')}>{T('senderStudio.btnExportJson')}</button>
          <button style={btn} onClick={() => downloadExport('html')}>{T('senderStudio.btnExportHtml')}</button>
          <button style={btn} onClick={() => downloadExport('txt')}>{T('senderStudio.btnExportTxt')}</button>
          <button style={btn} onClick={loadVersions}>{T('senderStudio.btnVersions')}</button>
        </div>
      </div>

      {/* Fields */}
      <div style={card}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 160px' }}>
            <label style={label}>{T('senderStudio.fieldCategory')}</label>
            <select style={input} value={t.category} onChange={e => patch({ category: e.target.value })}>
              {meta.categories.map((c: string) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div style={{ flex: '0 0 110px' }}>
            <label style={label}>{T('senderStudio.fieldLanguage')}</label>
            <select style={input} value={t.language} onChange={e => patch({ language: e.target.value })}>
              {meta.languages.map((l: string) => <option key={l} value={l}>{l}</option>)}
            </select>
          </div>
          <div style={{ flex: '0 0 150px' }}>
            <label style={label}>{T('senderStudio.fieldEditorMode')}</label>
            <select style={input} value={t.editor_mode} onChange={e => changeEditorMode(e.target.value)}>
              {meta.editorModes.map((m: string) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
        </div>
        <label style={label}>{T('senderStudio.fieldSubject')}</label>
        <input style={input} value={t.subject} onChange={e => patch({ subject: e.target.value })} />
        <label style={label}>{T('senderStudio.fieldPreheader')}</label>
        <input style={input} value={t.preheader ?? ''} onChange={e => patch({ preheader: e.target.value })} />
        <label style={label}>{T('senderStudio.fieldUseCase')}</label>
        <input style={input} value={t.use_case ?? ''} onChange={e => patch({ use_case: e.target.value })} />

        {/* Variable panel */}
        <label style={label}>{T('senderStudio.fieldInsertReplaceField')}</label>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {meta.variables.map((v: any) => (
            <button key={v.key} style={{ ...btn, fontSize: 11, padding: '3px 7px' }} onClick={() => insertVar(v.key)} title={`{{${v.key}}}`}>+ {v.label}</button>
          ))}
          <button style={{ ...btn, fontSize: 11, padding: '3px 7px', borderColor: '#1d4ed8', color: '#1d4ed8' }} onClick={insertFooter}>{T('senderStudio.btnDefaultFooter')}</button>
        </div>

        {/* Editor by mode */}
        {t.editor_mode === 'plain' && (
          <>
            <label style={label}>{T('senderStudio.fieldPlainBody')}</label>
            <textarea ref={bodyRef} style={{ ...input, height: 240, fontFamily: 'monospace' }} value={t.body} onChange={e => patch({ body: e.target.value })} />
          </>
        )}
        {t.editor_mode === 'html' && (
          <>
            <label style={label}>{T('senderStudio.fieldHtmlBody')}</label>
            <textarea style={{ ...input, height: 200, fontFamily: 'monospace' }} value={t.html_body ?? ''} onChange={e => patch({ html_body: e.target.value })} />
            <label style={label}>{T('senderStudio.fieldPlainFallback')}</label>
            <textarea ref={bodyRef} style={{ ...input, height: 120, fontFamily: 'monospace' }} value={t.body} onChange={e => patch({ body: e.target.value })} />
          </>
        )}
        {t.editor_mode === 'visual_lite' && (
          <VisualLite blocks={blocks} onChange={(b: any) => patch({ blocks_json: JSON.stringify(b) })} />
        )}
      </div>

      {/* Validation */}
      {validation && (
        <div style={card}>
          <div style={{ fontWeight: 700, color: sevColor(validation.status) }}>
            {T('senderStudio.safetyLabel')}: {validation.status.toUpperCase()} · {validation.canApprove ? T('senderStudio.canApprove') : T('senderStudio.approvalBlocked')} · {T('senderStudio.linksCount').replace('{n}', String(validation.links.count))}
          </div>
          <div style={{ marginTop: 6 }}>
            {validation.badges.map((b: string) => <span key={b} style={badgeStyle(b)}>{badgeText(T, b)}</span>)}
          </div>
          {validation.issues.length === 0 && <div style={{ color: '#15803d', fontSize: 13, marginTop: 6 }}>{T('senderStudio.noIssues')}</div>}
          <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 13 }}>
            {validation.issues.map((i: any, n: number) => (
              <li key={n} style={{ color: i.level === 'block' ? '#b91c1c' : '#b45309', marginBottom: 3 }}>
                <b>{i.level === 'block' ? T('senderStudio.levelBlock') : T('senderStudio.levelWarn')}:</b> {i.message}
              </li>
            ))}
          </ul>
          {validation.links.findings.filter((f: any) => !f.ok).length > 0 && (
            <div style={{ fontSize: 12, color: '#b45309', marginTop: 6 }}>
              {T('senderStudio.linkIssues')}: {validation.links.findings.filter((f: any) => !f.ok).map((f: any) => `${f.url} (${f.issues.join(', ')})`).join('; ')}
            </div>
          )}
        </div>
      )}

      {/* Preview */}
      <div style={card}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
          {(['desktop', 'mobile', 'dark', 'plain', 'source'] as const).map(d => (
            <button key={d} style={device === d ? btnPrimary : btn} onClick={() => setDevice(d)}>{T(`senderStudio.device_${d}`)}</button>
          ))}
          <span style={{ marginLeft: 'auto' }} />
          <button style={dataMode === 'variable' ? btnPrimary : btn} onClick={() => setDataMode('variable')}>{T('senderStudio.btnReplaceFields')}</button>
          <button style={dataMode === 'human' ? btnPrimary : btn} onClick={() => setDataMode('human')}>{T('senderStudio.btnDemoData')}</button>
        </div>
        <div style={{ fontSize: 12, color: '#555', marginBottom: 6 }}>
          <b>{T('senderStudio.fromLabel')}:</b> {dataMode === 'human' ? 'Andrey <andrey@clients.help>' : '<<< REPLACE: Sender name >>>'} &nbsp;·&nbsp; <b>{T('senderStudio.subjectLabel')}:</b> {previewSubject || T('senderStudio.empty')}
        </div>
        {device === 'plain' && <pre style={{ whiteSpace: 'pre-wrap', fontSize: 13, background: '#fafafa', padding: 12, borderRadius: 6, border: '1px solid #eee' }}>{previewText || T('senderStudio.empty')}</pre>}
        {device === 'source' && <pre style={{ whiteSpace: 'pre-wrap', fontSize: 11, fontFamily: 'monospace', background: '#0b1021', color: '#a5d6ff', padding: 12, borderRadius: 6, maxHeight: 420, overflow: 'auto' }}>{previewHtml}</pre>}
        {(device === 'desktop' || device === 'mobile' || device === 'dark') && (
          <div style={{ background: device === 'dark' ? '#111' : '#e9eaed', padding: 12, borderRadius: 6, display: 'flex', justifyContent: 'center' }}>
            <iframe title={T('senderStudio.previewIframeTitle')} srcDoc={previewHtml}
              style={{ width: device === 'mobile' ? 375 : '100%', maxWidth: device === 'mobile' ? 375 : 640, height: 460, border: '1px solid #ccc', borderRadius: 6, background: '#fff' }} />
          </div>
        )}
      </div>

      {/* Versions */}
      {versions.length > 0 && (
        <div style={card}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>{T('senderStudio.versionHistory')}</div>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead><tr style={{ textAlign: 'left', color: '#666' }}><th>{T('senderStudio.thV')}</th><th>{T('senderStudio.thName')}</th><th>{T('senderStudio.thSubject')}</th><th>{T('senderStudio.thStatus')}</th><th>{T('senderStudio.thAt')}</th></tr></thead>
            <tbody>
              {versions.map((v: any) => (
                <tr key={v.id} style={{ borderTop: '1px solid #eee' }}>
                  <td>{v.version_number}</td><td>{v.name}</td><td>{v.subject}</td><td>{v.approval_status}</td>
                  <td>{v.created_at ? new Date(v.created_at).toLocaleString() : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function VisualLite({ blocks, onChange }: { blocks: any[]; onChange: (b: any[]) => void }) {
  const T = useT();
  function add(type: string) { onChange([...blocks, { ...EMPTY_BLOCK[type] }]); }
  function upd(i: number, patch: any) { const c = blocks.slice(); c[i] = { ...c[i], ...patch }; onChange(c); }
  function del(i: number) { onChange(blocks.filter((_, n) => n !== i)); }
  function move(i: number, dir: number) { const j = i + dir; if (j < 0 || j >= blocks.length) return; const c = blocks.slice(); [c[i], c[j]] = [c[j], c[i]]; onChange(c); }
  return (
    <div>
      <label style={label}>{T('senderStudio.visualBlocksLabel')}</label>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
        {Object.keys(EMPTY_BLOCK).map(k => <button key={k} style={{ ...btn, fontSize: 11, padding: '3px 7px' }} onClick={() => add(k)}>+ {k}</button>)}
      </div>
      {blocks.map((b, i) => (
        <div key={i} style={{ border: '1px solid #e5e7eb', borderRadius: 6, padding: 8, marginBottom: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#666', marginBottom: 4 }}>
            <b>{b.type}</b>
            <span>
              <button style={{ ...btn, padding: '1px 6px', fontSize: 11 }} onClick={() => move(i, -1)}>↑</button>
              <button style={{ ...btn, padding: '1px 6px', fontSize: 11 }} onClick={() => move(i, 1)}>↓</button>
              <button style={{ ...btnDanger, padding: '1px 6px', fontSize: 11 }} onClick={() => del(i)}>✕</button>
            </span>
          </div>
          {(b.type === 'heading' || b.type === 'paragraph' || b.type === 'signature' || b.type === 'footer') && (
            <textarea style={{ ...input, height: 60 }} value={b.text ?? ''} onChange={e => upd(i, { text: e.target.value })} />
          )}
          {b.type === 'button' && (
            <>
              <input style={{ ...input, marginBottom: 4 }} placeholder={T('senderStudio.phLabel')} value={b.text ?? ''} onChange={e => upd(i, { text: e.target.value })} />
              <input style={input} placeholder={T('senderStudio.phHref')} value={b.href ?? ''} onChange={e => upd(i, { href: e.target.value })} />
            </>
          )}
          {b.type === 'list' && (
            <textarea style={{ ...input, height: 60 }} placeholder={T('senderStudio.phOneItemPerLine')} value={(b.items ?? []).join('\n')} onChange={e => upd(i, { items: e.target.value.split('\n') })} />
          )}
          {b.type === 'image' && (
            <>
              <input style={{ ...input, marginBottom: 4 }} placeholder={T('senderStudio.phSrc')} value={b.src ?? ''} onChange={e => upd(i, { src: e.target.value })} />
              <input style={input} placeholder={T('senderStudio.phAlt')} value={b.alt ?? ''} onChange={e => upd(i, { alt: e.target.value })} />
            </>
          )}
        </div>
      ))}
    </div>
  );
}
