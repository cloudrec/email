import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { query } from '../db.js';
import { privacyHash } from '../services/inviteToken.js';
import { config } from '../config.js';

export const publicInviteRouter = Router();

// Rate limit /i/:token. Defense against abuse + click-flooding.
const clickLimiter = rateLimit({
  windowMs: 60_000,
  max: 240,                    // 4 req/s per IP per minute (global guardrail)
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

function safeInactivePage(reason: string, locale = 'en') {
  const titles: Record<string, string> = {
    en: 'Link no longer active', ru: 'Ссылка больше не активна', uk: 'Посилання більше не активне',
  };
  const messages: Record<string, string> = {
    en: 'This invite link is no longer active. If you reached it by mistake, you can safely close this page.',
    ru: 'Эта пригласительная ссылка больше не активна. Если вы открыли её по ошибке — можете спокойно закрыть страницу.',
    uk: 'Це запрошувальне посилання більше не активне. Якщо ви відкрили його помилково — можете спокійно закрити сторінку.',
  };
  const t = titles[locale] ?? titles.en;
  const m = messages[locale] ?? messages.en;
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"/><title>${t}</title>
<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:80px auto;padding:0 16px;color:#1c2230;}
h1{font-size:22px;}p{line-height:1.5;color:#4a556b;}</style></head>
<body><h1>${t}</h1><p>${m}</p>
<p style="font-size:12px;color:#6b7591;margin-top:32px;">reason: ${reason}</p></body></html>`;
}

function personalLandingPage(args: { productName: string; productUrl: string | null; locale: string; honest: string }) {
  const { productName, productUrl, locale, honest } = args;
  const learnMore: Record<string, string> = { en: 'Learn more', ru: 'Узнать больше', uk: 'Дізнатися більше' };
  const button = productUrl
    ? `<p style="margin-top:24px;"><a href="${productUrl}" rel="noopener noreferrer" style="background:#2154e0;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;">${learnMore[locale] ?? learnMore.en}</a></p>`
    : '';
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"/><title>${productName}</title>
<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:80px auto;padding:0 16px;color:#1c2230;}
h1{font-size:24px;}p{line-height:1.55;color:#4a556b;}</style></head>
<body><h1>${productName}</h1><p>${honest}</p>${button}</body></html>`;
}

publicInviteRouter.get('/i/:token', clickLimiter, async (req, res) => {
  const token = req.params.token;
  const locale = (req.acceptsLanguages(['en', 'ru', 'uk']) || 'en') as 'en' | 'ru' | 'uk';

  const rows = await query(
    `SELECT il.*, t.status AS tenant_status,
            COALESCE(s.invite_links_enabled, 1) AS tenant_invite_enabled,
            COALESCE(s.outreach_paused, 0) AS outreach_paused,
            pp.name AS product_name, pp.product_url AS product_url
     FROM invite_links il
     JOIN tenants t ON t.id = il.tenant_id
     LEFT JOIN tenant_safety_settings s ON s.tenant_id = il.tenant_id
     LEFT JOIN outreach_drafts d ON d.id = il.outreach_draft_id
     LEFT JOIN tenant_product_profiles pp ON pp.id = d.product_profile_id
     WHERE il.token = ? LIMIT 1`,
    [token],
  );
  if (!rows.length) {
    res.status(404).type('text/html').send(safeInactivePage('not_found', locale));
    return;
  }
  const il = rows[0];

  // Determine effective status. We never silently redirect when a kill-switch is on.
  let effective: 'active' | 'inactive' = 'active';
  let inactiveReason: string | null = null;

  if (il.status !== 'active') { effective = 'inactive'; inactiveReason = il.status; }
  if (!il.tenant_invite_enabled) { effective = 'inactive'; inactiveReason = 'invite_links_disabled'; }
  if (il.outreach_paused) { effective = 'inactive'; inactiveReason = 'tenant_outreach_paused'; }
  if (il.tenant_status === 'suspended' || il.tenant_status === 'payment_pending' || il.tenant_status === 'canceled') {
    effective = 'inactive'; inactiveReason = `tenant_${il.tenant_status}`;
  }
  if (il.expires_at && new Date(il.expires_at).getTime() < Date.now()) {
    effective = 'inactive'; inactiveReason = 'expired';
    // Persist the new status so admin views match reality.
    await query("UPDATE invite_links SET status='expired' WHERE id=? AND status NOT IN ('disabled','suppressed','unsubscribed')", [il.id]);
  }

  // Live suppression / unsubscribed lookup (covers cases where contact got suppressed AFTER link create).
  if (effective === 'active' && il.contact_id) {
    const c = (await query('SELECT email, status FROM contacts WHERE id=?', [il.contact_id]))[0];
    if (c) {
      const sup = await query('SELECT 1 FROM suppressions WHERE tenant_id=? AND email=? LIMIT 1', [il.tenant_id, c.email]);
      if (sup.length) {
        effective = 'inactive'; inactiveReason = 'suppressed';
        await query("UPDATE invite_links SET status='suppressed' WHERE id=? AND status='active'", [il.id]);
      } else if (c.status === 'unsubscribed') {
        effective = 'inactive'; inactiveReason = 'unsubscribed';
        await query("UPDATE invite_links SET status='unsubscribed' WHERE id=? AND status='active'", [il.id]);
      }
    }
  }

  // Log the click — even if inactive. The operator wants visibility on suppressed-link probes too.
  try {
    const ipHash = req.ip ? privacyHash(req.ip, config.jwt.secret) : null;
    const uaHash = req.header('user-agent') ? privacyHash(req.header('user-agent') as string, config.jwt.secret) : null;
    const country = (req.header('cf-ipcountry') ?? '').slice(0, 2) || null;
    await query(
      `INSERT INTO invite_link_clicks (tenant_id, invite_link_id, ip_hash, user_agent_hash, country, referrer, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [il.tenant_id, il.id, ipHash, uaHash, country, (req.header('referer') ?? '').slice(0, 500) || null,
       JSON.stringify({ effective, inactive_reason: inactiveReason })],
    );
    if (effective === 'active') {
      await query(
        'UPDATE invite_links SET click_count = click_count + 1, last_clicked_at = NOW() WHERE id=?',
        [il.id],
      );
    }
  } catch {
    // never block the response on a logging failure
  }

  if (effective === 'inactive') {
    res.status(410).type('text/html').send(safeInactivePage(inactiveReason ?? 'inactive', locale));
    return;
  }

  if (il.landing_mode === 'redirect') {
    // Safety: only allow http(s) destinations. Normalized at create-time, double-check here.
    if (!/^https?:\/\//i.test(il.destination_url)) {
      res.status(410).type('text/html').send(safeInactivePage('invalid_destination', locale));
      return;
    }
    res.redirect(302, il.destination_url);
    return;
  }

  // personal_page mode
  const honest: Record<string, string> = {
    en: 'You may have been invited to take a look. No prior relationship is implied. If this is not relevant, you can close this page.',
    ru: 'Возможно, вам предложили взглянуть на этот сайт. Никаких предшествующих отношений не подразумевается. Если это не актуально — можете закрыть страницу.',
    uk: 'Можливо, вам запропонували поглянути на цей сайт. Жодних попередніх стосунків не мається на увазі. Якщо це не актуально — можете закрити сторінку.',
  };
  res.type('text/html').send(personalLandingPage({
    productName: il.product_name ?? 'Invite',
    productUrl: il.product_url ?? il.destination_url,
    locale,
    honest: honest[locale] ?? honest.en,
  }));
});
