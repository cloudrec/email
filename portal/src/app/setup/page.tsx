'use client';

import { useEffect, useState } from 'react';
import { useLocaleClient } from '../../components/useLocaleClient';
import { useT } from '@/lib/useT';

function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = document.cookie.split('; ').find((c) => c.startsWith('token='))?.split('=')[1];
  const tenantId = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '').get('tenantId');
  return fetch(`/api${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(tenantId ? { 'x-tenant-id': tenantId } : {}),
      ...(init?.headers ?? {}),
    },
  }).then(async (r) => {
    if (r.status === 401) { window.location.href = '/login?next=/setup'; throw new Error('unauthorized'); }
    if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json() as Promise<T>;
  });
}

type SmtpStatus = {
  configured: boolean; host: string; port: number; user_set: boolean;
  from_address: string; reachable: boolean | null; warnings: string[];
  ready_for_send: boolean; state?: string;
};
type Domain = { id: number; domain: string; type: string; status: string; daily_send_limit: number | null };
type DnsRecord = { type: string; host: string; expected: string; purpose: string };
type SenderIdentity = { id: number; from_email: string; from_name: string; domain_status: string };

export default function SetupPage() {
  useLocaleClient();
  const t = useT();
  const [smtp, setSmtp] = useState<SmtpStatus | null>(null);
  const [domains, setDomains] = useState<Domain[]>([]);
  const [identities, setIdentities] = useState<SenderIdentity[]>([]);
  const [selectedDomain, setSelectedDomain] = useState<number | null>(null);
  const [dnsRecords, setDnsRecords] = useState<DnsRecord[] | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // First-test-send state
  const [testTo, setTestTo] = useState('');
  const [testSending, setTestSending] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const load = async () => {
    try {
      const [d, s, id] = await Promise.allSettled([
        api<{ domains: Domain[] }>('/domains'),
        api<SmtpStatus>('/system/smtp-status'),
        api<{ identities: SenderIdentity[] }>('/sender-identities').catch(() => ({ identities: [] as SenderIdentity[] })),
      ]);
      if (d.status === 'fulfilled') setDomains(d.value.domains);
      if (s.status === 'fulfilled') setSmtp(s.value);
      if (id.status === 'fulfilled') setIdentities(id.value.identities);
      setError(null);
    } catch (e: any) { setError(e.message); }
  };

  useEffect(() => { load(); }, []);

  const showDns = async (id: number) => {
    if (selectedDomain === id) { setSelectedDomain(null); setDnsRecords(null); return; }
    try {
      const r = await api<{ records: DnsRecord[] }>(`/domains/${id}/dns-records`);
      setDnsRecords(r.records);
      setSelectedDomain(id);
    } catch (e: any) { setError(e.message); }
  };

  const verify = async (id: number) => {
    setVerifying(true);
    try {
      await api(`/domains/${id}/verify`, { method: 'POST' });
      await load();
    } catch (e: any) { setError(e.message); }
    setVerifying(false);
  };

  const verifiedDomains = domains.filter((d) => d.status === 'verified');
  const smtpReady = smtp?.state === 'ready';
  const hasVerifiedIdentity = identities.some((i) => i.domain_status === 'verified');
  const gates = [
    { ok: verifiedDomains.length > 0, label: t('setup.gates.verifiedDomain'), href: '/domains' },
    { ok: smtpReady, label: t('setup.gates.smtpProvider'), href: '/admin', note: smtp?.state ? t('setup.gates.currentState').replace('{state}', smtp.state.replace(/_/g, ' ')) : undefined },
    { ok: hasVerifiedIdentity, label: t('setup.gates.senderIdentity'), href: '/domains' },
    { ok: false, label: t('setup.gates.subscribedContacts'), href: '/contacts' },
    { ok: false, label: t('setup.gates.approvedDraft'), href: '/outreach' },
  ];
  const gatesDone = gates.filter((g) => g.ok).length;

  // First-test-send preflight
  const testGates = {
    smtpReady,
    domainVerified: verifiedDomains.length > 0,
    identityExists: identities.length > 0,
    recipientEntered: testTo.length > 0,
  };
  const testReady = Object.values(testGates).every(Boolean);

  const sendFirstTest = async () => {
    if (!testReady || testSending) return;
    setTestSending(true);
    setTestResult(null);
    try {
      const r = await api<{ ok: boolean; messageId: string; to: string; from: string; domain: string }>('/system/first-test-send', {
        method: 'POST',
        body: JSON.stringify({ to: testTo }),
      });
      setTestResult({ ok: true, msg: t('setup.test.sentMsg').replace('{id}', r.messageId).replace('{from}', r.from).replace('{domain}', r.domain) });
    } catch (e: any) {
      setTestResult({ ok: false, msg: t('setup.test.failedMsg').replace('{err}', e.message) });
    }
    setTestSending(false);
  };

  return (
    <div>
      {/* Phase 21A Zoho manual bridge note */}
      <div className="card" style={{ borderLeft: '3px solid var(--warn)', background: 'var(--surface-sunken)' }}>
        <h2 style={{ marginBottom: 6 }}>{t('setup.zoho.title')}</h2>
        <p style={{ fontSize: 13, margin: 0 }}>
          {t('setup.zoho.bodyBefore')} <a href="/manual-outreach">{t('setup.zoho.linkText')}</a> {t('setup.zoho.bodyMid')}
          <code> ZOHO_SMTP_USER / ZOHO_SMTP_PASSWORD / ZOHO_IMAP_USER / ZOHO_IMAP_PASSWORD</code> {t('setup.zoho.bodyIn')} <code>.env</code>
          {' '}{t('setup.zoho.bodyAfter')}
        </p>
      </div>

      {/* emails.cheap domain strategy banner */}
      <div className="card" style={{ borderLeft: '3px solid var(--danger)', background: 'var(--surface-sunken)' }}>
        <h2 style={{ color: 'var(--ink)', marginBottom: 8 }}>{t('setup.strategy.title')}</h2>
        <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', marginBottom: 12 }}>
          {[
            { s: `✓ ${t('setup.strategy.statusRegistered')}`, t: t('setup.strategy.row1') },
            { s: verifiedDomains.length > 0 ? `✓ ${t('setup.strategy.statusVerified')}` : `⟳ ${t('setup.strategy.statusPending')}`, t: t('setup.strategy.row2').replace('{detail}', verifiedDomains.length > 0 ? t('setup.strategy.row2Verified') : t('setup.strategy.row2Pending')) },
            { s: `— ${t('setup.strategy.statusPlanned')}`, t: t('setup.strategy.row3') },
            { s: `— ${t('setup.strategy.statusPlanned')}`, t: t('setup.strategy.row4') },
            { s: `— ${t('setup.strategy.statusPlanned')}`, t: t('setup.strategy.row5') },
          ].map(({ s, t: rowText }, i) => (
            <div key={i} style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 4, padding: '8px 12px' }}>
              <span style={{ fontWeight: 600, color: s.startsWith('✓') ? 'var(--ok)' : s.startsWith('⟳') ? 'var(--warn)' : 'var(--muted)', fontSize: 12 }}>{s}</span>
              <p style={{ margin: '3px 0 0', fontSize: 13, color: 'var(--ink-2)' }}>{rowText}</p>
            </div>
          ))}
        </div>
        <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 4, padding: '10px 14px', fontSize: 12, lineHeight: 1.6 }}>
          <strong style={{ color: 'var(--warn)' }}>⚠ {t('setup.strategy.isolationTitle')}</strong>{' '}
          <span style={{ color: 'var(--ink-2)' }}>
            {t('setup.strategy.isolationBody')}
          </span>
        </div>
      </div>

      {/* Sending gates */}
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
          <h2>{t('setup.gates.title')}</h2>
          <span style={{ fontSize: 13, color: gatesDone === gates.length ? 'var(--ok)' : 'var(--warn)' }}>
            {t('setup.gates.readyCount').replace('{done}', String(gatesDone)).replace('{total}', String(gates.length))}
          </span>
        </div>
        <ol style={{ margin: 0, paddingLeft: 18 }}>
          {gates.map((g, i) => (
            <li key={i} style={{ margin: '7px 0', color: g.ok ? 'var(--muted)' : 'var(--ink)' }}>
              <span style={{ marginRight: 8, color: g.ok ? 'var(--ok)' : 'var(--warn)' }}>{g.ok ? '✓' : '○'}</span>
              {g.ok ? <s style={{ color: 'var(--muted)' }}>{g.label}</s> : <a href={g.href}>{g.label}</a>}
              {(g as any).note && <span style={{ fontSize: 11, color: 'var(--ink-3)', marginLeft: 8 }}>({(g as any).note})</span>}
            </li>
          ))}
        </ol>
        {gatesDone < gates.length && (
          <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
            {t('setup.gates.blockedNote')}
          </p>
        )}
      </div>

      {/* Domain list */}
      <div className="card">
        <h2>{t('setup.domains.title')}</h2>
        {domains.length === 0 ? (
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>{t('setup.domains.empty')} <a href="/domains">{t('setup.domains.addLink')}</a></p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--line)' }}>
                <th align="left" style={{ padding: '6px 0' }}>{t('setup.domains.colDomain')}</th>
                <th align="left">{t('setup.domains.colStatus')}</th>
                <th align="left">{t('setup.domains.colDailyLimit')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {domains.map((d) => (
                <>
                  <tr key={d.id} style={{ borderTop: '1px solid var(--line)' }}>
                    <td style={{ padding: '8px 0' }}><code style={{ fontSize: 12 }}>{d.domain}</code></td>
                    <td>
                      <span className={`badge ${d.status === 'verified' ? 'ok' : d.status === 'failed' ? 'fail' : 'warn'}`}>
                        {d.status}
                      </span>
                    </td>
                    <td style={{ color: 'var(--ink-2)' }}>{t('setup.domains.perDay').replace('{limit}', String(d.daily_send_limit ?? '—'))}</td>
                    <td style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                      <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => showDns(d.id)}>
                        {t('setup.domains.dnsRecords')}
                      </button>
                      <button className="btn btn-ghost" style={{ fontSize: 12 }} disabled={verifying} onClick={() => verify(d.id)}>
                        {verifying ? '…' : t('setup.domains.verify')}
                      </button>
                    </td>
                  </tr>
                  {selectedDomain === d.id && dnsRecords && (
                    <tr key={`dns-${d.id}`}>
                      <td colSpan={4} style={{ padding: '0 0 10px 0' }}>
                        <div style={{ background: 'var(--surface-sunken)', border: '1px solid var(--line)', borderRadius: 4, padding: 12, marginTop: 4 }}>
                          <p style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 8 }}>
                            {t('setup.domains.dnsHint')}
                          </p>
                          <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
                            <thead>
                              <tr style={{ borderBottom: '1px solid var(--line)' }}>
                                <th align="left" style={{ padding: '4px 0' }}>{t('setup.domains.colPurpose')}</th>
                                <th align="left">{t('setup.domains.colType')}</th>
                                <th align="left">{t('setup.domains.colHost')}</th>
                                <th align="left">{t('setup.domains.colValue')}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {dnsRecords.map((r, i) => (
                                <tr key={i} style={{ borderTop: '1px solid var(--line-2)' }}>
                                  <td style={{ padding: '4px 8px 4px 0', color: 'var(--ink-3)', textTransform: 'capitalize' }}>{r.purpose}</td>
                                  <td style={{ color: 'var(--ink-2)' }}>{r.type}</td>
                                  <td><code style={{ fontSize: 10, wordBreak: 'break-all' }}>{r.host}</code></td>
                                  <td><code style={{ fontSize: 10, wordBreak: 'break-all', color: 'var(--accent)' }}>{r.expected}</code></td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        )}
        <div style={{ marginTop: 10 }}>
          <a className="btn btn-ghost" href="/domains">{t('setup.domains.manageLink')}</a>
        </div>
      </div>

      {/* SMTP */}
      <div className="card">
        <h2>{t('setup.smtp.title')}</h2>
        {smtp ? (
          <>
            <div style={{ marginBottom: 10 }}>
              {smtp.state === 'ready'
                ? <span className="badge ok" style={{ padding: '4px 10px' }}>✓ {t('setup.smtp.badgeReady')}</span>
                : smtp.state === 'test_only_mailhog'
                ? <span className="badge warn" style={{ padding: '4px 10px' }}>⚠ {t('setup.smtp.badgeMailhog')}</span>
                : smtp.state === 'not_configured'
                ? <span className="badge warn" style={{ padding: '4px 10px' }}>⚠ {t('setup.smtp.badgeNotConfigured')}</span>
                : smtp.state === 'auth_failed'
                ? <span className="badge warn" style={{ padding: '4px 10px' }}>⚠ {t('setup.smtp.badgeAuthFailed')}</span>
                : <span className="badge warn" style={{ padding: '4px 10px' }}>⚠ {String(smtp.state ?? '').replace(/_/g, ' ')}</span>
              }
            </div>
            {smtp.state === 'test_only_mailhog' && (
              <div style={{ background: 'var(--surface-sunken)', border: '1px solid var(--warn)', borderRadius: 6, padding: '10px 14px', marginBottom: 12, fontSize: 12.5 }}>
                <strong style={{ color: 'var(--warn)' }}>{t('setup.smtp.mailhogTitle')}</strong>{' '}
                <span style={{ color: 'var(--ink-2)' }}>
                  {t('setup.smtp.mailhogBodyBefore')} <code>http://localhost:8025</code>. {t('setup.smtp.mailhogBodyAfter')}
                </span>
              </div>
            )}
            <table style={{ width: '100%', fontSize: 13 }}>
              <tbody>
                <tr><td style={{ color: 'var(--ink-3)', width: 140 }}>{t('setup.smtp.rowState')}</td><td><code style={{ color: smtp.state === 'ready' ? 'var(--ok)' : 'var(--warn)' }}>{smtp.state}</code></td></tr>
                <tr><td style={{ color: 'var(--ink-3)' }}>{t('setup.smtp.rowHost')}</td><td><code>{smtp.host || '—'}</code></td></tr>
                <tr><td style={{ color: 'var(--ink-3)' }}>{t('setup.smtp.rowPort')}</td><td>{smtp.port}</td></tr>
                <tr><td style={{ color: 'var(--ink-3)' }}>{t('setup.smtp.rowFromAddress')}</td><td><code>{smtp.from_address || '—'}</code></td></tr>
                <tr><td style={{ color: 'var(--ink-3)' }}>{t('setup.smtp.rowAuthSet')}</td><td>{smtp.user_set ? '✓' : '—'}</td></tr>
                <tr><td style={{ color: 'var(--ink-3)' }}>{t('setup.smtp.rowReachable')}</td><td>{smtp.reachable === null ? '—' : smtp.reachable ? '✓' : '✗'}</td></tr>
              </tbody>
            </table>
          </>
        ) : (
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>{t('setup.smtp.loading')}</p>
        )}
      </div>

      {/* SMTP provider setup instructions */}
      <div className="card">
        <h2>{t('setup.provider.title')}</h2>
        <p style={{ fontSize: 13, color: 'var(--ink-2)', marginBottom: 14 }}>
          {t('setup.provider.editBefore')} <code>/opt/email/.env</code> {t('setup.provider.editMid')} <code>docker compose restart api worker</code>.
        </p>
        <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
          {[
            {
              name: t('setup.provider.brevo'),
              env: 'SMTP_HOST=smtp-relay.brevo.com\nSMTP_PORT=587\nSMTP_USER=<your@email.com>\nSMTP_PASSWORD=<SMTP-key>\nSMTP_FROM=you@yourdomain.com',
            },
            {
              name: t('setup.provider.smtp2go'),
              env: 'SMTP_HOST=mail.smtp2go.com\nSMTP_PORT=587\nSMTP_USER=<smtp2go-username>\nSMTP_PASSWORD=<smtp2go-password>\nSMTP_FROM=you@yourdomain.com',
            },
            {
              name: t('setup.provider.mailgun'),
              env: 'SMTP_HOST=smtp.mailgun.org\nSMTP_PORT=587\nSMTP_USER=postmaster@mg.yourdomain.com\nSMTP_PASSWORD=<mailgun-SMTP-password>\nSMTP_FROM=you@yourdomain.com',
            },
            {
              name: t('setup.provider.ses'),
              env: 'SMTP_HOST=email-smtp.us-east-1.amazonaws.com\nSMTP_PORT=587\nSMTP_USER=<AKID>\nSMTP_PASSWORD=<SES-SMTP-secret>\nSMTP_FROM=you@yourdomain.com',
            },
            {
              name: t('setup.provider.postmark'),
              env: '# Postmark prohibits cold outreach — do not use for this platform.\n# Transactional only.',
            },
          ].map(({ name, env }) => (
            <div key={name} style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 6, padding: '10px 14px' }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, color: 'var(--ink)' }}>{name}</div>
              <pre style={{ margin: 0, fontSize: 10.5, color: 'var(--accent)', background: 'var(--surface-sunken)', padding: '6px 8px', borderRadius: 4, overflowX: 'auto', lineHeight: 1.7 }}>{env}</pre>
            </div>
          ))}
        </div>
        <p style={{ fontSize: 11.5, color: 'var(--ink-3)', marginTop: 12 }}>
          {t('setup.provider.afterBefore')} <code>ready</code> {t('setup.provider.afterAfter')}
        </p>
      </div>

      {/* Step-by-step guide */}
      <div className="card">
        <h2>{t('setup.steps.title')}</h2>
        <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
          {[
            { n: 1, done: verifiedDomains.length > 0, t: t('setup.steps.s1') },
            { n: 2, done: verifiedDomains.length > 0, t: t('setup.steps.s2') },
            { n: 3, done: smtpReady, t: t('setup.steps.s3') },
            { n: 4, done: smtpReady, t: t('setup.steps.s4') },
            { n: 5, done: smtpReady, t: t('setup.steps.s5') },
            { n: 6, done: hasVerifiedIdentity, t: t('setup.steps.s6') },
            { n: 7, done: false, t: t('setup.steps.s7') },
            { n: 8, done: false, t: t('setup.steps.s8') },
            { n: 9, done: false, t: t('setup.steps.s9') },
            { n: 10, done: false, t: t('setup.steps.s10') },
          ].map(({ n, done, t: stepText }) => (
            <li key={n} style={{ margin: '6px 0', fontSize: 13, color: done ? 'var(--muted)' : 'var(--ink-2)' }}>
              <strong style={{ color: done ? 'var(--ok)' : 'var(--ink)' }}>{done ? '✓' : t('setup.steps.stepLabel').replace('{n}', String(n))}</strong>{' '}{done ? <s style={{ color: 'var(--muted)' }}>{stepText}</s> : stepText}
            </li>
          ))}
        </ol>
      </div>

      {/* SMTP owner checklist */}
      <div className="card" style={{ borderLeft: '3px solid var(--accent)' }}>
        <h2>{t('setup.checklist.title')}</h2>
        <p style={{ fontSize: 13, color: 'var(--ink-2)', marginBottom: 14 }}>
          {t('setup.checklist.introBefore')} <code>ready</code>{t('setup.checklist.introAfter')}
        </p>
        <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.9 }}>
          {[
            { n: 1, t: t('setup.checklist.c1') },
            { n: 2, t: t('setup.checklist.c2') },
            { n: 3, t: <>{t('setup.checklist.c3Before')} <code>/opt/email/.env</code> {t('setup.checklist.c3After')}</> },
            { n: 4, t: <>{t('setup.checklist.c4Before')} <code>docker compose up -d --build api worker</code></> },
            { n: 5, t: t('setup.checklist.c5') },
            { n: 6, t: t('setup.checklist.c6') },
            { n: 7, t: t('setup.checklist.c7') },
            { n: 8, t: t('setup.checklist.c8') },
          ].map(({ n, t: itemText }) => (
            <li key={n} style={{ margin: '5px 0', fontSize: 13, color: 'var(--ink-2)' }}>
              <strong style={{ color: 'var(--ink)' }}>{t('setup.checklist.stepLabel').replace('{n}', String(n))}</strong> {itemText}
            </li>
          ))}
        </ol>
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-3)', marginBottom: 6 }}>{t('setup.checklist.envTemplateLabel')}</div>
          <pre style={{ margin: 0, fontSize: 11.5, color: 'var(--accent)', background: 'var(--surface-sunken)', padding: '10px 14px', borderRadius: 6, overflowX: 'auto', lineHeight: 1.8 }}>{
`SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=<your@email.com>
SMTP_PASSWORD=<your-brevo-smtp-key>
SMTP_FROM_ADDRESS=outreach@mail.emails.cheap
SMTP_FROM_NAME="Emails Cheap"`
          }</pre>
          <p style={{ fontSize: 11.5, color: 'var(--ink-3)', marginTop: 8 }}>
            {t('setup.checklist.fallbackNote')}
          </p>
        </div>
      </div>

      {/* First real test email */}
      <div className="card" style={{ borderLeft: `3px solid ${testReady ? 'var(--ok)' : 'var(--warn)'}` }}>
        <h2>{t('setup.test.title')}</h2>
        <p style={{ fontSize: 13, color: 'var(--ink-2)', marginBottom: 14 }}>
          {t('setup.test.intro')}
        </p>

        {/* Preflight checklist */}
        <div style={{ display: 'grid', gap: 6, marginBottom: 16 }}>
          {[
            { ok: testGates.smtpReady, label: t('setup.test.gateSmtpReady'), note: smtp?.state ? smtp.state.replace(/_/g, ' ') : t('setup.test.noteLoading') },
            { ok: testGates.domainVerified, label: t('setup.test.gateDomainVerified'), note: verifiedDomains[0]?.domain ?? t('setup.test.noteNone') },
            { ok: testGates.identityExists, label: t('setup.test.gateIdentityExists'), note: identities[0]?.from_email ?? t('setup.test.noteNone') },
            { ok: testGates.recipientEntered, label: t('setup.test.gateRecipient'), note: '' },
          ].map(({ ok, label, note }, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5 }}>
              <span style={{ color: ok ? 'var(--ok)' : 'var(--warn)', fontSize: 14, lineHeight: 1 }}>{ok ? '✓' : '○'}</span>
              <span style={{ color: ok ? 'var(--muted)' : 'var(--ink)' }}>{ok ? <s style={{ color: 'var(--muted)' }}>{label}</s> : label}</span>
              {note && <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>({note})</span>}
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="email"
            placeholder={t('setup.test.placeholder')}
            value={testTo}
            onChange={e => { setTestTo(e.target.value); setTestResult(null); }}
            style={{ padding: '7px 10px', border: '1px solid var(--line)', borderRadius: 6, fontSize: 13,
              background: 'var(--surface)', color: 'var(--ink)', minWidth: 240 }}
          />
          <button
            className="btn btn-primary"
            disabled={!testReady || testSending}
            onClick={sendFirstTest}
            style={{ fontSize: 13 }}
          >
            {testSending ? t('setup.test.sending') : t('setup.test.sendButton')}
          </button>
          {!testGates.smtpReady && (
            <span style={{ fontSize: 12, color: 'var(--warn)' }}>{t('setup.test.configureFirst')}</span>
          )}
        </div>

        {testResult && (
          <div style={{
            marginTop: 12, padding: '8px 14px', borderRadius: 6, fontSize: 12.5,
            background: testResult.ok ? 'var(--surface-sunken)' : 'var(--surface-sunken)',
            border: `1px solid ${testResult.ok ? 'var(--ok)' : 'var(--danger)'}`,
            color: testResult.ok ? 'var(--ok)' : 'var(--danger)',
          }}>
            {testResult.ok ? '✓ ' : '✗ '}{testResult.msg}
          </div>
        )}
      </div>

      {/* Anti-abuse */}
      <div className="card" style={{ borderLeft: '3px solid var(--warn)' }}>
        <h2>{t('setup.abuse.title')}</h2>
        <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8, fontSize: 13, color: 'var(--ink-2)' }}>
          {[
            t('setup.abuse.r1'),
            t('setup.abuse.r2'),
            t('setup.abuse.r3'),
            t('setup.abuse.r4'),
            t('setup.abuse.r5'),
            t('setup.abuse.r6'),
            t('setup.abuse.r7'),
            t('setup.abuse.r8'),
            t('setup.abuse.r9'),
            t('setup.abuse.r10'),
            t('setup.abuse.r11'),
          ].map((rule, i) => (
            <li key={i} style={{ margin: '4px 0' }}>{rule}</li>
          ))}
        </ul>
      </div>

      {error && <div className="card"><p style={{ color: 'var(--danger)' }}>{error}</p></div>}
    </div>
  );
}
