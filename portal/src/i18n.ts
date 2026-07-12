import en from './locales/en.json';
import ru from './locales/ru.json';
import uk from './locales/uk.json';

export type Locale = 'en' | 'ru' | 'uk';
export const SUPPORTED_LOCALES: Locale[] = ['en', 'ru', 'uk'];
export const DEFAULT_LOCALE: Locale = (process.env.NEXT_PUBLIC_DEFAULT_LOCALE as Locale) || 'en';

const dictionaries: Record<Locale, any> = { en, ru, uk };

export function getMessages(locale: Locale) {
  return dictionaries[locale] ?? dictionaries.en;
}

export function resolveLocale(input: string | undefined | null): Locale {
  if (!input) return DEFAULT_LOCALE;
  const short = input.slice(0, 2).toLowerCase();
  return (SUPPORTED_LOCALES as string[]).includes(short) ? (short as Locale) : DEFAULT_LOCALE;
}
