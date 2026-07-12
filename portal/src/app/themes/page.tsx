'use client';

import { useEffect, useState } from 'react';
import { THEMES, DEFAULT_THEME, themeByCode, themeContrastSummary, type Theme } from '../../theme/registry';
import { applyThemePreview, persistUserTheme } from '../../components/ThemeProvider';
import { useLocaleClient } from '../../components/useLocaleClient';
import { LanguageSwitcher } from '../../components/LanguageSwitcher';
import { ThemeSwitcher } from '../../components/ThemeSwitcher';
import { t } from '../../lib/t';

export default function ThemesPage() {
  const locale = useLocaleClient();
  const [active, setActive] = useState<string>(DEFAULT_THEME);
  const [serverDefault, setServerDefault] = useState<string>(DEFAULT_THEME);

  useEffect(() => {
    const cookieTheme = document.cookie.split('; ').find((c) => c.startsWith('theme='))?.split('=')[1];
    setActive(cookieTheme ?? DEFAULT_THEME);
    fetch('/api/system/theme').then((r) => r.ok ? r.json() : null).then((j) => {
      if (j?.defaultTheme) setServerDefault(j.defaultTheme);
    }).catch(() => {});
  }, []);

  const preview = (code: string) => {
    setActive(code);
    applyThemePreview(code);
  };
  const apply = (code: string) => {
    setActive(code);
    persistUserTheme(code);
  };
  const reset = () => {
    setActive(serverDefault);
    persistUserTheme(null);
  };

  return (
    <main className="landing">
      <nav className="topnav" aria-label={t(locale, 'themes.topNavLabel')}>
        <a href="/" className="brand"><span className="mark" aria-hidden="true" /> {t(locale, 'themes.brand')}</a>
        <div className="links">
          <a href="/">{t(locale, 'home.nav.product')}</a>
          <a href="/themes" style={{ color: 'var(--ink)' }}>{t(locale, 'themes.nav')}</a>
        </div>
        <div className="right">
          <ThemeSwitcher />
          <LanguageSwitcher current={locale} />
        </div>
      </nav>

      <section style={{ paddingTop: 56 }}>
        <div className="eyebrow">THEME_GALLERY_VISIBLE_20260526</div>
        <h1>{t(locale, 'themes.galleryHeading')}</h1>
        <p>{t(locale, 'themes.sub')}</p>
        <div className="cluster" style={{ marginTop: 18 }}>
          <span className="chip ok">{t(locale, 'themes.activeChip')}: <code style={{ marginLeft: 4 }}>{themeByCode(active).name}</code></span>
          <span className="chip muted">{t(locale, 'themes.globalDefaultChip')}: <code style={{ marginLeft: 4 }}>{themeByCode(serverDefault).name}</code></span>
          <button className="btn btn-ghost" onClick={reset}>{t(locale, 'themes.reset')}</button>
        </div>
      </section>

      <section style={{ paddingTop: 24 }}>
        <div className="feature-grid">
          {THEMES.map((th) => <ThemeCard key={th.code} theme={th} active={active === th.code} onPreview={preview} onApply={apply} locale={locale} />)}
        </div>
      </section>
      <span data-marker="THEME_GALLERY_VISIBLE_20260526" style={{ display: 'none' }}>THEME_GALLERY_VISIBLE_20260526</span>
    </main>
  );
}

function ThemeCard({ theme, active, onPreview, onApply, locale }: {
  theme: Theme; active: boolean; onPreview: (c: string) => void; onApply: (c: string) => void; locale: 'en' | 'ru' | 'uk';
}) {
  const contrast = themeContrastSummary(theme);
  const worst = contrast.reduce((a, b) => (a.ratio < b.ratio ? a : b));
  return (
    <div className="feature" style={{ borderColor: active ? 'var(--accent)' : 'var(--line)' }}>
      <div className="cluster between" style={{ marginBottom: 8 }}>
        <strong style={{ fontSize: 14, color: 'var(--ink)' }}>{theme.name}</strong>
        <span className="chip muted">{theme.mode}</span>
      </div>
      <p style={{ fontSize: 12.5, color: 'var(--ink-3)', minHeight: 32 }}>{theme.feel}</p>

      {/* Mini desktop preview */}
      <div style={{ marginTop: 8 }}>
        <MiniPreview theme={theme} variant="desktop" />
        <div style={{ marginTop: 6 }}>
          <MiniPreview theme={theme} variant="mobile" />
        </div>
      </div>

      <div className="cluster" style={{ marginTop: 10 }}>
        {theme.swatches.map((c, i) => (
          <span key={i} title={c} style={{ width: 14, height: 14, borderRadius: 3, background: c, border: '1px solid rgba(0,0,0,0.15)' }} />
        ))}
        <span className="chip muted" style={{ marginLeft: 'auto' }}>{worst.passAA ? 'AA' : 'low'} {worst.ratio.toFixed(2)}</span>
      </div>

      <div className="cluster" style={{ marginTop: 12 }}>
        <button className="btn btn-ghost" onClick={() => onPreview(theme.code)}>{t(locale, 'themes.preview')}</button>
        <button className="btn btn-primary" onClick={() => onApply(theme.code)}>{t(locale, 'themes.useThis')}</button>
      </div>
    </div>
  );
}

function MiniPreview({ theme, variant }: { theme: Theme; variant: 'desktop' | 'mobile' }) {
  const t = theme.tokens;
  const w = variant === 'desktop' ? '100%' : 110;
  const h = variant === 'desktop' ? 100 : 80;
  return (
    <div style={{
      width: w, height: h, display: 'flex',
      borderRadius: 4, overflow: 'hidden',
      border: `1px solid ${t.line}`,
      background: t.bg,
      color: t.ink, fontSize: 8.5,
    }}>
      <div style={{ width: variant === 'desktop' ? 40 : 26, background: t.navBg, color: t.navInk, padding: 6 }}>
        <div style={{ width: 18, height: 3, background: t.accent, marginBottom: 6 }} />
        <div style={{ height: 4, background: t.navBg2, marginBottom: 3 }} />
        <div style={{ height: 4, background: t.navActiveBg, marginBottom: 3 }} />
        <div style={{ height: 4, background: t.navBg2 }} />
      </div>
      <div style={{ flex: 1, padding: 6, background: t.bg }}>
        <div style={{ height: 6, background: t.surface, border: `1px solid ${t.line}`, marginBottom: 4, borderRadius: 2 }} />
        <div style={{ display: 'flex', gap: 3, marginBottom: 4 }}>
          <div style={{ flex: 1, height: 12, background: t.surface, border: `1px solid ${t.line}`, borderRadius: 2, borderTop: `2px solid ${t.accent}` }} />
          <div style={{ flex: 1, height: 12, background: t.surface, border: `1px solid ${t.line}`, borderRadius: 2 }} />
        </div>
        <div style={{ display: 'flex', gap: 3 }}>
          <div style={{ width: 14, height: 5, background: t.accent, borderRadius: 2 }} />
          <div style={{ width: 18, height: 5, background: t.ok, opacity: 0.85, borderRadius: 2 }} />
          <div style={{ width: 14, height: 5, background: t.warn, opacity: 0.7, borderRadius: 2 }} />
        </div>
      </div>
    </div>
  );
}
