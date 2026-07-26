'use client';

import { useEffect, useState, useCallback } from 'react';
import { useLocaleClient } from './useLocaleClient';
import { LanguageSwitcher } from './LanguageSwitcher';
import { ThemeSwitcher } from './ThemeSwitcher';
import { t } from '../lib/t';
import { type Locale } from '../i18n';

type Me = {
  userId: number;
  email: string;
  isSuperAdmin: boolean;
  tenantId: number | null;
  role: string | null;
};

type Health = {
  smtp?: 'ready' | 'not_configured' | 'configured_but_unreachable' | 'auth_failed' | null;
  domainsVerified?: number;
  domainsTotal?: number;
  collectorActive?: number;
  pendingDrafts?: number;
};

// Navigation grouped by the operator's job-to-be-done — one clear place per task,
// plain names, with rarely-used infra folded under "Advanced". Routes are unchanged.
const GROUPS: Array<{ section: string; superOnly?: boolean; items: Array<{ key: string; href: (q: string) => string }> }> = [
  { section: 'home', items: [
    { key: 'dashboard', href: (q) => `/dashboard${q}` },
  ] },
  { section: 'find', items: [
    { key: 'collector',  href: (q) => `/collector${q}` },
    { key: 'warehouse',  href: (q) => `/warehouse${q}` },
    { key: 'leads',      href: (q) => `/leads${q}` },
    { key: 'contacts',   href: (q) => `/contacts${q}` },
  ] },
  { section: 'outreach', items: [
    { key: 'senderStudio',   href: (q) => `/sender-studio${q}` },
    { key: 'campaigns',      href: (q) => `/campaigns${q}` },
    { key: 'manualOutreach', href: (q) => `/manual-outreach${q}` },
    { key: 'outreach',       href: (q) => `/outreach${q}` },
  ] },
  { section: 'engine', items: [
    { key: 'affiliateOffers', href: (q) => `/affiliate-offers${q}` },
    { key: 'replies',         href: (q) => `/replies${q}` },
    { key: 'revenue',         href: (q) => `/revenue${q}` },
  ] },
  { section: 'deliver', items: [
    { key: 'deliverability', href: (q) => `/deliverability${q}` },
    { key: 'goLive',         href: (q) => `/go-live${q}` },
    { key: 'domains',        href: (q) => `/domains${q}` },
    { key: 'mailboxes',      href: (q) => `/mailboxes${q}` },
  ] },
  { section: 'settings', items: [
    { key: 'settings',   href: () => `/settings` },
    { key: 'billing',    href: (q) => `/billing${q}` },
    { key: 'onboarding', href: (q) => `/onboarding${q}` },
    { key: 'setup',      href: (q) => `/setup${q}` },
  ] },
  { section: 'advanced', items: [
    { key: 'smtpNodes',       href: (q) => `/smtp-nodes${q}` },
    { key: 'sendControl',     href: (q) => `/send-control${q}` },
    { key: 'partnerOutreach', href: (q) => `/partner-outreach${q}` },
    { key: 'invites',         href: (q) => `/invites${q}` },
    { key: 'stats',           href: (q) => `/stats${q}` },
    { key: 'themes',          href: () => `/themes` },
  ] },
  { section: 'admin', superOnly: true, items: [
    { key: 'admin',      href: () => `/admin` },
    { key: 'adminTheme', href: () => `/admin/theme` },
  ] },
];

function fetchMe(token: string): Promise<Me | null> {
  return fetch('/api/auth/me', { headers: { authorization: `Bearer ${token}` } })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
}

async function fetchHealth(token: string, tenantId: number | null, isSuper: boolean): Promise<Health> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (tenantId) headers['x-tenant-id'] = String(tenantId);
  const out: Health = {};
  if (isSuper) {
    try {
      const r = await fetch('/api/system/smtp-status', { headers });
      if (r.ok) { const j = await r.json(); out.smtp = j.state ?? null; }
    } catch {}
  }
  if (tenantId) {
    try {
      const r = await fetch('/api/domains', { headers });
      if (r.ok) { const j = await r.json(); out.domainsTotal = j.domains?.length ?? 0; out.domainsVerified = (j.domains ?? []).filter((d: any) => d.status === 'verified').length; }
    } catch {}
    try {
      const r = await fetch('/api/collector/campaigns', { headers });
      if (r.ok) { const j = await r.json(); out.collectorActive = (j.campaigns ?? []).filter((c: any) => c.status === 'active').length; }
    } catch {}
    try {
      const r = await fetch('/api/outreach/drafts?status=pending_review', { headers });
      if (r.ok) { const j = await r.json(); out.pendingDrafts = (j.drafts ?? []).filter((d: any) => d.status === 'pending_review').length; }
    } catch {}
  }
  return out;
}

function avatarOf(email: string): string {
  const [local] = email.split('@');
  const letters = local.replace(/[^a-z]/gi, '').slice(0, 2).toUpperCase();
  return letters || 'OP';
}

function SidebarContent({
  locale, me, health, tenantParam, pageKey, logout, onNavClick
}: {
  locale: Locale;
  me: Me;
  health: Health;
  tenantParam: string;
  pageKey: string;
  logout: () => void;
  onNavClick?: () => void;
}) {
  const smtpChip =
    !me.isSuperAdmin ? null :
    health.smtp === 'ready' ? <span className="value ok">ready</span> :
    health.smtp == null ? <span className="value">—</span> :
    <span className="value warn">{health.smtp.replace(/_/g, ' ')}</span>;

  const domainChip =
    health.domainsTotal == null ? <span className="value">—</span> :
    health.domainsVerified === health.domainsTotal && health.domainsTotal > 0 ?
      <span className="value ok">{health.domainsVerified}/{health.domainsTotal}</span> :
    health.domainsTotal === 0 ?
      <span className="value warn">0</span> :
      <span className="value warn">{health.domainsVerified}/{health.domainsTotal}</span>;

  const collectorChip = health.collectorActive == null
    ? <span className="value">—</span>
    : <span className={`value ${health.collectorActive ? 'ok' : ''}`}>{health.collectorActive}</span>;

  const pendingChip = health.pendingDrafts == null
    ? <span className="value">—</span>
    : <span className={`value ${health.pendingDrafts ? 'warn' : ''}`}>{health.pendingDrafts}</span>;

  return (
    <>
      <div className="brand">
        <span className="mark" aria-hidden="true" />
        Email Platform
        <small>v0.1</small>
      </div>

      <nav className="menu">
        {GROUPS.filter((g) => !g.superOnly || me.isSuperAdmin).map((g) => (
          <div key={g.section}>
            <div className="section">{t(locale, `nav.section.${g.section}`)}</div>
            {g.items.map((i) => (
              <a key={i.key} href={i.href(tenantParam)} className={pageKey === i.key ? 'active' : ''} onClick={onNavClick}>
                {t(locale, `nav.${i.key}`)}
                {i.key === 'outreach' && (health.pendingDrafts ?? 0) > 0 && <span className="dot warn" />}
                {i.key === 'domains' && health.domainsTotal === 0 && <span className="dot warn" />}
                {i.key === 'collector' && (health.collectorActive ?? 0) > 0 && <span className="dot ok" />}
              </a>
            ))}
          </div>
        ))}

        <a href="/guide-ru.html" target="_blank" rel="noopener" style={{ marginTop: 10 }}>📖 {t(locale, 'nav.guide')}</a>
      </nav>

      <div className="health">
        {me.isSuperAdmin && (
          <div className="row">
            <span className="label">{t(locale, 'shell.smtp')}</span>
            {smtpChip}
          </div>
        )}
        <div className="row"><span className="label">{t(locale, 'shell.domains')}</span>{domainChip}</div>
        <div className="row"><span className="label">{t(locale, 'shell.collector')}</span>{collectorChip}</div>
        <div className="row"><span className="label">{t(locale, 'shell.pendingDrafts')}</span>{pendingChip}</div>
        <div className="row"><span className="label">{t(locale, 'shell.emailsSent')}</span><span className="value">0</span></div>
      </div>

      <div className="user">
        <div className="avatar" aria-hidden="true">{avatarOf(me.email)}</div>
        <div className="who">
          {me.email.split('@')[0]}
          <br /><small>{me.isSuperAdmin ? t(locale, 'shell.superAdmin') : (me.role ?? '')}</small>
        </div>
        <a href="#" className="logout" onClick={(e) => { e.preventDefault(); logout(); }}>{t(locale, 'auth.logout')}</a>
      </div>
    </>
  );
}

export function AppShell({ children, pageKey, pageTitle, pageSub, actions }: {
  children: React.ReactNode;
  pageKey: string;
  pageTitle?: string;
  pageSub?: string;
  actions?: React.ReactNode;
}) {
  const locale = useLocaleClient();
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [health, setHealth] = useState<Health>({});
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  useEffect(() => {
    const token = document.cookie.split('; ').find((c) => c.startsWith('token='))?.split('=')[1];
    if (!token) { setMe(null); return; }
    fetchMe(token).then((m) => {
      setMe(m ?? null);
      if (m) fetchHealth(token, m.tenantId, m.isSuperAdmin).then(setHealth);
    });
  }, []);

  // ESC closes mobile sidebar
  useEffect(() => {
    if (!sidebarOpen) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') closeSidebar(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [sidebarOpen, closeSidebar]);

  // Lock scroll when sidebar open
  useEffect(() => {
    document.body.style.overflow = sidebarOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [sidebarOpen]);

  if (me === undefined) return null;
  if (me === null) {
    return <div className="container">{children}</div>;
  }

  const tenantParam = me.isSuperAdmin && me.tenantId ? `?tenantId=${me.tenantId}` : '';
  const logout = () => {
    document.cookie = 'token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
    document.cookie = 'tenantId=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
    window.location.href = '/';
  };

  return (
    <div className="app">
      {/* Desktop sidebar */}
      <aside className="sidebar sidebar--desktop">
        <SidebarContent
          locale={locale}
          me={me}
          health={health}
          tenantParam={tenantParam}
          pageKey={pageKey}
          logout={logout}
        />
      </aside>

      {/* Mobile sidebar backdrop */}
      {sidebarOpen && (
        <div className="mob-backdrop" aria-hidden="true" onClick={closeSidebar} />
      )}

      {/* Mobile sidebar drawer */}
      <aside className={`sidebar sidebar--mobile${sidebarOpen ? ' sidebar--mobile-open' : ''}`} aria-hidden={!sidebarOpen}>
        <SidebarContent
          locale={locale}
          me={me}
          health={health}
          tenantParam={tenantParam}
          pageKey={pageKey}
          logout={logout}
          onNavClick={closeSidebar}
        />
      </aside>

      <div className="main">
        <header className="topbar">
          {/* Mobile hamburger */}
          <button
            className="mob-hamburger mob-hamburger--app"
            aria-label="Open navigation menu"
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen(true)}
          >
            <span /><span /><span />
          </button>

          <div className="crumbs">
            <strong>{pageTitle ?? t(locale, `nav.${pageKey}`)}</strong>
            {me.isSuperAdmin && me.tenantId && (
              <> <span style={{ margin: '0 6px' }}>·</span><code>tenant {me.tenantId}</code></>
            )}
          </div>
          <div className="spacer" />
          {actions}
          <ThemeSwitcher />
          <LanguageSwitcher current={locale} />
        </header>

        <div className="content">
          {(pageTitle || pageSub) && (
            <div className="page-h">
              <div>
                {pageTitle && <h1>{pageTitle}</h1>}
                {pageSub && <div className="sub">{pageSub}</div>}
              </div>
            </div>
          )}
          {children}
        </div>
      </div>
    </div>
  );
}
