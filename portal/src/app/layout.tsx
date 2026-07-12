import { cookies, headers } from 'next/headers';
import { resolveLocale } from '../i18n';
import { AutoShell } from '../components/AutoShell';
import { ThemeProvider } from '../components/ThemeProvider';
import { DEFAULT_THEME, allThemesCss, themeByCode } from '../theme/registry';
import './globals.css';

export const metadata = {
  title: 'Email Platform — operator console',
  description: 'Lead collection, website analysis, and reviewed outreach drafts. No sending without approval.',
};

const THEMES_CSS = allThemesCss();

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const c = await cookies();
  const h = await headers();
  const locale = resolveLocale(c.get('locale')?.value ?? h.get('accept-language'));

  // SSR theme resolution:
  //   - cookie 'theme' if present (set by ThemeProvider after user choice or after login)
  //   - else DEFAULT_THEME (the registry baseline; admin overrides at /admin/theme persist in DB,
  //     but for the very first uncached page paint we don't block on a DB read)
  const cookieTheme = c.get('theme')?.value;
  const ssrTheme = cookieTheme ? themeByCode(cookieTheme).code : DEFAULT_THEME;

  return (
    <html lang={locale} data-theme={ssrTheme}>
      <head>
        {/* All theme palettes baked into one stylesheet. Switching = changing data-theme. */}
        <style id="email-platform-themes" dangerouslySetInnerHTML={{ __html: THEMES_CSS }} />
        <meta name="x-deploy-check" content="DEPLOY_CHECK_2026_05_26_THEME_VISIBLE" />
      </head>
      <body>
        <ThemeProvider ssrTheme={ssrTheme} />
        <AutoShell>{children}</AutoShell>
      </body>
    </html>
  );
}
