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
  const seo = m.pages?.faq?.seo ?? {};
  return {
    title: seo.title ?? 'FAQ — Email Platform',
    description: seo.description ?? '',
    metadataBase: new URL(SITE),
    alternates: { canonical: '/faq' },
  };
}

export default async function FaqPage() {
  const locale = await detectLocale();
  const m: any = getMessages(locale);
  const p = m.pages?.faq ?? {};
  const nav = m.publicNav ?? {};
  const footer = m.publicFooter ?? {};
  const items = p.items ?? [];

  return (
    <PublicShell locale={locale} loginLabel={nav.login ?? 'Sign in'} dashboardLabel={nav.openDashboard ?? 'Open dashboard'} nav={nav} footer={footer}>
      <section className="landing-hero" style={{ paddingBottom: 48 }}>
        <div>
          <div className="eyebrow">{p.eyebrow}</div>
          <h1>{p.title}</h1>
          <p style={{ maxWidth: 580, lineHeight: 1.6, opacity: 0.85 }}>{p.sub}</p>
        </div>
      </section>

      <section style={{ padding: '0 0 80px' }}>
        <div style={{ maxWidth: 800, margin: '0 auto', padding: '0 24px', display: 'grid', gap: 4 }}>
          {items.map((item: any, i: number) => (
            <details key={i} style={{ borderBottom: '1px solid var(--border, rgba(255,255,255,0.07))', padding: '0' }}>
              <summary style={{ padding: '18px 4px', cursor: 'pointer', fontWeight: 600, fontSize: 15, listStyle: 'none', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>{item.q}</span>
                <span style={{ opacity: 0.4, flexShrink: 0, marginLeft: 12, fontSize: 20 }}>+</span>
              </summary>
              <div style={{ padding: '0 4px 18px', lineHeight: 1.65, opacity: 0.8, fontSize: 14 }}>{item.a}</div>
            </details>
          ))}
        </div>
      </section>

      {/* More help */}
      <div className="cta-band">
        <div className="wrap">
          <div className="eyebrow">{p.cta?.eyebrow ?? 'Need more detail?'}</div>
          <h2>{p.cta?.heading ?? 'Read the full operator instructions.'}</h2>
          <p>{p.cta?.body ?? 'The Instructions page covers every module step by step.'}</p>
          <div className="ctas">
            <a href="/instructions" style={{ padding: '12px 28px', borderRadius: 8, background: 'var(--accent, #4f8ef7)', color: '#fff', textDecoration: 'none', fontWeight: 600 }}>{p.cta?.primary ?? 'Full instructions'}</a>
            <a href="mailto:support@emails.cheap" style={{ padding: '12px 20px', opacity: 0.75, textDecoration: 'none' }}>{p.cta?.secondary ?? 'Contact support'} →</a>
          </div>
        </div>
      </div>

      <span data-marker="PUBLIC_DOCS_PHASE13_VISIBLE" style={{ display: 'none' }}>PUBLIC_DOCS_PHASE13_VISIBLE</span>
    </PublicShell>
  );
}
