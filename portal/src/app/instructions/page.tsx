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
  const seo = m.pages?.instructions?.seo ?? {};
  return {
    title: seo.title ?? 'Instructions — Email Platform',
    description: seo.description ?? '',
    metadataBase: new URL(SITE),
    alternates: { canonical: '/instructions' },
  };
}

export default async function InstructionsPage() {
  const locale = await detectLocale();
  const m: any = getMessages(locale);
  const p = m.pages?.instructions ?? {};
  const nav = m.publicNav ?? {};
  const footer = m.publicFooter ?? {};
  const sections = p.sections ?? FALLBACK_SECTIONS;

  return (
    <PublicShell locale={locale} loginLabel={nav.login ?? 'Sign in'} dashboardLabel={nav.openDashboard ?? 'Open dashboard'} nav={nav} footer={footer}>
      <section className="landing-hero" style={{ paddingBottom: 32 }}>
        <div>
          <div className="eyebrow">{p.eyebrow}</div>
          <h1>{p.title}</h1>
          <p style={{ maxWidth: 620, lineHeight: 1.6, opacity: 0.85 }}>{p.sub}</p>
        </div>
      </section>

      {/* TOC */}
      <section style={{ padding: '0 24px 32px' }}>
        <div style={{ maxWidth: 860, margin: '0 auto' }}>
          <div style={{ padding: '20px 24px', borderRadius: 10, background: 'var(--surface, rgba(255,255,255,0.04))', border: '1px solid var(--border, rgba(255,255,255,0.08))' }}>
            <div style={{ fontWeight: 700, marginBottom: 12, fontSize: 14, opacity: 0.7 }}>{p.toc ?? 'Contents'}</div>
            <div style={{ display: 'grid', gap: 6 }}>
              {sections.map((s: any) => (
                <a key={s.id} href={`#${s.id}`} style={{ textDecoration: 'none', fontSize: 14, opacity: 0.75, color: 'var(--accent, #4f8ef7)' }}>{s.h}</a>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Sections */}
      <section style={{ padding: '0 0 80px' }}>
        <div style={{ maxWidth: 860, margin: '0 auto', padding: '0 24px', display: 'grid', gap: 56 }}>
          {sections.map((s: any) => (
            <div key={s.id} id={s.id}>
              <h2 style={{ fontSize: 22, marginBottom: 24, paddingBottom: 12, borderBottom: '1px solid var(--border, rgba(255,255,255,0.08))' }}>{s.h}</h2>
              <div style={{ display: 'grid', gap: 20 }}>
                {s.items.map((item: any, i: number) => (
                  <div key={i} style={{ padding: '18px 20px', borderRadius: 10, background: 'var(--surface, rgba(255,255,255,0.03))', border: '1px solid var(--border, rgba(255,255,255,0.07))' }}>
                    <div style={{ fontWeight: 700, marginBottom: 8, fontSize: 14 }}>{item.q}</div>
                    <p style={{ margin: 0, lineHeight: 1.65, fontSize: 14, opacity: 0.8 }}>{item.a}</p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <span data-marker="PUBLIC_DOCS_PHASE13_VISIBLE" style={{ display: 'none' }}>PUBLIC_DOCS_PHASE13_VISIBLE</span>
    </PublicShell>
  );
}

const FALLBACK_SECTIONS = [
  {
    id: 'getting-started',
    h: '1. Getting started',
    items: [
      { q: 'Log in', a: 'Navigate to /login. Enter your operator email and password.' },
      { q: 'First-time setup', a: 'Follow the setup wizard at /onboarding.' },
    ],
  },
];
