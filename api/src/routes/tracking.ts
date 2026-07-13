import { Router } from 'express';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { query } from '../db.js';
import { addSuppression } from '../services/suppression.js';

export const trackingRouter = Router();

const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

function sign(payload: string): string {
  return crypto.createHmac('sha256', config.jwt.secret).update(payload).digest('base64url');
}

function verify(payload: string, sig: string): boolean {
  const expected = sign(payload);
  if (expected.length !== sig.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

export function makeOpenToken(campaignId: number, contactId: number): string {
  const payload = `${campaignId}.${contactId}`;
  return `${payload}.${sign(payload)}`;
}

function parseToken(token: string): { campaignId: number; contactId: number } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [c, k, s] = parts;
  if (!verify(`${c}.${k}`, s)) return null;
  const campaignId = parseInt(c, 10);
  const contactId  = parseInt(k, 10);
  if (!Number.isFinite(campaignId) || !Number.isFinite(contactId)) return null;
  return { campaignId, contactId };
}

// Open pixel
trackingRouter.get(`${config.tracking.pixelPath}/:token`, async (req, res) => {
  const t = parseToken(req.params.token);
  if (t) {
    void recordEvent(t.campaignId, t.contactId, 'opened', { ip: req.ip, ua: req.header('user-agent') }).catch(() => {});
  }
  res.set('Content-Type', 'image/gif');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.send(PIXEL);
});

// Click redirect
trackingRouter.get(`${config.tracking.clickPath}/:token`, async (req, res) => {
  const t = parseToken(req.params.token);
  const raw = (req.query.u as string | undefined) ?? '';

  // Only redirect for a valid (signed) tracking token, and only to an absolute
  // http/https URL. This blocks the open-redirect / phishing primitive where an
  // attacker swaps ?u= on the trusted tracking domain, and rejects dangerous
  // schemes (javascript:, data:). Anything else falls back to the site root.
  let target = '/';
  if (t && raw) {
    try {
      const url = new URL(raw);
      if (url.protocol === 'http:' || url.protocol === 'https:') target = url.toString();
    } catch { /* malformed → root */ }
  }
  if (t) {
    void recordEvent(t.campaignId, t.contactId, 'clicked', { url: target, ip: req.ip, ua: req.header('user-agent') }).catch(() => {});
  }
  res.redirect(302, target);
});

// ── Manual-outreach one-click unsubscribe (Phase 22G) ────────────────────────
// For cold leads sent from manual_outreach_queue (no campaign/contact row). Token
// is HMAC over `${tenantId}.${base64url(email)}`. Suppresses the email so the drip
// never sends to it again. Public, no auth.
export function makeManualUnsubToken(tenantId: number, email: string): string {
  const payload = `${tenantId}.${Buffer.from(email.toLowerCase()).toString('base64url')}`;
  return `${payload}.${sign(payload)}`;
}
function parseManualUnsubToken(token: string): { tenantId: number; email: string } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [t, e, s] = parts;
  if (!verify(`${t}.${e}`, s)) return null;
  const tenantId = parseInt(t, 10);
  if (!Number.isFinite(tenantId)) return null;
  let email = '';
  try { email = Buffer.from(e, 'base64url').toString('utf8'); } catch { return null; }
  if (!email.includes('@')) return null;
  return { tenantId, email };
}
async function manualUnsub(token: string): Promise<boolean> {
  const t = parseManualUnsubToken(token);
  if (!t) return false;
  await addSuppression(t.tenantId, t.email, 'unsubscribe');
  try {
    await query(
      `INSERT INTO global_contact_suppression (type, normalized_value, reason) VALUES ('email', ?, 'unsubscribe')`,
      [t.email.toLowerCase()],
    );
  } catch { /* dup or table variance — suppressions table already blocks resend */ }
  try { await query("UPDATE contact_points SET status='do_not_contact' WHERE value=?", [t.email.toLowerCase()]); } catch { /* best effort */ }
  return true;
}
// GET shows a confirmation page and does NOT suppress — antivirus/link scanners
// (corporate mail security) auto-fetch every URL in an email, and a GET-suppress
// would unsubscribe recipients they never chose to. Actual opt-out happens on POST
// (the confirm button below, or an RFC 8058 List-Unsubscribe-Post one-click).
trackingRouter.get('/u/m/:token', async (req, res) => {
  const t = parseManualUnsubToken(req.params.token);
  if (!t) return res.status(400).send('Invalid unsubscribe link');
  const tok = req.params.token.replace(/[^A-Za-z0-9._-]/g, '');
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:460px;margin:12vh auto;padding:24px;color:#1f2733;text-align:center}
.b{display:inline-block;margin-top:16px;padding:11px 22px;background:#b91c1c;color:#fff;border:0;border-radius:8px;font-size:15px;cursor:pointer}</style>
<h2>Unsubscribe</h2><p>Stop receiving emails at <b>${t.email.replace(/[<>&]/g, '')}</b>?</p>
<form method="POST" action="/u/m/${tok}"><button class="b" type="submit">Unsubscribe me</button></form>
<p style="color:#94a3b8;font-size:13px;margin-top:18px">You can also just reply STOP to the email.</p>`);
});
trackingRouter.post('/u/m/:token', async (req, res) => {
  const ok = await manualUnsub(req.params.token);
  if (!ok) return res.status(400).send('Invalid unsubscribe link');
  // 200 for RFC 8058 one-click clients; the HTML body is for humans clicking the button.
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:460px;margin:12vh auto;padding:24px;text-align:center;color:#1f2733}</style><h2>✓ Unsubscribed</h2><p>You won\'t receive any more emails from us.</p>');
});

// One-click unsubscribe
trackingRouter.get(`${config.tracking.unsubPath}/:token`, async (req, res) => {
  const t = parseToken(req.params.token);
  if (!t) return res.status(400).send('Invalid unsubscribe link');

  const contact = await query(
    `SELECT c.id, c.email, c.tenant_id
     FROM contacts c JOIN campaigns ca ON ca.tenant_id = c.tenant_id
     WHERE ca.id=? AND c.id=? LIMIT 1`,
    [t.campaignId, t.contactId],
  );
  if (!contact.length) return res.status(404).send('Not found');

  await addSuppression(contact[0].tenant_id, contact[0].email, 'unsubscribe');
  await recordEvent(t.campaignId, t.contactId, 'unsubscribed', { ip: req.ip, ua: req.header('user-agent') });
  const base = `https://${config.platformDomain}`;
  res.redirect(302, `${base}/unsubscribed`);
});

trackingRouter.post(`${config.tracking.unsubPath}/:token`, async (req, res) => {
  const t = parseToken(req.params.token);
  if (!t) return res.status(400).json({ error: 'invalid_token' });
  const contact = await query(
    `SELECT c.id, c.email, c.tenant_id FROM contacts c
     JOIN campaigns ca ON ca.tenant_id = c.tenant_id
     WHERE ca.id=? AND c.id=? LIMIT 1`,
    [t.campaignId, t.contactId],
  );
  if (!contact.length) return res.status(404).json({ error: 'not_found' });
  await addSuppression(contact[0].tenant_id, contact[0].email, 'unsubscribe');
  res.json({ ok: true });
});

async function recordEvent(
  campaignId: number,
  contactId: number,
  type: 'opened' | 'clicked' | 'unsubscribed',
  detail: Record<string, any>,
) {
  const camp = await query(
    'SELECT tenant_id FROM campaigns WHERE id=? LIMIT 1',
    [campaignId],
  );
  if (!camp.length) return;
  const tenantId = camp[0].tenant_id;

  const contact = await query(
    'SELECT email FROM contacts WHERE id=? LIMIT 1',
    [contactId],
  );

  await query(
    `INSERT INTO campaign_events
       (tenant_id, campaign_id, contact_id, email, event_type, url, ip, user_agent, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tenantId, campaignId, contactId,
      contact[0]?.email ?? '',
      type,
      detail.url ?? null,
      detail.ip ?? null,
      (detail.ua ?? '').slice(0, 500),
      JSON.stringify(detail),
    ],
  );

  const counter =
    type === 'opened' ? 'opened_count' :
    type === 'clicked' ? 'clicked_count' :
    'unsubscribed_count';
  await query(`UPDATE campaigns SET ${counter} = ${counter} + 1 WHERE id=?`, [campaignId]);
}
