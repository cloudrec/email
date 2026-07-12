'use client';

import { useEffect, useRef, useState } from 'react';
import { THEMES, DEFAULT_THEME, themeByCode } from '../theme/registry';

function readCookieTheme(): string {
  if (typeof document === 'undefined') return DEFAULT_THEME;
  return document.cookie.split('; ').find((c) => c.startsWith('theme='))?.split('=')[1] ?? DEFAULT_THEME;
}

function applyAndSave(code: string) {
  document.documentElement.setAttribute('data-theme', code);
  document.cookie = `theme=${code}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
  const token = document.cookie.split('; ').find((c) => c.startsWith('token='))?.split('=')[1];
  if (token) {
    fetch('/api/me/theme', {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ theme: code }),
    }).catch(() => {});
  }
}

export function ThemeSwitcher() {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(DEFAULT_THEME);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setActive(readCookieTheme());
    const onOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onOutside);
    return () => document.removeEventListener('mousedown', onOutside);
  }, []);

  const select = (code: string) => {
    setActive(code);
    applyAndSave(code);
    setOpen(false);
  };

  const cur = themeByCode(active);

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Switch theme"
        aria-expanded={open}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          background: 'var(--surface)', border: '1px solid var(--line)',
          color: 'var(--ink)', borderRadius: 6, padding: '5px 10px',
          fontSize: 13, cursor: 'pointer', lineHeight: 1.4,
        }}
      >
        <span style={{ display: 'flex', gap: 3 }}>
          {cur.swatches.slice(0, 2).map((c, i) => (
            <span key={i} style={{ width: 8, height: 8, borderRadius: '50%', background: c, display: 'block' }} />
          ))}
        </span>
        Theme
        <span style={{ opacity: 0.4, fontSize: 9 }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div
          style={{
            position: 'absolute', right: 0, top: 'calc(100% + 4px)',
            background: 'var(--surface)', border: '1px solid var(--line)',
            borderRadius: 8, boxShadow: '0 8px 28px rgba(0,0,0,0.22)',
            minWidth: 200, maxHeight: 380, overflowY: 'auto', zIndex: 9999,
            padding: '4px 0',
          }}
        >
          {THEMES.map((th) => (
            <button
              key={th.code}
              onClick={() => select(th.code)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                padding: '7px 12px', border: 'none', cursor: 'pointer',
                background: th.code === active ? 'var(--accent-soft, rgba(0,0,0,0.08))' : 'transparent',
                color: th.code === active ? 'var(--accent)' : 'var(--ink)',
                fontSize: 13, textAlign: 'left',
              }}
            >
              <span style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
                {th.swatches.slice(0, 3).map((c, i) => (
                  <span key={i} style={{ width: 8, height: 8, borderRadius: '50%', background: c, display: 'block' }} />
                ))}
              </span>
              <span style={{ flex: 1 }}>{th.name}</span>
              {th.code === active && <span style={{ fontSize: 11, opacity: 0.7 }}>✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
