'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '../../components/AppShell';

// Replies admin (TZ §17 Replies). Threaded inbox with classification, escalation status,
// the last outbound message, and per-reply actions: create a follow-up DRAFT (never an
// auto-send) and suppress the sender. Escalation status is derived from the same
// REPLY_ESCALATION policy the backend uses. No reply is ever sent automatically.

type Reply = {
  id: number; subject: string; snippet: string; receivedAt: string | null;
  classification: string; source: string; confidence: number; reason: string;
  handled: boolean; queueItemId: number | null;
};
type Thread = {
  key: string; companyId: number | null; contactEmail: string | null; company: string | null;
  replies: Reply[];
  lastOutbound: { subject: string; body: string; sentAt: string | null; queueStatus: string } | null;
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
    if (r.status === 401) { window.location.href = '/login?next=/replies'; throw new Error('unauthorized'); }
    if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 300)}`);
    return r.json() as Promise<T>;
  });
}

// Mirrors REPLY_ESCALATION in api/src/services/replyClassifier.ts.
const ESCALATION: Record<string, string> = {
  complaint: 'pause_campaign',
  legal_or_privacy: 'human_escalate',
  interested: 'draft_no_autosend',
  meeting_request: 'draft_no_autosend',
  request_details: 'draft_no_autosend',
  unknown: 'human_escalate',
};
const escalationChip = (a: string | undefined) =>
  a === 'pause_campaign' || a === 'human_escalate' ? 'chip danger'
  : a === 'draft_no_autosend' ? 'chip info' : 'chip muted';

const classChip = (c: string) =>
  c === 'interested' || c === 'meeting_request' || c === 'request_details' ? 'chip ok'
  : c === 'complaint' || c === 'legal_or_privacy' ? 'chip danger'
  : c === 'do_not_contact' || c === 'unsubscribe' || c === 'not_interested' ? 'chip warn'
  : 'chip muted';

export default function RepliesPage() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    try { setThreads((await api<{ threads: Thread[] }>('/manual-outreach/replies/threads')).threads); setError(null); }
    catch (e: any) { setError(e.message); }
  };
  useEffect(() => { reload(); }, []);

  const doImport = async () => {
    setBusy(true); setError(null); setNotice(null);
    try { const r = await api<any>('/manual-outreach/replies/import', { method: 'POST' }); setNotice(`Import: ${r.imported ?? 0} imported, ${r.fetched ?? 0} fetched.`); reload(); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };

  const createFollowup = async (id: number) => {
    setError(null);
    try { await api(`/manual-outreach/replies/${id}/create-followup`, { method: 'POST' }); setNotice(`Follow-up draft created for reply #${id} (not sent).`); reload(); }
    catch (e: any) { setError(e.message); }
  };
  const suppress = async (id: number) => {
    setError(null);
    try { const r = await api<any>(`/manual-outreach/replies/${id}/suppress`, { method: 'POST' }); setNotice(`Suppressed ${r.suppressed}.`); reload(); }
    catch (e: any) { setError(e.message); }
  };

  const totalReplies = threads.reduce((n, t) => n + t.replies.length, 0);

  return (
    <AppShell pageKey="replies">
      <div className="between" style={{ marginBottom: 16 }}>
        <div>
          <h1>Replies</h1>
          <p className="muted">Threaded inbox. Positive replies produce a follow-up draft for review — nothing is sent automatically.</p>
        </div>
        <button className="btn btn-primary" onClick={doImport} disabled={busy}>{busy ? 'Importing…' : 'Import replies'}</button>
      </div>

      {error && <div className="notice danger" style={{ marginBottom: 12 }}>{error}</div>}
      {notice && <div className="notice ok" style={{ marginBottom: 12 }}>{notice}</div>}

      {threads.length === 0 && !error && <div className="empty">No replies yet. Use “Import replies” to pull from inbound mailboxes.</div>}

      <p className="muted">{threads.length} threads · {totalReplies} replies</p>

      {threads.map((th) => (
        <div key={th.key} className="panel" style={{ marginBottom: 16 }}>
          <div className="panel-h between">
            <span>{th.company || th.contactEmail || 'Unknown contact'}{th.contactEmail && th.company ? ` · ${th.contactEmail}` : ''}</span>
            <span className="muted">{th.replies.length} repl{th.replies.length === 1 ? 'y' : 'ies'}</span>
          </div>
          <div style={{ padding: 16 }}>
            {th.lastOutbound && (
              <div className="notice info" style={{ marginBottom: 12 }}>
                <strong>Last outbound:</strong> {th.lastOutbound.subject}
                {th.lastOutbound.sentAt ? <span className="muted"> · sent {new Date(th.lastOutbound.sentAt).toLocaleDateString()}</span> : null}
              </div>
            )}
            <table>
              <thead><tr><th>Received</th><th>Subject</th><th>Classification</th><th>Escalation</th><th>Confidence</th><th></th></tr></thead>
              <tbody>
                {th.replies.map((r) => {
                  const esc = ESCALATION[r.classification];
                  return (
                    <tr key={r.id}>
                      <td>{r.receivedAt ? new Date(r.receivedAt).toLocaleString() : '—'}</td>
                      <td>{r.subject || '—'}<br /><span className="muted">{(r.snippet || '').slice(0, 90)}</span></td>
                      <td><span className={classChip(r.classification)}>{r.classification}</span></td>
                      <td>{esc ? <span className={escalationChip(esc)}>{esc}</span> : <span className="chip muted">—</span>}</td>
                      <td>{r.confidence != null ? `${Math.round(Number(r.confidence) * 100)}%` : '—'}{r.handled ? <> · <span className="chip ok">handled</span></> : null}</td>
                      <td>
                        <div className="cluster">
                          <button className="btn btn-ghost" onClick={() => createFollowup(r.id)} disabled={r.handled}>Follow-up draft</button>
                          <button className="btn btn-danger" onClick={() => suppress(r.id)}>Suppress</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </AppShell>
  );
}
