import type { Metadata } from 'next';
import { cookies, headers } from 'next/headers';
import { resolveLocale, getMessages, type Locale } from '../../i18n';
import { PublicShell } from '../../components/PublicShell';

const SITE = 'https://emails.cheap';

async function detectLocale(): Promise<Locale> {
  const c = await cookies();
  const h = await headers();
  return resolveLocale(c.get('locale')?.value ?? h.get('accept-language'));
}

export async function generateMetadata(): Promise<Metadata> {
  const locale = await detectLocale();
  const m: any = getMessages(locale);
  const seo = m.pages?.safety?.seo ?? {};
  return {
    title: seo.title ?? 'Safety & Anti-Abuse — Email Platform',
    description: seo.description ?? '',
    metadataBase: new URL(SITE),
    alternates: { canonical: '/safety' },
  };
}

export default async function SafetyPage() {
  const locale = await detectLocale();
  const m: any = getMessages(locale);
  const p = m.pages?.safety ?? {};
  const nav = m.publicNav ?? {};
  const footer = m.publicFooter ?? {};
  const sections = p.sections ?? FALLBACK_SECTIONS;

  return (
    <PublicShell locale={locale} loginLabel={nav.login ?? 'Sign in'} dashboardLabel={nav.openDashboard ?? 'Open dashboard'} nav={nav} footer={footer}>
      <section className="landing-hero" style={{ paddingBottom: 48 }}>
        <div>
          <div className="eyebrow">{p.eyebrow}</div>
          <h1>{p.title}</h1>
          <p style={{ maxWidth: 640, lineHeight: 1.6, opacity: 0.85 }}>{p.sub}</p>
        </div>
      </section>

      {/* Phase 21A Zoho manual bridge safety note */}
      <section style={{ padding: '0 24px 24px' }}>
        <div style={{ maxWidth: 800, margin: '0 auto', border: '1px solid #fcd34d', background: '#fffbeb', borderRadius: 8, padding: '12px 16px', fontSize: 14 }}>
          <b>{p.zohoNote?.title ?? 'Zoho manual bridge.'}</b> {p.zohoNote?.body ?? 'Optional zero-budget channel. Low-volume, operator-approved, one-by-one only. No bulk send, no scheduler, no mass subscribe. Sends only if the operator configures Zoho credentials and clicks send; otherwise drafts are copy/pasted manually. Negative replies are one-click suppressed. emails.cheap campaign rails are unchanged.'}
        </div>
      </section>

      {/* Gate overview diagram */}
      <section style={{ padding: '0 24px 48px' }}>
        <div style={{ maxWidth: 800, margin: '0 auto' }}>
          <div style={{ overflowX: 'auto' }}>
            <SafetyGatesDiagram p={p} />
          </div>
        </div>
      </section>

      {/* Sections */}
      <section style={{ padding: '0 0 80px' }}>
        <div style={{ maxWidth: 860, margin: '0 auto', padding: '0 24px', display: 'grid', gap: 32 }}>
          {sections.map((s: any, i: number) => (
            <div key={i} style={{ padding: '28px', borderRadius: 12, background: 'var(--surface, rgba(255,255,255,0.04))', border: '1px solid var(--border, rgba(255,255,255,0.08))' }}>
              <h2 style={{ margin: '0 0 12px', fontSize: 18 }}>{s.h}</h2>
              <p style={{ margin: 0, lineHeight: 1.65, opacity: 0.82 }}>{s.p}</p>
              {s.items && (
                <ul style={{ margin: '12px 0 0', paddingLeft: 20, display: 'grid', gap: 6 }}>
                  {s.items.map((item: string, j: number) => (
                    <li key={j} style={{ lineHeight: 1.55, opacity: 0.8, fontSize: 14 }}>{item}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* Anti-spam band */}
      <div className="antispam-band">
        <div className="wrap">
          <div className="eyebrow">{p.antispam?.eyebrow ?? 'Anti-spam commitment'}</div>
          <h2>{p.antispam?.heading ?? 'The platform is built for legitimate B2B outreach only.'}</h2>
          <p className="antispam-sub">{p.antispam?.sub ?? 'Every design decision enforces a review-first model. There is no path from contact discovery to outbox without a human operator approving each step.'}</p>
          <div className="antispam-grid">
            {COMMITMENTS(p).map((c, i) => (
              <div key={i} className="antispam-card">
                <h3>{c.h}</h3>
                <p>{c.p}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      <span data-marker="PUBLIC_DOCS_PHASE13_VISIBLE" style={{ display: 'none' }}>PUBLIC_DOCS_PHASE13_VISIBLE</span>
    </PublicShell>
  );
}

function SafetyGatesDiagram({ p }: { p: any }) {
  const d = p.gatesDiagram ?? {};
  const gates = [
    { label: d.collectorLabel ?? 'Collector', note: d.collectorNote ?? 'No SMTP access', color: '#4f8ef7' },
    { label: d.warehouseLabel ?? 'Warehouse', note: d.warehouseNote ?? 'Contacts = discovered', color: '#7c6af7' },
    { label: d.reviewLabel ?? 'Review gate', note: d.reviewNote ?? 'Manual approval', color: '#f7a04f', isGate: true },
    { label: d.domainLabel ?? 'Domain gate', note: d.domainNote ?? 'DNS verified', color: '#f7a04f', isGate: true },
    { label: d.smtpLabel ?? 'SMTP gate', note: d.smtpNote ?? 'Status = ready', color: '#f7a04f', isGate: true },
    { label: d.contactLabel ?? 'Contact gate', note: d.contactNote ?? 'Manually subscribed', color: '#f7a04f', isGate: true },
    { label: d.sendLabel ?? 'Send', note: d.sendNote ?? 'Suppression checked', color: '#4fc87f' },
  ];
  return (
    <div style={{ display: 'flex', gap: 6, padding: '20px 0', minWidth: 560, alignItems: 'center' }}>
      {gates.map((g, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', flex: 1 }}>
          <div style={{ flex: 1, textAlign: 'center', borderRadius: 8, padding: '10px 6px', border: `1px solid ${g.color}55`, background: `${g.color}${g.isGate ? '22' : '10'}` }}>
            <div style={{ fontWeight: 700, fontSize: 12, color: g.color }}>{g.label}</div>
            <div style={{ fontSize: 10, opacity: 0.65, marginTop: 3 }}>{g.note}</div>
            {g.isGate && <div style={{ fontSize: 10, marginTop: 4, color: '#f7a04f' }}>🔒 GATE</div>}
          </div>
          {i < gates.length - 1 && (
            <div style={{ padding: '0 4px', opacity: 0.3, flexShrink: 0, fontSize: 14 }}>→</div>
          )}
        </div>
      ))}
    </div>
  );
}

function COMMITMENTS(p: any) {
  const c = p.commitments ?? {};
  return [
    { h: c.autoSendH ?? 'No auto-sending', p: c.autoSendP ?? 'The platform has no scheduled auto-send without operator approval. Every campaign is manually triggered or manually scheduled.' },
    { h: c.purchasedH ?? 'No purchased lists', p: c.purchasedP ?? 'Sending to purchased, rented, or leaked lists is prohibited and results in immediate account suspension.' },
    { h: c.unsubscribeH ?? 'Permanent unsubscribe', p: c.unsubscribeP ?? 'One-click unsubscribe removes the address permanently. No re-add via bulk import.' },
    { h: c.auditH ?? 'Full audit trail', p: c.auditP ?? 'Every approval, rejection, send, and admin action is timestamped and stored. Operators cannot modify the audit log.' },
  ];
}

const FALLBACK_SECTIONS = [
  {
    h: 'Five required gates',
    p: 'All five gates must pass simultaneously before a message is queued.',
    items: ['Domain DNS-verified', 'SMTP status = ready', 'Contact status = subscribed', 'Draft status = approved', 'No suppression hit'],
  },
];
