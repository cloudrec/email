'use client';

import { useEffect } from 'react';
import { DEFAULT_THEME, themeByCode } from '../theme/registry';

// Reads theme/preview cookies + URL ?previewTheme= and sets <html data-theme>.
// Calls /api/me/theme on mount if user is authenticated to honor user override.
export function ThemeProvider({ ssrTheme }: { ssrTheme: string }) {
  useEffect(() => {
    // 1) URL preview takes precedence (transient)
    const url = new URL(window.location.href);
    const preview = url.searchParams.get('previewTheme');
    if (preview) {
      const t = themeByCode(preview);
      document.documentElement.setAttribute('data-theme', t.code);
      return;
    }

    // 2) User cookie (set when user picked a theme)
    const cookieTheme = document.cookie.split('; ').find((c) => c.startsWith('theme='))?.split('=')[1];
    if (cookieTheme) {
      document.documentElement.setAttribute('data-theme', themeByCode(cookieTheme).code);
    } else if (!document.documentElement.getAttribute('data-theme')) {
      document.documentElement.setAttribute('data-theme', ssrTheme || DEFAULT_THEME);
    }

    // 3) If authenticated, ask server for the persisted user preference
    const token = document.cookie.split('; ').find((c) => c.startsWith('token='))?.split('=')[1];
    if (!token) return;
    fetch('/api/me/theme', { headers: { authorization: `Bearer ${token}` } })
      .then((r) => r.ok ? r.json() : null)
      .then((j) => {
        if (!j) return;
        const resolved = j.userTheme ?? j.defaultTheme ?? DEFAULT_THEME;
        document.cookie = `theme=${resolved}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
        document.documentElement.setAttribute('data-theme', themeByCode(resolved).code);
      })
      .catch(() => {});
  }, [ssrTheme]);

  return null;
}

// Imperative client helpers used by Settings / Admin / Themes pages.
export function applyThemePreview(code: string) {
  document.documentElement.setAttribute('data-theme', themeByCode(code).code);
}

export function persistUserTheme(code: string | null): Promise<void> {
  const token = document.cookie.split('; ').find((c) => c.startsWith('token='))?.split('=')[1];
  if (!token) {
    // anonymous: cookie only
    if (code === null) {
      document.cookie = 'theme=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
    } else {
      document.cookie = `theme=${code}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
    }
    document.documentElement.setAttribute('data-theme', themeByCode(code ?? DEFAULT_THEME).code);
    return Promise.resolve();
  }
  return fetch('/api/me/theme', {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ theme: code }),
  }).then((r) => r.json()).then((j) => {
    const final = code ?? j.defaultTheme ?? DEFAULT_THEME;
    document.cookie = `theme=${final}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
    document.documentElement.setAttribute('data-theme', themeByCode(final).code);
  });
}

export function setGlobalDefaultTheme(code: string): Promise<void> {
  const token = document.cookie.split('; ').find((c) => c.startsWith('token='))?.split('=')[1];
  if (!token) return Promise.reject(new Error('not_authenticated'));
  return fetch('/api/admin/theme-default', {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ theme: code }),
  }).then((r) => { if (!r.ok) throw new Error('failed'); });
}
