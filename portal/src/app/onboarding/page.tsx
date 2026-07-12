'use client';

import { useEffect, useRef, useState } from 'react';
import { useT } from '@/lib/useT';

// ─── API helper ──────────────────────────────────────────────────────────────

function getAuth() {
  const token = document.cookie.split('; ').find((c) => c.startsWith('token='))?.split('=')[1] ?? '';
  const tenantId = new URLSearchParams(window.location.search).get('tenantId') ?? '';
  return { token, tenantId };
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const { token, tenantId } = getAuth();
  const r = await fetch(`/api${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(tenantId ? { 'x-tenant-id': tenantId } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (r.status === 401) { window.location.href = '/login?next=/onboarding'; throw new Error('unauthorized'); }
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`${r.status}: ${body.slice(0, 200)}`);
  }
  return r.json() as Promise<T>;
}

// ─── Persistence ─────────────────────────────────────────────────────────────

type SavedState = {
  completedSteps: number[];
  profileId?: number;
  domainId?: number;
  domainName?: string;
  dnsRecords?: any[];
  identityId?: number;
  listId?: number;
  listName?: string;
};

function storageKey(tenantId: string) {
  return `wizard:v1:${tenantId || 'default'}`;
}

function loadSaved(tenantId: string): SavedState {
  try {
    const raw = localStorage.getItem(storageKey(tenantId));
    return raw ? JSON.parse(raw) : { completedSteps: [] };
  } catch { return { completedSteps: [] }; }
}

function saveSaved(tenantId: string, s: SavedState) {
  try { localStorage.setItem(storageKey(tenantId), JSON.stringify(s)); } catch {}
}

// ─── Step config ─────────────────────────────────────────────────────────────

const STEPS = [
  { n: 1, titleKey: 'steps.brandProfile.title',  subKey: 'steps.brandProfile.sub' },
  { n: 2, titleKey: 'steps.sendingDomain.title', subKey: 'steps.sendingDomain.sub' },
  { n: 3, titleKey: 'steps.senderIdentity.title', subKey: 'steps.senderIdentity.sub' },
  { n: 4, titleKey: 'steps.importLeads.title',   subKey: 'steps.importLeads.sub', optional: true },
  { n: 5, titleKey: 'steps.readyToGo.title',     subKey: 'steps.readyToGo.sub' },
];

// ─── Mini components ─────────────────────────────────────────────────────────

function Stepper({ current, completed }: { current: number; completed: number[] }) {
  const t = useT();
  return (
    <div style={{ display: 'flex', gap: 0, marginBottom: 32, borderRadius: 6, overflow: 'hidden', border: '1px solid var(--line)' }}>
      {STEPS.map((s) => {
        const done = completed.includes(s.n);
        const active = s.n === current;
        return (
          <div
            key={s.n}
            style={{
              flex: 1, padding: '10px 8px', textAlign: 'center', fontSize: 12,
              background: active ? 'var(--accent)' : done ? 'var(--surface-2)' : 'var(--surface)',
              color: active ? '#fff' : done ? 'var(--ok)' : 'var(--muted)',
              borderRight: '1px solid var(--line)',
              fontWeight: active ? 700 : 400,
              transition: 'background 0.2s',
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 2 }}>
              {done ? '✓' : s.n}
            </div>
            <div style={{ lineHeight: 1.3, fontSize: 11 }}>{t(`onboarding.${s.titleKey}`)}</div>
          </div>
        );
      })}
    </div>
  );
}

function Err({ msg }: { msg: string | null }) {
  if (!msg) return null;
  return (
    <div style={{ background: '#2a0c0c', border: '1px solid var(--danger)', borderRadius: 4, padding: '8px 12px', color: '#ffaaaa', fontSize: 13, marginTop: 12 }}>
      {msg}
    </div>
  );
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: 'block', fontWeight: 600, fontSize: 13, marginBottom: 5, color: 'var(--ink-2)' }}>{label}</label>
      {children}
      {hint && <p style={{ fontSize: 11, color: 'var(--muted)', margin: '4px 0 0' }}>{hint}</p>}
    </div>
  );
}

function Btn({ children, onClick, disabled, secondary, ghost }: {
  children: React.ReactNode; onClick?: () => void; disabled?: boolean; secondary?: boolean; ghost?: boolean;
}) {
  return (
    <button
      className={`btn${secondary ? '' : ghost ? ' btn-ghost' : ''}`}
      onClick={onClick}
      disabled={disabled}
      style={secondary ? { background: 'var(--surface-2)', color: 'var(--ink-2)', border: '1px solid var(--line)' } : undefined}
    >
      {children}
    </button>
  );
}

// ─── Step 1: Brand Profile ────────────────────────────────────────────────────

function Step1Profile({
  saved, onDone,
}: {
  saved: SavedState;
  onDone: (profileId: number) => void;
}) {
  const t = useT();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [desc, setDesc] = useState('');
  const [target, setTarget] = useState('');
  const [tone, setTone] = useState<'neutral' | 'friendly' | 'professional' | 'short_direct'>('professional');
  const [lang, setLang] = useState<'en' | 'ru' | 'uk'>('en');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Pre-fill if already done
  useEffect(() => {
    if (saved.profileId) {
      api<{ profiles: any[] }>('/product-profiles').then((r) => {
        const p = r.profiles.find((x) => x.id === saved.profileId) ?? r.profiles[0];
        if (p) {
          setName(p.name ?? '');
          setUrl(p.product_url ?? '');
          setDesc(p.description ?? '');
          setTarget(p.target_customer ?? '');
          setTone(p.preferred_tone ?? 'professional');
          setLang(p.default_language ?? 'en');
        }
      }).catch(() => {});
    }
  }, []);

  const submit = async () => {
    if (!name.trim() || !desc.trim()) { setErr(t('onboarding.step1.errNameDescRequired')); return; }
    if (desc.trim().length < 10) { setErr(t('onboarding.step1.errDescMin')); return; }
    setLoading(true); setErr(null);
    try {
      const payload = {
        name: name.trim(), productUrl: url.trim() || null,
        description: desc.trim(), targetCustomer: target.trim() || null,
        keyBenefits: [], allowedClaims: [], forbiddenClaims: [],
        preferredTone: tone, defaultLanguage: lang, isDefault: true,
      };
      let id: number;
      if (saved.profileId) {
        await api(`/product-profiles/${saved.profileId}`, { method: 'PATCH', body: JSON.stringify(payload) });
        id = saved.profileId;
      } else {
        const r = await api<{ id: number }>('/product-profiles', { method: 'POST', body: JSON.stringify(payload) });
        id = r.id;
      }
      onDone(id);
    } catch (e: any) { setErr(e.message); }
    setLoading(false);
  };

  return (
    <div>
      <Field label={t('onboarding.step1.nameLabel')} hint={t('onboarding.step1.nameHint')}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('onboarding.step1.namePlaceholder')} />
      </Field>
      <Field label={t('onboarding.step1.urlLabel')} hint={t('onboarding.step1.urlHint')}>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com" />
      </Field>
      <Field label={t('onboarding.step1.descLabel')} hint={t('onboarding.step1.descHint')}>
        <textarea value={desc} onChange={(e) => setDesc(e.target.value)}
          rows={4} placeholder={t('onboarding.step1.descPlaceholder')} />
      </Field>
      <Field label={t('onboarding.step1.targetLabel')} hint={t('onboarding.step1.targetHint')}>
        <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder={t('onboarding.step1.targetPlaceholder')} />
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <Field label={t('onboarding.step1.toneLabel')}>
          <select value={tone} onChange={(e) => setTone(e.target.value as any)}>
            <option value="professional">{t('onboarding.step1.toneProfessional')}</option>
            <option value="friendly">{t('onboarding.step1.toneFriendly')}</option>
            <option value="neutral">{t('onboarding.step1.toneNeutral')}</option>
            <option value="short_direct">{t('onboarding.step1.toneShortDirect')}</option>
          </select>
        </Field>
        <Field label={t('onboarding.step1.langLabel')}>
          <select value={lang} onChange={(e) => setLang(e.target.value as any)}>
            <option value="en">{t('onboarding.step1.langEn')}</option>
            <option value="ru">{t('onboarding.step1.langRu')}</option>
            <option value="uk">{t('onboarding.step1.langUk')}</option>
          </select>
        </Field>
      </div>
      <Err msg={err} />
      <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
        <Btn onClick={submit} disabled={loading}>{loading ? t('onboarding.common.saving') : saved.profileId ? t('onboarding.step1.updateContinue') : t('onboarding.common.saveContinue')}</Btn>
      </div>
    </div>
  );
}

// ─── Step 2: Domain ───────────────────────────────────────────────────────────

function Step2Domain({
  saved, onDone, onBack,
}: {
  saved: SavedState;
  onDone: (domainId: number, domainName: string, records: any[]) => void;
  onBack: () => void;
}) {
  const t = useT();
  const [domain, setDomain] = useState(saved.domainName ?? '');
  const [records, setRecords] = useState<any[]>(saved.dnsRecords ?? []);
  const [domainId, setDomainId] = useState<number | null>(saved.domainId ?? null);
  const [status, setStatus] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const add = async () => {
    if (!domain.trim()) { setErr(t('onboarding.step2.errEnterDomain')); return; }
    setLoading(true); setErr(null);
    try {
      const r = await api<{ id: number; domain: string; records: any[] }>('/domains', {
        method: 'POST',
        body: JSON.stringify({ domain: domain.trim().toLowerCase(), type: 'sending', dkimSelector: 'mail' }),
      });
      setDomainId(r.id);
      setRecords(r.records);
      setDomain(r.domain);
    } catch (e: any) {
      if (e.message.includes('Duplicate')) setErr(t('onboarding.step2.errDuplicate'));
      else setErr(e.message);
    }
    setLoading(false);
  };

  const verify = async () => {
    if (!domainId) return;
    setVerifying(true); setErr(null);
    try {
      const r = await api<{ status: string }>(`/domains/${domainId}/verify`, { method: 'POST' });
      setStatus(r.status);
    } catch (e: any) { setErr(e.message); }
    setVerifying(false);
  };

  const proceed = () => {
    if (domainId) onDone(domainId, domain, records);
  };

  const alreadyHasDomain = !!domainId && records.length > 0;

  return (
    <div>
      <p style={{ fontSize: 13, color: 'var(--ink-3)', marginBottom: 16 }}>
        {t('onboarding.step2.introBefore')} <code>mail.yourdomain.com</code>. {t('onboarding.step2.introAfter')}
      </p>
      {!alreadyHasDomain ? (
        <Field label={t('onboarding.step2.subdomainLabel')} hint={t('onboarding.step2.subdomainHint')}>
          <div style={{ display: 'flex', gap: 8 }}>
            <input style={{ flex: 1 }} value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="mail.yourdomain.com" />
            <Btn onClick={add} disabled={loading}>{loading ? t('onboarding.step2.adding') : t('onboarding.step2.addDomain')}</Btn>
          </div>
        </Field>
      ) : (
        <div style={{ background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 5, padding: '12px 14px', marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <code style={{ fontSize: 14 }}>{domain}</code>
              {status && (
                <span className={`badge ${status === 'verified' ? 'ok' : status === 'failed' ? 'fail' : 'warn'}`} style={{ marginLeft: 10 }}>
                  {status}
                </span>
              )}
            </div>
            <Btn ghost onClick={() => { setDomainId(null); setRecords([]); setStatus(null); }}>{t('onboarding.step2.change')}</Btn>
          </div>
        </div>
      )}

      {records.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <h3 style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>{t('onboarding.step2.dnsHeading')}</h3>
          <p style={{ fontSize: 12, color: 'var(--ink-3)', marginBottom: 8 }}>
            {t('onboarding.step2.dnsProxyBefore')} <strong>{t('onboarding.step2.dnsProxyBold')}</strong> {t('onboarding.step2.dnsProxyAfter')}
          </p>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--line)' }}>
                  {[t('onboarding.step2.colPurpose'), t('onboarding.step2.colType'), t('onboarding.step2.colHost'), t('onboarding.step2.colValue')].map((h) => (
                    <th key={h} align="left" style={{ padding: '5px 8px 5px 0', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {records.map((r, i) => (
                  <tr key={i} style={{ borderTop: '1px solid var(--line-2)' }}>
                    <td style={{ padding: '5px 8px 5px 0', color: 'var(--ink-3)', textTransform: 'capitalize' }}>{r.purpose}</td>
                    <td style={{ padding: '5px 8px 5px 0', color: 'var(--ink-2)' }}>{r.type}</td>
                    <td style={{ padding: '5px 8px 5px 0' }}><code style={{ fontSize: 10, wordBreak: 'break-all' }}>{r.host}</code></td>
                    <td style={{ padding: '5px 0' }}><code style={{ fontSize: 10, wordBreak: 'break-all', color: 'var(--accent)' }}>{r.expected}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <Btn ghost onClick={verify} disabled={verifying}>
              {verifying ? t('onboarding.step2.checkingDns') : `⟳ ${t('onboarding.step2.verifyDns')}`}
            </Btn>
            {status === 'verified' && <span style={{ color: 'var(--ok)', fontSize: 13, alignSelf: 'center' }}>✓ {t('onboarding.step2.allVerified')}</span>}
            {status && status !== 'verified' && <span style={{ color: 'var(--warn)', fontSize: 13, alignSelf: 'center' }}>{t('onboarding.step2.notResolved')}</span>}
          </div>
        </div>
      )}

      <Err msg={err} />
      <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
        <Btn secondary onClick={onBack}>← {t('onboarding.common.back')}</Btn>
        {alreadyHasDomain && <Btn onClick={proceed}>{t('onboarding.common.continue')} →</Btn>}
      </div>
    </div>
  );
}

// ─── Step 3: Sender Identity ──────────────────────────────────────────────────

function Step3Sender({
  saved, onDone, onBack, onSkip,
}: {
  saved: SavedState;
  onDone: (id: number) => void;
  onBack: () => void;
  onSkip: () => void;
}) {
  const t = useT();
  const [fromName, setFromName] = useState('');
  const [fromEmail, setFromEmail] = useState(saved.domainName ? `hello@${saved.domainName}` : '');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [existing, setExisting] = useState<any[]>([]);

  useEffect(() => {
    api<{ identities: any[] }>('/sender-identities').then((r) => {
      setExisting(r.identities);
      if (saved.identityId) {
        const id = r.identities.find((x) => x.id === saved.identityId);
        if (id) { setFromName(id.from_name); setFromEmail(id.from_email); }
      }
    }).catch(() => {});
  }, []);

  const submit = async () => {
    if (!fromName.trim() || !fromEmail.trim()) { setErr(t('onboarding.step3.errFromRequired')); return; }
    if (!saved.domainId) { setErr(t('onboarding.step3.errNoDomain')); return; }
    setLoading(true); setErr(null);
    try {
      const r = await api<{ id: number }>('/sender-identities', {
        method: 'POST',
        body: JSON.stringify({ fromName: fromName.trim(), fromEmail: fromEmail.trim(), domainId: saved.domainId, isDefault: true }),
      });
      onDone(r.id);
    } catch (e: any) { setErr(e.message); }
    setLoading(false);
  };

  return (
    <div>
      <p style={{ fontSize: 13, color: 'var(--ink-3)', marginBottom: 16 }}>
        {t('onboarding.step3.introBefore')} <code>{saved.domainName ?? t('onboarding.step3.yourSendingDomain')}</code>.
      </p>
      {existing.length > 0 && !saved.identityId && (
        <div style={{ background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 4, padding: '10px 14px', marginBottom: 16, fontSize: 13 }}>
          {t('onboarding.step3.alreadyHave').replace('{count}', String(existing.length)).replace('{noun}', existing.length === 1 ? t('onboarding.step3.identitySingular') : t('onboarding.step3.identityPlural'))}{' '}
          <Btn ghost onClick={onSkip}>{t('onboarding.step3.useExisting')} →</Btn>
        </div>
      )}
      <Field label={t('onboarding.step3.fromNameLabel')} hint={t('onboarding.step3.fromNameHint')}>
        <input value={fromName} onChange={(e) => setFromName(e.target.value)} placeholder={t('onboarding.step3.fromNamePlaceholder')} />
      </Field>
      <Field label={t('onboarding.step3.fromEmailLabel')} hint={t('onboarding.step3.fromEmailHint').replace('{domain}', saved.domainName ?? 'your-sending-domain.com')}>
        <input type="email" value={fromEmail} onChange={(e) => setFromEmail(e.target.value)}
          placeholder={`hello@${saved.domainName ?? 'mail.yourdomain.com'}`} />
      </Field>
      {!saved.domainName && (
        <div style={{ background: '#1a1200', border: '1px solid var(--warn)', borderRadius: 4, padding: '8px 12px', fontSize: 12, color: 'var(--warn)', marginBottom: 8 }}>
          {t('onboarding.step3.noVerifiedDomain')}
        </div>
      )}
      <Err msg={err} />
      <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
        <Btn secondary onClick={onBack}>← {t('onboarding.common.back')}</Btn>
        <Btn onClick={submit} disabled={loading}>{loading ? t('onboarding.common.saving') : t('onboarding.common.saveContinue')}</Btn>
        <Btn ghost onClick={onSkip}>{t('onboarding.common.skipForNow')}</Btn>
      </div>
    </div>
  );
}

// ─── Step 4: Import Leads ─────────────────────────────────────────────────────

function Step4Leads({
  onDone, onBack, onSkip,
}: {
  onDone: (listId: number, listName: string) => void;
  onBack: () => void;
  onSkip: () => void;
}) {
  const t = useT();
  const [listName, setListName] = useState(t('onboarding.step4.defaultListName'));
  const [industry, setIndustry] = useState('');
  const [country, setCountry] = useState('');
  const [fit, setFit] = useState('good_fit');
  const [limit, setLimit] = useState(100);
  const [preview, setPreview] = useState<{ eligible: number; wouldImport: number } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const dryRun = async () => {
    setPreviewing(true); setErr(null); setPreview(null);
    try {
      const r = await api<{ eligible: number; wouldImport: number }>('/contacts/lists/from-warehouse', {
        method: 'POST',
        body: JSON.stringify({
          name: listName, dryRun: true,
          industry: industry || undefined,
          country: country || undefined,
          productFit: fit || undefined,
          limit,
        }),
      });
      setPreview(r);
    } catch (e: any) { setErr(e.message); }
    setPreviewing(false);
  };

  const importNow = async () => {
    if (!listName.trim()) { setErr(t('onboarding.step4.errListNameRequired')); return; }
    setImporting(true); setErr(null);
    try {
      const r = await api<{ listId: number; imported: number }>('/contacts/lists/from-warehouse', {
        method: 'POST',
        body: JSON.stringify({
          name: listName, dryRun: false,
          industry: industry || undefined,
          country: country || undefined,
          productFit: fit || undefined,
          limit,
        }),
      });
      onDone(r.listId, listName);
    } catch (e: any) { setErr(e.message); }
    setImporting(false);
  };

  return (
    <div>
      <p style={{ fontSize: 13, color: 'var(--ink-3)', marginBottom: 16 }}>
        {t('onboarding.step4.intro')}
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <Field label={t('onboarding.step4.listNameLabel')}>
          <input value={listName} onChange={(e) => setListName(e.target.value)} placeholder={t('onboarding.step4.listNamePlaceholder')} />
        </Field>
        <Field label={t('onboarding.step4.maxContactsLabel')}>
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
            {[50, 100, 200, 500].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </Field>
        <Field label={t('onboarding.step4.industryLabel')} hint={t('onboarding.step4.industryHint')}>
          <input value={industry} onChange={(e) => setIndustry(e.target.value)} placeholder={t('onboarding.step4.industryPlaceholder')} />
        </Field>
        <Field label={t('onboarding.step4.countryLabel')} hint={t('onboarding.step4.countryHint')}>
          <input value={country} onChange={(e) => setCountry(e.target.value.toUpperCase())} placeholder="GB" maxLength={2} />
        </Field>
      </div>
      <Field label={t('onboarding.step4.fitLabel')}>
        <select value={fit} onChange={(e) => setFit(e.target.value)}>
          <option value="good_fit">{t('onboarding.step4.fitGood')}</option>
          <option value="weak_fit">{t('onboarding.step4.fitWeak')}</option>
          <option value="">{t('onboarding.step4.fitAll')}</option>
        </select>
      </Field>

      {preview && (
        <div style={{ background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 5, padding: '10px 14px', marginBottom: 12, fontSize: 13 }}>
          <strong style={{ color: 'var(--ok)' }}>{t('onboarding.step4.dryRunResult')}</strong>{' '}
          {t('onboarding.step4.dryRunDetail').replace('{eligible}', preview.eligible.toLocaleString()).replace('{wouldImport}', preview.wouldImport.toLocaleString())}
        </div>
      )}

      <Err msg={err} />
      <div style={{ display: 'flex', gap: 10, marginTop: 20, flexWrap: 'wrap' }}>
        <Btn secondary onClick={onBack}>← {t('onboarding.common.back')}</Btn>
        <Btn ghost onClick={dryRun} disabled={previewing}>{previewing ? t('onboarding.common.checking') : t('onboarding.step4.previewCount')}</Btn>
        <Btn onClick={importNow} disabled={importing}>{importing ? t('onboarding.step4.importing') : t('onboarding.step4.importContinue')}</Btn>
        <Btn ghost onClick={onSkip}>{t('onboarding.common.skipForNow')}</Btn>
      </div>
    </div>
  );
}

// ─── Step 5: Done ─────────────────────────────────────────────────────────────

function Step5Done({ saved }: { saved: SavedState }) {
  const t = useT();
  const checks = [
    { ok: !!saved.profileId, label: t('onboarding.step5.checkBrandProfile'), href: '/outreach' },
    { ok: !!saved.domainId, label: t('onboarding.step5.checkDomain'), href: '/domains' },
    { ok: !!saved.identityId, label: t('onboarding.step5.checkIdentity'), href: '/domains' },
    { ok: !!saved.listId, label: t('onboarding.step5.checkContacts'), href: '/contacts' },
  ];

  const nextSteps = [
    { done: !!saved.domainId, label: t('onboarding.step5.nextVerifyDns'), href: '/setup' },
    { done: false, label: t('onboarding.step5.nextConfigureSmtp'), href: '/admin' },
    { done: false, label: t('onboarding.step5.nextReviewDrafts'), href: '/outreach' },
    { done: false, label: t('onboarding.step5.nextTestSend'), href: '/outreach' },
  ];

  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 48, marginBottom: 12 }}>🎉</div>
      <h2 style={{ marginBottom: 8 }}>{t('onboarding.step5.heading')}</h2>
      <p style={{ color: 'var(--ink-3)', marginBottom: 28, fontSize: 14 }}>
        {t('onboarding.step5.subheading')}
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, marginBottom: 28, textAlign: 'left' }}>
        {checks.map((c) => (
          <a key={c.label} href={c.href} style={{ textDecoration: 'none' }}>
            <div style={{ background: 'var(--surface-2)', border: `1px solid ${c.ok ? 'var(--ok)' : 'var(--line)'}`, borderRadius: 5, padding: '10px 14px', display: 'flex', gap: 10, alignItems: 'center' }}>
              <span style={{ fontSize: 16, color: c.ok ? 'var(--ok)' : 'var(--muted)' }}>{c.ok ? '✓' : '○'}</span>
              <span style={{ fontSize: 13, color: c.ok ? 'var(--ink)' : 'var(--muted)' }}>{c.label}</span>
            </div>
          </a>
        ))}
      </div>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 5, padding: 16, marginBottom: 24, textAlign: 'left' }}>
        <h3 style={{ fontSize: 13, marginBottom: 10 }}>{t('onboarding.step5.nextStepsHeading')}</h3>
        <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.9 }}>
          {nextSteps.map((s, i) => (
            <li key={i} style={{ fontSize: 13, color: s.done ? 'var(--muted)' : 'var(--ink-2)' }}>
              {s.done ? <s>{s.label}</s> : <a href={s.href}>{s.label}</a>}
            </li>
          ))}
        </ol>
      </div>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
        <a className="btn" href="/dashboard">{t('onboarding.step5.goToDashboard')}</a>
        <a className="btn btn-ghost" href="/setup">{t('onboarding.step5.setupCenter')}</a>
      </div>
    </div>
  );
}

// ─── Main wizard ──────────────────────────────────────────────────────────────

export default function OnboardingPage() {
  const t = useT();
  const [step, setStep] = useState(1);
  const [saved, setSaved] = useState<SavedState>({ completedSteps: [] });
  const tenantIdRef = useRef('');
  const [ready, setReady] = useState(false);

  // Load saved state + detect tenant
  useEffect(() => {
    const { tenantId, token } = getAuth();
    tenantIdRef.current = tenantId;

    const persisted = loadSaved(tenantId);
    setSaved(persisted);

    // Set starting step: first incomplete step
    const done = persisted.completedSteps ?? [];
    let startStep = 1;
    for (let i = 1; i <= STEPS.length; i++) {
      if (done.includes(i)) startStep = i + 1;
      else break;
    }
    setStep(Math.min(startStep, STEPS.length));
    setReady(true);
  }, []);

  const update = (patch: Partial<SavedState>) => {
    setSaved((prev) => {
      const next = { ...prev, ...patch };
      saveSaved(tenantIdRef.current, next);
      return next;
    });
  };

  const complete = (stepN: number, extra?: Partial<SavedState>) => {
    const next = {
      ...saved,
      ...extra,
      completedSteps: [...new Set([...(saved.completedSteps ?? []), stepN])],
    };
    setSaved(next);
    saveSaved(tenantIdRef.current, next);
    setStep(stepN + 1);
  };

  if (!ready) {
    return <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>{t('onboarding.common.loading')}</div>;
  }

  const cfg = STEPS.find((s) => s.n === step)!;

  return (
    <div style={{ maxWidth: 680, margin: '0 auto', padding: '0 0 40px' }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ marginBottom: 4 }}>{t('onboarding.title')}</h1>
        <p style={{ color: 'var(--ink-3)', fontSize: 14 }}>
          {t('onboarding.headerSubtitle')}
        </p>
      </div>

      {/* Phase 21 — Connect your sending channel (foundation guide + warnings) */}
      <div className="card" style={{ marginBottom: 16, borderLeft: '3px solid var(--accent)' }}>
        <h3 style={{ margin: '0 0 6px', fontSize: 14 }}>{t('onboarding.channel.heading')}</h3>
        <ol style={{ margin: '0 0 10px', paddingLeft: 18, fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.7 }}>
          <li>{t('onboarding.channel.step1Before')} <b>{t('onboarding.channel.step1Bold')}</b>{t('onboarding.channel.step1After')}</li>
          <li>{t('onboarding.channel.step2')}</li>
          <li>{t('onboarding.channel.step3Before')} <a href="/setup">{t('onboarding.channel.step3Link')}</a>.</li>
          <li>{t('onboarding.channel.step4')}</li>
          <li>{t('onboarding.channel.step5')}</li>
          <li>{t('onboarding.channel.step6')}</li>
        </ol>
        <div style={{ fontSize: 12, color: 'var(--warn)', lineHeight: 1.6 }}>
          {t('onboarding.channel.warning')}
        </div>
      </div>

      <Stepper current={step} completed={saved.completedSteps ?? []} />

      <div className="card" style={{ minHeight: 320 }}>
        <div style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              {t('onboarding.stepNofM').replace('{n}', String(step)).replace('{m}', String(STEPS.length))}
            </span>
            {cfg.optional && (
              <span style={{ fontSize: 11, color: 'var(--muted)', background: 'var(--surface-2)', padding: '1px 6px', borderRadius: 3, border: '1px solid var(--line)' }}>{t('onboarding.common.optional')}</span>
            )}
          </div>
          <h2 style={{ margin: '4px 0 2px' }}>{t(`onboarding.${cfg.titleKey}`)}</h2>
          <p style={{ color: 'var(--ink-3)', fontSize: 13, margin: 0 }}>{t(`onboarding.${cfg.subKey}`)}</p>
        </div>

        {step === 1 && (
          <Step1Profile
            saved={saved}
            onDone={(profileId) => complete(1, { profileId })}
          />
        )}
        {step === 2 && (
          <Step2Domain
            saved={saved}
            onDone={(domainId, domainName, dnsRecords) => complete(2, { domainId, domainName, dnsRecords })}
            onBack={() => setStep(1)}
          />
        )}
        {step === 3 && (
          <Step3Sender
            saved={saved}
            onDone={(identityId) => complete(3, { identityId })}
            onBack={() => setStep(2)}
            onSkip={() => complete(3)}
          />
        )}
        {step === 4 && (
          <Step4Leads
            onDone={(listId, listName) => complete(4, { listId, listName })}
            onBack={() => setStep(3)}
            onSkip={() => complete(4)}
          />
        )}
        {step === 5 && <Step5Done saved={saved} />}
      </div>

      {/* Quick jump to already-completed steps */}
      {(saved.completedSteps ?? []).length > 0 && step < 5 && (
        <div style={{ marginTop: 16, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: 'var(--muted)', alignSelf: 'center' }}>{t('onboarding.jumpTo')}</span>
          {STEPS.filter((s) => (saved.completedSteps ?? []).includes(s.n) && s.n !== step).map((s) => (
            <button key={s.n} className="btn btn-ghost" style={{ fontSize: 11, padding: '3px 8px' }} onClick={() => setStep(s.n)}>
              {s.n}. {t(`onboarding.${s.titleKey}`)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
