import { query } from './db.js';
import { redis } from './redis.js';
import { logger } from './logger.js';

// Automatic warmup engine. Once per UTC day, per active warmup mailbox:
//  - if bounce/complaint rate breached today -> auto-PAUSE (never advance);
//  - else advance warmup_stage by 1 and set daily_send_limit to the ramp value.
// Gentle ramp: day 1=5, 2=8, 3=12, 4=18, 5=25, ... (mirror of
// api/src/services/warmup.ts WARMUP_RAMP — keep in sync).
const WARMUP_RAMP = [5, 8, 12, 18, 25, 35, 50, 70, 100, 140, 200, 280, 400, 500];
const WARMUP_MAX_DAY = WARMUP_RAMP.length;
function warmupLimitForDay(day: number): number {
  const d = Math.max(1, Math.floor(day || 1));
  return WARMUP_RAMP[Math.min(d, WARMUP_RAMP.length) - 1];
}
const GATE_BOUNCE = 0.03;      // > 3%
const GATE_COMPLAINT = 0.001;  // > 0.1%
const TICK_MS = 10 * 60_000;   // re-check every 10 min; the per-day Redis guard gates actual advances

function utcDay(): string { return new Date().toISOString().slice(0, 10); }

async function processMailbox(m: any): Promise<void> {
  // Once-per-UTC-day guard so frequent ticks advance a mailbox at most once/day.
  const guard = `warmup:day:${m.id}:${utcDay()}`;
  const first = await redis.set(guard, '1', 'EX', 26 * 3600, 'NX');
  if (!first) return;

  const sent = Number(m.sent_today) || 0;
  const bounces = Number(m.bounce_like_today) || 0;
  const complaints = Number(m.complaints_today) || 0;
  const denom = Math.max(1, sent);

  // Auto-stop: only judge once there is a meaningful same-day sample.
  if (sent >= 20) {
    const bounceRate = bounces / denom;
    const complaintRate = complaints / denom;
    if (bounceRate > GATE_BOUNCE || complaintRate > GATE_COMPLAINT) {
      const reason = bounceRate > GATE_BOUNCE
        ? `warmup_auto_pause:bounce_${(bounceRate * 100).toFixed(1)}pct`
        : `warmup_auto_pause:complaint_${(complaintRate * 100).toFixed(2)}pct`;
      await query(
        "UPDATE sender_identities SET status='paused', paused_reason=?, health_status='unhealthy' WHERE id=?",
        [reason, m.id],
      );
      logger.warn({ mailbox: m.from_email, reason }, 'warmup: auto-paused mailbox on health breach');
      return;
    }
  }

  // Healthy -> advance one warmup day and set the ramped daily limit.
  if (Number(m.warmup_stage) >= WARMUP_MAX_DAY) return; // at ceiling, hold
  const nextStage = Number(m.warmup_stage) + 1;
  const limit = warmupLimitForDay(nextStage);
  await query(
    'UPDATE sender_identities SET warmup_stage=?, daily_send_limit=? WHERE id=?',
    [nextStage, limit, m.id],
  );
  logger.info({ mailbox: m.from_email, warmupDay: nextStage, dailyLimit: limit }, 'warmup: advanced');
}

export async function warmupSchedulerLoop(): Promise<void> {
  logger.info('warmupScheduler: started (auto ramp + auto-pause)');
  while (true) {
    try {
      const mailboxes = await query(
        `SELECT id, from_email, warmup_stage, daily_send_limit, sent_today, bounce_like_today, complaints_today
           FROM sender_identities
          WHERE status='active' AND outbound_enabled=1`,
      );
      for (const m of mailboxes) {
        try { await processMailbox(m); }
        catch (e: any) { logger.error({ mailbox: m.from_email, err: e.message }, 'warmup: mailbox error'); }
      }
    } catch (e: any) {
      logger.error({ err: e.message }, 'warmupScheduler loop error');
    }
    await new Promise((r) => setTimeout(r, TICK_MS));
  }
}
