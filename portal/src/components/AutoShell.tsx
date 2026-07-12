'use client';

import { usePathname } from 'next/navigation';
import { AppShell } from './AppShell';
import { useLocaleClient } from './useLocaleClient';
import { t } from '../lib/t';

const PUBLIC_PATHS = new Set<string>([
  '/', '/login', '/register', '/themes',
  '/privacy', '/terms', '/unsubscribed',
  '/features', '/how-it-works', '/instructions', '/safety', '/modules', '/faq', '/system-overview',
]);

// Map first path segment → nav key + i18n title key + optional sub.
const PAGE_MAP: Record<string, { key: string; title: string; sub?: string }> = {
  dashboard: { key: 'dashboard', title: 'dashboard.title',  sub: 'dashboard.subtitle' },
  leads:     { key: 'leads',     title: 'leads.title',      sub: 'leads.subtitle' },
  collector: { key: 'collector', title: 'collector.title',  sub: 'collector.subtitle' },
  outreach:  { key: 'outreach',  title: 'outreach.title',   sub: 'outreach.subtitle' },
  invites:   { key: 'invites',   title: 'invites.title',    sub: 'invites.subtitle' },
  contacts:  { key: 'contacts',  title: 'contacts.title' },
  campaigns: { key: 'campaigns', title: 'campaigns.title' },
  domains:   { key: 'domains',   title: 'domains.title' },
  billing:   { key: 'billing',   title: 'billing.title' },
  admin:     { key: 'admin',     title: 'admin.title',      sub: 'admin.subtitle' },
  setup:       { key: 'setup',       title: 'setup.title',       sub: 'setup.subtitle' },
  stats:       { key: 'stats',       title: 'stats.title',       sub: 'stats.subtitle' },
  onboarding:  { key: 'onboarding',  title: 'onboarding.title',  sub: 'onboarding.subtitle' },
  settings:    { key: 'settings',    title: 'settings.title',    sub: 'settings.subtitle' },
};

export function AutoShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? '/';
  const locale = useLocaleClient();

  if (PUBLIC_PATHS.has(pathname)) return <>{children}</>;

  const first = pathname.split('/').filter(Boolean)[0] ?? '';
  const cfg = PAGE_MAP[first];
  if (!cfg) {
    // Unknown route — render bare. Per-page wrapping still works.
    return <>{children}</>;
  }
  return (
    <AppShell
      pageKey={cfg.key}
      pageTitle={t(locale, cfg.title)}
      pageSub={cfg.sub ? t(locale, cfg.sub) : undefined}
    >
      {children}
    </AppShell>
  );
}
