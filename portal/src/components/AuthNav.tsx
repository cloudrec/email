'use client';

import { useEffect, useState } from 'react';
import { useLocaleClient } from './useLocaleClient';
import { t } from '../lib/t';

type Me = {
  userId: number;
  email: string;
  isSuperAdmin: boolean;
  tenantId: number | null;
  role: string | null;
};

export function AuthNav() {
  const locale = useLocaleClient();
  const [me, setMe] = useState<Me | null>(null);
  const [tenants, setTenants] = useState<Array<{ tenant_id: number; name: string }>>([]);

  useEffect(() => {
    const token = document.cookie.split('; ').find((c) => c.startsWith('token='))?.split('=')[1];
    if (!token) return;
    fetch('/api/auth/me', { headers: { authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (j) setMe(j); })
      .catch(() => {});
  }, []);

  const logout = () => {
    document.cookie = 'token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
    document.cookie = 'tenantId=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
    window.location.href = '/';
  };

  if (!me) {
    return (
      <nav style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <a href="/login">{t(locale, 'auth.login')}</a>
        <a href="/register">{t(locale, 'auth.register')}</a>
      </nav>
    );
  }

  const tenantParam = me.isSuperAdmin && me.tenantId ? `?tenantId=${me.tenantId}` : '';

  return (
    <nav style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
      {me.isSuperAdmin && <a href="/admin">{t(locale, 'nav.admin')}</a>}
      <a href={`/dashboard${tenantParam}`}>{t(locale, 'nav.dashboard')}</a>
      <a href={`/contacts${tenantParam}`}>{t(locale, 'nav.contacts')}</a>
      <a href={`/campaigns${tenantParam}`}>{t(locale, 'nav.campaigns')}</a>
      <a href={`/domains${tenantParam}`}>{t(locale, 'nav.domains')}</a>
      <a href={`/leads${tenantParam}`}>{t(locale, 'nav.leads')}</a>
      <a href={`/collector${tenantParam}`}>{t(locale, 'nav.collector')}</a>
      <a href={`/invites${tenantParam}`}>{t(locale, 'nav.invites')}</a>
      <a href={`/outreach${tenantParam}`}>{t(locale, 'nav.outreach')}</a>
      <a href={`/billing${tenantParam}`}>{t(locale, 'nav.billing')}</a>
      <span style={{ color: '#6b7591', fontSize: 12 }}>{me.email}{me.isSuperAdmin ? ' (super)' : ''}</span>
      <a href="#" onClick={(e) => { e.preventDefault(); logout(); }}>{t(locale, 'auth.logout')}</a>
    </nav>
  );
}
