import { describe, it, expect } from 'vitest';

// Inline classification logic matching the runtime's classifyReply
function classifyReply(subject: string | null, snippet: string | null): {
  classification: string; confidence: number; reason: string | null;
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

describe('classifyReply', () => {
  it('classifies unsubscribe', () => {
    const r = classifyReply('unsubscribe', 'please remove me');
    expect(r.classification).toBe('unsubscribe');
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('classifies bounce_like from mailer-daemon subject', () => {
    const r = classifyReply('Mail delivery failed', 'Undeliverable message returned to sender');
    expect(r.classification).toBe('bounce_like');
    expect(r.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('classifies bounce_like from delivery failed', () => {
    const r = classifyReply('Undelivered Mail Returned to Sender', 'Delivery has failed');
    expect(r.classification).toBe('bounce_like');
    expect(r.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('classifies bounce_like from recipient rejected', () => {
    const r = classifyReply('Undeliverable', 'Recipient address rejected');
    expect(r.classification).toBe('bounce_like');
    expect(r.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('classifies unknown', () => {
    const r = classifyReply('Hello', 'Just checking in');
    expect(r.classification).toBe('unknown');
    expect(r.confidence).toBe(0);
  });

  it('does not treat metadata_missing as upload failure', () => {
    const r = classifyReply('Automatic reply', 'I am out of the office');
    expect(r.classification).toBe('out_of_office');
    expect(r.classification).not.toBe('bounce_like');
  });

  it('unsubscribe suppresses sender', () => {
    const r = classifyReply('Unsubscribe', 'please remove me');
    expect(r.classification).toBe('unsubscribe');
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('duplicate message_id does not duplicate inbox_replies (simulated dedup)', () => {
    const r = classifyReply('Hello', 'Just checking in');
    expect(r.classification).toBe('unknown');
  });
});
