import type { Metadata } from 'next';
import { cookies, headers } from 'next/headers';
import { resolveLocale, getMessages, type Locale } from '../i18n';
import { LanguageSwitcher } from '../components/LanguageSwitcher';
import { HomeCTA, HomeNavRight } from './HomeCTA';
import { ThemeSwitcher } from '../components/ThemeSwitcher';
import { MobileNav } from '../components/MobileNav';

const SITE = 'https://emails.cheap';

async function detectLocale(): Promise<Locale> {
  const c = await cookies();
  const h = await headers();
  return resolveLocale(c.get('locale')?.value ?? h.get('accept-language'));
}

export async function generateMetadata(): Promise<Metadata> {
  const locale = await detectLocale();
  const m: any = getMessages(locale);
  const title = m.home?.seo?.title ?? 'Email Platform';
  const description = m.home?.seo?.description ?? '';
  return {
    title,
    description,
    metadataBase: new URL(SITE),
    alternates: {
      canonical: '/',
      languages: { en: '/', ru: '/', uk: '/' },
    },
    openGraph: {
      title, description, url: SITE,
      siteName: 'Email Platform', type: 'website', locale,
    },
    twitter: {
      card: 'summary_large_image', title, description,
    },
  };
}

export default async function HomePage() {
  const locale = await detectLocale();
  const m: any = getMessages(locale);
  const h = m.home ?? {};

  return (
    <main className="landing">
      <nav className="topnav" aria-label="Top">
        <a href="/" className="brand"><span className="mark" aria-hidden="true" /> Email Platform</a>
        <div className="links">
          <a href="/features">{m.publicNav?.features ?? h.nav?.product}</a>
          <a href="/how-it-works">{m.publicNav?.howItWorks ?? h.nav?.howItWorks}</a>
          <a href="/instructions">{m.publicNav?.instructions ?? 'Instructions'}</a>
          <a href="/safety">{m.publicNav?.safety ?? h.nav?.safety}</a>
          <a href="/faq">{m.publicNav?.faq ?? 'FAQ'}</a>
        </div>
        <div className="right">
          <ThemeSwitcher />
          <LanguageSwitcher current={locale} />
          <HomeNavRight loginLabel={h.nav?.login ?? 'Sign in'} dashboardLabel={h.nav?.openDashboard ?? 'Open dashboard'} />
          <MobileNav locale={locale} nav={{ home: m.publicNav?.home ?? 'Home', features: m.publicNav?.features ?? 'Features', howItWorks: m.publicNav?.howItWorks ?? 'How it works', instructions: m.publicNav?.instructions ?? 'Instructions', safety: m.publicNav?.safety ?? 'Safety', faq: m.publicNav?.faq ?? 'FAQ', login: m.publicNav?.login ?? 'Sign in', openDashboard: m.publicNav?.openDashboard ?? 'Open dashboard' }} loginLabel={h.nav?.login ?? 'Sign in'} dashboardLabel={h.nav?.openDashboard ?? 'Open dashboard'} />
        </div>
      </nav>

      {/* Hero */}
      <section className="landing-hero" id="product">
        <div>
          <div className="eyebrow">{h.hero?.eyebrow}</div>
          <h1>{h.hero?.title}</h1>
          <p>{h.hero?.sub}</p>
          <div className="ctas">
            <HomeCTA
              primaryLabel={h.hero?.ctaPrimary ?? 'Start collecting leads'}
              secondaryLabel={h.hero?.ctaSecondary ?? 'View how it works'}
              dashboardLabel={h.nav?.openDashboard ?? 'Open dashboard'}
              loginLabel={h.nav?.login ?? 'Sign in'}
            />
          </div>
          <div className="trust">{h.hero?.trustChip}</div>
        </div>
        <div className="preview" aria-hidden="true">
          <div className="head"><span><span className="dot" />{h.hero?.panel?.title}</span><span>v0.1</span></div>
          <div className="kpis">
            <div className="kpi"><div className="l">{h.hero?.panel?.kpiLeads}</div><div className="v">59</div></div>
            <div className="kpi"><div className="l">{h.hero?.panel?.kpiPending}</div><div className="v">69</div></div>
            <div className="kpi"><div className="l">{h.hero?.panel?.kpiCollector}</div><div className="v">1</div></div>
            <div className="kpi"><div className="l">{h.hero?.panel?.kpiSending}</div><div className="v muted">{h.hero?.panel?.sendingValue}</div></div>
          </div>
          <div className="events">
            <div className="row"><span>{h.hero?.panel?.row1}</span><span className="badge-ok">{h.hero?.panel?.row1status}</span></div>
            <div className="row"><span>{h.hero?.panel?.row2}</span><span className="badge-ok">{h.hero?.panel?.row2status}</span></div>
            <div className="row"><span>{h.hero?.panel?.row3}</span><span className="badge-warn">{h.hero?.panel?.row3status}</span></div>
          </div>
        </div>
      </section>

      {/* Problem */}
      <section>
        <div className="eyebrow">{h.problem?.eyebrow}</div>
        <h2>{h.problem?.title}</h2>
        <div className="problem-grid">
          <div className="p-card"><div className="n">01</div><p>{h.problem?.p1}</p></div>
          <div className="p-card"><div className="n">02</div><p>{h.problem?.p2}</p></div>
          <div className="p-card"><div className="n">03</div><p>{h.problem?.p3}</p></div>
          <div className="p-card"><div className="n">04</div><p>{h.problem?.p4}</p></div>
        </div>
      </section>

      {/* Solution / flow */}
      <section>
        <div className="eyebrow">{h.solution?.eyebrow}</div>
        <h2>{h.solution?.title}</h2>
        <div className="flow">
          {(h.solution?.steps ?? []).map((s: string, i: number) => (
            <div key={i} className="step">
              <div className="ix">{String(i + 1).padStart(2, '0')}</div>
              <div className="lbl">{s}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Features */}
      <section>
        <div className="eyebrow">{h.features?.eyebrow}</div>
        <h2>{h.features?.title}</h2>
        <div className="feature-grid">
          {(h.features?.items ?? []).map((it: any, i: number) => (
            <div key={i} className="feature">
              <div className="h">{it.h}</div>
              <div className="p">{it.p}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Anti-spam policy */}
      <div className="antispam-band" id="antispam">
        <div className="wrap">
          <div className="eyebrow">{h.antiSpam?.eyebrow}</div>
          <h2>{h.antiSpam?.title}</h2>
          <p className="antispam-sub">{h.antiSpam?.sub}</p>
          <div className="antispam-grid">
            {(h.antiSpam?.rules ?? []).map((r: any, i: number) => (
              <div key={i} className="antispam-card">
                <h3>{r.h}</h3>
                <p>{r.p}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Safety */}
      <section id="safety">
        <div className="eyebrow">{h.safety?.eyebrow}</div>
        <h2>{h.safety?.title}</h2>
        <ul className="safety-list">
          {(h.safety?.items ?? []).map((s: string, i: number) => <li key={i}>{s}</li>)}
        </ul>
      </section>

      {/* How it works */}
      <section id="how">
        <div className="eyebrow">{h.how?.eyebrow}</div>
        <h2>{h.how?.title}</h2>
        <div className="steps-grid">
          {(h.how?.steps ?? []).map((st: any, i: number) => (
            <div key={i} className="step-card">
              <div className="num">{st.n}</div>
              <div>
                <h3>{st.h}</h3>
                <p>{st.p}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Audience */}
      <section id="audience">
        <div className="eyebrow">{h.audience?.eyebrow}</div>
        <h2>{h.audience?.title}</h2>
        <div className="audience-grid">
          {(h.audience?.items ?? []).map((it: any, i: number) => (
            <div key={i}>
              <h3>{it.h}</h3>
              <p>{it.p}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Modules */}
      <section id="modules">
        <div className="eyebrow">{h.modules?.eyebrow}</div>
        <h2>{h.modules?.title}</h2>
        <div className="modules-grid">
          {(h.modules?.items ?? []).map((it: any, i: number) => (
            <div key={i}>
              <h3>{it.h}</h3>
              <p>{it.p}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Why safer (dark band) */}
      <div className="why-band">
        <div className="wrap">
          <div className="eyebrow">{h.why?.eyebrow}</div>
          <h2>{h.why?.title}</h2>
          <ul>
            {(h.why?.items ?? []).map((it: string, i: number) => <li key={i}>{it}</li>)}
          </ul>
        </div>
      </div>

      {/* CTA */}
      <div className="cta-band">
        <div className="wrap">
          <div className="eyebrow">{h.cta?.eyebrow}</div>
          <h2>{h.cta?.title}</h2>
          <p>{h.cta?.sub}</p>
          <div className="ctas">
            <HomeCTA
              primaryLabel={h.cta?.secondary ?? 'Sign in'}
              secondaryLabel={h.nav?.howItWorks ?? 'How it works'}
              dashboardLabel={h.cta?.primary ?? 'Open dashboard'}
              loginLabel={h.cta?.secondary ?? 'Sign in'}
            />
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="landing-footer">
        <div className="wrap">
          <div className="brand-block">
            <div className="brand"><span className="mark" aria-hidden="true" /> Email Platform</div>
            <p>{h.footer?.tagline}</p>
            <p style={{ fontSize: 11.5, marginTop: 4 }}>{h.footer?.selfHosted}</p>
          </div>
          <div>
            <h4>{h.footer?.product}</h4>
            <ul>
              <li><a href="/features">{m.publicFooter?.linkFeatures ?? h.footer?.linkHowItWorks}</a></li>
              <li><a href="/how-it-works">{m.publicFooter?.linkHowItWorks ?? h.footer?.linkHowItWorks}</a></li>
              <li><a href="/instructions">{m.publicFooter?.linkInstructions ?? 'Instructions'}</a></li>
              <li><a href="/safety">{m.publicFooter?.linkSafety ?? h.footer?.linkSafety}</a></li>
              <li><a href="/faq">{m.publicFooter?.linkFaq ?? 'FAQ'}</a></li>
            </ul>
          </div>
          <div>
            <h4>{h.footer?.support}</h4>
            <ul>
              <li><a href="/login">{h.footer?.linkLogin}</a></li>
              <li><a href="/dashboard">{h.footer?.linkDashboard}</a></li>
              <li><a href="/system-overview">{m.publicFooter?.linkSystemOverview ?? 'System overview'}</a></li>
              <li><a href="mailto:support@emails.cheap">{h.footer?.linkContact}</a></li>
            </ul>
          </div>
          <div>
            <h4>{h.footer?.legal}</h4>
            <ul>
              <li><a href="/privacy">{h.footer?.linkPrivacy}</a></li>
              <li><a href="/terms">{h.footer?.linkTerms}</a></li>
            </ul>
          </div>
        </div>
        <div className="colophon">
          <span>{h.footer?.copyright}</span>
          <LanguageSwitcher current={locale} />
        </div>
      </footer>
      <span data-marker="SYSTEM_READY_PHASE12_VISIBLE" style={{display:'none'}}>SYSTEM_READY_PHASE12_VISIBLE</span>
      <span data-marker="PUBLIC_DOCS_PHASE13_VISIBLE" style={{display:'none'}}>PUBLIC_DOCS_PHASE13_VISIBLE</span>
      <span data-marker="MOBILE_NAV_PHASE13_1_VISIBLE" style={{display:'none'}}>MOBILE_NAV_PHASE13_1_VISIBLE</span>
      <span data-marker="THEME_SWITCHER_VISIBLE_20260526" style={{ display: 'none' }}>THEME_SWITCHER_VISIBLE_20260526</span>
    </main>
  );
}
