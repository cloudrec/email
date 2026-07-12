import nodemailer from 'nodemailer';
import crypto from 'node:crypto';
import { config } from './config.js';
import { query } from './db.js';
import { logger } from './logger.js';

let transporter: nodemailer.Transporter | null = null;

function getTransport() {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.password! } : undefined,
    pool: true,
    maxConnections: 5,
    maxMessages: 100,
  });
  return transporter;
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', config.jwtSecret).update(payload).digest('base64url');
}

export function makeToken(campaignId: number, contactId: number): string {
  const p = `${campaignId}.${contactId}`;
  return `${p}.${sign(p)}`;
}

export interface RenderContext {
  campaignId: number;
  contactId: number;
  contactEmail: string;
  firstName?: string | null;
  lastName?: string | null;
  trackingDomain: string;
}

const URL_RE = /href="(https?:\/\/[^"]+)"/g;

export function injectTracking(html: string, ctx: RenderContext): string {
  const token = makeToken(ctx.campaignId, ctx.contactId);
  const base = `https://${ctx.trackingDomain}`;
  const open = `${base}${config.tracking.pixelPath}/${token}`;
  const unsub = `${base}${config.tracking.unsubPath}/${token}`;

  let body = html.replace(URL_RE, (_m, url) => {
    const rewritten = `${base}${config.tracking.clickPath}/${token}?u=${encodeURIComponent(url)}`;
    return `href="${rewritten}"`;
  });

  body = body.replace(/\{\{\s*unsubscribe_url\s*\}\}/gi, unsub);
  body = body.replace(/\{\{\s*first_name\s*\}\}/gi, ctx.firstName ?? '');
  body = body.replace(/\{\{\s*last_name\s*\}\}/gi, ctx.lastName ?? '');
  body = body.replace(/\{\{\s*email\s*\}\}/gi, ctx.contactEmail);

  if (!/<img[^>]+\/o\//i.test(body)) {
    body += `<img src="${open}" width="1" height="1" alt="" style="display:none" />`;
  }
  return body;
}

export interface SmtpOpts {
  host: string;
  port: number;
  user?: string;
  pass?: string;
}

export interface SendArgs {
  campaign: any;
  sender: { from_email: string; from_name: string; reply_to: string | null; dkim_selector: string; dkim_private_key: string; domain: string };
  contact: { id: number; email: string; first_name: string | null; last_name: string | null };
  trackingDomain: string;
  smtp?: SmtpOpts;
}

export async function sendOne(args: SendArgs): Promise<void> {
  const html = injectTracking(args.campaign.html_body, {
    campaignId: args.campaign.id,
    contactId: args.contact.id,
    contactEmail: args.contact.email,
    firstName: args.contact.first_name,
    lastName: args.contact.last_name,
    trackingDomain: args.trackingDomain,
  });

  const text = args.campaign.text_body || stripHtml(html);
  const unsubToken = makeToken(args.campaign.id, args.contact.id);
  const unsubUrl = `https://${args.trackingDomain}${config.tracking.unsubPath}/${unsubToken}`;

  let transport: nodemailer.Transporter;
  if (args.smtp) {
    transport = nodemailer.createTransport({
      host: args.smtp.host,
      port: args.smtp.port,
      secure: args.smtp.port === 465,
      auth: args.smtp.user ? { user: args.smtp.user, pass: args.smtp.pass! } : undefined,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    });
  } else {
    transport = getTransport();
  }

  const info = await transport.sendMail({
    from: `${args.sender.from_name} <${args.sender.from_email}>`,
    replyTo: args.sender.reply_to ?? undefined,
    to: args.contact.email,
    subject: args.campaign.subject,
    html,
    text,
    headers: {
      'List-Unsubscribe': `<${unsubUrl}>, <mailto:unsubscribe@${args.sender.domain}?subject=unsubscribe>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      'X-Campaign-Id': String(args.campaign.id),
      'X-Tenant-Id': String(args.campaign.tenant_id),
    },
    dkim: {
      domainName: args.sender.domain,
      keySelector: args.sender.dkim_selector,
      privateKey: args.sender.dkim_private_key,
    },
  });

  if (args.smtp) transport.close();

  await query(
    `INSERT INTO campaign_events (tenant_id, campaign_id, contact_id, email, event_type, detail)
     VALUES (?, ?, ?, ?, 'sent', ?)`,
    [args.campaign.tenant_id, args.campaign.id, args.contact.id, args.contact.email, JSON.stringify({ messageId: info.messageId })],
  );
  await query(
    'UPDATE campaigns SET sent_count = sent_count + 1 WHERE id=?',
    [args.campaign.id],
  );
  logger.info({ campaignId: args.campaign.id, to: args.contact.email, messageId: info.messageId }, 'sent');
}

function stripHtml(h: string): string {
  return h.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<[^>]+>/g, '')
          .replace(/\s+/g, ' ')
          .trim();
}
