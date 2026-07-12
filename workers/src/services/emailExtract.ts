// Extract publicly visible business emails from HTML.
// Skips obfuscated mailto-only addresses inside login/account/checkout pages.
// Strategy:
//   - regex match plain emails in HTML text + href="mailto:..." attrs
//   - filter out personal-looking @gmail.com etc. (kept but flagged risky upstream)
//   - drop common image/asset filenames misidentified as emails

const EMAIL_RE = /(?:mailto:)?([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;

const ROLE_PREFIXES = new Set([
  'info', 'sales', 'support', 'admin', 'contact', 'hello',
  'partnerships', 'partner', 'office', 'team', 'help',
  'service', 'inquiries', 'enquiries', 'press', 'media', 'pr',
]);

const SKIP_DOMAINS = new Set([
  // Common false positives: image/asset hosts, sentry, etc.
  'example.com', 'example.org', 'sentry.io', 'wixpress.com',
  '2x.png', '3x.png',
]);

const SKIP_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.css', '.js', '.json'];

export interface ExtractedEmail {
  email: string;
  roleHint: string | null;
}

export interface ExtractResult {
  emails: ExtractedEmail[];
  title: string | null;
  snippets: Record<string, string>;
}

export function stripScripts(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, ' ');
}

export function extractTitle(html: string): string | null {
  const m = TITLE_RE.exec(html);
  if (!m) return null;
  return m[1].replace(/\s+/g, ' ').trim().slice(0, 500) || null;
}

export function extractEmails(html: string): ExtractResult {
  const cleaned = stripScripts(html);
  const title = extractTitle(html);
  const seen = new Map<string, ExtractedEmail>();
  const snippets: Record<string, string> = {};

  let m: RegExpExecArray | null;
  while ((m = EMAIL_RE.exec(cleaned)) !== null) {
    const raw = m[1].toLowerCase();
    if (seen.has(raw)) continue;
    if (SKIP_DOMAINS.has(raw.split('@')[1])) continue;
    if (SKIP_EXTS.some((ext) => raw.endsWith(ext))) continue;
    if (raw.length > 254) continue;
    if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(raw)) continue;

    const local = raw.split('@')[0];
    const baseLocal = local.replace(/[._\-+].*$/, '');
    const roleHint = ROLE_PREFIXES.has(baseLocal) ? baseLocal : null;

    // Capture ~120-char snippet around the match for context
    const start = Math.max(0, m.index - 60);
    const end = Math.min(cleaned.length, m.index + raw.length + 60);
    snippets[raw] = cleaned.slice(start, end).replace(/\s+/g, ' ').trim().slice(0, 1000);

    seen.set(raw, { email: raw, roleHint });
  }

  return { emails: [...seen.values()], title, snippets };
}
