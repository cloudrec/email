import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Unsubscribed — Email Platform',
  robots: 'noindex',
};

export default function UnsubscribedPage() {
  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg, #0a1020)', padding: '40px 20px',
    }}>
      <div style={{
        maxWidth: 480, width: '100%', background: 'var(--surface, #10182a)',
        border: '1px solid var(--line, #1d2746)', borderRadius: 8, padding: '40px 36px',
        textAlign: 'center',
      }}>
        <div style={{ fontSize: 40, marginBottom: 16 }}>✓</div>
        <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 12, color: 'var(--ink, #e6ebf5)' }}>
          Unsubscribed
        </h1>
        <p style={{ color: 'var(--ink-3, #9099b3)', fontSize: 14, lineHeight: 1.6, marginBottom: 24 }}>
          You have been permanently removed from this mailing list.
          This is immediate and applies across all future campaigns from this sender.
        </p>
        <p style={{ color: 'var(--muted, #6c7593)', fontSize: 13, lineHeight: 1.6 }}>
          If you believe this was a mistake, contact the sender directly.
          You will not receive further emails from this campaign.
        </p>
      </div>
    </div>
  );
}
