import { describe, it, expect } from 'vitest';
import { evaluateMessageQuality, type MessageQualityContext } from '../messageQualityGate.js';

// A clean, compliant baseline message. Each test perturbs one field.
function base(overrides: Partial<MessageQualityContext> = {}): MessageQualityContext {
  return {
    subject: 'A quick idea for your booking flow',
    body:
      'Hi Sam,\n\nI looked at your site and noticed the contact form 404s on mobile. ' +
      'We help small studios fix that. Worth a quick look?\n\n' +
      'Regards,\nAndrii\n\nReply "stop" and I will not contact you again.',
    isReply: false,
    requireSenderIdentity: true,
    senderName: 'Andrii',
    requireOptOut: true,
    ...overrides,
  };
}

describe('message quality gate (TZ §9)', () => {
  it('passes a clean compliant message', () => {
    const r = evaluateMessageQuality(base());
    expect(r.passed).toBe(true);
    expect(r.blockers).toEqual([]);
    expect(r.reviewFlags).toEqual([]);
  });

  it('blocks guaranteed income claims', () => {
    const r = evaluateMessageQuality(base({ body: base().body + ' Guaranteed income for you.' }));
    expect(r.passed).toBe(false);
    expect(r.blockers).toContain('guaranteed_income_claim');
  });

  it('blocks "make $500 per day"', () => {
    const r = evaluateMessageQuality(base({ body: base().body + ' You can make $500 per day.' }));
    expect(r.blockers).toContain('guaranteed_income_claim');
  });

  it('blocks false urgency', () => {
    const r = evaluateMessageQuality(base({ subject: 'Act now — limited time' }));
    expect(r.blockers).toContain('false_urgency');
  });

  it('blocks fabricated case studies', () => {
    const r = evaluateMessageQuality(base({ body: base().body + ' One of our clients saw 300% growth.' }));
    expect(r.blockers).toContain('fabricated_case_study');
  });

  it('blocks a misleading RE: subject on a first-touch email', () => {
    const r = evaluateMessageQuality(base({ subject: 'RE: our conversation' }));
    expect(r.blockers).toContain('misleading_subject');
    expect(r.checks.subject_ok).toBe(false);
  });

  it('allows RE: when it is a genuine reply', () => {
    const r = evaluateMessageQuality(base({ subject: 'RE: our conversation', isReply: true }));
    expect(r.blockers).not.toContain('misleading_subject');
  });

  it('blocks a message with no sender identity', () => {
    const r = evaluateMessageQuality(base({ body: 'Hi — buy our thing. Reply stop to opt out.', senderName: 'Andrii' }));
    expect(r.blockers).toContain('missing_sender_identity');
  });

  it('accepts a signature block when no explicit senderName is given', () => {
    const r = evaluateMessageQuality(base({ senderName: null }));
    expect(r.blockers).not.toContain('missing_sender_identity');
    expect(r.checks.sender_identity).toBe(true);
  });

  it('blocks a message with no opt-out when required', () => {
    const r = evaluateMessageQuality(base({ body: 'Hi Sam, nice site.\n\nRegards,\nAndrii' }));
    expect(r.blockers).toContain('missing_opt_out');
  });

  it('does not require opt-out when requireOptOut is false', () => {
    const r = evaluateMessageQuality(base({ body: 'Hi Sam, nice site.\n\nRegards,\nAndrii', requireOptOut: false }));
    expect(r.blockers).not.toContain('missing_opt_out');
    expect(r.checks.opt_out).toBe(true);
  });

  it('blocks hidden affiliate nature when affiliate and no disclosure', () => {
    const r = evaluateMessageQuality(base({ isAffiliate: true, disclosurePresent: false }));
    expect(r.blockers).toContain('hidden_affiliate_nature');
    expect(r.checks.affiliate_disclosed).toBe(false);
  });

  it('allows affiliate when disclosure is present', () => {
    const r = evaluateMessageQuality(base({ isAffiliate: true, disclosurePresent: true }));
    expect(r.blockers).not.toContain('hidden_affiliate_nature');
    expect(r.checks.affiliate_disclosed).toBe(true);
  });

  it('allows affiliate when the body carries an ad marker', () => {
    const r = evaluateMessageQuality(
      base({ isAffiliate: true, body: base().body + '\n\nThis is an advertisement.' }),
    );
    expect(r.blockers).not.toContain('hidden_affiliate_nature');
  });

  it('sets affiliate_disclosed null for non-affiliate messages', () => {
    const r = evaluateMessageQuality(base());
    expect(r.checks.affiliate_disclosed).toBeNull();
  });

  it('flags manipulative language for review without hard-blocking', () => {
    const r = evaluateMessageQuality(base({ body: base().body + " You'd be crazy not to reply." }));
    expect(r.reviewFlags).toContain('manipulative_language');
    expect(r.passed).toBe(true);
  });

  it('flags fake familiarity for review', () => {
    const r = evaluateMessageQuality(base({ body: base().body + ' As we discussed on our call...' }));
    expect(r.reviewFlags).toContain('fake_familiarity');
  });

  it('flags unverified savings claims for review', () => {
    const r = evaluateMessageQuality(base({ body: base().body + ' Save $2,000 a year.' }));
    expect(r.reviewFlags).toContain('unverified_savings_claim');
  });

  it('accumulates multiple blockers', () => {
    const r = evaluateMessageQuality({
      subject: 'RE: act now',
      body: 'Guaranteed income. One of our clients saw 500% growth.',
      requireSenderIdentity: true,
      senderName: 'Andrii',
      requireOptOut: true,
    });
    expect(r.passed).toBe(false);
    expect(r.blockers).toEqual(
      expect.arrayContaining([
        'guaranteed_income_claim',
        'false_urgency',
        'fabricated_case_study',
        'misleading_subject',
        'missing_sender_identity',
        'missing_opt_out',
      ]),
    );
  });
});
