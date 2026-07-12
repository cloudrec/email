// Pure, dependency-free reply classifier. Extracted from mailboxRuntime so it can
// be unit-tested directly (importing mailboxRuntime pulls in db/config/imap).
// mailboxRuntime re-exports these for existing callers.

export type ReplyClass =
  | 'interested' | 'not_interested' | 'do_not_contact' | 'unsubscribe' | 'wrong_person'
  | 'out_of_office' | 'bounce_like' | 'auto_reply' | 'unknown';

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
  if ((m = has('wrong person', 'no longer with', 'left the company', 'not the right', 'try contacting', 'forwarded to', 'no longer works')))
    return { classification: 'wrong_person', confidence: 0.7, reason: `matched "${m}"` };
  if ((m = has('not interested', 'no thanks', 'no thank you', 'not for us', 'we already', 'not a fit', 'please stop')))
    return { classification: 'not_interested', confidence: 0.75, reason: `matched "${m}"` };
  if ((m = has('interested', 'tell me more', 'how much', 'pricing', 'book a call', 'happy to chat', 'sounds good', 'lets talk', "let's talk", 'more info', 'call me')))
    return { classification: 'interested', confidence: 0.7, reason: `matched "${m}"` };
  return { classification: 'unknown', confidence: 0.0, reason: null };
}
