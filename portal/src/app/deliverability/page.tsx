'use client';

// Deliverability Center — one operator page aggregating real deliverability +
// launch-readiness signals (DNS/auth, Postal, providers, mailboxes, rates, worker)
// plus a deterministic advisor and launch verdict. All data is live from
// /api/deliverability/center — no fabricated scores. Fully i18n (en/ru/uk).
import { useEffect, useState, useCallback } from 'react';
import { AppShell } from '../../components/AppShell';
import { useT } from '@/lib/useT';

function getToken(): string {
  if (typeof document === 'undefined') return '';
  return document.cookie.split('; ').find(c => c.startsWith('token='))?.split('=')[1] ?? '';
}
async function api(path: string) {
  const r = await fetch(`/api/deliverability${path}`, { headers: { authorization: `Bearer ${getToken()}` } });
  if (r.status === 401 && typeof window !== 'undefined') { window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname); }
  return { ok: r.ok, status: r.status, json: r.ok ? await r.json() : null };
}

const card: React.CSSProperties = { border: '1px solid var(--line,#e5e7eb)', borderRadius: 10, padding: 16, background: 'var(--panel,#fff)' };
const grid: React.CSSProperties = { display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))' };

const VERDICT_STYLE: Record<string, { bg: string; fg: string }> = {
  READY_FOR_LOW_VOLUME_WARMUP: { bg: '#dcfce7', fg: '#15803d' },
  READY_FOR_CONTROLLED_TEST_SEND: { bg: '#fef9c3', fg: '#a16207' },
  NOT_READY: { bg: '#fee2e2', fg: '#b91c1c' },
};
function statusDot(s: string) {
  const c = s === 'pass' ? '#16a34a' : s === 'warn' ? '#d97706' : s === 'na' ? '#9ca3af' : '#dc2626';
  return <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 9, background: c, marginRight: 8 }} />;
}
function sevBadge(sev: string) {
  const c = sev === 'blocker' ? { bg: '#fee2e2', fg: '#b91c1c' } : sev === 'warning' ? { bg: '#fef9c3', fg: '#a16207' } : { bg: '#e0e7ff', fg: '#3730a3' };
  return <span style={{ background: c.bg, color: c.fg, borderRadius: 6, padding: '1px 8px', fontSize: 11, fontWeight: 700 }}>{sev}</span>;
}
function yn(v: boolean) { return <span style={{ color: v ? '#16a34a' : '#dc2626', fontWeight: 700 }}>{v ? '✓' : '✗'}</span>; }

export default function DeliverabilityPage() {
  const t = useT();
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try { const r = await api('/center'); if (r.ok && r.json) { setD(r.json); setErr(false); } else setErr(true); }
    catch { setErr(true); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const vs = d ? (VERDICT_STYLE[d.verdict] ?? VERDICT_STYLE.NOT_READY) : VERDICT_STYLE.NOT_READY;

  return (
    <AppShell pageKey="deliverability" pageTitle={t('deliverability.title')} pageSub={t('deliverability.subtitle')}
      actions={<button style={{ ...card, padding: '6px 12px', cursor: 'pointer', fontSize: 13 }} onClick={load}>{t('deliverability.refresh')}</button>}>
      <div style={{ maxWidth: 1100, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {loading && !d && <div style={card}>{t('deliverability.loading')}</div>}
        {err && !d && <div style={{ ...card, borderColor: '#fca5a5' }}>{t('deliverability.loadError')}</div>}

        {d && <>
          {/* Verdict + score */}
          <div style={{ ...card, background: vs.bg, borderColor: vs.fg, display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div>
              <div style={{ fontSize: 12, color: vs.fg, fontWeight: 600 }}>{t('deliverability.verdictLabel')}</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: vs.fg }}>{t(`deliverability.verdict.${d.verdict}`)}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 12, color: vs.fg }}>{t('deliverability.readiness')}</div>
              <div style={{ fontSize: 28, fontWeight: 800, color: vs.fg }}>{d.readinessScore}/100</div>
            </div>
          </div>

          {d.blockers?.length > 0 && (
            <div style={{ ...card, borderColor: '#fca5a5', fontSize: 13 }}>
              <b>{t('deliverability.blockers')}:</b> {d.blockers.join(', ')}
            </div>
          )}

          {/* Advisor */}
          <div style={card}>
            <h3 style={{ margin: '0 0 10px', fontSize: 15 }}>{t('deliverability.advisor')}</h3>
            {(!d.advisor || d.advisor.length === 0) && <div style={{ fontSize: 13, color: '#16a34a' }}>{t('deliverability.advisorClean')}</div>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {d.advisor?.map((a: any, i: number) => (
                <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 13 }}>
                  {sevBadge(a.severity)}
                  <div>
                    <div style={{ fontWeight: 600 }}>{a.message}</div>
                    {a.evidence && <div style={{ fontSize: 11, color: '#6b7280' }}>{a.evidence}</div>}
                    {a.action && <div style={{ fontSize: 12, color: '#1d4ed8' }}>→ {a.action}</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Launch checklist */}
          <div style={card}>
            <h3 style={{ margin: '0 0 10px', fontSize: 15 }}>{t('deliverability.checklist')}</h3>
            <div style={{ ...grid }}>
              {d.checklist?.map((c: any) => (
                <div key={c.key} style={{ fontSize: 13, display: 'flex', alignItems: 'center' }}>{statusDot(c.status)}{t(`deliverability.check.${c.key}`)}</div>
              ))}
            </div>
          </div>

          {/* Domains / DNS auth */}
          <div style={card}>
            <h3 style={{ margin: '0 0 10px', fontSize: 15 }}>{t('deliverability.dns')}</h3>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, minWidth: 620 }}>
                <thead><tr style={{ textAlign: 'left', color: '#6b7280' }}>
                  <th style={{ padding: 4 }}>{t('deliverability.domain')}</th><th>SPF</th><th>DKIM</th><th>DMARC</th><th>MX</th><th>{t('deliverability.returnPath')}</th><th>Postal</th>
                </tr></thead>
                <tbody>{d.domains?.map((x: any) => (
                  <tr key={x.domain} style={{ borderTop: '1px solid var(--line,#eee)' }}>
                    <td style={{ padding: 4 }}>{x.domain}</td>
                    <td>{yn(x.spf)}</td><td>{yn(x.dkim)}</td><td>{yn(x.dmarc)}</td><td>{yn(x.mx)}</td>
                    <td>{x.sendsViaPostal ? yn(x.returnPathResolves) : <span style={{ color: '#9ca3af' }}>—</span>}</td>
                    <td>{x.sendsViaPostal ? '✓' : <span style={{ color: '#9ca3af' }}>—</span>}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 8 }}>PTR: {d.ptr?.aligned ? yn(true) : yn(false)} {d.ptr?.records?.join(', ')}</div>
          </div>

          {/* Infra cards */}
          <div style={grid}>
            <div style={card}>
              <div style={{ fontSize: 12, color: '#6b7280' }}>Postal / SMTP</div>
              <div style={{ fontSize: 13, marginTop: 4 }}>{t('deliverability.reachable')}: {yn(!!d.postal?.reachable)} · AUTH: {yn(!!d.postal?.auth)} · TLS: {yn(!!d.postal?.tls)}</div>
              <div style={{ fontSize: 11, color: '#6b7280' }}>HELO: {d.postal?.helo ?? '—'} · Banner: {yn(!!d.postal?.bannerOk)}</div>
            </div>
            <div style={card}>
              <div style={{ fontSize: 12, color: '#6b7280' }}>{t('deliverability.blacklist')}</div>
              <div style={{ fontSize: 13, marginTop: 4 }}>Spamhaus: <b style={{ color: d.blacklist?.spamhaus === 'listed' ? '#dc2626' : '#16a34a' }}>{d.blacklist?.spamhaus}</b></div>
              <div style={{ fontSize: 13 }}>Barracuda: <b style={{ color: d.blacklist?.barracuda === 'listed' ? '#dc2626' : '#16a34a' }}>{d.blacklist?.barracuda}</b></div>
            </div>
            <div style={card}>
              <div style={{ fontSize: 12, color: '#6b7280' }}>{t('deliverability.limits')}</div>
              <div style={{ fontSize: 13, marginTop: 4 }}>{t('deliverability.dailyLimit')}: {d.limits?.dailyLimitTotal} · {t('deliverability.hourlyLimit')}: {d.limits?.hourlyLimitTotal}</div>
              <div style={{ fontSize: 11, color: '#6b7280' }}>{t('deliverability.usedToday')}: {d.limits?.usedToday}</div>
            </div>
            <div style={card}>
              <div style={{ fontSize: 12, color: '#6b7280' }}>{t('deliverability.worker')}</div>
              <div style={{ fontSize: 13, marginTop: 4 }}>{d.worker?.alive ? yn(true) : yn(false)} · {d.worker?.heartbeatAgeSec}s</div>
            </div>
            <div style={card}>
              <div style={{ fontSize: 12, color: '#6b7280' }}>{t('deliverability.mailboxes')}</div>
              <div style={{ fontSize: 13, marginTop: 4 }}>{d.senders?.active}/{d.senders?.total} · SMTP {d.senders?.smtpTested} · IMAP {d.senders?.imapMonitored}</div>
            </div>
            <div style={card}>
              <div style={{ fontSize: 12, color: '#6b7280' }}>{t('deliverability.smtpRelay')}</div>
              <div style={{ fontSize: 13, marginTop: 4 }}>{d.smtp?.state}</div>
            </div>
          </div>

          {/* Rates */}
          <div style={card}>
            <h3 style={{ margin: '0 0 10px', fontSize: 15 }}>{t('deliverability.rates')}</h3>
            <div style={grid}>
              <div style={{ fontSize: 13 }}>{t('deliverability.sentToday')}: <b>{d.rates?.sentToday}</b></div>
              <div style={{ fontSize: 13 }}>{t('deliverability.bounceRate')}: <b>{d.rates?.bounceRate}%</b></div>
              <div style={{ fontSize: 13 }}>{t('deliverability.complaintRate')}: <b>{d.rates?.complaintRate}%</b></div>
              <div style={{ fontSize: 13 }}>{t('deliverability.unsubRate')}: <b>{d.rates?.unsubRate}%</b></div>
              <div style={{ fontSize: 13 }}>{t('deliverability.replyRate')}: <b>{d.rates?.replyRate}%</b></div>
            </div>
          </div>

          {/* External integrations — honest not_configured */}
          <div style={card}>
            <h3 style={{ margin: '0 0 6px', fontSize: 15 }}>{t('deliverability.external')}</h3>
            <div style={{ fontSize: 12.5, color: '#6b7280' }}>
              Spamhaus / Barracuda: <b>{t('deliverability.liveDnsbl')}</b> ({d.blacklist?.spamhaus} / {d.blacklist?.barracuda}).
              Google / Microsoft reputation, inbox/spam placement: <b>{t('deliverability.notConfigured')}</b>. {t('deliverability.externalNote')}
            </div>
          </div>

          <div style={{ fontSize: 11, color: '#9ca3af', textAlign: 'right' }}>{t('deliverability.generatedAt')}: {d.generatedAt}</div>
        </>}
      </div>
    </AppShell>
  );
}
