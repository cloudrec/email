// Pure campaign-send planner (TZ §18/§21). Given a campaign and its candidate contacts,
// it produces a per-contact send decision by applying the campaignSendGate to each, while
// accounting for the mailbox's REMAINING daily capacity across the batch: once the running
// planned-send count would reach the mailbox's daily limit, every further candidate is
// blocked with daily_limit_reached. DB-free and dispatch-free so the campaign worker's
// planning is unit-testable without a database or a live sender.
import { decideCampaignSend, campaignSendKey, type CampaignSendDecision } from './campaignSendGate.js';

export interface PlannerCampaign {
  id: number;
  isAffiliate: boolean;
  lifecycleState?: string | null;
  affiliateOfferApproved?: boolean | null;
}
export interface PlannerContact { contactId: number; email: string; }
export interface PlannerMailbox { usedToday: number; dailyLimit: number; }

export interface PlannerInput {
  campaign: PlannerCampaign;
  contacts: PlannerContact[];
  step?: number;                    // default 1
  sentKeys: Iterable<string>;       // send keys already dispatched (status='sent')
  suppressedEmails: Iterable<string>; // lowercased suppressed emails
  mailbox: PlannerMailbox;
}

export interface PlannedItem {
  contactId: number;
  email: string;
  sendKey: string;
  decision: CampaignSendDecision;
}
export interface CampaignPlan {
  items: PlannedItem[];
  wouldSend: number;
  blocked: number;
}

export function planCampaign(input: PlannerInput): CampaignPlan {
  const step = input.step ?? 1;
  const sent = input.sentKeys instanceof Set ? input.sentKeys : new Set(input.sentKeys);
  const suppressed = input.suppressedEmails instanceof Set
    ? input.suppressedEmails
    : new Set([...input.suppressedEmails].map((e) => String(e).toLowerCase()));

  const items: PlannedItem[] = [];
  let plannedSoFar = 0; // sends committed by THIS batch, on top of usedToday

  for (const c of input.contacts) {
    const sendKey = campaignSendKey(input.campaign.id, c.contactId, step);
    const decision = decideCampaignSend({
      lifecycleState: input.campaign.lifecycleState,
      suppressed: suppressed.has(c.email.toLowerCase()),
      isAffiliate: input.campaign.isAffiliate,
      affiliateOfferApproved: input.campaign.affiliateOfferApproved ?? null,
      sendKey,
      alreadySentKeys: sent,
      // Effective usage includes what earlier candidates in this batch have consumed, so
      // the batch never plans past the daily limit.
      mailboxUsedToday: input.mailbox.usedToday + plannedSoFar,
      mailboxDailyLimit: input.mailbox.dailyLimit,
    });
    if (decision.send) plannedSoFar++;
    items.push({ contactId: c.contactId, email: c.email, sendKey, decision });
  }

  const wouldSend = items.filter((i) => i.decision.send).length;
  return { items, wouldSend, blocked: items.length - wouldSend };
}
