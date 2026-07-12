'use client';

import { SUPPORTED_LOCALES, Locale } from '../i18n';

export function LanguageSwitcher({ current }: { current: Locale }) {
  const set = (l: Locale) => {
    document.cookie = `locale=${l}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
    window.location.reload();
  };
  return (
    <div className="lang-switch" role="group" aria-label="Language">
      {SUPPORTED_LOCALES.map((l) => (
        <a
          key={l}
          href="#"
          className={l === current ? 'active' : ''}
          onClick={(e) => { e.preventDefault(); set(l); }}
        >
          {l.toUpperCase()}
        </a>
      ))}
    </div>
  );
}
