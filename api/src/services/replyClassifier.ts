// Pure, dependency-free reply classifier. Extracted from mailboxRuntime so it can
// be unit-tested directly (importing mailboxRuntime pulls in db/config/imap).
// mailboxRuntime re-exports these for existing callers.

export type ReplyClass =
  | 'interested' | 'not_interested' | 'do_not_contact' | 'unsubscribe' | 'wrong_person'
  | 'out_of_office' | 'bounce_like' | 'auto_reply' | 'unknown'
  // Finer intent added for the TZ §11 set. Existing values above are kept verbatim so
  // stored rows, the monitor, and existing tests are unaffected.
  | 'meeting_request' | 'request_details' | 'referral' | 'complaint' | 'legal_or_privacy' | 'not_now';

// Which classes must NOT be auto-answered and how the reply pipeline must escalate them
// (TZ §11). Consumed by the reply handler; the classifier itself only labels.
export const REPLY_ESCALATION: Record<string, 'pause_campaign' | 'human_escalate' | 'draft_no_autosend'> = {
  complaint: 'pause_campaign',
  legal_or_privacy: 'human_escalate',
  interested: 'draft_no_autosend',
  meeting_request: 'draft_no_autosend',
  request_details: 'draft_no_autosend',
  unknown: 'human_escalate',
};

// From-addresses that are machine senders (never a human lead). Welcome/account/
// newsletter/system mail funnels here so it can never be scored 'interested'.
const AUTOMATED_FROM = /(?:^|[.+_-])(?:noreply|no-reply|no_reply|donotreply|do-not-reply|mailer-daemon|postmaster|notifications?|notify|automailer|mailer|bounce|bounces|newsletter|updates|welcome|account|accounts|system|wordpress|jenkins|gitlab|github)@|@(?:notifications?|mail|email|bounce|reply)\./i;
const WELCOME_SUBJECT = /welcome to |your account|account (?:created|activated|verification|verified|is ready)|verify your (?:email|account)|confirm your (?:email|subscription|account)|password (?:reset|changed)|thanks for (?:signing up|registering|joining)|your (?:login|credentials|receipt|invoice|order)|order (?:confirmation|received)|new sign-?in|subscription confirmed|newsletter/i;

/** Deterministic rule-based classification with confidence + human reason. LLM slot left for later. */
export function classifyReply(subject: string | null, snippet: string | null, fromEmail?: string | null): {
  classification: ReplyClass; confidence: number; reason: string | null;
} {
  const text = `${subject ?? ''} \n ${snippet ?? ''}`.toLowerCase();
  const has = (...ws: string[]) => ws.find((w) => text.includes(w)) ?? null;
  let m: string | null;
  if ((m = has('unsubscribe', 'opt out', 'opt-out', 'remove me', 'take me off', 'remove from your list')))
    return { classification: 'unsubscribe', confidence: 0.95, reason: `matched "${m}"` };
  if ((m = has('do not contact', "don't contact", 'do not email', 'stop emailing', 'cease', 'lose my details')))
    return { classification: 'do_not_contact', confidence: 0.95, reason: `matched "${m}"` };
  // Complaint & legal/privacy are hard signals — caught before intent scoring so a
  // "this is spam / I'll report you" is never mislabelled 'interested'. The reply
  // handler pauses the campaign on complaint and escalates legal to a human (§11).
  if ((m = has('this is spam', 'report you', 'reported as spam', 'marked as spam', 'abuse', 'unsolicited', 'how did you get my', 'stop harassing', 'i never signed up')))
    return { classification: 'complaint', confidence: 0.85, reason: `matched "${m}"` };
  if ((m = has('gdpr', 'data protection', 'right to erasure', 'ico complaint', 'legal action', 'our lawyer', 'privacy request', 'subject access request', 'ccpa')))
    return { classification: 'legal_or_privacy', confidence: 0.85, reason: `matched "${m}"` };
  if ((m = has('mail delivery', 'delivery failed', 'undeliverable', 'returned to sender', 'mailer-daemon', 'address not found', 'failure notice', 'recipient rejected')))
    return { classification: 'bounce_like', confidence: 0.9, reason: `matched "${m}"` };
  if ((m = has('out of office', 'out of the office', 'on annual leave', 'on holiday', 'maternity leave', 'currently away', 'back on')))
    return { classification: 'out_of_office', confidence: 0.85, reason: `matched "${m}"` };
  // Machine/welcome/account/newsletter mail — guard BEFORE any positive scoring so
  // a platform welcome email or noreply@ notification is never surfaced as a lead.
  if (fromEmail && AUTOMATED_FROM.test(fromEmail))
    return { classification: 'auto_reply', confidence: 0.9, reason: `automated sender ${fromEmail}` };
  if (WELCOME_SUBJECT.test(subject ?? ''))
    return { classification: 'auto_reply', confidence: 0.85, reason: 'welcome/account/system subject' };
  if ((m = has('auto-reply', 'autoreply', 'automatic reply', 'this is an automated', 'do-not-reply', 'do not reply', 'noreply')))
    return { classification: 'auto_reply', confidence: 0.8, reason: `matched "${m}"` };
  // Standalone STOP token = hard opt-out. Checked AFTER the bounce/OOO/automated/welcome
  // guards so a bounce or auto-reply that merely QUOTES our "reply STOP" instruction
  // isn't misfiled as an unsubscribe. A genuine human "STOP" reply still lands here.
  if (/\bstop\b/i.test(text))
    return { classification: 'unsubscribe', confidence: 0.95, reason: 'matched "stop"' };
  // Referral BEFORE wrong_person: "not me, speak to Jane" is a warm handoff, not a dead end.
  if ((m = has('speak to', 'reach out to', 'you should contact', 'the right person is', 'cc my colleague', 'copying in', 'pass this to', 'forward to my colleague')))
    return { classification: 'referral', confidence: 0.7, reason: `matched "${m}"` };
  if ((m = has('wrong person', 'no longer with', 'left the company', 'not the right', 'try contacting', 'forwarded to', 'no longer works')))
    return { classification: 'wrong_person', confidence: 0.7, reason: `matched "${m}"` };
  // Meeting > request-details > interested: capture the strongest intent present.
  if ((m = has('book a call', 'schedule a call', 'set up a call', 'calendly', 'jump on a call', 'meeting', 'zoom', 'available to talk', 'what time', 'my calendar')))
    return { classification: 'meeting_request', confidence: 0.75, reason: `matched "${m}"` };
  if ((m = has('how much', 'pricing', 'price', 'send me the', 'send over', 'more info', 'more details', 'can you send', 'what does it cost', 'quote')))
    return { classification: 'request_details', confidence: 0.72, reason: `matched "${m}"` };
  if ((m = has('not right now', 'not now', 'maybe later', 'reach out later', 'circle back', 'follow up in', 'next quarter', 'busy period', 'after the holidays')))
    return { classification: 'not_now', confidence: 0.7, reason: `matched "${m}"` };
  if ((m = has('not interested', 'no thanks', 'no thank you', 'not for us', 'we already', 'not a fit', 'please stop')))
    return { classification: 'not_interested', confidence: 0.75, reason: `matched "${m}"` };
  if ((m = has('interested', 'tell me more', 'book a call', 'happy to chat', 'sounds good', 'lets talk', "let's talk", 'call me')))
    return { classification: 'interested', confidence: 0.7, reason: `matched "${m}"` };
  return { classification: 'unknown', confidence: 0.0, reason: null };
}
