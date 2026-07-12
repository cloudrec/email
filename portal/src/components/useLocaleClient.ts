'use client';

import { useEffect, useState } from 'react';
import { Locale, DEFAULT_LOCALE, SUPPORTED_LOCALES } from '../i18n';

export function useLocaleClient(): Locale {
  const [locale, setLocale] = useState<Locale>(DEFAULT_LOCALE);
  useEffect(() => {
    const cookieVal = document.cookie.split('; ').find((c) => c.startsWith('locale='))?.split('=')[1];
    const short = (cookieVal ?? navigator.language ?? 'en').slice(0, 2).toLowerCase();
    if ((SUPPORTED_LOCALES as string[]).includes(short)) setLocale(short as Locale);
  }, []);
  return locale;
}
