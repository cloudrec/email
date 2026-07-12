// Single authoritative definition of per-mailbox send caps + selectability.
// Previously each path (campaignRunner, manualOutreachDrip, mailboxFleet,
// portal gate) re-derived caps with slightly different rules; this centralizes
// the *limit* + eligibility so no path can overload a mailbox beyond its
// (warmup-driven) daily_send_limit. The per-window COUNT source stays per-path
// (campaign_events / queue-ledger / counters) — this module defines the ceiling
// the count is compared against, so all paths agree on the limit.
function num(v: any, d = 0): number { const n = Number(v); return Number.isFinite(n) ? n : d; }

/** Daily limit for a mailbox (warmup scheduler keeps daily_send_limit current). */
export function dailyLimit(m: any): number { return Math.max(0, num(m.daily_send_limit, 0)); }
export function hourlyLimit(m: any): number { return Math.max(0, num(m.hourly_send_limit, 0)); }

/** Remaining sends today given an already-computed same-day sent count. */
export function dailyRemaining(m: any, sentToday: number): number {
  return Math.max(0, dailyLimit(m) - num(sentToday));
}
export function hourlyRemaining(m: any, sentThisHour: number): number {
  return Math.max(0, hourlyLimit(m) - num(sentThisHour));
}

/** True if the mailbox is over its daily cap given a same-day sent count. */
export function overDailyCap(m: any, sentToday: number): boolean {
  return num(sentToday) >= dailyLimit(m);
}
export function overHourlyCap(m: any, sentThisHour: number): boolean {
  return num(sentThisHour) >= hourlyLimit(m);
}

/** Eligibility gate shared by every send path: a mailbox may send only when it is
 *  active, outbound-enabled, and not paused/disabled. Returns a blocker string or null. */
export function mailboxBlocker(m: any): string | null {
  if (!m) return 'mailbox_missing';
  if (m.status && m.status !== 'active') return `mailbox_${m.status}`;
  if (m.outbound_enabled != null && !num(m.outbound_enabled, 1)) return 'mailbox_outbound_disabled';
  return null;
}
