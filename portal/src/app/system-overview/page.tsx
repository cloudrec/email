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
  const seo = m.pages?.systemOverview?.seo ?? {};
  return {
    title: seo.title ?? 'System Overview — Email Platform',
    description: seo.description ?? '',
    metadataBase: new URL(SITE),
    alternates: { canonical: '/system-overview' },
  };
}

export default async function SystemOverviewPage() {
  const locale = await detectLocale();
  const m: any = getMessages(locale);
  const p = m.pages?.systemOverview ?? {};
  const nav = m.publicNav ?? {};
  const footer = m.publicFooter ?? {};
  const services = p.services ?? FALLBACK_SERVICES;
  const security = p.securityModel ?? {};
  const dataFlow = p.dataFlow ?? {};

  return (
    <PublicShell locale={locale} loginLabel={nav.login ?? 'Sign in'} dashboardLabel={nav.openDashboard ?? 'Open dashboard'} nav={nav} footer={footer}>
      <section className="landing-hero" style={{ paddingBottom: 48 }}>
        <div>
          <div className="eyebrow">{p.eyebrow}</div>
          <h1>{p.title}</h1>
          <p style={{ maxWidth: 620, lineHeight: 1.6, opacity: 0.85 }}>{p.sub}</p>
        </div>
      </section>

      {/* Architecture diagram */}
      <section style={{ padding: '0 24px 48px' }}>
        <div style={{ maxWidth: 860, margin: '0 auto', overflowX: 'auto' }}>
          <ArchDiagram p={p} />
        </div>
      </section>

      {/* Services */}
      <section style={{ padding: '0 0 48px' }}>
        <div style={{ maxWidth: 860, margin: '0 auto', padding: '0 24px' }}>
          <h2 style={{ marginBottom: 24 }}>{p.servicesHeading ?? 'Services'}</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
            {services.map((s: any, i: number) => (
              <div key={i} style={{ padding: '20px', borderRadius: 10, background: 'var(--surface, rgba(255,255,255,0.04))', border: '1px solid var(--border, rgba(255,255,255,0.08))' }}>
                <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>{s.h}</div>
                <div style={{ fontSize: 11, opacity: 0.55, marginBottom: 10, fontFamily: 'monospace' }}>{s.tech}</div>
                <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, opacity: 0.8 }}>{s.p}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Security model */}
      <section style={{ padding: '0 0 48px' }}>
        <div style={{ maxWidth: 860, margin: '0 auto', padding: '0 24px' }}>
          <h2 style={{ marginBottom: 20 }}>{security.h ?? 'Security model'}</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 10 }}>
            {(security.items ?? []).map((item: string, i: number) => (
              <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 14px', borderRadius: 8, background: 'rgba(80,180,120,0.08)', border: '1px solid rgba(80,180,120,0.2)' }}>
                <span style={{ color: '#4fc87f', flexShrink: 0, marginTop: 1 }}>✓</span>
                <span style={{ fontSize: 13, lineHeight: 1.5 }}>{item}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Data flow */}
      <section style={{ padding: '0 0 80px' }}>
        <div style={{ maxWidth: 860, margin: '0 auto', padding: '0 24px' }}>
          <h2 style={{ marginBottom: 20 }}>{dataFlow.h ?? 'Data flow'}</h2>
          <div style={{ display: 'grid', gap: 8 }}>
            {(dataFlow.steps ?? []).map((step: string, i: number) => (
              <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '10px 16px', borderRadius: 8, background: 'var(--surface, rgba(255,255,255,0.03))', border: '1px solid var(--border, rgba(255,255,255,0.07))' }}>
                <span style={{ fontFamily: 'monospace', fontSize: 11, opacity: 0.4, flexShrink: 0 }}>{String(i + 1).padStart(2, '0')}</span>
                <span style={{ fontSize: 13, lineHeight: 1.5, fontFamily: 'monospace', opacity: 0.8 }}>{step}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <span data-marker="PUBLIC_DOCS_PHASE13_VISIBLE" style={{ display: 'none' }}>PUBLIC_DOCS_PHASE13_VISIBLE</span>
    </PublicShell>
  );
}

function ArchDiagram({ p }: { p: any }) {
  const d = p.arch ?? {};
  return (
    <div style={{ padding: '24px 0' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: 16, alignItems: 'center', minWidth: 520 }}>
        {/* Client */}
        <div style={{ borderRadius: 10, border: '1px solid rgba(79,142,247,0.4)', background: 'rgba(79,142,247,0.08)', padding: '14px', textAlign: 'center' }}>
          <div style={{ fontWeight: 700, fontSize: 13, color: '#4f8ef7' }}>{d.clientLabel ?? 'Browser / Client'}</div>
          <div style={{ fontSize: 11, opacity: 0.6, marginTop: 4 }}>HTTPS → Cloudflare → Nginx :443</div>
        </div>
        <div style={{ opacity: 0.3, fontSize: 18 }}>→</div>
        {/* Server */}
        <div style={{ borderRadius: 10, border: '1px solid rgba(124,106,247,0.4)', background: 'rgba(124,106,247,0.08)', padding: '14px' }}>
          <div style={{ fontWeight: 700, fontSize: 13, color: '#7c6af7', marginBottom: 8, textAlign: 'center' }}>{d.serverLabel ?? 'Server (Docker Compose)'}</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            {[
              { label: 'Portal :13000', note: 'Next.js' },
              { label: 'API :4000', note: 'Express' },
              { label: 'Worker', note: d.noteBackground ?? 'Background' },
              { label: 'MariaDB', note: d.noteInternal ?? 'Internal' },
              { label: 'Redis', note: d.noteInternal ?? 'Internal' },
              { label: 'Nginx', note: d.noteProxy ?? 'Proxy' },
            ].map((s, i) => (
              <div key={i} style={{ borderRadius: 6, border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.04)', padding: '6px 8px', textAlign: 'center' }}>
                <div style={{ fontWeight: 600, fontSize: 11 }}>{s.label}</div>
                <div style={{ fontSize: 10, opacity: 0.5 }}>{s.note}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

const FALLBACK_SERVICES = [
  { h: 'Portal', tech: 'Next.js 14 App Router', p: 'Server-rendered operator console and public pages.' },
  { h: 'API', tech: 'Node.js + Express', p: 'REST API for all platform operations.' },
  { h: 'Worker', tech: 'Node.js background', p: 'Collector, analyzer, draft generator, campaign sender.' },
  { h: 'Database', tech: 'MariaDB 11.4', p: 'All persistent data. Internal network only.' },
  { h: 'Cache', tech: 'Redis 7.4', p: 'Sessions and job queues.' },
  { h: 'Proxy', tech: 'Nginx', p: 'HTTPS routing and static files.' },
];
