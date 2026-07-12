import { describe, it, expect } from 'vitest';
import { parseBounceContent, isBounceSender, isMailerDaemon, shouldAutoSuppressBounce } from '../bounceParser.js';

describe('parseBounceContent', () => {
  // ── RFC 3464 DSN Status Codes ────────────────────────────────────────────

  it('parses 5.1.1 invalid_mailbox (Gmail style)', () => {
    const body = `Final-Recipient: RFC822; bad@example.com
Status: 5.1.1
Diagnostic-Code: SMTP; 550-5.1.1 The email account does not exist.`;
    const r = parseBounceContent('Delivery Status Notification (Failure)', body);
    expect(r.failedRecipientEmail).toBe('bad@example.com');
    expect(r.bounceCategory).toBe('invalid_mailbox');
    expect(r.confidence).toBe(1);
  });

  it('parses 5.1.1 with Postfix style', () => {
    const body = `Final-Recipient: RFC822; unknown@remote.org
Status: 5.1.1
Diagnostic-Code: smtp; 550 5.1.1 <unknown@remote.org>: Recipient address rejected: User unknown`;
    const r = parseBounceContent('Undelivered Mail Returned to Sender', body);
    expect(r.failedRecipientEmail).toBe('unknown@remote.org');
    expect(r.bounceCategory).toBe('invalid_mailbox');
    expect(r.confidence).toBe(1);
  });

  it('parses 5.1.10 via prefix fallback (Exchange)', () => {
    const body = `Final-Recipient: RFC822; volvoparts@parkplace.com
Status: 5.1.10
Diagnostic-Code: smtp; 550 5.1.10 RESOLVER.ADR.RecipientNotFound`;
    const r = parseBounceContent('Undeliverable: test', body);
    expect(r.failedRecipientEmail).toBe('volvoparts@parkplace.com');
    expect(r.bounceCategory).toBe('invalid_mailbox');
    expect(r.confidence).toBe(0.85); // prefix fallback
  });

  it('parses 5.1.2 domain_not_found', () => {
    const body = `Final-Recipient: RFC822; user@nonexistentdomain.xyz
Status: 5.1.2
Diagnostic-Code: smtp; 550 5.1.2 <user@nonexistentdomain.xyz>: Domain not found`;
    const r = parseBounceContent('Mail delivery failed', body);
    expect(r.failedRecipientEmail).toBe('user@nonexistentdomain.xyz');
    expect(r.bounceCategory).toBe('domain_not_found');
    expect(r.confidence).toBe(0.95);
  });

  it('parses 5.2.2 mailbox_full', () => {
    const body = `Final-Recipient: RFC822; full@example.com
Status: 5.2.2
Diagnostic-Code: smtp; 552 5.2.2 Mailbox full`;
    const r = parseBounceContent('Mail delivery failed', body);
    expect(r.failedRecipientEmail).toBe('full@example.com');
    expect(r.bounceCategory).toBe('mailbox_full');
    expect(r.confidence).toBe(0.95);
  });

  it('parses 5.7.1 blocked', () => {
    const body = `Final-Recipient: RFC822; blocked@example.com
Status: 5.7.1
Diagnostic-Code: smtp; 550 5.7.1 Delivery not authorized`;
    const r = parseBounceContent('Delivery failure', body);
    expect(r.failedRecipientEmail).toBe('blocked@example.com');
    expect(r.bounceCategory).toBe('blocked');
    expect(r.confidence).toBe(0.90);
  });

  it('parses 5.7.9 blocked (spam identified)', () => {
    const body = `Final-Recipient: RFC822; spam-target@example.com
Status: 5.7.9
Diagnostic-Code: smtp; 550 5.7.9 Message has been identified as spam`;
    const r = parseBounceContent('Blocked', body);
    expect(r.bounceCategory).toBe('blocked');
    expect(r.confidence).toBe(0.85);
  });

  it('parses 5.7.3 spam', () => {
    const body = `Final-Recipient: RFC822; spammy@example.com
Status: 5.7.3
Diagnostic-Code: smtp; 550 5.7.3 Spam message rejected`;
    const r = parseBounceContent('Spam rejected', body);
    expect(r.failedRecipientEmail).toBe('spammy@example.com');
    expect(r.bounceCategory).toBe('spam');
    expect(r.confidence).toBe(0.90);
  });

  it('parses 4.x.x temporary', () => {
    const body = `Final-Recipient: RFC822; temp@example.com
Status: 4.2.1
Diagnostic-Code: smtp; 452 4.2.1 Mailbox busy`;
    const r = parseBounceContent('Temporary failure', body);
    expect(r.bounceCategory).toBe('temporary');
    expect(r.confidence).toBe(0.60);
  });

  it('parses 5.4.4 network (unable to route)', () => {
    const body = `Final-Recipient: RFC822; unrouteable@example.com
Status: 5.4.4
Diagnostic-Code: smtp; 550 5.4.4 Unable to route`;
    const r = parseBounceContent('Network error', body);
    expect(r.bounceCategory).toBe('network');
    expect(r.confidence).toBe(0.80);
  });

  // ── Raw SMTP Codes (Zoho, some MTAs) ────────────────────────────────────

  it('parses Zoho DSN with Status: 550 (raw SMTP code)', () => {
    const body = `This message was created automatically by mail delivery software.
A message that you sent could not be delivered to one or more of its recipients. This is a permanent error.

marketing@hello-performance.com, ERROR CODE :550 - Unroutable address

Final-Recipient: rfc822; marketing@hello-performance.com
Status: 550
Action: failed
Diagnostic-Code: Unroutable address`;
    const r = parseBounceContent('Undelivered Mail Returned to Sender', body);
    expect(r.failedRecipientEmail).toBe('marketing@hello-performance.com');
    expect(r.bounceCategory).toBe('invalid_mailbox');
    expect(r.confidence).toBe(0.90);
  });

  it('parses Zoho Status: 421 (raw SMTP temporary)', () => {
    const body = `Final-Recipient: rfc822; temp@example.com
Status: 421
Action: failed
Diagnostic-Code: Service not available`;
    const r = parseBounceContent('Undelivered Mail Returned to Sender', body);
    expect(r.failedRecipientEmail).toBe('temp@example.com');
    expect(r.bounceCategory).toBe('temporary');
    expect(r.confidence).toBe(0.60);
  });

  it('extracts email and category from Zoho body text without DSN headers', () => {
    const body = `This message was created automatically by mail delivery software.
A message that you sent could not be delivered to one or more of its recipients. This is a permanent error.

booking@brighton.salon, ERROR CODE :421 - Host not reachable.

Reporting-MTA: dns; mx.zohomail.eu`;
    const r = parseBounceContent('Undelivered Mail Returned to Sender', body);
    expect(r.failedRecipientEmail).toBe('booking@brighton.salon');
    // Should detect temporary from body text keywords (421, host not reachable)
    expect(r.bounceCategory).toBe('temporary');
    expect(r.confidence).toBe(0.50);
  });

  it('extracts from body text with mailbox unavailable message', () => {
    const body = `johndoe@email.com, ERROR CODE :550 - Requested action not taken: mailbox unavailable`;
    const r = parseBounceContent('Undelivered Mail Returned to Sender', body);
    expect(r.failedRecipientEmail).toBe('johndoe@email.com');
    expect(r.bounceCategory).toBe('invalid_mailbox');
  });

  // ── Provider-specific ───────────────────────────────────────────────────

  it('parses Microsoft 365 DSN with multi-line diagnostic', () => {
    const body = `Your message to volvoparts@parkplace.com couldn't be delivered.
volvoparts wasn't found at parkplace.com.
Final-Recipient: RFC822; volvoparts@parkplace.com
Status: 5.1.10
Diagnostic-Code: smtp; 550 5.1.10 RESOLVER.ADR.RecipientNotFound`;
    const r = parseBounceContent('Undeliverable: Park Place Volvo', body);
    expect(r.failedRecipientEmail).toBe('volvoparts@parkplace.com');
    expect(r.bounceCategory).toBe('invalid_mailbox');
  });

  it('parses Mailgun DSN', () => {
    const body = `Final-Recipient: RFC822; bad@example.com
Status: 5.1.1
Diagnostic-Code: SMTP; 550 5.1.1 <bad@example.com>: Recipient address rejected: Mailbox not found`;
    const r = parseBounceContent('Mailgun permanent failure', body);
    expect(r.failedRecipientEmail).toBe('bad@example.com');
    expect(r.bounceCategory).toBe('invalid_mailbox');
    expect(r.confidence).toBe(1);
  });

  it('parses Amazon SES DSN', () => {
    const body = `Final-Recipient: RFC822; bounce@example.com
Status: 5.1.1
Diagnostic-Code: smtp; 550 5.1.1 Address rejected`;
    const r = parseBounceContent('Amazon SES bounce', body);
    expect(r.failedRecipientEmail).toBe('bounce@example.com');
    expect(r.bounceCategory).toBe('invalid_mailbox');
    expect(r.confidence).toBe(1);
  });

  it('parses Sendgrid DSN', () => {
    const body = `Final-Recipient: RFC822; invalid@example.com
Status: 5.1.1
Diagnostic-Code: SMTP; 550 5.1.1 The email account that you tried to reach does not exist`;
    const r = parseBounceContent('Sendgrid bounce', body);
    expect(r.failedRecipientEmail).toBe('invalid@example.com');
    expect(r.bounceCategory).toBe('invalid_mailbox');
    expect(r.confidence).toBe(1);
  });

  it('parses Exim DSN', () => {
    const body = `Final-Recipient: RFC822; unknown@eximtest.com
Status: 5.1.1
Diagnostic-Code: X-Postfix; host mx.test.com said: 550 5.1.1 <unknown@eximtest.com>: User unknown`;
    const r = parseBounceContent('Mail delivery failed', body);
    expect(r.failedRecipientEmail).toBe('unknown@eximtest.com');
    expect(r.bounceCategory).toBe('invalid_mailbox');
    expect(r.confidence).toBe(1);
  });

  // ── Generic RFC 3464 ────────────────────────────────────────────────────

  it('handles DSN with X-Failed-Recipients', () => {
    const body = `X-Failed-Recipients: failed@example.com
Final-Recipient: RFC822; failed@example.com
Status: 5.1.1
Diagnostic-Code: smtp; 550 5.1.1 User unknown`;
    const r = parseBounceContent('Mail delivery failed', body);
    expect(r.failedRecipientEmail).toBe('failed@example.com');
    expect(r.bounceCategory).toBe('invalid_mailbox');
  });

  it('handles DSN with Original-Recipient (no Final-Recipient)', () => {
    const body = `Original-Recipient: RFC822; orig@example.com
Status: 5.1.1
Diagnostic-Code: smtp; 550 5.1.1 Mailbox not found`;
    const r = parseBounceContent('Mail delivery failed', body);
    expect(r.failedRecipientEmail).toBe('orig@example.com');
  });

  it('returns unknown category for bounce-like text without status', () => {
    const r = parseBounceContent('Mail delivery failed', 'No further information');
    expect(r.failedRecipientEmail).toBeNull();
    expect(r.confidence).toBe(0.30);
    expect(r.bounceCategory).toBe('unknown');
  });

  it('filters out mailer-daemon as failed recipient', () => {
    const body = `Final-Recipient: RFC822; MAILER-DAEMON@mail.zoho.eu
Status: 5.1.1
Diagnostic-Code: smtp; 550 5.1.1 Mailbox not found`;
    const r = parseBounceContent('Undelivered Mail', body);
    expect(r.failedRecipientEmail).toBeNull();
    expect(r.confidence).toBe(0);
    expect(r.bounceCategory).toBeNull();
  });

  it('filters out postmaster as failed recipient', () => {
    const body = `Final-Recipient: RFC822; POSTMASTER@example.com
Status: 5.1.1`;
    const r = parseBounceContent('Delivery Status Notification', body);
    expect(r.failedRecipientEmail).toBeNull();
    expect(r.confidence).toBe(0);
  });

  it('parses Microsoft 365 "could not be delivered" link in body', () => {
    const body = `Your message to volvoparts@parkplace.com couldn't be delivered.
volvoparts wasn't found at parkplace.com.`;
    const r = parseBounceContent('Undeliverable', body);
    expect(r.failedRecipientEmail).toBe('volvoparts@parkplace.com');
    expect(r.bounceCategory).toBe('invalid_mailbox');
  });
});

describe('isBounceSender', () => {
  it('detects mailer-daemon', () => {
    expect(isBounceSender('mailer-daemon@mail.zoho.eu')).toBe(true);
  });

  it('detects postmaster', () => {
    expect(isBounceSender('postmaster@example.com')).toBe(true);
  });

  it('detects mail delivery system', () => {
    expect(isBounceSender('Mail Delivery System <mailer-daemon@example.com>')).toBe(true);
  });

  it('returns false for normal senders', () => {
    expect(isBounceSender('user@example.com')).toBe(false);
  });

  it('returns false for null', () => {
    expect(isBounceSender(null)).toBe(false);
  });
});

describe('isMailerDaemon', () => {
  it('detects mailer-daemon by inclusion', () => {
    expect(isMailerDaemon('mailer-daemon@mail.zoho.eu')).toBe(true);
    expect(isMailerDaemon('MAILER-DAEMON@GOOGLEMAIL.COM')).toBe(true);
  });

  it('detects postmaster', () => {
    expect(isMailerDaemon('postmaster@example.com')).toBe(true);
  });

  it('returns false for normal email', () => {
    expect(isMailerDaemon('user@example.com')).toBe(false);
  });
});

describe('shouldAutoSuppressBounce', () => {
  it('suppresses invalid_mailbox at confidence >= 0.90', () => {
    expect(shouldAutoSuppressBounce({ failedRecipientEmail: 'a@b.com', bounceCategory: 'invalid_mailbox', confidence: 0.90, evidence: null })).toBe(true);
    expect(shouldAutoSuppressBounce({ failedRecipientEmail: 'a@b.com', bounceCategory: 'invalid_mailbox', confidence: 1.00, evidence: null })).toBe(true);
    expect(shouldAutoSuppressBounce({ failedRecipientEmail: 'a@b.com', bounceCategory: 'invalid_mailbox', confidence: 0.95, evidence: null })).toBe(true);
  });

  it('does NOT suppress invalid_mailbox below 0.90', () => {
    expect(shouldAutoSuppressBounce({ failedRecipientEmail: 'a@b.com', bounceCategory: 'invalid_mailbox', confidence: 0.85, evidence: null })).toBe(false);
    expect(shouldAutoSuppressBounce({ failedRecipientEmail: 'a@b.com', bounceCategory: 'invalid_mailbox', confidence: 0.50, evidence: null })).toBe(false);
  });

  it('does NOT suppress non-invalid categories even at high confidence', () => {
    expect(shouldAutoSuppressBounce({ failedRecipientEmail: 'a@b.com', bounceCategory: 'blocked', confidence: 0.95, evidence: null })).toBe(false);
    expect(shouldAutoSuppressBounce({ failedRecipientEmail: 'a@b.com', bounceCategory: 'temporary', confidence: 0.95, evidence: null })).toBe(false);
    expect(shouldAutoSuppressBounce({ failedRecipientEmail: 'a@b.com', bounceCategory: 'mailbox_full', confidence: 0.95, evidence: null })).toBe(false);
    expect(shouldAutoSuppressBounce({ failedRecipientEmail: 'a@b.com', bounceCategory: 'network', confidence: 0.95, evidence: null })).toBe(false);
    expect(shouldAutoSuppressBounce({ failedRecipientEmail: 'a@b.com', bounceCategory: 'policy', confidence: 0.95, evidence: null })).toBe(false);
    expect(shouldAutoSuppressBounce({ failedRecipientEmail: 'a@b.com', bounceCategory: 'spam', confidence: 0.95, evidence: null })).toBe(false);
    expect(shouldAutoSuppressBounce({ failedRecipientEmail: 'a@b.com', bounceCategory: 'domain_not_found', confidence: 0.95, evidence: null })).toBe(false);
    expect(shouldAutoSuppressBounce({ failedRecipientEmail: 'a@b.com', bounceCategory: 'unknown', confidence: 0.95, evidence: null })).toBe(false);
  });
});
