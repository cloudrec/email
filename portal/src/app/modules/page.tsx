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
  return {
    title: 'Modules — Email Platform',
    description: 'Every module in Email Platform: collector, warehouse, analyzer, outreach, campaigns, domains, contacts, billing, and admin.',
    metadataBase: new URL(SITE),
    alternates: { canonical: '/modules' },
  };
}

export default async function ModulesPage() {
  const locale = await detectLocale();
  const m: any = getMessages(locale);
  const p = m.pages?.modules ?? {};
  const nav = m.publicNav ?? {};
  const footer = m.publicFooter ?? {};
  const featuresModules = m.pages?.features?.modules ?? [];
  const cards = MODULE_CARDS(p);

  return (
    <PublicShell locale={locale} loginLabel={nav.login ?? 'Sign in'} dashboardLabel={nav.openDashboard ?? 'Open dashboard'} nav={nav} footer={footer}>
      <section className="landing-hero" style={{ paddingBottom: 48 }}>
        <div>
          <div className="eyebrow">{p.eyebrow ?? 'Module reference'}</div>
          <h1>{p.title ?? 'Every module in the platform.'}</h1>
          <p style={{ maxWidth: 580, lineHeight: 1.6, opacity: 0.85 }}>{p.sub ?? 'Quick-reference for each module: purpose, activation requirements, and what it connects to in the pipeline.'}</p>
        </div>
      </section>

      {/* Module grid */}
      <section style={{ padding: '0 0 80px' }}>
        <div style={{ maxWidth: 900, margin: '0 auto', padding: '0 24px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 20 }}>
          {cards.map((card, i) => (
            <div key={i} style={{ padding: '24px', borderRadius: 12, background: 'var(--surface, rgba(255,255,255,0.04))', border: '1px solid var(--border, rgba(255,255,255,0.08))' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 22 }}>{card.icon}</span>
                <h3 style={{ margin: 0, fontSize: 16 }}>{card.h}</h3>
                <span style={{ marginLeft: 'auto', fontSize: 11, padding: '2px 8px', borderRadius: 12, background: card.active ? 'rgba(80,200,120,0.15)' : 'rgba(200,120,80,0.15)', color: card.active ? '#4fc87f' : '#f7a04f', fontWeight: 600 }}>{card.active ? (p.badgeActive ?? 'Active') : (p.badgeRequiresSetup ?? 'Requires setup')}</span>
              </div>
              <p style={{ margin: '0 0 10px', fontSize: 13, lineHeight: 1.6, opacity: 0.8 }}>{card.p}</p>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {card.requires.map((r, j) => (
                  <span key={j} style={{ fontSize: 11, padding: '3px 8px', borderRadius: 6, background: 'rgba(255,255,255,0.06)', opacity: 0.7 }}>{r}</span>
                ))}
              </div>
              {card.href && (
                <a href={card.href} style={{ display: 'inline-block', marginTop: 12, fontSize: 12, color: 'var(--accent, #4f8ef7)', textDecoration: 'none', opacity: 0.8 }}>{p.openInApp ?? 'Open in app'} →</a>
              )}
            </div>
          ))}
        </div>
      </section>

      <div className="cta-band">
        <div className="wrap">
          <div className="eyebrow">{p.cta?.eyebrow ?? 'Get going'}</div>
          <h2>{p.cta?.heading ?? 'Start with the collector.'}</h2>
          <p>{p.cta?.body ?? 'Add your first source and watch leads flow into the warehouse automatically.'}</p>
          <div className="ctas">
            <a href="/dashboard" style={{ padding: '12px 28px', borderRadius: 8, background: 'var(--accent, #4f8ef7)', color: '#fff', textDecoration: 'none', fontWeight: 600 }}>{p.cta?.primary ?? 'Open dashboard'}</a>
            <a href="/features" style={{ padding: '12px 20px', opacity: 0.75, textDecoration: 'none' }}>{p.cta?.secondary ?? 'Detailed features'} →</a>
          </div>
        </div>
      </div>

      <span data-marker="PUBLIC_DOCS_PHASE13_VISIBLE" style={{ display: 'none' }}>PUBLIC_DOCS_PHASE13_VISIBLE</span>
    </PublicShell>
  );
}

function MODULE_CARDS(p: any) {
  const c = p.cards ?? {};
  return [
    { icon: '🔍', h: c.collectorH ?? 'Collector', p: c.collectorP ?? 'Discovers and crawls public business websites from OSM, Tavily, or CSV. Runs perpetually in the background.', active: true, requires: ['OSM free', 'Tavily optional'], href: '/collector' },
    { icon: '🗄️', h: c.warehouseH ?? 'Warehouse', p: c.warehouseP ?? 'Stores all collected companies and contacts. Industry classification, fit scoring, source attribution.', active: true, requires: [c.reqCollectorRunning ?? 'Collector running'], href: '/warehouse' },
    { icon: '🔬', h: c.analyzerH ?? 'Website Analyzer', p: c.analyzerP ?? 'Profiles each company website: industry, offering, pain points, confidence score.', active: true, requires: [c.reqWarehouseEntry ?? 'Warehouse entry'], href: '/warehouse' },
    { icon: '✉️', h: c.outreachH ?? 'Outreach Drafts', p: c.outreachP ?? 'Generates personalized messages from analyzed website facts. Requires operator review before any send.', active: true, requires: [c.reqWebsiteAnalysis ?? 'Website analysis', c.reqManualApproval ?? 'Manual approval'], href: '/outreach' },
    { icon: '👥', h: c.contactsH ?? 'Contacts', p: c.contactsP ?? 'Stores all addressable recipients. Strict pending→subscribed lifecycle. No auto-activation.', active: true, requires: [c.reqManualActivation ?? 'Manual activation'], href: '/contacts' },
    { icon: '📢', h: c.campaignsH ?? 'Campaigns', p: c.campaignsP ?? 'Scheduled outbound campaigns. Per-day limits, bounce monitoring, auto-pause on threshold breach.', active: false, requires: [c.reqDomainVerified ?? 'Domain verified', c.reqSmtpReady ?? 'SMTP ready', c.reqSubscribedContacts ?? 'Subscribed contacts'], href: '/campaigns' },
    { icon: '🌐', h: c.domainsH ?? 'Domains', p: c.domainsP ?? 'DNS verification for sending domains: SPF, DKIM (auto-generated), DMARC, Return-Path.', active: false, requires: [c.reqDnsAccess ?? 'DNS access'], href: '/domains' },
    { icon: '🔗', h: c.invitesH ?? 'Invite Links', p: c.invitesP ?? 'Branded short links with click tracking and suppression-aware redirects.', active: true, requires: [c.reqNone ?? 'None'], href: '/invites' },
    { icon: '💳', h: c.billingH ?? 'Billing', p: c.billingP ?? 'Plan management, trial tracking, manual payment confirmation.', active: true, requires: [c.reqAdminSetup ?? 'Admin setup'], href: '/billing' },
    { icon: '⚙️', h: c.settingsH ?? 'Settings', p: c.settingsP ?? 'Profile, language, password change, session management.', active: true, requires: [c.reqAuthenticated ?? 'Authenticated'], href: '/settings' },
    { icon: '🛡️', h: c.adminH ?? 'Admin Panel', p: c.adminP ?? 'Super-admin view: all tenants, SMTP, domains, audit, global suppression.', active: false, requires: ['super_admin role'], href: '/admin' },
    { icon: '📊', h: c.statsH ?? 'Stats & Logs', p: c.statsP ?? 'Platform-wide statistics: collector activity, warehouse volume, draft status, send totals.', active: true, requires: [c.reqAuthenticated ?? 'Authenticated'], href: '/stats' },
  ];
}
