import { describe, it, expect } from 'vitest';
// Import the SHIPPING classifier (the older classifyReply.test.ts re-implements it inline).
import { classifyReply } from '../replyClassifier.js';

describe('classifyReply — welcome/automated-mail guard (never a lead)', () => {
  it('does NOT score a platform welcome email as interested', () => {
    const r = classifyReply('Welcome to your Emails.Cheap account', 'Your account is ready. Here is our pricing and more info.', 'noreply@emails.cheap');
    expect(r.classification).toBe('auto_reply');
  });

  it('treats noreply@ / notifications@ senders as automated', () => {
    expect(classifyReply('Interested in pricing', 'sounds good, call me', 'noreply@acme.com').classification).toBe('auto_reply');
    expect(classifyReply('Your invoice', 'more info inside', 'notifications@service.io').classification).toBe('auto_reply');
    expect(classifyReply('Update', 'pricing details', 'mailer-daemon@x.com').classification).toBe('auto_reply'); // automated sender, non-bounce body
    // real bounce content still classifies as bounce_like regardless of sender guard:
    expect(classifyReply('Mail delivery failed', 'address not found', 'mailer-daemon@x.com').classification).toBe('bounce_like');
  });

  it('flags WordPress / account / password mail by subject', () => {
    expect(classifyReply('Your account was created', 'welcome aboard', 'admin@site.com').classification).toBe('auto_reply');
    expect(classifyReply('Password reset request', 'click here', 'wp@site.com').classification).toBe('auto_reply');
  });

  it('STILL classifies a genuine human interested reply as a positive lead', () => {
    // Taxonomy got finer (TZ §11): a pricing question is now the more specific
    // 'request_details' rather than the generic 'interested'. Both are positive
    // human leads (escalate to a draft, never auto-send) — the guard's intent holds.
    const r = classifyReply('Re: quick question', 'This sounds good, how much is it? Call me.', 'anna@realcleaningco.co.uk');
    expect(['interested', 'request_details', 'meeting_request']).toContain(r.classification);
  });

  it('a bare STOP reply auto-classifies as unsubscribe (compliance)', () => {
    expect(classifyReply('Re: quick question', 'STOP', 'anna@co.com').classification).toBe('unsubscribe');
    expect(classifyReply('Re: outreach', 'Stop.', 'bob@x.com').classification).toBe('unsubscribe');
    expect(classifyReply(null, 'stop emailing me please', 'c@d.com').classification).toBe('do_not_contact'); // "stop emailing" is a do_not_contact phrase
    // confidence high enough to trigger auto-suppression (>= 0.9)
    expect(classifyReply(null, 'stop', 'c@d.com').confidence).toBeGreaterThanOrEqual(0.9);
    // does NOT false-positive on words containing "stop"
    expect(classifyReply('Re: hi', 'this is unstoppable, great product', 'e@f.com').classification).not.toBe('unsubscribe');
  });

  it('unsubscribe / do_not_contact still win over the automated guard', () => {
    expect(classifyReply('unsubscribe', 'remove me', 'noreply@acme.com').classification).toBe('unsubscribe');
    // explicit do_not_contact keyword wins (checked before the standalone STOP token):
    expect(classifyReply('please do not contact me', 'lose my details', 'x@y.com').classification).toBe('do_not_contact');
    // a plain STOP reply still auto-suppresses (as unsubscribe):
    expect(classifyReply('Re: hi', 'STOP', 'human@realco.com').classification).toBe('unsubscribe');
  });

  it('negative reply is not_interested, not interested', () => {
    expect(classifyReply('Re: hello', 'not interested, no thanks', 'bob@co.com').classification).toBe('not_interested');
  });
});
