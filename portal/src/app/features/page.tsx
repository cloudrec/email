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
  const seo = m.pages?.features?.seo ?? {};
  return {
    title: seo.title ?? 'Features — Email Platform',
    description: seo.description ?? '',
    metadataBase: new URL(SITE),
    alternates: { canonical: '/features' },
  };
}

export default async function FeaturesPage() {
  const locale = await detectLocale();
  const m: any = getMessages(locale);
  const p = m.pages?.features ?? {};
  const nav = m.publicNav ?? {};
  const footer = m.publicFooter ?? {};

  const modules = p.modules ?? [];

  return (
    <PublicShell locale={locale} loginLabel={nav.login ?? 'Sign in'} dashboardLabel={nav.openDashboard ?? 'Open dashboard'} nav={nav} footer={footer}>
      <section className="landing-hero" style={{ paddingBottom: 48 }}>
        <div>
          <div className="eyebrow">{p.eyebrow}</div>
          <h1>{p.title}</h1>
          <p style={{ maxWidth: 640, lineHeight: 1.6, opacity: 0.85 }}>{p.sub}</p>
        </div>
      </section>

      {/* Pipeline diagram */}
      <section style={{ padding: '0 0 48px' }}>
        <div style={{ overflowX: 'auto', padding: '0 24px' }}>
          <PipelineDiagram p={p} />
        </div>
      </section>

      {/* Module cards */}
      <section style={{ padding: '0 0 80px' }}>
        <div style={{ maxWidth: 900, margin: '0 auto', padding: '0 24px', display: 'grid', gap: 28 }}>
          {modules.map((mod: any) => (
            <div key={mod.id} className="feature" style={{ display: 'grid', gap: 12, padding: '28px 28px', background: 'var(--surface, rgba(255,255,255,0.04))', borderRadius: 12, border: '1px solid var(--border, rgba(255,255,255,0.08))' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <h2 style={{ fontSize: 20, margin: 0 }}>{mod.h}</h2>
                <span style={{ fontSize: 12, padding: '3px 10px', borderRadius: 20, background: 'var(--accent, #4f8ef7)', color: '#fff', fontWeight: 600, letterSpacing: 0.3 }}>{mod.badge}</span>
              </div>
              <p style={{ margin: 0, lineHeight: 1.65, opacity: 0.85 }}>{mod.p}</p>
              {mod.details && (
                <ul style={{ margin: '4px 0 0', paddingLeft: 20, display: 'grid', gap: 6 }}>
                  {mod.details.map((d: string, i: number) => (
                    <li key={i} style={{ lineHeight: 1.55, opacity: 0.8, fontSize: 14 }}>{d}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* CTA band */}
      <div className="cta-band">
        <div className="wrap">
          <div className="eyebrow">{p.cta?.eyebrow ?? 'Get started'}</div>
          <h2>{p.cta?.heading ?? 'Start building your outreach pipeline.'}</h2>
          <p>{p.cta?.body ?? 'Open the operator console to explore all modules.'}</p>
          <div className="ctas">
            <a href="/dashboard" className="btn-primary" style={{ padding: '12px 28px', borderRadius: 8, background: 'var(--accent, #4f8ef7)', color: '#fff', textDecoration: 'none', fontWeight: 600 }}>{p.cta?.primary ?? 'Open dashboard'}</a>
            <a href="/how-it-works" style={{ padding: '12px 20px', opacity: 0.75, textDecoration: 'none' }}>{p.cta?.secondary ?? 'How it works'} →</a>
          </div>
        </div>
      </div>

      <span data-marker="PUBLIC_DOCS_PHASE13_VISIBLE" style={{ display: 'none' }}>PUBLIC_DOCS_PHASE13_VISIBLE</span>
    </PublicShell>
  );
}

function PipelineDiagram({ p }: { p: any }) {
  const d = p.pipeline ?? {};
  const steps = [
    { label: d.collectorLabel ?? 'Collector', sub: d.collectorSub ?? 'Discovers sources' },
    { label: d.warehouseLabel ?? 'Warehouse', sub: d.warehouseSub ?? 'Stores contacts' },
    { label: d.analyzerLabel ?? 'Analyzer', sub: d.analyzerSub ?? 'Profiles websites' },
    { label: d.draftLabel ?? 'Draft Review', sub: d.draftSub ?? 'Operator approval' },
    { label: d.testLabel ?? 'Test Send', sub: d.testSub ?? 'SMTP + domain check' },
    { label: d.campaignLabel ?? 'Campaign', sub: d.campaignSub ?? 'Controlled delivery' },
  ];
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 0, minWidth: 600, padding: '24px 0' }}>
      {steps.map((s, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', flex: 1 }}>
          <div style={{ flex: 1, textAlign: 'center' }}>
            <div style={{ background: 'var(--surface, rgba(255,255,255,0.07))', border: '1px solid var(--border, rgba(255,255,255,0.12))', borderRadius: 10, padding: '12px 10px', minWidth: 80 }}>
              <div style={{ fontWeight: 700, fontSize: 13 }}>{s.label}</div>
              <div style={{ fontSize: 11, opacity: 0.6, marginTop: 3 }}>{s.sub}</div>
            </div>
          </div>
          {i < steps.length - 1 && (
            <div style={{ padding: '0 6px', opacity: 0.4, fontSize: 18, flexShrink: 0 }}>→</div>
          )}
        </div>
      ))}
    </div>
  );
}
