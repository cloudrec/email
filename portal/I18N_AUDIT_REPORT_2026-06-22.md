# Email Platform (emails.cheap) — Full i18n Hardcode Audit & Fix

Date: 2026-06-22
Scope: `/opt/email/portal` (Next.js 15 App Router portal, served :13000)
Languages: en / ru / uk

## Trigger
User reported `https://emails.cheap/onboarding?tenantId=1` had no translation.
Root cause: onboarding page (and ~20 other app pages) were `'use client'`
components with 100% hardcoded English — never wired to the i18n system.

## What was wrong
1. **Client app pages hardcoded.** 8 pages had zero i18n (onboarding, setup, stats,
   settings, sender-studio, send-control, manual-outreach, warehouse/cohorts).
   ~12 more were only partially wired and still had leftover hardcoded strings.
2. **Public `pages` block untranslated in ru/uk.** en had 354 strings for the
   marketing pages (features/how-it-works/instructions/safety/faq/system-overview);
   ru/uk had only 32 → 322 keys missing per language.
3. **Public CTA/footer blocks hardcoded** on 6 server pages.
4. **Legal pages (privacy, terms)** fully static English, no i18n at all.

## What was done
- **Infra:** added `src/lib/useT.ts` (client hook = `useLocaleClient()` + `t()`);
  hardened `src/lib/t.ts` to fall back to English when a locale key is missing
  (no more raw keys leaking to the UI).
- **20 app pages** wired to translation, every user-visible string keyed.
- **322 missing ru + 322 uk** marketing strings translated (full `pages` block).
- **6 public pages** CTA/footer blocks keyed + translated.
- **privacy + terms** converted to locale-aware server components; full legal text
  translated to ru + uk (English kept inline as fallback).

## Result
- `src/locales/{en,ru,uk}.json`: **2251 strings each, full parity, 0 missing.**
- All 35 pages compile (`docker compose build portal` clean — Next.js typecheck passed).
- Deployed; container healthy. Server-rendered RU/UK verified live
  (home, features, privacy render translated by `locale` cookie).
- Client pages localize at runtime via the `locale` cookie (`useT`).

## Intentionally NOT translated (correct)
- Language self-names in the locale picker (English / Русский / Українська).
- Brand/product names: BeautyBot, ManualPay, Instantly, Smartlead, Lemlist.
- Tech acronyms (SPF, DKIM, DMARC, DNS, SMTP, API…), API paths, code samples,
  server enum values, URLs, hidden QA markers (`*_PHASE*_VISIBLE`).

## How translation works (for future pages)
- **Client component:** `import { useT } from '@/lib/useT'; const t = useT();`
  then `t('namespace.key')`. Locale from `locale` cookie (`useLocaleClient`).
- **Server component:** `getMessages(locale)` where
  `locale = resolveLocale(cookie 'locale' ?? accept-language)`; reference `m.namespace.key`.
- Add the key to all three `src/locales/*.json` (keep parity).
- Language switch: `LanguageSwitcher` sets the `locale` cookie + reloads.
