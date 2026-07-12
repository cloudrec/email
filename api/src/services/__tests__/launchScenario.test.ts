import { describe, it, expect } from 'vitest';
import { contentBlockers } from '../outboundContentGuard.js';
import { classifyReply } from '../replyClassifier.js';
import { warmupLimitForDay } from '../warmup.js';
import { parseBounceContent, shouldAutoSuppressBounce } from '../bounceParser.js';

// End-to-end LAUNCH scenario over the real deterministic pipeline functions:
// draft validation -> send-gate content -> reply classification -> STOP/unsubscribe
// -> suppression -> bounce -> suppression -> warmup ramp. No mocks, no fake data.
describe('Launch scenario — deterministic pipeline', () => {
  it('1. approved draft with an opt-out line and no placeholders passes the content gate', () => {
    const subject = 'Quick question, Anna';
    const body = 'Hi Anna, I run a cleaning service in Leeds and thought it might be a fit. Worth a chat? To stop hearing from me reply STOP.';
    expect(contentBlockers(subject, body)).toEqual([]);
  });

  it('2. broken drafts are blocked before send (empty / macro / REPLACE / grammar)', () => {
    expect(contentBlockers('', 'body').length).toBeGreaterThan(0);
    expect(contentBlockers('Hi {{company}}', 'x')).toContain('unresolved_macro');
    expect(contentBlockers('s', 'Best, <<< REPLACE name >>>')).toContain('unfilled_replace_field');
    expect(contentBlockers('s', 'I can help the your business')).toContain('broken_grammar');
  });

  it('3. warmup ramp is 5, 8, 12, 18, 25 for days 1..5 and monotonic', () => {
    expect([1, 2, 3, 4, 5].map(warmupLimitForDay)).toEqual([5, 8, 12, 18, 25]);
    for (let d = 1; d < 14; d++) expect(warmupLimitForDay(d + 1)).toBeGreaterThanOrEqual(warmupLimitForDay(d));
  });

  it('4. reply classification is deterministic and correct for every scenario branch', () => {
    expect(classifyReply('Re: q', 'This sounds good, how much? call me', 'anna@realco.uk').classification).toBe('interested');
    expect(classifyReply('Re: q', 'STOP', 'anna@realco.uk').classification).toBe('unsubscribe');        // stop -> opt out
    expect(classifyReply('Welcome to your account', 'pricing inside', 'noreply@app.com').classification).toBe('auto_reply'); // welcome guard
    expect(classifyReply('Mail delivery failed', 'address not found', 'mailer-daemon@x').classification).toBe('bounce_like');
    expect(classifyReply('Out of office', 'back on Monday', 'bob@co.com').classification).toBe('out_of_office');
    expect(classifyReply('Re: q', 'not interested, no thanks', 'bob@co.com').classification).toBe('not_interested');
    expect(classifyReply(null, '', null).classification).toBe('unknown');                                  // always terminal
  });

  it('5. a STOP reply reaches suppression confidence (>= 0.9 triggers auto-suppress)', () => {
    const r = classifyReply(null, 'stop', 'x@y.com');
    expect(r.classification).toBe('unsubscribe');
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('6. a hard bounce parses the failed recipient and is flagged for auto-suppression', () => {
    const dsn = [
      'The following message to <jane@deadco.com> was undeliverable.',
      'Diagnostic-Code: smtp; 550 5.1.1 User unknown',
      'Final-Recipient: rfc822; jane@deadco.com',
      'Status: 5.1.1',
    ].join('\n');
    const parsed = parseBounceContent('Mail delivery failed', dsn);
    expect(parsed.failedRecipientEmail?.toLowerCase()).toBe('jane@deadco.com');
    expect(shouldAutoSuppressBounce(parsed)).toBe(true);
  });
});
