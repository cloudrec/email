import { Locale, getMessages } from '../i18n';

function lookup(dict: any, parts: string[]): string | undefined {
  let cur: any = dict;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in cur) cur = cur[p];
    else return undefined;
  }
  return typeof cur === 'string' ? cur : undefined;
}

export function t(locale: Locale, key: string): string {
  const parts = key.split('.');
  // Try requested locale, then fall back to English, then the raw key.
  return lookup(getMessages(locale), parts) ?? lookup(getMessages('en'), parts) ?? key;
}
