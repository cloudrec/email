import { LanguageSwitcher } from './LanguageSwitcher';
import { ThemeSwitcher } from './ThemeSwitcher';
import { HomeNavRight } from '../app/HomeCTA';
import { MobileNav } from './MobileNav';
import { type Locale } from '../i18n';

interface Props {
  locale: Locale;
  loginLabel: string;
  dashboardLabel: string;
  children: React.ReactNode;
  nav: {
    home: string;
    features: string;
    howItWorks: string;
    instructions: string;
    safety: string;
    faq: string;
    login: string;
    openDashboard: string;
  };
  footer: {
    tagline: string;
    selfHosted: string;
    product: string;
    support: string;
    legal: string;
    linkHowItWorks: string;
    linkFeatures: string;
    linkInstructions: string;
    linkSafety: string;
    linkFaq: string;
    linkLogin: string;
    linkDashboard: string;
    linkPrivacy: string;
    linkTerms: string;
    linkContact: string;
    copyright: string;
  };
}

export function PublicShell({ locale, loginLabel, dashboardLabel, nav, footer, children }: Props) {
  return (
    <main className="landing">
      <nav className="topnav" aria-label="Top">
        <a href="/" className="brand"><span className="mark" aria-hidden="true" /> Email Platform</a>
        {/* Desktop links — hidden on mobile via CSS */}
        <div className="links">
          <a href="/">{nav.home}</a>
          <a href="/features">{nav.features}</a>
          <a href="/how-it-works">{nav.howItWorks}</a>
          <a href="/instructions">{nav.instructions}</a>
          <a href="/safety">{nav.safety}</a>
          <a href="/faq">{nav.faq}</a>
        </div>
        <div className="right">
          <ThemeSwitcher />
          <LanguageSwitcher current={locale} />
          <HomeNavRight loginLabel={loginLabel} dashboardLabel={dashboardLabel} />
          {/* Mobile hamburger — visible only on mobile via CSS */}
          <MobileNav locale={locale} nav={nav} loginLabel={loginLabel} dashboardLabel={dashboardLabel} />
        </div>
      </nav>

      {children}

      <footer className="landing-footer">
        <div className="wrap">
          <div className="brand-block">
            <div className="brand"><span className="mark" aria-hidden="true" /> Email Platform</div>
            <p>{footer.tagline}</p>
            <p style={{ fontSize: 11.5, marginTop: 4 }}>{footer.selfHosted}</p>
          </div>
          <div>
            <h4>{footer.product}</h4>
            <ul>
              <li><a href="/features">{footer.linkFeatures}</a></li>
              <li><a href="/how-it-works">{footer.linkHowItWorks}</a></li>
              <li><a href="/instructions">{footer.linkInstructions}</a></li>
              <li><a href="/safety">{footer.linkSafety}</a></li>
              <li><a href="/faq">{footer.linkFaq}</a></li>
            </ul>
          </div>
          <div>
            <h4>{footer.support}</h4>
            <ul>
              <li><a href="/login">{footer.linkLogin}</a></li>
              <li><a href="/dashboard">{footer.linkDashboard}</a></li>
              <li><a href="mailto:support@emails.cheap">{footer.linkContact}</a></li>
            </ul>
          </div>
          <div>
            <h4>{footer.legal}</h4>
            <ul>
              <li><a href="/privacy">{footer.linkPrivacy}</a></li>
              <li><a href="/terms">{footer.linkTerms}</a></li>
            </ul>
          </div>
        </div>
        <div className="colophon">
          <span>{footer.copyright}</span>
          <LanguageSwitcher current={locale} />
        </div>
      </footer>
      <span data-marker="MOBILE_NAV_PHASE13_1_VISIBLE" style={{ display: 'none' }}>MOBILE_NAV_PHASE13_1_VISIBLE</span>
    </main>
  );
}
