import { describe, it, expect } from 'vitest';
import { classifyReply, REPLY_ESCALATION } from '../replyClassifier.js';

describe('reply classifier — TZ §11 finer classes', () => {
  it('flags a complaint (→ pause campaign)', () => {
    const r = classifyReply('Re: audit', 'this is spam, stop harassing me', 'a@b.com');
    expect(r.classification).toBe('complaint');
    expect(REPLY_ESCALATION.complaint).toBe('pause_campaign');
  });

  it('flags a legal/privacy request (→ human escalate)', () => {
    const r = classifyReply('GDPR', 'I invoke my right to erasure under GDPR', 'a@b.com');
    expect(r.classification).toBe('legal_or_privacy');
    expect(REPLY_ESCALATION.legal_or_privacy).toBe('human_escalate');
  });

  it('detects a meeting request', () => {
    const r = classifyReply('Re: your email', "happy to book a call, here's my calendly", 'a@b.com');
    expect(r.classification).toBe('meeting_request');
  });

  it('detects a request for details/pricing', () => {
    const r = classifyReply('Re', 'how much is it? can you send more details', 'a@b.com');
    expect(r.classification).toBe('request_details');
  });

  it('detects a referral to a colleague', () => {
    const r = classifyReply('Re', 'not me — please reach out to Jane in marketing', 'a@b.com');
    expect(r.classification).toBe('referral');
  });

  it('detects not-now', () => {
    const r = classifyReply('Re', 'not right now, maybe circle back next quarter', 'a@b.com');
    expect(r.classification).toBe('not_now');
  });

  it('positive interest still escalates to a draft, never auto-send', () => {
    const r = classifyReply('Re', "sounds good, let's talk", 'a@b.com');
    expect(r.classification).toBe('interested');
    expect(REPLY_ESCALATION.interested).toBe('draft_no_autosend');
  });

  it('complaint beats intent — spam wording never scored interested', () => {
    const r = classifyReply('Re', 'this is spam but tell me more', 'a@b.com');
    expect(r.classification).toBe('complaint');
  });
});
