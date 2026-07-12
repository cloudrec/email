'use client';

import { useState } from 'react';
import { useLocaleClient } from '../../components/useLocaleClient';
import { LanguageSwitcher } from '../../components/LanguageSwitcher';
import { t } from '../../lib/t';

export default function LoginPage() {
  const locale = useLocaleClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const r = await fetch(`/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await r.json();
      if (!r.ok) { setError(t(locale, 'auth.loginFailed')); return; }
      document.cookie = `token=${data.token}; path=/; samesite=lax`;
      const next = new URLSearchParams(window.location.search).get('next');
      const tenantParam = data.activeTenantId ? `?tenantId=${data.activeTenantId}` : '';
      window.location.href = next ?? (data.isSuperAdmin ? '/admin' : `/dashboard${tenantParam}`);
    } catch (e: any) {
      setError(t(locale, 'auth.networkError'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="public">
      <div className="pane brand">
        <div className="logo"><span className="mark" aria-hidden="true" /> Email Platform</div>
        <div>
          <h1>{t(locale, 'public.headline')}</h1>
          <p>{t(locale, 'public.subhead')}</p>
          <div className="points">
            <div className="item"><span className="marker" /><div>{t(locale, 'public.bullet1')}</div></div>
            <div className="item"><span className="marker" /><div>{t(locale, 'public.bullet2')}</div></div>
            <div className="item"><span className="marker" /><div>{t(locale, 'public.bullet3')}</div></div>
            <div className="item"><span className="marker" /><div>{t(locale, 'public.bullet4')}</div></div>
          </div>
        </div>
        <footer>{t(locale, 'public.trust')}</footer>
      </div>

      <div className="pane form" style={{ position: 'relative' }}>
        <div style={{ position: 'absolute', top: 20, right: 24 }}><LanguageSwitcher current={locale} /></div>
        <div className="box">
          <h2>{t(locale, 'auth.login')}</h2>
          <div className="hint">{t(locale, 'public.loginHint')}</div>
          <form onSubmit={submit}>
            <label htmlFor="email">{t(locale, 'auth.email')}</label>
            <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            <label htmlFor="password">{t(locale, 'auth.password')}</label>
            <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            {error && <div className="notice danger" style={{ marginTop: 14 }}>{error}</div>}
            <p style={{ marginTop: 18 }}>
              <button className="btn btn-primary" type="submit" disabled={loading} style={{ width: '100%', justifyContent: 'center' }}>
                {loading ? '…' : t(locale, 'auth.submit')}
              </button>
            </p>
            <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 14 }}>
              <a href="/register">{t(locale, 'auth.register')}</a>
            </p>
          </form>
        </div>
      </div>
    </div>
  );
}
