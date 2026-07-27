import { describe, it, expect } from 'vitest';
import { planCampaign, type PlannerInput } from '../campaignSendPlanner.js';
import { campaignSendKey } from '../campaignSendGate.js';

function contacts(n: number) {
  return Array.from({ length: n }, (_, i) => ({ contactId: 100 + i, email: `u${i}@example.com` }));
}
function base(over: Partial<PlannerInput> = {}): PlannerInput {
  return {
    campaign: { id: 3, isAffiliate: false, lifecycleState: 'ACTIVE', affiliateOfferApproved: null },
    contacts: contacts(3),
    sentKeys: new Set<string>(),
    suppressedEmails: new Set<string>(),
    mailbox: { usedToday: 0, dailyLimit: 10 },
    ...over,
  };
}

describe('campaign send planner (TZ §18/§21)', () => {
  it('plans a send for every clean candidate', () => {
    const p = planCampaign(base());
    expect(p.wouldSend).toBe(3);
    expect(p.blocked).toBe(0);
    expect(p.items.every((i) => i.decision.send)).toBe(true);
  });

  it('respects remaining mailbox capacity across the batch (§21 #15)', () => {
    // 8 already used, limit 10 → only 2 more may send; the rest blocked.
    const p = planCampaign(base({ contacts: contacts(5), mailbox: { usedToday: 8, dailyLimit: 10 } }));
    expect(p.wouldSend).toBe(2);
    expect(p.blocked).toBe(3);
    expect(p.items.slice(2).every((i) => i.decision.blockers.includes('daily_limit_reached'))).toBe(true);
  });

  it('skips already-sent keys and does not consume capacity for them (§21 #13)', () => {
    const sent = new Set([campaignSendKey(3, 100, 1)]);
    const p = planCampaign(base({ sentKeys: sent }));
    expect(p.items[0].decision.blockers).toContain('duplicate_send');
    expect(p.wouldSend).toBe(2);
  });

  it('blocks the whole batch when the campaign is paused (§21 #14)', () => {
    const p = planCampaign(base({ campaign: { id: 3, isAffiliate: false, lifecycleState: 'PAUSED' } }));
    expect(p.wouldSend).toBe(0);
    expect(p.items.every((i) => i.decision.blockers.includes('campaign_paused'))).toBe(true);
  });

  it('blocks suppressed contacts by email (case-insensitive)', () => {
    const p = planCampaign(base({ suppressedEmails: ['U1@EXAMPLE.COM'] }));
    const u1 = p.items.find((i) => i.email === 'u1@example.com')!;
    expect(u1.decision.blockers).toContain('contact_suppressed');
    expect(p.wouldSend).toBe(2);
  });

  it('blocks an affiliate campaign whose offer is not approved', () => {
    const p = planCampaign(base({ campaign: { id: 5, isAffiliate: true, lifecycleState: 'ACTIVE', affiliateOfferApproved: false } }));
    expect(p.wouldSend).toBe(0);
    expect(p.items.every((i) => i.decision.blockers.includes('affiliate_offer_not_approved'))).toBe(true);
  });

  it('uses deterministic send keys per contact', () => {
    const p = planCampaign(base({ contacts: contacts(2) }));
    expect(p.items[0].sendKey).toBe(campaignSendKey(3, 100, 1));
    expect(p.items[1].sendKey).toBe(campaignSendKey(3, 101, 1));
  });
});
