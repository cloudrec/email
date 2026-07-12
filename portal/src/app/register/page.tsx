'use client';

import { useState } from 'react';
import { useLocaleClient } from '../../components/useLocaleClient';
import { t } from '../../lib/t';

export default function RegisterPage() {
  const locale = useLocaleClient();
  const [form, setForm] = useState({ email: '', password: '', fullName: '', tenantName: '', locale: 'en' });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const r = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await r.json();
      if (!r.ok) { setError(t(locale, 'auth.registerFailed')); return; }
      document.cookie = `token=${data.token}; path=/; samesite=lax`;
      window.location.href = `/dashboard?tenantId=${data.tenantId}`;
    } catch (e: any) { setError(t(locale, 'auth.networkError')); }
    finally { setLoading(false); }
  }

  return (
    <div className="card" style={{ maxWidth: 480, margin: '40px auto' }}>
      <h1>{t(locale, 'auth.register')}</h1>
      <form onSubmit={submit}>
        <label>{t(locale, 'auth.email')}</label>
        <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
        <label>{t(locale, 'auth.password')}</label>
        <input type="password" minLength={10} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
        <label>{t(locale, 'auth.fullName')}</label>
        <input value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
        <label>{t(locale, 'auth.workspaceName')}</label>
        <input value={form.tenantName} onChange={(e) => setForm({ ...form, tenantName: e.target.value })} required minLength={2} />
        <label>{t(locale, 'auth.languageLabel')}</label>
        <select value={form.locale} onChange={(e) => setForm({ ...form, locale: e.target.value })}>
          <option value="en">EN</option><option value="ru">RU</option><option value="uk">UK</option>
        </select>
        {error && <p style={{ color: '#a31818', marginTop: 12 }}>{error}</p>}
        <p style={{ marginTop: 16 }}>
          <button className="btn" type="submit" disabled={loading}>{loading ? '…' : t(locale, 'auth.submit')}</button>
        </p>
      </form>
    </div>
  );
}
