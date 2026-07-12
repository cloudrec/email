// Phase 22C — Sender Studio engine.
// Pure, deterministic, no network: variable UX, visual-lite block rendering,
// HTML sanitisation, spam/deliverability checks, link checking, footer builder,
// and template validation/approval gating. NO sending happens here.

// ── Variable UX ──────────────────────────────────────────────────────────────
// Internally templates store {{var}}. The operator sees clear replacement
// fields: <<< REPLACE: Human label >>>. Demo data is for preview only.
export const VAR_LABELS: Record<string, string> = {
  company: 'Company name',
  service: 'Service noticed',
  website: 'Website URL',
  city: 'City',
  industry: 'Industry',
  sender_name: 'Sender name',
  sender_company: 'Sender company',
  sender_address: 'Business address',
  business_address: 'Business address',
  unsubscribe_url: 'Unsubscribe URL',
  reply_to: 'Reply-to / no-contact line',
};
export const DEMO_VARS: Record<string, string> = {
  company: 'London Easy Clean',
  service: 'office cleaning in London',
  website: 'https://londoneasyclean.example',
  city: 'London',
  industry: 'cleaning',
  sender_name: 'Andrey',
  sender_company: 'Clients.Help',
  sender_address: 'Kryvyi Rih, Ukraine',
  business_address: 'Kryvyi Rih, Ukraine',
  unsubscribe_url: 'https://emails.cheap/u/abc123',
  reply_to: 'reply "no" and I will not contact you again',
};

export const CATEGORIES = [
  'cold_first_touch', 'cold_followup', 'newsletter', 'transactional',
  'clients_help_sales', 'remote_it_ps', 'generic_service', 'internal_test',
] as const;
export type Category = typeof CATEGORIES[number];

// Categories treated as cold outreach (reply-"no" opt-out + address required).
const COLD_CATEGORIES = new Set(['cold_first_touch', 'cold_followup', 'remote_it_ps']);
// Categories that are commercial bulk marketing (unsubscribe LINK + address required).
const MARKETING_CATEGORIES = new Set(['newsletter']);
// Commercial categories that must carry a physical business address.
const COMMERCIAL_CATEGORIES = new Set([
  'cold_first_touch', 'cold_followup', 'newsletter', 'clients_help_sales', 'remote_it_ps', 'generic_service',
]);

export function toReplaceFields(s: string): string {
  return (s || '').replace(/\{\{(\w+)\}\}/g, (_, k) => `<<< REPLACE: ${VAR_LABELS[k] ?? k} >>>`);
}
export function toHumanPreview(s: string): string {
  return (s || '').replace(/\{\{(\w+)\}\}/g, (_, k) => DEMO_VARS[k] ?? `[${k}]`);
}

// ── HTML sanitisation (email-safe) ───────────────────────────────────────────
// Strips scripts, event handlers, dangerous URI schemes and remote/active
// content. Conservative allow-by-removal approach — never executes anything.
export function sanitizeHtml(input: string): string {
  if (!input) return '';
  let h = input;
  // Remove whole dangerous elements (with content).
  h = h.replace(/<\s*(script|style|iframe|object|embed|applet|form|noscript|link|meta|base)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
  // Remove self-closing / unclosed dangerous tags.
  h = h.replace(/<\s*(script|style|iframe|object|embed|applet|form|link|meta|base)\b[^>]*\/?>/gi, '');
  // Strip inline event handlers: on*="..." / on*='...' / on*=value.
  h = h.replace(/\son\w+\s*=\s*"[^"]*"/gi, '');
  h = h.replace(/\son\w+\s*=\s*'[^']*'/gi, '');
  h = h.replace(/\son\w+\s*=\s*[^\s>]+/gi, '');
  // Neutralise dangerous URI schemes in href/src.
  h = h.replace(/(href|src)\s*=\s*(["'])\s*(javascript|vbscript|data)\s*:[^"']*\2/gi, '$1="#"');
  // Strip <a ... > with javascript: even unquoted.
  h = h.replace(/(href|src)\s*=\s*(javascript|vbscript):[^\s>]*/gi, '$1="#"');
  return h.trim();
}

// ── Visual-lite block model → email-safe HTML + plain text ───────────────────
export interface Block {
  type: 'heading' | 'paragraph' | 'button' | 'divider' | 'list' | 'signature' | 'footer' | 'image';
  text?: string;
  items?: string[];
  href?: string;
  src?: string;
  alt?: string;
}

const esc = (s: string) => (s || '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

export function blocksToHtml(blocks: Block[]): string {
  const out: string[] = [];
  for (const b of blocks || []) {
    switch (b.type) {
      case 'heading':
        out.push(`<h2 style="font-family:Arial,Helvetica,sans-serif;font-size:20px;line-height:1.3;color:#111;margin:0 0 12px;">${esc(b.text ?? '')}</h2>`);
        break;
      case 'paragraph':
        out.push(`<p style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#222;margin:0 0 14px;">${esc(b.text ?? '').replace(/\n/g, '<br>')}</p>`);
        break;
      case 'button':
        out.push(`<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 16px;"><tr><td style="border-radius:6px;background:#1d4ed8;"><a href="${esc(b.href ?? '#')}" style="display:inline-block;padding:10px 20px;font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#ffffff;text-decoration:none;">${esc(b.text ?? 'Open')}</a></td></tr></table>`);
        break;
      case 'divider':
        out.push('<hr style="border:none;border-top:1px solid #e2e2e2;margin:16px 0;">');
        break;
      case 'list': {
        const items = (b.items ?? []).map((i) => `<li style="margin:0 0 6px;">${esc(i)}</li>`).join('');
        out.push(`<ul style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#222;margin:0 0 14px;padding-left:20px;">${items}</ul>`);
        break;
      }
      case 'signature':
        out.push(`<p style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#222;margin:16px 0 0;">${esc(b.text ?? '').replace(/\n/g, '<br>')}</p>`);
        break;
      case 'footer':
        out.push(`<p style="font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:#777;margin:18px 0 0;">${esc(b.text ?? '').replace(/\n/g, '<br>')}</p>`);
        break;
      case 'image':
        // Placeholder only — no upload pipeline yet. alt always emitted.
        out.push(`<img src="${esc(b.src ?? 'https://via.placeholder.com/600x200')}" alt="${esc(b.alt ?? 'image')}" style="max-width:100%;height:auto;display:block;margin:0 0 14px;">`);
        break;
    }
  }
  return out.join('\n');
}

export function blocksToPlainText(blocks: Block[]): string {
  const out: string[] = [];
  for (const b of blocks || []) {
    switch (b.type) {
      case 'heading': out.push((b.text ?? '').toUpperCase()); break;
      case 'paragraph': out.push(b.text ?? ''); break;
      case 'button': out.push(`${b.text ?? 'Open'}: ${b.href ?? ''}`); break;
      case 'divider': out.push('---'); break;
      case 'list': out.push((b.items ?? []).map((i) => `- ${i}`).join('\n')); break;
      case 'signature': out.push(b.text ?? ''); break;
      case 'footer': out.push(b.text ?? ''); break;
      case 'image': out.push(`[image: ${b.alt ?? 'image'}]`); break;
    }
  }
  return out.join('\n\n').trim();
}

// Wrap an HTML fragment in a minimal, email-client-safe document.
export function wrapEmailHtml(bodyHtml: string, preheader?: string): string {
  const ph = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>`
    : '';
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;">
${ph}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:8px;padding:28px;">
<tr><td>
${bodyHtml}
</td></tr></table>
</td></tr></table>
</body></html>`;
}

// Plain-text → simple HTML (auto fallback when operator only wrote plain text).
export function plainTextToHtml(text: string): string {
  const paras = (text || '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return paras
    .map((p) => `<p style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#222;margin:0 0 14px;">${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

// ── Footer builder ───────────────────────────────────────────────────────────
export const DEFAULT_COLD_FOOTER = `Best,
{{sender_name}}
{{sender_company}}

If this is not relevant, reply "no" and I won't contact you again.

Business address: {{business_address}}`;

export const DEFAULT_UNSUBSCRIBE_FOOTER = `If you do not want to receive emails from us, you can unsubscribe here:
{{unsubscribe_url}}

{{sender_company}} — {{business_address}}`;

export function defaultFooter(category: string): string {
  return MARKETING_CATEGORIES.has(category) ? DEFAULT_UNSUBSCRIBE_FOOTER : DEFAULT_COLD_FOOTER;
}

// ── Link extraction + checking ───────────────────────────────────────────────
const SHORTENERS = new Set([
  'bit.ly', 'tinyurl.com', 'goo.gl', 't.co', 'ow.ly', 'is.gd', 'buff.ly',
  'rebrand.ly', 'cutt.ly', 'shorturl.at', 'tiny.cc',
]);

export interface LinkFinding {
  url: string;
  issues: string[];
  ok: boolean;
}

export function extractLinks(html: string, text: string): string[] {
  const urls = new Set<string>();
  const hrefRe = /href\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(html || '')) !== null) urls.add(m[1].trim());
  const bareRe = /\bhttps?:\/\/[^\s<>"')]+/gi;
  for (const src of [html || '', text || '']) {
    let b: RegExpExecArray | null;
    while ((b = bareRe.exec(src)) !== null) urls.add(b[0].replace(/[.,;:]+$/, ''));
  }
  return Array.from(urls);
}

export function checkLinks(links: string[]): { findings: LinkFinding[]; duplicates: string[] } {
  const seen = new Map<string, number>();
  const findings: LinkFinding[] = [];
  for (const raw of links) {
    const issues: string[] = [];
    const url = raw.trim();
    // Template variables are fine (resolved at send time).
    if (/\{\{\w+\}\}/.test(url) || /<<< REPLACE/.test(url)) {
      findings.push({ url, issues: [], ok: true });
      continue;
    }
    if (url === '#' || url === '') { issues.push('broken_placeholder_url'); }
    let host = '';
    try {
      const u = new URL(url);
      host = u.hostname.toLowerCase();
      if (u.protocol === 'http:') issues.push('insecure_http');
      if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'mailto:') issues.push('unusual_scheme');
      if (SHORTENERS.has(host)) issues.push('shortened_link');
      if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) issues.push('raw_ip_host');
      if (/[?&](utm_|fbclid|gclid|trk|ref=)/i.test(url) && /[?&].*[?&]/.test(url)) issues.push('tracking_garbage');
    } catch {
      if (!/^mailto:/i.test(url)) issues.push('invalid_url_format');
    }
    seen.set(url, (seen.get(url) ?? 0) + 1);
    findings.push({ url, issues, ok: issues.length === 0 });
  }
  const duplicates = Array.from(seen.entries()).filter(([, n]) => n > 1).map(([u]) => u);
  return { findings, duplicates };
}

// ── Spam / deliverability checker ────────────────────────────────────────────
const SPAM_WORDS = [
  'free', 'guarantee', 'guaranteed', 'act now', 'limited time', 'click here',
  'buy now', 'order now', 'risk-free', 'risk free', '100%', 'cash', 'cheap',
  'winner', 'congratulations', 'urgent', 'earn money', 'make money', 'income',
  'no obligation', 'no cost', 'why pay more', 'amazing', 'incredible offer',
  'best price', 'lowest price', 'discount', 'save big', 'cash bonus',
  'double your', 'extra income', 'work from home', 'be your own boss',
  'million', 'billion', 'lottery', 'viagra', 'prize',
];
const AGGRESSIVE = ['guaranteed results', 'instantly', '10x', 'explode your', 'skyrocket', 'crush your competition'];

export type SafetyLevel = 'safe' | 'warning' | 'blocked';

export interface Issue {
  level: 'block' | 'warn';
  code: string;
  message: string;
}

export interface ValidationResult {
  status: SafetyLevel;
  canApprove: boolean;
  issues: Issue[];
  badges: string[];
  links: { findings: LinkFinding[]; duplicates: string[]; count: number };
  hasOptOut: boolean;
  hasUnsubscribe: boolean;
  hasAddress: boolean;
  category: string;
}

export interface TemplateForCheck {
  subject?: string | null;
  preheader?: string | null;
  body?: string | null;       // plain text
  html_body?: string | null;
  category?: string | null;
  editor_mode?: string | null;
}

function countMatches(text: string, words: string[]): string[] {
  const lc = text.toLowerCase();
  return words.filter((w) => lc.includes(w));
}

const OPT_OUT_RE = /unsubscribe|opt[\s-]?out|reply\s+["'“”]?\s*stop|\bstop\b|no longer wish|reply .*to stop|don'?t want to hear|reply "?no"?|won'?t (?:email|contact)/i;
const UNSUB_LINK_RE = /unsubscribe|\{\{unsubscribe_url\}\}|<<< REPLACE: Unsubscribe URL/i;
const ADDRESS_RE = /business address|\{\{business_address\}\}|\{\{sender_address\}\}|<<< REPLACE: Business address|\b\d{1,5}\s+\w+.*(street|st\.|road|rd\.|ave|avenue|lane|sq|square)\b/i;

export function validateTemplate(t: TemplateForCheck): ValidationResult {
  const subject = (t.subject ?? '').trim();
  const body = (t.body ?? '').trim();
  const html = (t.html_body ?? '').trim();
  const category = (t.category ?? 'generic_service');
  // Word/spam scan runs on VISIBLE text only — strip HTML tags + inline CSS so
  // markup like `width:100%` never trips spam-word matching. Link/img checks
  // below still use the raw `html`.
  const visibleHtml = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const combined = `${subject}\n${t.preheader ?? ''}\n${body}\n${visibleHtml}`;
  const issues: Issue[] = [];
  const badges: string[] = [];

  const block = (code: string, message: string) => issues.push({ level: 'block', code, message });
  const warn = (code: string, message: string) => issues.push({ level: 'warn', code, message });

  // Empties.
  if (!subject) block('subject_empty', 'Subject is empty.');
  if (!body && !html) block('body_empty', 'Body is empty.');

  // Subject checks.
  if (subject.length > 90) warn('subject_too_long', `Subject is ${subject.length} chars (aim < 70).`);
  if (subject && subject === subject.toUpperCase() && /[A-Z]{4,}/.test(subject)) warn('subject_all_caps', 'Subject is ALL CAPS.');
  if (/[!?]{2,}/.test(subject) || (subject.match(/!/g) || []).length >= 2) warn('subject_punctuation', 'Excessive punctuation in subject.');
  if (/^re:/i.test(subject) && (category === 'cold_first_touch')) block('misleading_re', 'Misleading "Re:" on a first-touch email.');

  // Spam words.
  const hits = countMatches(combined, SPAM_WORDS);
  if (hits.length >= 4) warn('many_spam_words', `Spammy wording: ${hits.slice(0, 6).join(', ')}.`);
  else if (hits.length >= 1) warn('some_spam_words', `Possible spam words: ${hits.join(', ')}.`);
  const aggr = countMatches(combined, AGGRESSIVE);
  if (aggr.length) warn('aggressive_claims', `Aggressive claims: ${aggr.join(', ')}.`);

  // Emojis.
  const emojis = (combined.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || []).length;
  if (emojis > 3) warn('too_many_emojis', `${emojis} emojis — reduce for cold outreach.`);

  // Punctuation overall.
  if ((combined.match(/!/g) || []).length > 3) warn('excessive_punctuation', 'Too many exclamation marks.');

  // Attachment mention.
  if (/attach(ed|ment)|see (the )?attached/i.test(combined)) warn('attachment_mention', 'Mentions an attachment — none are sent.');

  // Links.
  const links = extractLinks(html, body);
  const { findings, duplicates } = checkLinks(links);
  if (links.length > 5) warn('too_many_links', `${links.length} links — keep it low for cold outreach.`);
  if (findings.some((f) => f.issues.includes('shortened_link'))) warn('shortened_links', 'Shortened links hurt deliverability.');
  if (findings.some((f) => f.issues.includes('insecure_http'))) warn('insecure_links', 'http:// links — prefer https://.');
  if (findings.some((f) => f.issues.includes('invalid_url_format') || f.issues.includes('broken_placeholder_url'))) warn('broken_links', 'Broken or placeholder link present.');
  if (duplicates.length) warn('duplicate_links', 'Duplicate links present.');

  // Images / alt.
  const imgs = (html.match(/<img\b[^>]*>/gi) || []);
  if (imgs.some((i) => !/\balt\s*=/.test(i))) warn('image_no_alt', 'Image without alt text.');
  const bigImg = imgs.length > 3;
  if (bigImg) warn('large_images', 'Many images — heavy HTML hurts inbox placement.');

  // HTML/text balance.
  if (html && !body) block('no_plain_text', 'HTML-only email — add a plain-text fallback.');
  if (html) {
    const textLen = html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().length;
    const tagLen = html.length - textLen;
    if (textLen < 40 && tagLen > 400) warn('too_much_html', 'Too much HTML vs text.');
  }

  // Unsafe HTML (post-sanitise diff).
  if (html) {
    const cleaned = sanitizeHtml(html);
    if (/<\s*script|javascript:|\son\w+\s*=/i.test(html) && cleaned !== html) block('unsafe_html', 'Unsafe HTML/script detected.');
  }

  // Opt-out / unsubscribe / address.
  const hasOptOut = OPT_OUT_RE.test(combined);
  const hasUnsubscribe = UNSUB_LINK_RE.test(combined);
  const hasAddress = ADDRESS_RE.test(combined);

  if (COLD_CATEGORIES.has(category) && !hasOptOut) block('missing_opt_out', 'Cold outreach must include an opt-out line (reply "no").');
  if (MARKETING_CATEGORIES.has(category) && !hasUnsubscribe) block('missing_unsubscribe', 'Newsletter/marketing must include an unsubscribe link.');
  if (COMMERCIAL_CATEGORIES.has(category) && !hasAddress) block('missing_address', 'Commercial outreach must include a physical business address.');

  // Signature / from presence (warn).
  if (!/\{\{sender_name\}\}|best,|regards|thanks,|cheers/i.test(combined)) warn('no_signature', 'No signature / sender name.');

  // Classify.
  const hasBlock = issues.some((i) => i.level === 'block');
  const hasWarn = issues.some((i) => i.level === 'warn');
  const status: SafetyLevel = hasBlock ? 'blocked' : hasWarn ? 'warning' : 'safe';

  // Badges.
  if (status === 'safe') badges.push('Ready');
  if (issues.some((i) => i.code === 'missing_address')) badges.push('Needs address');
  if (issues.some((i) => i.code === 'missing_opt_out' || i.code === 'missing_unsubscribe')) badges.push('Needs opt-out');
  if (aggr.length || hits.length >= 4) badges.push('Has risky wording');
  if (links.length > 5) badges.push('Too many links');

  return {
    status, canApprove: !hasBlock, issues, badges,
    links: { findings, duplicates, count: links.length },
    hasOptOut, hasUnsubscribe, hasAddress, category,
  };
}

// Render the email (subject/preheader/body) for preview in a given data mode.
//   variable → <<< REPLACE: ... >>> fields; human → demo data.
export function renderPreview(
  t: TemplateForCheck & { blocks_json?: string | null },
  dataMode: 'variable' | 'human',
): { subject: string; preheader: string; html: string; text: string } {
  const xf = dataMode === 'human' ? toHumanPreview : toReplaceFields;
  let html = (t.html_body ?? '').trim();
  const text = (t.body ?? '').trim();
  // If no stored HTML, render from blocks or fall back to plain text.
  if (!html) {
    if (t.editor_mode === 'visual_lite' && t.blocks_json) {
      try { html = blocksToHtml(JSON.parse(t.blocks_json) as Block[]); } catch { html = plainTextToHtml(text); }
    } else {
      html = plainTextToHtml(text);
    }
  }
  html = sanitizeHtml(html);
  const wrapped = wrapEmailHtml(xf(html), xf(t.preheader ?? ''));
  return {
    subject: xf(t.subject ?? ''),
    preheader: xf(t.preheader ?? ''),
    html: wrapped,
    text: xf(text),
  };
}

export function variablesUsed(t: TemplateForCheck): { key: string; label: string }[] {
  const combined = `${t.subject ?? ''} ${t.preheader ?? ''} ${t.body ?? ''} ${t.html_body ?? ''}`;
  return Object.entries(VAR_LABELS)
    .filter(([k]) => combined.includes(`{{${k}}}`))
    .map(([k, label]) => ({ key: k, label }));
}
