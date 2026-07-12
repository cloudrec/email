'use client';

import { useEffect, useState } from 'react';
import { THEMES, DEFAULT_THEME, themeByCode, themeContrastSummary, type Theme } from '../../../theme/registry';
import { applyThemePreview, persistUserTheme, setGlobalDefaultTheme } from '../../../components/ThemeProvider';
import { useLocaleClient } from '../../../components/useLocaleClient';
import { t } from '../../../lib/t';

export default function AdminThemePage() {
  const locale = useLocaleClient();
  const [active, setActive] = useState<string>(DEFAULT_THEME);
  const [serverDefault, setServerDefault] = useState<string>(DEFAULT_THEME);
  const [userTheme, setUserTheme] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    const token = document.cookie.split('; ').find((c) => c.startsWith('token='))?.split('=')[1];
    if (!token) { window.location.href = '/login?next=/admin/theme'; return; }
    fetch('/api/me/theme', { headers: { authorization: `Bearer ${token}` } })
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(String(r.status))))
      .then((j) => {
        setServerDefault(j.defaultTheme ?? DEFAULT_THEME);
        setUserTheme(j.userTheme ?? null);
        const cookieTheme = document.cookie.split('; ').find((c) => c.startsWith('theme='))?.split('=')[1];
        setActive(cookieTheme ?? j.userTheme ?? j.defaultTheme ?? DEFAULT_THEME);
      })
      .catch((e) => setMsg(t(locale, 'admin.themePage.authRequired')));
  }, []);

  const preview = (code: string) => { setActive(code); applyThemePreview(code); };
  const applyUser = async (code: string) => { await persistUserTheme(code); setUserTheme(code); setActive(code); setMsg(t(locale, 'admin.themePage.userOverrideSaved')); };
  const useSiteDefault = async () => { await persistUserTheme(null); setUserTheme(null); setActive(serverDefault); applyThemePreview(serverDefault); setMsg(t(locale, 'admin.themePage.revertedToDefault')); };
  const setDefault = async (code: string) => {
    try { await setGlobalDefaultTheme(code); setServerDefault(code); setMsg(t(locale, 'admin.themePage.globalDefaultSet').replace('{name}', themeByCode(code).name)); }
    catch (e: any) { setMsg(t(locale, 'admin.themePage.failed').replace('{msg}', e.message)); }
  };

  return (
    <>
      <div className="panel">
        <div className="panel-h"><h2>{t(locale, 'admin.themePage.title')}</h2><span className="right">{t(locale, 'admin.themePage.subtitle')}</span></div>
        <div className="row">
          <div className="stat"><div className="label">{t(locale, 'admin.themePage.active')}</div><div className="value">{themeByCode(active).name}</div></div>
          <div className="stat"><div className="label">{t(locale, 'admin.themePage.globalDefault')}</div><div className="value">{themeByCode(serverDefault).name}</div></div>
          <div className="stat"><div className="label">{t(locale, 'admin.themePage.userOverride')}</div><div className="value">{userTheme ? themeByCode(userTheme).name : <span className="muted">{t(locale, 'admin.themePage.useSiteDefault')}</span>}</div></div>
        </div>
        {msg && <div className="notice info" style={{ marginTop: 12 }}>{msg}</div>}
        <div className="cluster" style={{ marginTop: 12 }}>
          <button className="btn btn-ghost" onClick={useSiteDefault}>{t(locale, 'admin.themePage.useSiteDefault')}</button>
        </div>
      </div>

      <div className="panel">
        <div className="panel-h"><h2>{t(locale, 'admin.themePage.gallery')}</h2></div>
        <div className="feature-grid">
          {THEMES.map((th) => (
            <AdminThemeCard key={th.code} theme={th} active={active === th.code}
              isDefault={serverDefault === th.code}
              onPreview={preview} onApplyUser={applyUser} onMakeDefault={setDefault}
              locale={locale} />
          ))}
        </div>
      </div>
    </>
  );
}

function AdminThemeCard({ theme, active, isDefault, onPreview, onApplyUser, onMakeDefault, locale }: {
  theme: Theme; active: boolean; isDefault: boolean;
  onPreview: (c: string) => void; onApplyUser: (c: string) => Promise<void>; onMakeDefault: (c: string) => Promise<void>;
  locale: 'en' | 'ru' | 'uk';
}) {
  const contrast = themeContrastSummary(theme);
  const worst = contrast.reduce((a, b) => (a.ratio < b.ratio ? a : b));
  return (
    <div className="feature" style={{ borderColor: active ? 'var(--accent)' : 'var(--line)' }}>
      <div className="cluster between" style={{ marginBottom: 8 }}>
        <strong style={{ fontSize: 14 }}>{theme.name}</strong>
        <span className="chip muted">{theme.mode}</span>
      </div>
      <p style={{ fontSize: 12.5, color: 'var(--ink-3)', minHeight: 32 }}>{theme.feel}</p>
      <div className="cluster" style={{ marginTop: 8 }}>
        {theme.swatches.map((c, i) => (
          <span key={i} title={c} style={{ width: 14, height: 14, borderRadius: 3, background: c, border: '1px solid rgba(0,0,0,0.18)' }} />
        ))}
        <span className="chip muted" style={{ marginLeft: 'auto' }}>{worst.passAA ? t(locale, 'admin.themePage.ratingAA') : t(locale, 'admin.themePage.ratingLow')} {worst.ratio.toFixed(2)}</span>
      </div>
      {isDefault && <p style={{ marginTop: 8, fontSize: 11.5, color: 'var(--accent-2)', fontWeight: 600 }}>★ {t(locale, 'admin.themePage.currentDefault')}</p>}
      <div className="cluster" style={{ marginTop: 12 }}>
        <button className="btn btn-ghost" onClick={() => onPreview(theme.code)}>{t(locale, 'themes.preview')}</button>
        <button className="btn btn-ghost" onClick={() => onApplyUser(theme.code)}>{t(locale, 'admin.themePage.useForMe')}</button>
        <button className="btn btn-primary" onClick={() => onMakeDefault(theme.code)} disabled={isDefault}>
          {t(locale, 'admin.themePage.makeDefault')}
        </button>
      </div>
    </div>
  );
}
