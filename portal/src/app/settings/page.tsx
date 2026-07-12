'use client';

import { useEffect, useState } from 'react';
import { useT } from '@/lib/useT';

function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = document.cookie.split('; ').find((c) => c.startsWith('token='))?.split('=')[1] ?? '';
  return fetch(`/api${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  }).then(async (r) => {
    if (r.status === 401) { window.location.href = '/login?next=/settings'; throw new Error('unauthorized'); }
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error ?? `${r.status}`);
    }
    return r.json() as Promise<T>;
  });
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h2 style={{ marginBottom: 16 }}>{title}</h2>
      {children}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: 'block', fontWeight: 600, fontSize: 13, marginBottom: 5, color: 'var(--ink-2)' }}>{label}</label>
      {children}
      {hint && <p style={{ fontSize: 11, color: 'var(--muted)', margin: '3px 0 0' }}>{hint}</p>}
    </div>
  );
}

function Toast({ msg, ok }: { msg: string | null; ok?: boolean }) {
  if (!msg) return null;
  return (
    <div style={{
      padding: '8px 12px', borderRadius: 4, fontSize: 13, marginTop: 10,
      background: ok ? '#0c2010' : '#2a0c0c',
      border: `1px solid ${ok ? 'var(--ok)' : 'var(--danger)'}`,
      color: ok ? '#88ddaa' : '#ffaaaa',
    }}>
      {msg}
    </div>
  );
}

export default function SettingsPage() {
  const t = useT();
  const [user, setUser] = useState<{ email: string; fullName: string | null; locale: string; isSuperAdmin: boolean } | null>(null);

  // Profile form
  const [fullName, setFullName] = useState('');
  const [locale, setLocale] = useState('en');
  const [profileMsg, setProfileMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);

  // Password form
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [pwMsg, setPwMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [savingPw, setSavingPw] = useState(false);

  useEffect(() => {
    api<any>('/auth/me').then((u) => {
      setUser(u);
      setFullName(u.fullName ?? '');
      setLocale(u.locale ?? 'en');
    }).catch(() => {});
  }, []);

  const saveProfile = async () => {
    setSavingProfile(true); setProfileMsg(null);
    try {
      await api('/auth/me', { method: 'PATCH', body: JSON.stringify({ fullName: fullName || null, locale }) });
      setProfileMsg({ text: t('settings.profileUpdated'), ok: true });
    } catch (e: any) { setProfileMsg({ text: e.message, ok: false }); }
    setSavingProfile(false);
  };

  const changePassword = async () => {
    if (!newPw || !currentPw) { setPwMsg({ text: t('settings.fillAllPasswordFields'), ok: false }); return; }
    if (newPw !== confirmPw) { setPwMsg({ text: t('settings.passwordsDoNotMatch'), ok: false }); return; }
    if (newPw.length < 10) { setPwMsg({ text: t('settings.passwordMinLength'), ok: false }); return; }
    setSavingPw(true); setPwMsg(null);
    try {
      await api('/auth/me', { method: 'PATCH', body: JSON.stringify({ currentPassword: currentPw, newPassword: newPw }) });
      setPwMsg({ text: t('settings.passwordChanged'), ok: true });
      setCurrentPw(''); setNewPw(''); setConfirmPw('');
    } catch (e: any) {
      setPwMsg({ text: e.message === 'invalid_current_password' ? t('settings.currentPasswordWrong') : e.message, ok: false });
    }
    setSavingPw(false);
  };

  if (!user) {
    return <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>{t('settings.loading')}</div>;
  }

  return (
    <div style={{ maxWidth: 560 }}>
      {/* Account info */}
      <Section title={t('settings.accountTitle')}>
        <table style={{ width: '100%', fontSize: 13 }}>
          <tbody>
            <tr>
              <td style={{ color: 'var(--ink-3)', paddingBottom: 8, width: 140 }}>{t('settings.emailLabel')}</td>
              <td><code>{user.email}</code></td>
            </tr>
            <tr>
              <td style={{ color: 'var(--ink-3)', paddingBottom: 8 }}>{t('settings.roleLabel')}</td>
              <td>{user.isSuperAdmin ? <span className="badge ok">{t('settings.roleSuperAdmin')}</span> : <span className="badge">{t('settings.roleUser')}</span>}</td>
            </tr>
          </tbody>
        </table>
        <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>{t('settings.emailCannotChange')}</p>
      </Section>

      {/* Profile */}
      <Section title={t('settings.profileTitle')}>
        <Field label={t('settings.fullNameLabel')}>
          <input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder={t('settings.fullNamePlaceholder')} />
        </Field>
        <Field label={t('settings.localeLabel')}>
          <select value={locale} onChange={(e) => setLocale(e.target.value)}>
            <option value="en">English</option>
            <option value="ru">Русский</option>
            <option value="uk">Українська</option>
          </select>
        </Field>
        <Toast msg={profileMsg?.text ?? null} ok={profileMsg?.ok} />
        <div style={{ marginTop: 14 }}>
          <button className="btn" onClick={saveProfile} disabled={savingProfile}>
            {savingProfile ? t('settings.saving') : t('settings.saveProfile')}
          </button>
        </div>
      </Section>

      {/* Password */}
      <Section title={t('settings.changePasswordTitle')}>
        <Field label={t('settings.currentPasswordLabel')}>
          <input type="password" value={currentPw} onChange={(e) => setCurrentPw(e.target.value)} autoComplete="current-password" />
        </Field>
        <Field label={t('settings.newPasswordLabel')} hint={t('settings.newPasswordHint')}>
          <input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} autoComplete="new-password" />
        </Field>
        <Field label={t('settings.confirmPasswordLabel')}>
          <input type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} autoComplete="new-password" />
        </Field>
        <Toast msg={pwMsg?.text ?? null} ok={pwMsg?.ok} />
        <div style={{ marginTop: 14 }}>
          <button className="btn" onClick={changePassword} disabled={savingPw}>
            {savingPw ? t('settings.updating') : t('settings.changePasswordButton')}
          </button>
        </div>
      </Section>

      {/* Danger zone */}
      <div className="card" style={{ borderLeft: '3px solid var(--danger)' }}>
        <h2 style={{ marginBottom: 8 }}>{t('settings.sessionTitle')}</h2>
        <p style={{ fontSize: 13, color: 'var(--ink-3)', marginBottom: 12 }}>
          {t('settings.sessionDescription')}
        </p>
        <button
          className="btn btn-ghost"
          onClick={() => {
            document.cookie = 'token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
            window.location.href = '/login';
          }}
        >
          {t('settings.logOut')}
        </button>
      </div>
    </div>
  );
}
