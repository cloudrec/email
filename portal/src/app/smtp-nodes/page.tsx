'use client';

// Phase 22F — Self-Hosted SMTP Node Readiness Manager.
// Register FUTURE dedicated self-hosted SMTP nodes and see whether they are safe
// to use. METADATA ONLY — no secrets entered here. NO send button. NO MTA install.
// NO port opened. NO DNS changed. Sending is BLOCKED by default until every
// critical readiness check passes. Fully i18n via useT (en/ru/uk).
import { useEffect, useState, useCallback } from 'react';
import { AppShell } from '../../components/AppShell';
import { useT } from '@/lib/useT';

function getToken(): string {
  if (typeof document === 'undefined') return '';
  return document.cookie.split('; ').find(c => c.startsWith('token='))?.split('=')[1] ?? '';
}
function authHeaders() { return { authorization: `Bearer ${getToken()}`, 'content-type': 'application/json' }; }
async function api(path: string, method = 'GET', body?: any) {
  const r = await fetch(`/api/smtp-nodes${path}`, { method, headers: authHeaders(), body: body ? JSON.stringify(body) : undefined });
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
const td: React.CSSProperties = { fontSize: 12, padding: '4px 6px', borderBottom: '1px solid #f3f3f3' };

const STATUS_COLOR: Record<string, string> = { ready: '#16a34a', warning: '#d97706', blocked: '#dc2626', draft: '#888', checking: '#2563eb', disabled: '#999' };
const CHECK_ICON: Record<string, string> = { pass: '✅', fail: '❌', warning: '⚠️', unknown: '❔', unchecked: '⬜' };
const RISK_COLOR: Record<string, string> = { low: '#16a34a', medium: '#d97706', high: '#ea580c', blocked: '#dc2626' };

function chip(text: string, color: string) {
  return <span style={{ background: color, color: '#fff', borderRadius: 10, padding: '1px 8px', fontSize: 11 }}>{text}</span>;
}
const fill = (s: string, vars: Record<string, any>) => s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));

type Node = any;

export default function SmtpNodesPage() {
  const t = useT();
  const [nodes, setNodes] = useState<Node[]>([]);
  const [prodIps, setProdIps] = useState<string[]>([]);
  const [sel, setSel] = useState<Node | null>(null);
  const [checklist, setChecklist] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string>('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<any>({ name: '', node_type: 'self_hosted_vps', purpose: 'internal_test', isolation_status: 'unknown' });
  const [probe25, setProbe25] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, env] = await Promise.all([api('/'), api('/env')]);
      if (list.ok) setNodes(list.json.nodes ?? []);
      if (env.ok) setProdIps(env.json.production_ips ?? []);
    } finally {
      // Always clear the spinner — a fetch reject must not leave it stuck forever.
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function openNode(id: number) {
    const r = await api(`/${id}`);
    if (r.ok) { setSel(r.json.node); setChecklist(r.json.dns_checklist ?? []); }
  }

  async function create() {
    if (!form.name) { setMsg(t('smtpNodes.msgNameRequired')); return; }
    const r = await api('/', 'POST', form);
    if (r.ok) { setMsg(t('smtpNodes.msgCreated')); setShowForm(false); setForm({ name: '', node_type: 'self_hosted_vps', purpose: 'internal_test', isolation_status: 'unknown' }); await load(); await openNode(r.json.node.id); }
    else setMsg(fill(t('smtpNodes.msgFailed'), { e: r.json?.error ?? r.status }));
  }

  async function runCheck(id: number) {
    setMsg(t('smtpNodes.msgChecking'));
    const r = await api(`/${id}/check`, 'POST', { probePort25: probe25 });
    if (r.ok) { setSel(r.json.node); setChecklist(r.json.dns_checklist ?? []); setMsg(t('smtpNodes.msgChecked')); await load(); }
    else setMsg(fill(t('smtpNodes.msgFailed'), { e: r.json?.detail ?? r.json?.error ?? r.status }));
  }

  async function disable(id: number) {
    const r = await api(`/${id}/disable`, 'POST');
    if (r.ok) { setMsg(t('smtpNodes.msgDisabled')); await load(); await openNode(id); }
  }
  async function createProvider(id: number) {
    const r = await api(`/${id}/create-draft-provider`, 'POST');
    if (r.ok) setMsg(fill(t('smtpNodes.msgProviderCreated'), { id: r.json.provider_id }));
    else setMsg(fill(t('smtpNodes.msgProviderBlocked'), { e: r.json?.detail ?? r.json?.error }));
  }
  async function saveReputation(id: number, field: string, value: string) {
    const r = await api(`/${id}/reputation`, 'PATCH', { [field]: value });
    if (r.ok) { setSel(r.json.node); setMsg(t('smtpNodes.msgSaved')); await load(); }
  }
  async function exportReport(id: number, format: string) {
    const r = await fetch(`/api/smtp-nodes/${id}/report?format=${format}`, { headers: authHeaders() });
    const text = await r.text();
    const blob = new Blob([text], { type: format === 'markdown' ? 'text/markdown' : 'application/json' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = `smtp-node-${id}.${format === 'markdown' ? 'md' : 'json'}`; a.click(); URL.revokeObjectURL(url);
  }

  const setF = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));

  return (
    <AppShell pageKey="smtpNodes" pageTitle={t('smtpNodes.pageTitle')}>
      <div style={{ maxWidth: 1180, margin: '0 auto', padding: '0 8px' }}>
        <h1 style={{ fontSize: 22, marginBottom: 4 }}>{t('smtpNodes.pageTitle')}</h1>
        <p style={{ fontSize: 13, color: '#555', marginTop: 0 }}>{t('smtpNodes.intro')}</p>
        <div style={{ ...card, background: '#fff7ed', borderColor: '#fdba74', marginTop: 8 }}>
          <strong style={{ fontSize: 13 }}>🛡️ {t('smtpNodes.safetyTitle')}</strong>
          <p style={{ fontSize: 12, color: '#7c2d12', margin: '4px 0 0' }}>{t('smtpNodes.safetyBanner')}</p>
          {prodIps.length > 0 && (
            <p style={{ fontSize: 12, color: '#7c2d12', margin: '4px 0 0' }}>
              {t('smtpNodes.prodIpWarn')} <code>{prodIps.join(', ')}</code>
            </p>
          )}
        </div>

        {msg && <div style={{ ...card, background: '#eff6ff', borderColor: '#bfdbfe', display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 12 }}>{msg}</span>
          <button style={{ ...btn, marginTop: 0 }} onClick={() => setMsg('')}>✕</button>
        </div>}

        <div style={{ marginTop: 10 }}>
          <button style={btnPrimary} onClick={() => setShowForm(s => !s)}>{showForm ? t('smtpNodes.btnCancel') : t('smtpNodes.btnNew')}</button>
          <button style={btn} onClick={load}>{t('smtpNodes.btnRefresh')}</button>
        </div>

        {showForm && (
          <div style={card}>
            <h3 style={{ fontSize: 15, marginTop: 0 }}>{t('smtpNodes.formTitle')}</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
              <div><span style={label}>{t('smtpNodes.formName')}</span><input style={input} value={form.name} onChange={e => setF('name', e.target.value)} /></div>
              <div><span style={label}>{t('smtpNodes.formNodeType')}</span>
                <select style={input} value={form.node_type} onChange={e => setF('node_type', e.target.value)}>
                  {['self_hosted_vps', 'dedicated_smtp_server', 'postal_later', 'mailcow_later', 'postfix_later', 'generic_smtp_node'].map(x => <option key={x} value={x}>{x}</option>)}
                </select></div>
              <div><span style={label}>{t('smtpNodes.formPurpose')}</span>
                <select style={input} value={form.purpose} onChange={e => setF('purpose', e.target.value)}>
                  {['internal_test', 'transactional', 'cold_outreach'].map(x => <option key={x} value={x}>{x}</option>)}
                </select></div>
              <div><span style={label}>{t('smtpNodes.formHostname')}</span><input style={input} value={form.hostname ?? ''} onChange={e => setF('hostname', e.target.value)} placeholder="mail.example.com" /></div>
              <div><span style={label}>{t('smtpNodes.formIp')}</span><input style={input} value={form.ipv4 ?? ''} onChange={e => setF('ipv4', e.target.value)} placeholder="203.0.113.10" /></div>
              <div><span style={label}>{t('smtpNodes.formPtr')}</span><input style={input} value={form.ptr_expected ?? ''} onChange={e => setF('ptr_expected', e.target.value)} placeholder="mail.example.com" /></div>
              <div><span style={label}>{t('smtpNodes.formDomain')}</span><input style={input} value={form.sending_domain ?? ''} onChange={e => setF('sending_domain', e.target.value)} placeholder="example.com" /></div>
              <div><span style={label}>{t('smtpNodes.formDkim')}</span><input style={input} value={form.dkim_selector ?? ''} onChange={e => setF('dkim_selector', e.target.value)} placeholder="default" /></div>
              <div><span style={label}>{t('smtpNodes.formIsolation')}</span>
                <select style={input} value={form.isolation_status} onChange={e => setF('isolation_status', e.target.value)}>
                  {['unknown', 'dedicated', 'shared_with_app_server', 'shared_with_production', 'unsafe'].map(x => <option key={x} value={x}>{x}</option>)}
                </select></div>
              <div><span style={label}>{t('smtpNodes.formProvider')}</span><input style={input} value={form.provider_name ?? ''} onChange={e => setF('provider_name', e.target.value)} /></div>
              <div><span style={label}>{t('smtpNodes.formLocation')}</span><input style={input} value={form.location ?? ''} onChange={e => setF('location', e.target.value)} /></div>
              <div><span style={label}>{t('smtpNodes.formIsolationNote')}</span><input style={input} value={form.isolation_note ?? ''} onChange={e => setF('isolation_note', e.target.value)} /></div>
            </div>
            <button style={{ ...btnPrimary, marginTop: 10 }} onClick={create}>{t('smtpNodes.btnSaveDraft')}</button>
          </div>
        )}

        {/* List */}
        <div style={card}>
          <h3 style={{ fontSize: 15, marginTop: 0 }}>{t('smtpNodes.listTitle')}</h3>
          {loading ? <p style={{ fontSize: 12 }}>{t('smtpNodes.loading')}</p> : nodes.length === 0 ? <p style={{ fontSize: 12, color: '#888' }}>{t('smtpNodes.empty')}</p> : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={th}>{t('smtpNodes.colName')}</th><th style={th}>{t('smtpNodes.colHost')}</th><th style={th}>{t('smtpNodes.colIp')}</th>
                <th style={th}>{t('smtpNodes.colPurpose')}</th><th style={th}>{t('smtpNodes.colStatus')}</th><th style={th}>{t('smtpNodes.colScore')}</th>
                <th style={th}>{t('smtpNodes.colLevel')}</th><th style={th}>{t('smtpNodes.colBlocker')}</th><th style={th}></th>
              </tr></thead>
              <tbody>
                {nodes.map(n => (
                  <tr key={n.id}>
                    <td style={td}>{n.name}</td><td style={td}>{n.hostname ?? '—'}</td><td style={td}>{n.ipv4 ?? '—'}</td>
                    <td style={td}>{n.purpose}</td>
                    <td style={td}>{chip(n.status, STATUS_COLOR[n.status] ?? '#888')}</td>
                    <td style={td}>{n.readiness_score}</td>
                    <td style={td}>{n.readiness_level}</td>
                    <td style={{ ...td, color: '#b91c1c', maxWidth: 220 }}>{(n.blockers ?? [])[0] ?? '—'}</td>
                    <td style={td}><button style={{ ...btn, marginTop: 0 }} onClick={() => openNode(n.id)}>{t('smtpNodes.btnOpen')}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Detail */}
        {sel && <NodeDetail node={sel} checklist={checklist} t={t} probe25={probe25} setProbe25={setProbe25}
          onCheck={() => runCheck(sel.id)} onDisable={() => disable(sel.id)} onProvider={() => createProvider(sel.id)}
          onExport={(f: string) => exportReport(sel.id, f)} onReputation={(field: string, v: string) => saveReputation(sel.id, field, v)}
          onClose={() => setSel(null)} />}
      </div>
    </AppShell>
  );
}

function NodeDetail({ node, checklist, t, probe25, setProbe25, onCheck, onDisable, onProvider, onExport, onReputation, onClose }: any) {
  const checks: any[] = node.checklist ?? [];
  const byKey = (k: string) => checks.find((c: any) => c.key === k);
  const repFields = ['spamhaus_status', 'barracuda_status', 'microsoft_snds_status', 'google_postmaster_status'];
  const repLabels: Record<string, string> = {
    spamhaus_status: 'Spamhaus', barracuda_status: 'Barracuda', microsoft_snds_status: 'Microsoft SNDS', google_postmaster_status: 'Google Postmaster',
  };
  const Row = ({ c }: { c: any }) => c ? (
    <div style={{ fontSize: 12, padding: '3px 0', borderBottom: '1px solid #f5f5f5' }}>
      {CHECK_ICON[c.status] ?? '⬜'} <strong>{c.label}</strong>{c.critical ? <em style={{ color: '#b91c1c' }}> ({t('smtpNodes.critical')})</em> : ''}
      <div style={{ color: '#666', marginLeft: 18 }}>{c.detail}</div>
    </div>
  ) : null;

  return (
    <div style={{ ...card, borderColor: '#93c5fd' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ fontSize: 16, margin: 0 }}>{node.name} {chip(node.status, STATUS_COLOR[node.status] ?? '#888')}</h3>
        <button style={{ ...btn, marginTop: 0 }} onClick={onClose}>✕</button>
      </div>

      {/* Score strip */}
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 8, alignItems: 'center' }}>
        <div><span style={{ fontSize: 26, fontWeight: 700 }}>{node.readiness_score}</span><span style={{ fontSize: 12, color: '#888' }}>/100</span></div>
        <div>{t('smtpNodes.colLevel')}: <strong>{node.readiness_level}</strong></div>
        <div>{t('smtpNodes.risk')}: {chip(node.risk_level, RISK_COLOR[node.risk_level] ?? '#888')}</div>
        <div>{t('smtpNodes.safeToSend')}: {node.safe_to_send ? chip(t('smtpNodes.yes'), '#16a34a') : chip(t('smtpNodes.no'), '#dc2626')}</div>
        <div>{t('smtpNodes.safeProvider')}: {node.safe_to_connect_as_provider ? '✅' : '❌'}</div>
      </div>

      <div style={{ ...card, background: '#f8fafc', marginTop: 8 }}>
        <strong style={{ fontSize: 12 }}>➡️ {t('smtpNodes.nextAction')}</strong>
        <div style={{ fontSize: 13, marginTop: 2 }}>{node.next_action ?? t('smtpNodes.runCheckFirst')}</div>
      </div>

      {/* Actions */}
      <div style={{ marginTop: 8 }}>
        <label style={{ fontSize: 11, marginRight: 10 }}><input type="checkbox" checked={probe25} onChange={e => setProbe25(e.target.checked)} /> {t('smtpNodes.probe25')}</label>
        <button style={btnPrimary} onClick={onCheck}>{t('smtpNodes.btnRunCheck')}</button>
        <button style={btn} onClick={() => onExport('markdown')}>{t('smtpNodes.btnExportMd')}</button>
        <button style={btn} onClick={() => onExport('json')}>{t('smtpNodes.btnExportJson')}</button>
        <button style={btn} disabled={node.readiness_level !== 'ready_for_tiny_test'} title={t('smtpNodes.providerHint')} onClick={onProvider}>{t('smtpNodes.btnCreateProvider')}</button>
        <button style={btnDanger} onClick={onDisable}>{t('smtpNodes.btnDisable')}</button>
      </div>

      {/* Blockers / warnings */}
      {(node.blockers ?? []).length > 0 && <div style={{ ...card, background: '#fef2f2', borderColor: '#fecaca' }}>
        <strong style={{ fontSize: 12, color: '#b91c1c' }}>❌ {t('smtpNodes.blockers')}</strong>
        <ul style={{ fontSize: 12, margin: '4px 0 0' }}>{node.blockers.map((b: string, i: number) => <li key={i}>{b}</li>)}</ul>
      </div>}
      {(node.warnings ?? []).length > 0 && <div style={{ ...card, background: '#fffbeb', borderColor: '#fde68a' }}>
        <strong style={{ fontSize: 12, color: '#92400e' }}>⚠️ {t('smtpNodes.warnings')}</strong>
        <ul style={{ fontSize: 12, margin: '4px 0 0' }}>{node.warnings.map((w: string, i: number) => <li key={i}>{w}</li>)}</ul>
      </div>}

      {/* Checklist groups */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12, marginTop: 10 }}>
        <div style={card}>
          <strong style={{ fontSize: 13 }}>{t('smtpNodes.secDnsPtr')}</strong>
          <Row c={byKey('required_fields')} /><Row c={byKey('isolation')} /><Row c={byKey('forward_dns')} /><Row c={byKey('ptr')} />
        </div>
        <div style={card}>
          <strong style={{ fontSize: 13 }}>{t('smtpNodes.secAuth')}</strong>
          <Row c={byKey('spf')} /><Row c={byKey('dkim')} /><Row c={byKey('dmarc')} />
        </div>
        <div style={card}>
          <strong style={{ fontSize: 13 }}>{t('smtpNodes.secMxTls')}</strong>
          <Row c={byKey('mx')} /><Row c={byKey('tls')} /><Row c={byKey('port25')} />
        </div>
        <div style={card}>
          <strong style={{ fontSize: 13 }}>{t('smtpNodes.secMailboxes')}</strong>
          <Row c={byKey('abuse')} /><Row c={byKey('postmaster')} /><Row c={byKey('bounce')} />
        </div>
      </div>

      {/* Manual reputation checklist */}
      <div style={card}>
        <strong style={{ fontSize: 13 }}>{t('smtpNodes.secReputation')}</strong>
        <p style={{ fontSize: 11, color: '#888', margin: '2px 0 6px' }}>{t('smtpNodes.reputationHint')}</p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
          {repFields.map(f => (
            <div key={f}>
              <span style={label}>{repLabels[f]}</span>
              <select style={input} value={node[f] ?? 'unknown'} onChange={e => onReputation(f, e.target.value)}>
                {['clean', 'listed', 'unknown', 'not_applicable'].map(x => <option key={x} value={x}>{x}</option>)}
              </select>
            </div>
          ))}
        </div>
      </div>

      {/* DNS checklist generator */}
      <div style={card}>
        <strong style={{ fontSize: 13 }}>{t('smtpNodes.secDnsChecklist')}</strong>
        <p style={{ fontSize: 11, color: '#888', margin: '2px 0 6px' }}>{t('smtpNodes.dnsChecklistHint')}</p>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={th}>{t('smtpNodes.dnsType')}</th><th style={th}>{t('smtpNodes.dnsHost')}</th><th style={th}>{t('smtpNodes.dnsValue')}</th></tr></thead>
          <tbody>{checklist.map((r: any) => (
            <tr key={r.key}><td style={td}><code>{r.type}</code></td><td style={{ ...td, fontFamily: 'monospace', fontSize: 11 }}>{r.host}</td>
              <td style={td}><code style={{ fontSize: 11 }}>{r.value}</code><div style={{ color: '#888', fontSize: 11 }}>{r.note}</div></td></tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}
