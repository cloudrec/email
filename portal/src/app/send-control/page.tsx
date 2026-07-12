'use client';

import { useEffect, useState, useCallback } from 'react';
import { AppShell } from '../../components/AppShell';
import { useT } from '@/lib/useT';

type SmtpStatus = {
  state: string; host: string; port: number; from_address: string;
  user_set: boolean; reachable: boolean | null; warnings: string[];
  ready_for_send: boolean;
};
type Domain = { id: number; domain: string; status: string; daily_send_limit: number | null };
type Campaign = {
  id: number; name: string; status: string; scheduled_at: string | null;
  total_recipients: number; sent_count: number; bounced_count: number;
  unsubscribed_count: number; delivered_count: number; opened_count: number;
};
type SendStats = {
  totalCampaigns: number; activeCampaigns: number; sentToday: number;
  bouncedToday: number; unsubscribedToday: number; complaints: number;
};
type Mailbox = {
  id: number; from_email: string; purpose: string; status: string; domain: string | null;
  daily_send_limit: number; hourly_send_limit: number; sent_today: number;
  bounced_today: number; complained_today: number; unsubscribed_today: number;
  warmup_stage: number; paused_reason: string | null;
};
type Provider = { id: number; provider_type: string; name: string; smtp_host: string | null; status: string; last_error: string | null };
type ControlStatus = {
  domains: Array<{ id: number; domain: string; purpose: string; status: string; dns_status: string; daily_send_limit: number; hourly_send_limit: number }>;
  mailboxes: Mailbox[];
  providers: Provider[];
  killSwitch: { paused: boolean; reason: string | null };
  webhooks: { configured: boolean; adapters: Array<{ name: string; path: string; configured: boolean }>; lastEvent: any };
  readiness: { level: string; blockers: string[] };
  realWorldSends: number;
  sends?: { total: number; today: number; approvedPending: number; pendingReview: number; lastSentAt: string | null };
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
    if (r.status === 401) { window.location.href = '/login?next=/send-control'; throw new Error('unauthorized'); }
    if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 300)}`);
    return r.json() as Promise<T>;
  });
}

function smtpBadge(state: string, t: (key: string) => string) {
  if (state === 'ready') return <span className="chip ok">{t('sendControl.smtp.badgeReady')}</span>;
  if (state === 'test_only_mailhog') return <span className="chip warn">{t('sendControl.smtp.badgeMailhog')}</span>;
  if (state === 'not_configured') return <span className="chip muted">{t('sendControl.smtp.badgeNotConfigured')}</span>;
  return <span className="chip warn">{state.replace(/_/g, ' ')}</span>;
}

export default function SendControlPage() {
  const t = useT();
  const [smtp, setSmtp] = useState<SmtpStatus | null>(null);
  const [domains, setDomains] = useState<Domain[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [stats, setStats] = useState<SendStats | null>(null);
  const [ctl, setCtl] = useState<ControlStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pausing, setPausing] = useState(false);
  const [pauseMsg, setPauseMsg] = useState('');

  const load = useCallback(async () => {
    try {
      const [ca, do_] = await Promise.all([
        api<{ campaigns: Campaign[] }>('/campaigns'),
        api<{ domains: Domain[] }>('/domains').catch(() => ({ domains: [] as Domain[] })),
      ]);
      setCampaigns(ca.campaigns);
      setDomains(do_.domains);

      const now = new Date();
      const todayStr = now.toISOString().slice(0, 10);
      const todayCampaigns = ca.campaigns.filter((c) => {
        const sched = c.scheduled_at ? new Date(c.scheduled_at).toISOString().slice(0, 10) : null;
        return sched === todayStr || c.status === 'sending' || c.status === 'sent';
      });
      setStats({
        totalCampaigns: ca.campaigns.length,
        activeCampaigns: ca.campaigns.filter((c) => c.status === 'sending' || c.status === 'scheduled').length,
        sentToday: todayCampaigns.reduce((s, c) => s + (c.sent_count || 0), 0),
        bouncedToday: todayCampaigns.reduce((s, c) => s + (c.bounced_count || 0), 0),
        unsubscribedToday: todayCampaigns.reduce((s, c) => s + (c.unsubscribed_count || 0), 0),
        complaints: 0,
      });
      setError(null);
    } catch (e: any) { setError(e.message); }

    try {
      const s = await api<SmtpStatus>('/system/smtp-status');
      setSmtp(s);
    } catch { /* non-admin — leave null */ }

    try {
      const c = await api<ControlStatus>('/sending/control-status');
      setCtl(c);
    } catch { /* leave null */ }
  }, []);

  useEffect(() => { load(); }, [load]);

  const pauseAll = async () => {
    const active = campaigns.filter((c) => c.status === 'sending' || c.status === 'scheduled');
    if (!active.length) { setPauseMsg(t('sendControl.killSwitch.noActive')); return; }
    if (!confirm(t('sendControl.killSwitch.confirm').replace('{n}', String(active.length)))) return;
    setPausing(true);
    let paused = 0;
    for (const c of active) {
      try { await api(`/campaigns/${c.id}/pause`, { method: 'POST', body: '{}' }); paused++; } catch {}
    }
    setPauseMsg(t('sendControl.killSwitch.pausedResult').replace('{n}', String(paused)).replace('{total}', String(active.length)));
    setPausing(false);
    await load();
  };

  const verifiedDomains = domains.filter((d) => d.status === 'verified');
  const activeCampaigns = campaigns.filter((c) => c.status === 'sending' || c.status === 'scheduled');

  const kpi = (label: string, value: string | number, color?: string) => (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, padding: '12px 16px' }}>
      <div style={{ fontSize: 11, color: 'var(--ink-3)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: color ?? 'var(--ink)' }}>{value}</div>
    </div>
  );

  return (
    <AppShell pageKey="sendControl" pageTitle={t('sendControl.pageTitle')}
      actions={
        <button className="btn btn-ghost" onClick={load} style={{ fontSize: 13 }}>{t('sendControl.refresh')}</button>
      }
    >
      {error && <div className="chip warn" style={{ display: 'block', marginBottom: 12 }}>{error}</div>}

      {/* Phase 21A Zoho manual bridge banner */}
      <div style={{ background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 8, padding: '12px 16px', marginBottom: 16, fontSize: 13 }}>
        <b>{t('sendControl.zohoBanner.label')}</b> {t('sendControl.zohoBanner.pre')}<a href="/manual-outreach">{t('sendControl.zohoBanner.link')}</a>{t('sendControl.zohoBanner.post')}
      </div>

      {/* Phase 18 sending strategy banner */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, padding: '12px 16px', marginBottom: 16, fontSize: 13 }}>
        <b>{t('sendControl.strategyBanner.label')}</b> {t('sendControl.strategyBanner.pre')}<a href="/warehouse/cohorts">{t('sendControl.strategyBanner.link')}</a>{t('sendControl.strategyBanner.post')}
      </div>

      {/* Kill switch */}
      <div style={{ background: 'var(--surface)', border: '2px solid var(--danger)', borderRadius: 8, padding: '14px 18px', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 16 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--danger)' }}>{t('sendControl.killSwitch.title')}</div>
          <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 3 }}>
            {t('sendControl.killSwitch.desc')}
          </div>
          {pauseMsg && <div style={{ fontSize: 12, color: 'var(--ok)', marginTop: 4 }}>{pauseMsg}</div>}
        </div>
        <button
          className="btn"
          style={{ background: 'var(--danger)', color: '#fff', border: 'none', fontSize: 13, padding: '8px 18px', flexShrink: 0 }}
          onClick={pauseAll}
          disabled={pausing || activeCampaigns.length === 0}
        >
          {pausing ? t('sendControl.killSwitch.pausing') : t('sendControl.killSwitch.pauseAll').replace('{n}', String(activeCampaigns.length))}
        </button>
      </div>

      {/* SMTP status */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, padding: '14px 18px', marginBottom: 16 }}>
        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 10 }}>{t('sendControl.smtp.heading')}</div>
        {smtp ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center' }}>
            {smtpBadge(smtp.state, t)}
            <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>
              <code>{smtp.host}:{smtp.port}</code> · {t('sendControl.smtp.from')} <code>{smtp.from_address || '—'}</code>
            </span>
            {smtp.warnings.length > 0 && (
              <div style={{ width: '100%', fontSize: 12, color: 'var(--warn)', marginTop: 4 }}>
                {smtp.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
              </div>
            )}
            {smtp.state !== 'ready' && (
              <div style={{ width: '100%', fontSize: 12, color: 'var(--ink-3)' }}>
                {t('sendControl.smtp.blocked')} <a href="/setup">{t('sendControl.smtp.configureLink')}</a>
              </div>
            )}
          </div>
        ) : (
          <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>{t('sendControl.smtp.adminOnly')}</span>
        )}
      </div>

      {/* Domains */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, padding: '14px 18px', marginBottom: 16 }}>
        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 10 }}>{t('sendControl.domains.heading')}</div>
        {domains.length === 0
          ? <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>{t('sendControl.domains.none')} <a href="/domains">{t('sendControl.domains.addLink')}</a></span>
          : <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {domains.map((d) => (
                <div key={d.id} style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' }}>
                  <code>{d.domain}</code>
                  <span className={d.status === 'verified' ? 'chip ok' : 'chip warn'} style={{ fontSize: 10 }}>{d.status}</span>
                  {d.daily_send_limit && <span style={{ color: 'var(--ink-3)' }}>{t('sendControl.domains.perDay').replace('{n}', String(d.daily_send_limit))}</span>}
                </div>
              ))}
              {verifiedDomains.length === 0 && (
                <div style={{ fontSize: 12, color: 'var(--warn)' }}>{t('sendControl.domains.noneVerified')} <a href="/domains">{t('sendControl.domains.verifyLink')}</a></div>
              )}
            </div>
        }
      </div>

      {/* Phase 21 — Own sending infrastructure */}
      {ctl && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, padding: '14px 18px', marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>{t('sendControl.infra.heading')}</div>
            <span className={ctl.readiness.level === 'safe' ? 'chip ok' : ctl.readiness.level === 'warning' ? 'chip warn' : 'chip muted'}>
              {ctl.readiness.level}{ctl.readiness.blockers.length ? ` · ${ctl.readiness.blockers.join(', ')}` : ''}
            </span>
          </div>

          {ctl.killSwitch.paused && (
            <div className="chip warn" style={{ display: 'block', marginBottom: 10 }}>
              {t('sendControl.infra.killSwitchActive')} {ctl.killSwitch.reason ?? t('sendControl.infra.paused')}
            </div>
          )}

          {/* Providers */}
          <div style={{ fontSize: 12, color: 'var(--ink-3)', margin: '8px 0 4px' }}>{t('sendControl.infra.relayProviders')}</div>
          {ctl.providers.length === 0
            ? <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>{t('sendControl.infra.providersNonePre')}<code>POST /api/sending/providers</code>{t('sendControl.infra.providersNoneMid')}<code>pending</code>{t('sendControl.infra.providersNonePost')}</div>
            : <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {ctl.providers.map((p) => (
                  <div key={p.id} style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' }}>
                    <code>{p.name}</code><span style={{ color: 'var(--ink-3)' }}>{p.provider_type}</span>
                    <span className={p.status === 'active' ? 'chip ok' : p.status === 'error' ? 'chip warn' : 'chip muted'} style={{ fontSize: 10 }}>{p.status}</span>
                  </div>
                ))}
              </div>
          }

          {/* Mailboxes */}
          <div style={{ fontSize: 12, color: 'var(--ink-3)', margin: '12px 0 4px' }}>{t('sendControl.mailboxes.heading')}</div>
          {ctl.mailboxes.length === 0
            ? <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>{t('sendControl.mailboxes.none')}</div>
            : <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead><tr style={{ borderBottom: '2px solid var(--line)' }}>
                    {[t('sendControl.mailboxes.colMailbox'), t('sendControl.mailboxes.colPurpose'), t('sendControl.mailboxes.colStatus'), t('sendControl.mailboxes.colSentToday'), t('sendControl.mailboxes.colDaily'), t('sendControl.mailboxes.colHourly'), t('sendControl.mailboxes.colBounced'), t('sendControl.mailboxes.colWarmup')].map((h) =>
                      <th key={h} style={{ textAlign: 'left', padding: '4px 8px', color: 'var(--ink-3)', fontWeight: 500, whiteSpace: 'nowrap' }}>{h}</th>)}
                  </tr></thead>
                  <tbody>
                    {ctl.mailboxes.map((m) => (
                      <tr key={m.id} style={{ borderBottom: '1px solid var(--line)' }}>
                        <td style={{ padding: '5px 8px' }}><code>{m.from_email}</code></td>
                        <td style={{ padding: '5px 8px' }}>{m.purpose}</td>
                        <td style={{ padding: '5px 8px' }}>
                          <span className={m.status === 'active' ? 'chip ok' : 'chip warn'} style={{ fontSize: 10 }}>{m.status}</span>
                          {m.paused_reason && <span style={{ color: 'var(--warn)', marginLeft: 4 }}>{m.paused_reason}</span>}
                        </td>
                        <td style={{ padding: '5px 8px', textAlign: 'right' }}>{m.sent_today}</td>
                        <td style={{ padding: '5px 8px', textAlign: 'right' }}>{m.daily_send_limit}<span style={{ color: 'var(--ink-3)' }}> {t('sendControl.mailboxes.left').replace('{n}', String(Math.max(0, m.daily_send_limit - m.sent_today)))}</span></td>
                        <td style={{ padding: '5px 8px', textAlign: 'right' }}>{m.hourly_send_limit}</td>
                        <td style={{ padding: '5px 8px', textAlign: 'right', color: m.bounced_today > 0 ? 'var(--danger)' : undefined }}>{m.bounced_today}</td>
                        <td style={{ padding: '5px 8px', textAlign: 'right' }}>{m.warmup_stage}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
          }

          {/* Webhook adapters */}
          <div style={{ fontSize: 12, color: 'var(--ink-3)', margin: '12px 0 4px' }}>
            {t('sendControl.webhooks.heading')} {ctl.webhooks.configured ? '' : t('sendControl.webhooks.secretMissing')}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {ctl.webhooks.adapters.map((a) => (
              <span key={a.name} style={{ fontSize: 11, display: 'inline-flex', gap: 5, alignItems: 'center' }}>
                <span className={a.configured ? 'chip ok' : 'chip muted'} style={{ fontSize: 10 }}>{a.name}</span>
                <code style={{ color: 'var(--ink-3)' }}>{a.path}</code>
              </span>
            ))}
          </div>
          {ctl.webhooks.lastEvent && (
            <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 6 }}>
              {t('sendControl.webhooks.lastWebhook')} <code>{ctl.webhooks.lastEvent.action}</code> · {ctl.webhooks.lastEvent.target_id} · {new Date(ctl.webhooks.lastEvent.created_at).toLocaleString()}
            </div>
          )}

          <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 10 }}>
            {t('sendControl.infra.realWorldPre')}<b>{ctl.realWorldSends}</b>{t('sendControl.infra.realWorldPost')}
            {ctl.sends && (
              <span> · <b>{ctl.sends.today}</b> {t('sendControl.infra.sendsToday')} · <b>{ctl.sends.approvedPending}</b> {t('sendControl.infra.sendsApprovedPending')} · <b>{ctl.sends.pendingReview}</b> {t('sendControl.infra.sendsPendingReview')}
                {ctl.sends.lastSentAt && <> · {t('sendControl.infra.sendsLast')} {new Date(ctl.sends.lastSentAt).toLocaleString()}</>}
              </span>
            )}
          </div>
        </div>
      )}

      {/* KPIs */}
      {stats && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 12, marginBottom: 20 }}>
          {kpi(t('sendControl.kpi.totalCampaigns'), stats.totalCampaigns)}
          {kpi(t('sendControl.kpi.activeScheduled'), stats.activeCampaigns, stats.activeCampaigns > 0 ? 'var(--warn)' : undefined)}
          {(() => { const sentToday = ctl?.sends?.today ?? stats.sentToday; return kpi(t('sendControl.kpi.sentToday'), sentToday, sentToday > 0 ? 'var(--ok)' : undefined); })()}
          {kpi(t('sendControl.kpi.bouncedToday'), stats.bouncedToday, stats.bouncedToday > 0 ? 'var(--danger)' : undefined)}
          {kpi(t('sendControl.kpi.unsubsToday'), stats.unsubscribedToday)}
          {kpi(t('sendControl.kpi.verifiedDomains'), verifiedDomains.length, verifiedDomains.length > 0 ? 'var(--ok)' : 'var(--warn)')}
        </div>
      )}

      {/* Preflight gates */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, padding: '14px 18px', marginBottom: 20 }}>
        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 12 }}>{t('sendControl.preflight.heading')}</div>
        {[
          {
            ok: smtp?.state === 'ready',
            label: t('sendControl.preflight.smtpLabel'),
            fix: smtp?.state === 'test_only_mailhog' ? t('sendControl.preflight.smtpFixMailhog') : t('sendControl.preflight.smtpFixDefault'),
          },
          {
            ok: verifiedDomains.length > 0,
            label: t('sendControl.preflight.domainLabel'),
            fix: t('sendControl.preflight.domainFix'),
          },
          {
            ok: campaigns.some((c) => ['draft', 'scheduled', 'sending', 'sent', 'paused'].includes(c.status)),
            label: t('sendControl.preflight.campaignLabel'),
            fix: t('sendControl.preflight.campaignFix'),
          },
        ].map((gate, i) => (
          <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 8 }}>
            <span style={{ color: gate.ok ? 'var(--ok)' : 'var(--warn)', fontSize: 15, lineHeight: 1 }}>{gate.ok ? '✓' : '○'}</span>
            <div>
              <div style={{ fontSize: 12.5, color: gate.ok ? 'var(--muted)' : 'var(--ink)' }}>
                {gate.ok ? <s style={{ color: 'var(--muted)' }}>{gate.label}</s> : gate.label}
              </div>
              {!gate.ok && <div style={{ fontSize: 11.5, color: 'var(--ink-3)', marginTop: 2 }}>{gate.fix}</div>}
            </div>
          </div>
        ))}
      </div>

      {/* Active campaigns */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, padding: '14px 18px' }}>
        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 12 }}>{t('sendControl.campaigns.heading')}</div>
        {campaigns.length === 0
          ? <p style={{ fontSize: 13, color: 'var(--ink-3)' }}>{t('sendControl.campaigns.none')} <a href="/campaigns">{t('sendControl.campaigns.createLink')}</a></p>
          : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid var(--line)' }}>
                    {[t('sendControl.campaigns.colName'), t('sendControl.campaigns.colStatus'), t('sendControl.campaigns.colRecipients'), t('sendControl.campaigns.colSent'), t('sendControl.campaigns.colBounced'), t('sendControl.campaigns.colUnsub'), t('sendControl.campaigns.colActions')].map((h) => (
                      <th key={h} style={{ textAlign: 'left', padding: '5px 10px', color: 'var(--ink-3)', fontWeight: 500, whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {campaigns.map((c) => (
                    <tr key={c.id} style={{ borderBottom: '1px solid var(--line)' }}>
                      <td style={{ padding: '7px 10px', fontWeight: 500 }}>{c.name}</td>
                      <td style={{ padding: '7px 10px' }}>
                        <span className={c.status === 'sent' ? 'chip ok' : c.status === 'sending' || c.status === 'scheduled' ? 'chip warn' : 'chip muted'}>
                          {c.status}
                        </span>
                      </td>
                      <td style={{ padding: '7px 10px', textAlign: 'right' }}>{c.total_recipients}</td>
                      <td style={{ padding: '7px 10px', textAlign: 'right' }}>{c.sent_count}</td>
                      <td style={{ padding: '7px 10px', textAlign: 'right', color: c.bounced_count > 0 ? 'var(--danger)' : undefined }}>{c.bounced_count}</td>
                      <td style={{ padding: '7px 10px', textAlign: 'right' }}>{c.unsubscribed_count}</td>
                      <td style={{ padding: '7px 10px' }}>
                        {(c.status === 'sending' || c.status === 'scheduled') && (
                          <button
                            className="btn btn-ghost"
                            style={{ fontSize: 11, padding: '2px 8px' }}
                            onClick={async () => {
                              try { await api(`/campaigns/${c.id}/pause`, { method: 'POST', body: '{}' }); await load(); }
                              catch (e: any) { setError(e.message); }
                            }}
                          >{t('sendControl.campaigns.pause')}</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </div>
    </AppShell>
  );
}
