import { dedicatedRedis } from './redis.js';
import { query } from './db.js';
import { logger } from './logger.js';

// Reads bounce/complaint webhook payloads from queue `webhook:bounce`.
// Postal posts these via API; API forwards to this queue.
const LASTID_KEY = 'webhook:bounce:lastid';

export async function bounceLoop() {
  const r0 = dedicatedRedis();
  // Resume from the last durably-processed id so bounces/complaints/unsubscribes
  // pushed while the worker was down are NOT lost (suppression must not gap —
  // otherwise the next campaign mails hard-bounced/complained addresses). Only a
  // never-seen-before stream starts at '$' (skip pre-feature backlog).
  const stored = await r0.get(LASTID_KEY).catch(() => null);
  let lastId = stored || '$';
  while (true) {
    try {
      const r = await r0.xread('BLOCK', 10000, 'STREAMS', 'webhook:bounce', lastId);
      if (!r) continue;
      const [, entries] = r[0];
      for (const [id, fields] of entries) {
        const obj: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];

        const tenantId = parseInt(obj.tenantId, 10);
        const email = (obj.email ?? '').toLowerCase();
        const type = obj.type as 'bounce_hard' | 'bounce_soft' | 'complaint' | 'unsubscribe';
        const campaignId = obj.campaignId ? parseInt(obj.campaignId, 10) : null;
        if (!tenantId || !email || !type) {
          // Malformed entry — consume it so we don't re-read it forever.
          lastId = id;
          await r0.set(LASTID_KEY, id).catch(() => {});
          continue;
        }

        // campaign_events.campaign_id has a NOT NULL FK to campaigns(id). Only insert
        // a per-campaign event when the webhook supplied a campaign_id. Otherwise the
        // suppression below is still applied — the audit_log row at API ingestion time
        // covers the per-event audit need.
        if (campaignId) {
          await query(
            `INSERT INTO campaign_events (tenant_id, campaign_id, email, event_type, detail)
             VALUES (?, ?, ?, ?, ?)`,
            [tenantId, campaignId, email,
             type === 'bounce_soft' ? 'bounced_soft'
               : type === 'bounce_hard' ? 'bounced_hard'
               : type === 'unsubscribe' ? 'unsubscribed'
               : 'complained',
             obj.raw ?? null],
          );
        }

        if (type === 'bounce_hard' || type === 'complaint') {
          await query(
            'INSERT IGNORE INTO suppressions (tenant_id, email, reason) VALUES (?, ?, ?)',
            [tenantId, email, type === 'complaint' ? 'complaint' : 'bounce_hard'],
          );
          await query(
            `UPDATE contacts SET status=?, ${type === 'complaint' ? 'complained_at' : 'bounced_at'}=NOW()
             WHERE tenant_id=? AND email=?`,
            [type === 'complaint' ? 'complained' : 'bounced', tenantId, email],
          );
        } else if (type === 'unsubscribe') {
          // Provider-native unsubscribe (e.g. Brevo). Suppress + mark contact.
          await query(
            'INSERT IGNORE INTO suppressions (tenant_id, email, reason) VALUES (?, ?, ?)',
            [tenantId, email, 'unsubscribe'],
          );
          await query(
            `UPDATE contacts SET status='unsubscribed', unsubscribed_at=NOW()
             WHERE tenant_id=? AND email=?`,
            [tenantId, email],
          );
        }

        if (campaignId) {
          // Suppress UPDATE failure if campaign row vanished — bounce semantics
          // shouldn't unwind the suppression already applied above.
          const col = type === 'complaint' ? 'complained_count' : 'bounced_count';
          try { await query(`UPDATE campaigns SET ${col} = ${col} + 1 WHERE id=?`, [campaignId]); } catch {}
        }

        logger.info({ tenantId, email, type }, 'bounce processed');

        // Advance the durable cursor only after the entry is fully processed, so a
        // mid-entry throw leaves the cursor put and the entry is retried (at-least-
        // once for suppression) rather than silently skipped.
        lastId = id;
        await r0.set(LASTID_KEY, id).catch(() => {});
      }
    } catch (e: any) {
      logger.error({ err: e.message }, 'bounce loop error');
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
