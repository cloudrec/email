import { describe, it, expect } from 'vitest';
import { decideCampaignSend, campaignSendKey, type CampaignSendInput } from '../campaignSendGate.js';

// A baseline that WOULD send; each test perturbs one dimension.
function ok(overrides: Partial<CampaignSendInput> = {}): CampaignSendInput {
  return {
    lifecycleState: 'ACTIVE',
    suppressed: false,
    isAffiliate: false,
    sendKey: campaignSendKey(3, 100, 1),
    alreadySentKeys: new Set<string>(),
    mailboxUsedToday: 2,
    mailboxDailyLimit: 10,
    ...overrides,
  };
}

describe('campaign send gate (TZ §21 send-safety)', () => {
  it('sends when nothing blocks', () => {
    const d = decideCampaignSend(ok());
    expect(d.send).toBe(true);
    expect(d.blockers).toEqual([]);
  });

  // §21 #13 — duplicate message is not sent.
  it('blocks a duplicate send (same send key already dispatched)', () => {
    const key = campaignSendKey(3, 100, 1);
    const d = decideCampaignSend(ok({ sendKey: key, alreadySentKeys: new Set([key]) }));
    expect(d.send).toBe(false);
    expect(d.blockers).toContain('duplicate_send');
  });

  it('a different step for the same contact is not a duplicate', () => {
    const sent = new Set([campaignSendKey(3, 100, 1)]);
    const d = decideCampaignSend(ok({ sendKey: campaignSendKey(3, 100, 2), alreadySentKeys: sent }));
    expect(d.send).toBe(true);
  });

  it('send keys are deterministic and unique per campaign/contact/step', () => {
    expect(campaignSendKey(3, 100, 1)).toBe(campaignSendKey(3, 100, 1));
    expect(campaignSendKey(3, 100, 1)).not.toBe(campaignSendKey(3, 100, 2));
    expect(campaignSendKey(3, 100, 1)).not.toBe(campaignSendKey(4, 100, 1));
  });

  // §21 #14 — a paused campaign is not processed.
  it('blocks when the campaign is paused', () => {
    const d = decideCampaignSend(ok({ lifecycleState: 'PAUSED' }));
    expect(d.send).toBe(false);
    expect(d.blockers).toContain('campaign_paused');
  });

  it('pause check is case-insensitive', () => {
    expect(decideCampaignSend(ok({ lifecycleState: 'paused' })).blockers).toContain('campaign_paused');
  });

  // §21 #15 — existing mailbox limits remain unchanged (engine does not relax them).
  it('blocks when the mailbox daily limit is reached', () => {
    const d = decideCampaignSend(ok({ mailboxUsedToday: 10, mailboxDailyLimit: 10 }));
    expect(d.send).toBe(false);
    expect(d.blockers).toContain('daily_limit_reached');
  });

  it('sends at one below the limit, blocks exactly at the limit', () => {
    expect(decideCampaignSend(ok({ mailboxUsedToday: 9, mailboxDailyLimit: 10 })).send).toBe(true);
    expect(decideCampaignSend(ok({ mailboxUsedToday: 10, mailboxDailyLimit: 10 })).send).toBe(false);
  });

  it('blocks a suppressed contact', () => {
    expect(decideCampaignSend(ok({ suppressed: true })).blockers).toContain('contact_suppressed');
  });

  it('blocks an affiliate campaign whose offer is not approved', () => {
    const d = decideCampaignSend(ok({ isAffiliate: true, affiliateOfferApproved: false }));
    expect(d.blockers).toContain('affiliate_offer_not_approved');
  });

  it('allows an affiliate campaign with an approved offer', () => {
    const d = decideCampaignSend(ok({ isAffiliate: true, affiliateOfferApproved: true }));
    expect(d.send).toBe(true);
  });

  it('own-product campaigns ignore the offer gate', () => {
    const d = decideCampaignSend(ok({ isAffiliate: false, affiliateOfferApproved: null }));
    expect(d.send).toBe(true);
  });

  it('accumulates multiple blockers', () => {
    const key = campaignSendKey(3, 100, 1);
    const d = decideCampaignSend(ok({
      lifecycleState: 'PAUSED', suppressed: true, sendKey: key,
      alreadySentKeys: new Set([key]), mailboxUsedToday: 20, mailboxDailyLimit: 10,
    }));
    expect(d.send).toBe(false);
    expect(d.blockers).toEqual(
      expect.arrayContaining(['campaign_paused', 'contact_suppressed', 'duplicate_send', 'daily_limit_reached']),
    );
  });
});
