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
  const tr = m.terms ?? {};
  return {
    title: tr.seoTitle ?? 'Terms of Service — emails.cheap',
  };
}

const FALLBACK = [
  {
    h: '1. Acceptance',
    p: 'By creating an account on emails.cheap ("Platform"), you agree to these Terms. If you do not agree, do not use the Platform.',
  },
  {
    h: '2. Permitted use',
    p: 'The Platform is for legitimate B2B outreach to businesses that may have a genuine interest in your product or service. You may use it to: collect publicly listed business leads, generate personalised outreach drafts with human approval, and send emails to opted-in contacts or niche-segmented business lists.',
  },
  {
    h: '3. Prohibited use',
    p: 'You must NOT: (a) send to purchased, harvested, leaked, or consumer email lists; (b) send spam, phishing, malware, or deceptive content; (c) impersonate other entities or falsify sender information; (d) attempt to bypass suppression, unsubscribe, or bounce handling; (e) rotate sending domains to evade spam filters; (f) use the Platform for illegal activities. Violation results in immediate account suspension.',
  },
  {
    h: '4. Anti-spam obligations',
    p: 'You must: include a valid physical address in every email; provide a one-click unsubscribe link (enforced by the Platform); honour all unsubscribe and opt-out requests immediately; maintain bounce and complaint rates below industry thresholds (2% bounce, 0.08% complaint). The Platform monitors these metrics and may automatically suspend your account if thresholds are exceeded.',
  },
  {
    h: '5. Content standards',
    p: 'Approved outreach drafts must be accurate and not misleading. Claims about your product must be truthful. The Platform may review and decline content that violates these standards.',
  },
  {
    h: '6. Account suspension',
    p: 'We may suspend or terminate your account immediately for: sending spam, exceeding abuse thresholds, violating these Terms, or activity that harms the Platform\'s IP reputation. Suspended accounts may not access their data until the matter is resolved.',
  },
  {
    h: '7. Service availability',
    p: 'We aim for 99.5% uptime but provide the Platform "as is" without warranty. We are not liable for delivery failures, email filtering by third-party providers, or data loss outside our control.',
  },
  {
    h: '8. Limitation of liability',
    p: 'Our total liability for any claim related to the Platform is limited to the fees paid in the 3 months preceding the claim. We are not liable for indirect, consequential, or incidental damages.',
  },
  {
    h: '9. Changes to terms',
    p: 'We may update these Terms. We will notify active accounts by email at least 14 days before material changes take effect. Continued use after the effective date constitutes acceptance.',
  },
  {
    h: '10. Governing law',
    p: 'These Terms are governed by applicable law. Disputes shall be resolved through good-faith negotiation first, then binding arbitration if unresolved.',
  },
  {
    h: '11. Contact',
    p: 'Legal inquiries: support@emails.cheap',
  },
];

export default async function TermsPage() {
  const locale = await detectLocale();
  const m: any = getMessages(locale);
  const tr = m.terms ?? {};
  const updated = '2026-05-28';
  const sections = tr.sections ?? FALLBACK;
  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: '60px 24px', color: 'var(--ink, #e6ebf5)' }}>
      <h1 style={{ marginBottom: 8 }}>{tr.title ?? 'Terms of Service'}</h1>
      <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 40 }}>{tr.lastUpdated ?? 'Last updated'}: {updated}</p>

      {sections.map(({ h, p }: { h: string; p: string }) => (
        <section key={h} style={{ marginBottom: 28 }}>
          <h2 style={{ fontSize: 16, marginBottom: 8 }}>{h}</h2>
          <p style={{ fontSize: 14, lineHeight: 1.75, color: 'var(--ink-2, #c1c8db)' }}>{p}</p>
        </section>
      ))}
    </div>
  );
}
