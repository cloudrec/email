// Campaign send-decision gate (TZ §18/§21). A pure, DB-free, SMTP-free decision contract
// for "should this (campaign, contact, step) message be dispatched right now?". It exists
// so the TZ §21 send-safety invariants — duplicate message is not sent (#13), a paused
// campaign is not processed (#14), and existing mailbox limits still apply unchanged (#15)
// — are automatically testable WITHOUT building or running a live sender. There is
// deliberately NO real dispatch here: enabling actual campaign sending is an owner-gated
// step. A future campaign worker would call decideCampaignSend() and only send on
// { send: true }.
//
// The blocker precedence mirrors the manual-outreach evaluateSendGate: hard safety first
// (paused, suppressed, offer-not-approved), then idempotency (already sent), then capacity
// (mailbox daily limit). Any blocker => do not send.

export type CampaignSendBlocker =
  | 'campaign_paused'
  | 'contact_suppressed'
  | 'affiliate_offer_not_approved'
  | 'duplicate_send'
  | 'daily_limit_reached';

export interface CampaignSendInput {
  lifecycleState?: string | null;   // campaigns.lifecycle_state; 'PAUSED' blocks
  suppressed: boolean;              // contact on tenant/global suppression
  // Affiliate campaigns only: the offer must be APPROVED. Pass null/undefined for
  // own-product campaigns (no offer gate).
  affiliateOfferApproved?: boolean | null;
  isAffiliate?: boolean;
  sendKey: string;                  // unique per campaign/contact/step (see campaignSendKey)
  alreadySentKeys: Iterable<string>; // send keys already dispatched (from a durable log)
  mailboxUsedToday: number;         // sent_today for the assigned mailbox
  mailboxDailyLimit: number;        // daily_send_limit for the assigned mailbox
}

export interface CampaignSendDecision {
  send: boolean;
  blockers: CampaignSendBlocker[];
}

// Deterministic unique send key. The same (campaign, contact, step) always maps to the
// same key, so a durable UNIQUE(send_key) + this function make re-processing after a
// worker restart a no-op (TZ §18 "no duplicate sends after restart", §21 #13/#16).
export function campaignSendKey(campaignId: number, contactId: number, step: number): string {
  return `c${campaignId}:u${contactId}:s${step}`;
}

export function decideCampaignSend(input: CampaignSendInput): CampaignSendDecision {
  const blockers: CampaignSendBlocker[] = [];

  // 1. Hard safety.
  if ((input.lifecycleState ?? '').toUpperCase() === 'PAUSED') blockers.push('campaign_paused');
  if (input.suppressed) blockers.push('contact_suppressed');
  if (input.isAffiliate && input.affiliateOfferApproved !== true) {
    blockers.push('affiliate_offer_not_approved');
  }

  // 2. Idempotency — never send the same (campaign, contact, step) twice.
  const sent = input.alreadySentKeys instanceof Set
    ? input.alreadySentKeys
    : new Set(input.alreadySentKeys);
  if (sent.has(input.sendKey)) blockers.push('duplicate_send');

  // 3. Capacity — the existing per-mailbox daily limit is honoured unchanged. The engine
  //    does NOT relax or override it (TZ §21 #15).
  if (input.mailboxUsedToday >= input.mailboxDailyLimit) blockers.push('daily_limit_reached');

  return { send: blockers.length === 0, blockers };
}
