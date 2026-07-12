'use client';

import { useLocaleClient } from '../components/useLocaleClient';
import { t as translate } from './t';

/**
 * Client-side translation hook. Reads the active locale from the `locale`
 * cookie (via useLocaleClient) and returns a `t(key)` function.
 *
 *   const t = useT();
 *   <h1>{t('onboarding.title')}</h1>
 */
export function useT(): (key: string) => string {
  const locale = useLocaleClient();
  return (key: string) => translate(locale, key);
}
