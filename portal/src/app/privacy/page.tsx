import type { Metadata } from 'next';
import { cookies, headers } from 'next/headers';
import { resolveLocale, getMessages, type Locale } from '../../i18n';

async function detectLocale(): Promise<Locale> {
  const c = await cookies();
  const h = await headers();
  return resolveLocale(c.get('locale')?.value ?? h.get('accept-language'));
}

export async function generateMetadata(): Promise<Metadata> {
  const locale = await detectLocale();
  const m: any = getMessages(locale);
  const pr = m.privacy ?? {};
  return {
    title: pr.seoTitle ?? 'Privacy Policy — emails.cheap',
  };
}

const FALLBACK_SECTIONS = [
  {
    h: '1. Who we are',
    p: 'emails.cheap ("Platform", "we", "us") is an email outreach platform for B2B businesses. We operate at https://emails.cheap and https://email.clients.help. This policy describes how we collect, use, and protect personal data in connection with the Platform.',
  },
  {
    h: '2. Data we collect',
    p: 'We collect: (a) Account data — email address, name, tenant/organisation name, hashed password. (b) Usage data — login timestamps, audit logs, campaign activity. (c) Lead warehouse data — publicly listed business contact information (business emails, websites, company names) sourced from OpenStreetMap, Tavily web search, and user-uploaded archives. All warehouse contacts are B2B (business email addresses of companies), not personal consumer addresses.',
  },
  {
    h: '3. How we use your data',
    p: 'Account data is used to authenticate your account and provide the Platform services. Lead warehouse data is used solely to power outreach draft generation and sending features for the account that controls it. We do not sell, share, or trade personal data with third parties for advertising purposes.',
  },
  {
    h: '4. Data retention',
    p: 'Account data is retained while your account is active and for 30 days after deletion. Lead warehouse data is retained as long as your account is active. You may request deletion at any time by contacting support@emails.cheap.',
  },
  {
    h: '5. Anti-spam commitment',
    p: 'The Platform enforces strict anti-spam controls: (a) One-click permanent unsubscribe is enforced on all outgoing emails. (b) Global suppression lists are maintained and honoured. (c) Accounts sending to purchased, leaked, or non-consenting lists are immediately suspended. (d) Sending requires SPF, DKIM, and DMARC authentication on verified domains.',
  },
  {
    h: '6. Cookies and tracking',
    p: 'The Platform uses a session cookie (token) to maintain your authenticated session. No third-party tracking, analytics, or advertising cookies are set. Email open/click tracking is implemented via signed tokens — recipients can opt out by unsubscribing.',
  },
  {
    h: '7. Your rights',
    p: 'You have the right to access, correct, or delete your personal data. You have the right to data portability and to restrict processing. To exercise these rights, contact support@emails.cheap. We respond within 30 days.',
  },
  {
    h: '8. Security',
    p: 'Passwords are hashed with Argon2id. All connections use TLS. Database credentials are isolated per-service. We conduct periodic security reviews. If a breach affects your data, we will notify you within 72 hours.',
  },
  {
    h: '9. Contact',
    p: 'Privacy inquiries: support@emails.cheap',
  },
];

export default async function PrivacyPage() {
  const locale = await detectLocale();
  const m: any = getMessages(locale);
  const pr = m.privacy ?? {};
  const updated = '2026-05-28';
  const sections = pr.sections ?? FALLBACK_SECTIONS;
  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: '60px 24px', color: 'var(--ink, #e6ebf5)' }}>
      <h1 style={{ marginBottom: 8 }}>{pr.title ?? 'Privacy Policy'}</h1>
      <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 40 }}>{pr.lastUpdated ?? 'Last updated'}: {updated}</p>

      {sections.map(({ h, p }: { h: string; p: string }) => (
        <section key={h} style={{ marginBottom: 28 }}>
          <h2 style={{ fontSize: 16, marginBottom: 8 }}>{h}</h2>
          <p style={{ fontSize: 14, lineHeight: 1.75, color: 'var(--ink-2, #c1c8db)' }}>{p}</p>
        </section>
      ))}
    </div>
  );
}
