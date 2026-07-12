// Warmup / reputation-protection logic. PURE functions — no fake engagement,
// no bots, no synthetic opens. This only computes SAFE rate ceilings and
// auto-pause verdicts from REAL send/bounce/complaint counts.

export const WARMUP_STEPS = [20, 50, 100, 250, 500, 1000, 2500, 5000] as const;

// Automatic warmup ramp by DAY (1-indexed). Gentle cold-start curve that only
// grows while health stays safe (the scheduler holds/pauses on breach).
// Day 1=5, 2=8, 3=12, 4=18, 5=25, then continues to a steady-state ceiling.
export const WARMUP_RAMP = [5, 8, 12, 18, 25, 35, 50, 70, 100, 140, 200, 280, 400, 500] as const;

/** Daily send limit for a given warmup day (1-indexed). Caps at the last step. */
export function warmupLimitForDay(day: number): number {
  const d = Math.max(1, Math.floor(day || 1));
  return WARMUP_RAMP[Math.min(d, WARMUP_RAMP.length) - 1];
}
export const WARMUP_MAX_DAY = WARMUP_RAMP.length;

// Compliance thresholds (industry-standard auto-pause gates).
export const GATE = {
  bounceRate: 0.03,      // > 3% bounces  -> pause
  complaintRate: 0.001,  // > 0.1% spam complaints -> pause
  unsubSpike: 0.05,      // > 5% unsubscribes in a single day -> warn/pause
};

export interface WarmupMetrics {
  dailyLimit: number;
  reputationScore: number | null; // null = no history
  sentToday: number;
  bouncesToday: number;
  complaintsToday: number;
  unsubscribesToday: number;
  hasSendingHistory: boolean;
}

export interface WarmupVerdict {
  dailyLimit: number;
  sentToday: number;
  remainingToday: number;
  bouncesToday: number;
  complaintsToday: number;
  unsubscribesToday: number;
  bounceRate: number;
  complaintRate: number;
  unsubscribeRate: number;
  recommendedNextLimit: number;
  status: 'safe' | 'caution' | 'unsafe';
  reasons: string[];
  newDomainWarning: boolean;
  autoPauseRecommended: boolean;
}

function nextStep(current: number): number {
  for (const s of WARMUP_STEPS) if (s > current) return s;
  return current; // already at/above ceiling — hold
}

export function evaluateWarmup(m: WarmupMetrics): WarmupVerdict {
  const denom = Math.max(1, m.sentToday);
  const bounceRate = m.bouncesToday / denom;
  const complaintRate = m.complaintsToday / denom;
  const unsubscribeRate = m.unsubscribesToday / denom;

  const reasons: string[] = [];
  let status: 'safe' | 'caution' | 'unsafe' = 'safe';
  let autoPause = false;

  const newDomainWarning = !m.hasSendingHistory || m.reputationScore == null;
  if (newDomainWarning) {
    status = 'caution';
    reasons.push('No sending history yet — start at the lowest volume and ramp slowly.');
  }

  // Only judge bounce/complaint rates once there is a meaningful sample today.
  if (m.sentToday >= 20) {
    if (bounceRate > GATE.bounceRate) {
      status = 'unsafe'; autoPause = true;
      reasons.push(`Bounce rate ${(bounceRate * 100).toFixed(1)}% exceeds ${(GATE.bounceRate * 100)}% — pause and clean the list.`);
    }
    if (complaintRate > GATE.complaintRate) {
      status = 'unsafe'; autoPause = true;
      reasons.push(`Complaint rate ${(complaintRate * 100).toFixed(2)}% exceeds ${(GATE.complaintRate * 100)}% — pause immediately.`);
    }
    if (unsubscribeRate > GATE.unsubSpike) {
      if (status !== 'unsafe') status = 'caution';
      reasons.push(`Unsubscribe spike ${(unsubscribeRate * 100).toFixed(1)}% — review targeting/content.`);
    }
  }

  // Recommend the next step ONLY when healthy and the day's volume actually
  // approached the current limit (don't ramp on an idle day). Ramp is a
  // recommendation; raising the real limit always requires admin confirmation.
  let recommendedNextLimit = m.dailyLimit;
  if (status === 'safe' && m.sentToday >= Math.floor(m.dailyLimit * 0.8)) {
    recommendedNextLimit = nextStep(m.dailyLimit);
  }

  return {
    dailyLimit: m.dailyLimit,
    sentToday: m.sentToday,
    remainingToday: Math.max(0, m.dailyLimit - m.sentToday),
    bouncesToday: m.bouncesToday,
    complaintsToday: m.complaintsToday,
    unsubscribesToday: m.unsubscribesToday,
    bounceRate,
    complaintRate,
    unsubscribeRate,
    recommendedNextLimit,
    status,
    reasons: reasons.length ? reasons : ['All metrics within safe thresholds.'],
    newDomainWarning,
    autoPauseRecommended: autoPause,
  };
}
