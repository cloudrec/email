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
  const seo = m.pages?.howItWorks?.seo ?? {};
  return {
    title: seo.title ?? 'How it works — Email Platform',
    description: seo.description ?? '',
    metadataBase: new URL(SITE),
    alternates: { canonical: '/how-it-works' },
  };
}

export default async function HowItWorksPage() {
  const locale = await detectLocale();
  const m: any = getMessages(locale);
  const p = m.pages?.howItWorks ?? {};
  const nav = m.publicNav ?? {};
  const footer = m.publicFooter ?? {};
  const steps = p.steps ?? m.home?.how?.steps ?? [];

  return (
    <PublicShell locale={locale} loginLabel={nav.login ?? 'Sign in'} dashboardLabel={nav.openDashboard ?? 'Open dashboard'} nav={nav} footer={footer}>
      <section className="landing-hero" style={{ paddingBottom: 48 }}>
        <div>
          <div className="eyebrow">{p.eyebrow}</div>
          <h1>{p.title}</h1>
          <p style={{ maxWidth: 620, lineHeight: 1.6, opacity: 0.85 }}>{p.sub}</p>
        </div>
      </section>

      {/* Full pipeline visual */}
      <section style={{ padding: '0 24px 48px' }}>
        <div style={{ maxWidth: 860, margin: '0 auto', overflowX: 'auto' }}>
          <FullPipelineDiagram p={p} />
        </div>
      </section>

      {/* Steps */}
      <section style={{ padding: '0 0 80px' }}>
        <div style={{ maxWidth: 860, margin: '0 auto', padding: '0 24px', display: 'grid', gap: 0 }}>
          {steps.map((st: any, i: number) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '72px 1fr', gap: 24, padding: '32px 0', borderBottom: '1px solid var(--border, rgba(255,255,255,0.07))' }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontFamily: 'monospace', fontSize: 28, fontWeight: 900, opacity: 0.3, lineHeight: 1 }}>{st.n ?? String(i + 1).padStart(2, '0')}</div>
              </div>
              <div>
                <h3 style={{ margin: '0 0 8px', fontSize: 18 }}>{st.h}</h3>
                <p style={{ margin: 0, lineHeight: 1.65, opacity: 0.8 }}>{st.p}</p>
                {st.gate && (
                  <div style={{ marginTop: 12, padding: '8px 14px', borderRadius: 8, background: st.gate.startsWith('GATE') ? 'rgba(255,100,60,0.12)' : 'rgba(80,180,120,0.1)', border: st.gate.startsWith('GATE') ? '1px solid rgba(255,100,60,0.3)' : '1px solid rgba(80,180,120,0.25)', fontSize: 13, opacity: 0.9 }}>
                    {st.gate}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Gate summary */}
      <div className="why-band">
        <div className="wrap">
          <div className="eyebrow">{p.gateBand?.eyebrow ?? 'All gates must pass'}</div>
          <h2>{p.gateBand?.heading ?? 'Before a single message can send:'}</h2>
          <GateDiagram p={p} />
        </div>
      </div>

      <div className="cta-band">
        <div className="wrap">
          <div className="eyebrow">{p.cta?.eyebrow ?? 'Ready?'}</div>
          <h2>{p.cta?.heading ?? 'Start with the setup wizard.'}</h2>
          <p>{p.cta?.body ?? 'The onboarding guide walks you through all five setup steps in order.'}</p>
          <div className="ctas">
            <a href="/onboarding" className="btn-primary" style={{ padding: '12px 28px', borderRadius: 8, background: 'var(--accent, #4f8ef7)', color: '#fff', textDecoration: 'none', fontWeight: 600 }}>{p.cta?.primary ?? 'Open setup wizard'}</a>
            <a href="/instructions" style={{ padding: '12px 20px', opacity: 0.75, textDecoration: 'none' }}>{p.cta?.secondary ?? 'Full instructions'} →</a>
          </div>
        </div>
      </div>

      <span data-marker="PUBLIC_DOCS_PHASE13_VISIBLE" style={{ display: 'none' }}>PUBLIC_DOCS_PHASE13_VISIBLE</span>
    </PublicShell>
  );
}

function FullPipelineDiagram({ p }: { p: any }) {
  const d = p.pipeline ?? {};
  const stages = [
    { label: d.sourcesLabel ?? 'Sources', color: '#4f8ef7', items: ['OSM', 'Tavily', 'CSV'] },
    { label: d.collectorLabel ?? 'Collector', color: '#4f8ef7', items: [d.crawl ?? 'Crawl', d.dedupe ?? 'Dedupe', d.extract ?? 'Extract'] },
    { label: d.warehouseLabel ?? 'Warehouse', color: '#7c6af7', items: [d.store ?? 'Store', d.classify ?? 'Classify', d.score ?? 'Score'] },
    { label: d.analyzerLabel ?? 'Analyzer', color: '#7c6af7', items: [d.profile ?? 'Profile', d.industry ?? 'Industry', d.confidence ?? 'Confidence'] },
    { label: d.draftLabel ?? 'Draft', color: '#f7a04f', items: [d.generate ?? 'Generate', d.review ?? 'Review', d.approve ?? 'Approve'] },
    { label: d.sendLabel ?? 'Send', color: '#4fc87f', items: [d.test ?? 'Test', 'Domain ✓', 'SMTP ✓'] },
  ];
  return (
    <div style={{ display: 'flex', gap: 8, padding: '24px 0', minWidth: 560, alignItems: 'stretch' }}>
      {stages.map((s, i) => (
        <div key={i} style={{ flex: 1, display: 'flex', alignItems: 'center' }}>
          <div style={{ flex: 1, borderRadius: 10, border: `1px solid ${s.color}44`, background: `${s.color}12`, padding: '14px 10px', textAlign: 'center' }}>
            <div style={{ fontWeight: 700, fontSize: 13, color: s.color }}>{s.label}</div>
            {s.items.map((item, j) => (
              <div key={j} style={{ fontSize: 11, opacity: 0.65, marginTop: 4 }}>{item}</div>
            ))}
          </div>
          {i < stages.length - 1 && (
            <div style={{ padding: '0 4px', opacity: 0.3, flexShrink: 0 }}>→</div>
          )}
        </div>
      ))}
    </div>
  );
}

function GateDiagram({ p }: { p: any }) {
  const g = p.gates ?? {};
  const gates = [
    { label: g.domainLabel ?? 'Domain verified', detail: g.domainDetail ?? 'SPF + DKIM + DMARC + Return-Path' },
    { label: g.smtpLabel ?? 'SMTP ready', detail: g.smtpDetail ?? 'Connectivity + auth confirmed' },
    { label: g.contactLabel ?? 'Contact subscribed', detail: g.contactDetail ?? 'Manually activated by operator' },
    { label: g.draftLabel ?? 'Draft approved', detail: g.draftDetail ?? 'Reviewed + compliance checkbox' },
    { label: g.suppressionLabel ?? 'No suppression hit', detail: g.suppressionDetail ?? 'Global + tenant suppression list' },
  ];
  return (
    <div style={{ display: 'grid', gap: 10, marginTop: 20 }}>
      {gates.map((g, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 18px', borderRadius: 8, background: 'rgba(80,180,120,0.1)', border: '1px solid rgba(80,180,120,0.25)' }}>
          <span style={{ color: '#4fc87f', fontWeight: 900, fontSize: 18, flexShrink: 0 }}>✓</span>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>{g.label}</div>
            <div style={{ fontSize: 12, opacity: 0.65 }}>{g.detail}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
