'use client';

import { useEffect, useState } from 'react';

export function HomeCTA({ primaryLabel, secondaryLabel, dashboardLabel, loginLabel }: {
  primaryLabel: string; secondaryLabel: string; dashboardLabel: string; loginLabel: string;
}) {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [tenantParam, setTenantParam] = useState('');

  useEffect(() => {
    const token = document.cookie.split('; ').find((c) => c.startsWith('token='))?.split('=')[1];
    if (!token) { setAuthed(false); return; }
    fetch('/api/auth/me', { headers: { authorization: `Bearer ${token}` } })
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((me) => {
        setAuthed(true);
        if (me.isSuperAdmin) setTenantParam('');
        else if (me.tenantId) setTenantParam(`?tenantId=${me.tenantId}`);
      })
      .catch(() => setAuthed(false));
  }, []);

  if (authed === null) {
    return <span style={{ display: 'inline-block', width: 200, height: 36 }} />;
  }
  if (authed) {
    return (
      <>
        <a className="btn btn-primary" href={`/dashboard${tenantParam}`}>{dashboardLabel}</a>
        <a className="btn btn-ghost" href="#how">{secondaryLabel}</a>
      </>
    );
  }
  return (
    <>
      <a className="btn btn-primary" href="/login">{primaryLabel}</a>
      <a className="btn btn-ghost" href="#how">{secondaryLabel}</a>
    </>
  );
}

export function HomeNavRight({ loginLabel, dashboardLabel }: { loginLabel: string; dashboardLabel: string }) {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [tenantParam, setTenantParam] = useState('');

  useEffect(() => {
    const token = document.cookie.split('; ').find((c) => c.startsWith('token='))?.split('=')[1];
    if (!token) { setAuthed(false); return; }
    fetch('/api/auth/me', { headers: { authorization: `Bearer ${token}` } })
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((me) => {
        setAuthed(true);
        if (!me.isSuperAdmin && me.tenantId) setTenantParam(`?tenantId=${me.tenantId}`);
      })
      .catch(() => setAuthed(false));
  }, []);

  if (authed === null) return <span style={{ width: 110, display: 'inline-block' }} />;
  if (authed) {
    return <a className="btn btn-primary" href={`/dashboard${tenantParam}`}>{dashboardLabel}</a>;
  }
  return <a className="btn btn-primary" href="/login">{loginLabel}</a>;
}
