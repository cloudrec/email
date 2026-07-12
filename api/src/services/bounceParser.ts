export type BounceParseResult = {
  failedRecipientEmail: string | null;
  bounceCategory: string | null;
  confidence: number;
  evidence: string | null;
};

type DsnStatus = {
  status: string;
  category: string;
  confidence: number;
  description: string;
};

// DSN status → bounce category mapping per RFC 3463 / provider conventions.
const DSN_MAP: Record<string, DsnStatus> = {
  '5.1.0': { status: '5.1.0', category: 'invalid_mailbox', confidence: 0.95, description: 'Other address status' },
  '5.1.1': { status: '5.1.1', category: 'invalid_mailbox', confidence: 1.00, description: 'Bad destination mailbox address' },
  '5.1.2': { status: '5.1.2', category: 'domain_not_found', confidence: 0.95, description: 'Bad destination system address' },
  '5.1.3': { status: '5.1.3', category: 'invalid_mailbox', confidence: 0.90, description: 'Bad destination mailbox address syntax' },
  '5.1.4': { status: '5.1.4', category: 'domain_not_found', confidence: 0.90, description: 'Ambiguous address' },
  '5.1.6': { status: '5.1.6', category: 'invalid_mailbox', confidence: 0.95, description: 'Destination mailbox has moved' },
  '5.1.8': { status: '5.1.8', category: 'invalid_mailbox', confidence: 0.90, description: 'Bad sender address' },
  '5.2.1': { status: '5.2.1', category: 'mailbox_full', confidence: 0.95, description: 'Mailbox disabled' },
  '5.2.2': { status: '5.2.2', category: 'mailbox_full', confidence: 0.95, description: 'Mailbox full' },
  '5.2.3': { status: '5.2.3', category: 'mailbox_full', confidence: 0.85, description: 'Message length exceeds limit' },
  '5.2.4': { status: '5.2.4', category: 'mailbox_full', confidence: 0.80, description: 'Mailing list expansion problem' },
  '5.3.0': { status: '5.3.0', category: 'blocked', confidence: 0.80, description: 'Other or undefined mail system status' },
  '5.4.0': { status: '5.4.0', category: 'network', confidence: 0.70, description: 'Other or undefined network status' },
  '5.4.1': { status: '5.4.1', category: 'network', confidence: 0.75, description: 'No answer from host' },
  '5.4.4': { status: '5.4.4', category: 'network', confidence: 0.80, description: 'Unable to route' },
  '5.4.6': { status: '5.4.6', category: 'network', confidence: 0.70, description: 'Routing loop detected' },
  '5.5.0': { status: '5.5.0', category: 'policy', confidence: 0.80, description: 'Other or undefined protocol status' },
  '5.5.1': { status: '5.5.1', category: 'policy', confidence: 0.75, description: 'Invalid command' },
  '5.5.2': { status: '5.5.2', category: 'policy', confidence: 0.80, description: 'Syntax error' },
  '5.5.4': { status: '5.5.4', category: 'blocked', confidence: 0.85, description: 'Message too big for system' },
  '5.6.0': { status: '5.6.0', category: 'policy', confidence: 0.75, description: 'Other or undefined media error' },
  '5.6.1': { status: '5.6.1', category: 'policy', confidence: 0.75, description: 'Media not supported' },
  '5.6.2': { status: '5.6.2', category: 'policy', confidence: 0.75, description: 'Conversion required but prohibited' },
  '5.6.3': { status: '5.6.3', category: 'policy', confidence: 0.75, description: 'Conversion required but not supported' },
  '5.7.0': { status: '5.7.0', category: 'blocked', confidence: 0.85, description: 'Other or undefined security status' },
  '5.7.1': { status: '5.7.1', category: 'blocked', confidence: 0.90, description: 'Delivery not authorized, message refused' },
  '5.7.2': { status: '5.7.2', category: 'policy', confidence: 0.80, description: 'Mailing list expansion prohibited' },
  '5.7.3': { status: '5.7.3', category: 'spam', confidence: 0.90, description: 'Security conversion required but not possible' },
  '5.7.4': { status: '5.7.4', category: 'blocked', confidence: 0.90, description: 'Security features not supported' },
  '5.7.9': { status: '5.7.9', category: 'blocked', confidence: 0.85, description: 'Message has been identified as spam' },
  '5.7.13': { status: '5.7.13', category: 'spam', confidence: 0.90, description: 'Message rejected due to DMARC policy' },
  '5.7.27': { status: '5.7.27', category: 'blocked', confidence: 0.85, description: 'Message rejected due to DMARC policy' },
};

// Raw SMTP code → category (used when DSN headers use bare codes like "550")
const SMTP_MAP: Record<string, DsnStatus> = {
  '421': { status: '421', category: 'temporary', confidence: 0.60, description: 'Service not available, temporary' },
  '450': { status: '450', category: 'temporary', confidence: 0.60, description: 'Mailbox unavailable, temporary' },
  '451': { status: '451', category: 'temporary', confidence: 0.60, description: 'Local error, try again' },
  '452': { status: '452', category: 'temporary', confidence: 0.55, description: 'Insufficient system storage' },
  '550': { status: '550', category: 'invalid_mailbox', confidence: 0.90, description: 'Mailbox unavailable (generic)' },
  '551': { status: '551', category: 'invalid_mailbox', confidence: 0.80, description: 'User not local' },
  '552': { status: '552', category: 'mailbox_full', confidence: 0.85, description: 'Exceeded storage allocation' },
  '553': { status: '553', category: 'blocked', confidence: 0.85, description: 'Mailbox name not allowed' },
  '554': { status: '554', category: 'blocked', confidence: 0.80, description: 'Transaction failed' },
};

/** Map a status string (DSN x.y.z or raw SMTP) to category + confidence. */
function mapStatus(status: string): { category: string; confidence: number } | null {
  // RFC 3463 DSN codes: 5.x.x or 4.x.x
  if (status.startsWith('5.')) {
    const exact = DSN_MAP[status];
    if (exact) return { category: exact.category, confidence: exact.confidence };
    const prefix = status.slice(0, 4);
    const prefixMap: Record<string, DsnStatus> = {
      '5.1.': { status: prefix, category: 'invalid_mailbox', confidence: 0.85, description: 'Address status (unspecified)' },
      '5.2.': { status: prefix, category: 'mailbox_full', confidence: 0.80, description: 'Mailbox status (unspecified)' },
      '5.3.': { status: prefix, category: 'blocked', confidence: 0.75, description: 'Mail system status (unspecified)' },
      '5.4.': { status: prefix, category: 'network', confidence: 0.65, description: 'Network status (unspecified)' },
      '5.5.': { status: prefix, category: 'policy', confidence: 0.70, description: 'Protocol status (unspecified)' },
      '5.6.': { status: prefix, category: 'policy', confidence: 0.70, description: 'Media status (unspecified)' },
      '5.7.': { status: prefix, category: 'blocked', confidence: 0.80, description: 'Security status (unspecified)' },
    };
    const pMatch = prefixMap[prefix];
    if (pMatch) return { category: pMatch.category, confidence: pMatch.confidence };
    return { category: 'invalid_mailbox', confidence: 0.75 };
  }
  if (status.startsWith('4.')) {
    return { category: 'temporary', confidence: 0.60 };
  }
  // Raw SMTP code (3 digits) — Zoho, some MTAs use these in Status: field
  if (/^\d{3}$/.test(status)) {
    const smtp = SMTP_MAP[status];
    if (smtp) return { category: smtp.category, confidence: smtp.confidence };
    // Fallback: 5xx = permanent failure, 4xx = temporary
    if (status.startsWith('5')) return { category: 'invalid_mailbox', confidence: 0.75 };
    if (status.startsWith('4')) return { category: 'temporary', confidence: 0.55 };
  }
  return null;
}

function extractStatusFromText(text: string): { status: string | null; category: string | null; confidence: number } {
  // Match DSN status: Status: 5.1.1 or Status: 550 (raw SMTP)
  const m = text.match(/Status:\s*(\d[\d.]*)/i);
  if (m) {
    const raw = m[1].replace(/\.$/, '');
    const result = mapStatus(raw);
    if (result) return { status: raw, category: result.category, confidence: result.confidence };
  }
  // Match DSN status in diagnostic lines: "550 5.1.1" or "550-5.1.1"
  const m2 = text.match(/(?:550|551|552|553|554|555)\s+(\d+\.\d+\.\d+)/);
  if (m2) {
    const result = mapStatus(m2[1]);
    if (result) return { status: m2[1], category: result.category, confidence: result.confidence };
  }
  // Match bare SMTP code in text like "ERROR CODE :550" or "host said: 550"
  const m3 = text.match(/(?:error\s+code|host\s+said|remote\s+said|reply:\s*)\s*:?\s*(\d{3})\b/i);
  if (m3) {
    const result = mapStatus(m3[1]);
    if (result) return { status: m3[1], category: result.category, confidence: result.confidence };
  }
  return { status: null, category: null, confidence: 0 };
}

function extractFromDsn(text: string): { email: string | null; status: string | null } {
  let email: string | null = null;

  const finalRecipient = text.match(/Final-Recipient:\s*(?:rfc822|RFC822);?\s*(\S+@\S+)/i);
  if (finalRecipient) email = finalRecipient[1].replace(/[<>]/g, '').toLowerCase();

  const origRecipient = text.match(/Original-Recipient:\s*(?:rfc822|RFC822);?\s*(\S+@\S+)/i);
  if (!email && origRecipient) email = origRecipient[1].replace(/[<>]/g, '').toLowerCase();

  const xFailed = text.match(/X-Failed-Recipients:\s*(\S+@\S+)/i);
  if (!email && xFailed) email = xFailed[1].replace(/[<>]/g, '').toLowerCase();

  // Diagnostic-Code text may contain the actual failed address
  const diagCode = text.match(/Diagnostic-Code:\s*(?:smtp|SMTP|X-Postfix|X-Mailgun);?\s*(.*?)(?:\n|$)/i);
  const diagText = diagCode ? diagCode[1] : null;
  if (!email && diagText) {
    const diagAddr = diagText.match(/<([^@\s]+@[^@\s]+)>/);
    if (diagAddr) email = diagAddr[1].toLowerCase();
  }

  return { email, status: extractStatusFromText(text).status };
}

function stripTrailingPunct(s: string): string {
  return s.replace(/[<>;:)\]]+$/, '');
}

function extractFromBodyText(text: string): { email: string | null; category: string | null; status: string | null } {
  let email: string | null = null;

  // Match "email@domain.com, ERROR CODE :550" style (Zoho)
  const errorCodeLine = text.match(/(\S+@\S+)\s*,\s*(?:ERROR\s+CODE|error\s+code|Error\s+Code)\s*:?\s*\d{3}/i);
  if (errorCodeLine) email = stripTrailingPunct(errorCodeLine[1]).toLowerCase();

  // Match "could not be delivered to one or more recipients. email@domain.com" (Zoho)
  if (!email) {
    const couldNotDeliver = text.match(/could\s+not\s+be\s+delivered\s+[^.]*?\.\s*(\S+@\S+)/i);
    if (couldNotDeliver) email = stripTrailingPunct(couldNotDeliver[1]).toLowerCase();
  }

  const failedDelivery = text.match(/(?:Delivery\s+(?:has\s+)?failed|failed\s+permanently)[^@]*?(\S+@\S+)/i);
  if (!email && failedDelivery) email = stripTrailingPunct(failedDelivery[1]).toLowerCase();

  const recipientFailed = text.match(/The\s+(?:following\s+)?(?:recipient|address)\s*(?:\S+\s+)*?failed[:\s-]+(\S+@\S+)/i);
  if (!email && recipientFailed) email = stripTrailingPunct(recipientFailed[1]).toLowerCase();

  const couldNotDeliverAddr = text.match(/your\s+message\s+(?:to\s+)?(\S+@\S+)\s+couldn'?t?\s+be\s+delivered/i);
  if (!email && couldNotDeliverAddr) email = stripTrailingPunct(couldNotDeliverAddr[1]).toLowerCase();

  const noSuchUser = text.match(/User\s+(?:is\s+)?(?:unknown|not\s+found|doesn'?t\s+exist)[:\s]+(\S+@\S+)/i);
  if (!email && noSuchUser) email = stripTrailingPunct(noSuchUser[1]).toLowerCase();

  const addrWithCode = text.match(/<([^@\s]+@[^@\s]+)>\s*[:.]?\s*:?\s*(?:host\s+\S+\s+said\s*:\s*)?\d{3}\s[\d.]+\s+/i);
  if (!email && addrWithCode) email = addrWithCode[1].toLowerCase();

  const addrNotDelivered = text.match(/<([^@\s]+@[^@\s]+)>\s*[:.]?\s*:?\s*(?:recipient\s+)?(?:rejected|unknown|not\s+found|does\s+not\s+accept|unrouteable|no\s+mailbox|no\s+such)/i);
  if (!email && addrNotDelivered) email = addrNotDelivered[1].toLowerCase();

  const genericAngle = text.match(/<([^@\s]+@[^@\s]+)>\s*[:.]?\s*:?\s*(?:was\s+)?not\s+delivered/i);
  if (!email && genericAngle) email = genericAngle[1].toLowerCase();

  const statusResult = extractStatusFromText(text);
  let category = statusResult.category;

  // Infer category from body text keywords when no DSN status is available.
  if (!category) {
    if (text.match(/(?:mailbox\s+(?:unavailable|disabled|not\s+found|doesn'?t\s+exist|rejected|inactive)|no\s+(?:such\s+)?(?:mailbox|user|recipient)|address\s+(?:rejected|does\s+not\s+exist|invalid|not\s+found|doesn'?t\s+exist)|recipient\s+(?:rejected|unknown|invalid)|wasn'?t\s+found\s+at|was\s+not\s+found\s+at)/i)) {
      category = 'invalid_mailbox';
    } else if (text.match(/mailbox\s+(?:full|is\s+full|over\s+quota|quota\s+exceeded|disk\s+quota)/i)) {
      category = 'mailbox_full';
    } else if (text.match(/spam|bulk\s+mail|unsolicited|blacklisted|UCE/i)) {
      category = 'spam';
    } else if (text.match(/(?:blocked|banned|refused|not\s+allowed|not\s+authorized|policy\s+reject)/i)) {
      category = 'blocked';
    } else if (text.match(/domain\s+(?:not\s+found|does\s+not\s+exist|invalid|doesn'?t\s+exist|cannot\s+be\s+found)/i)) {
      category = 'domain_not_found';
    } else if (text.match(/unroutable\s+address/i)) {
      category = 'invalid_mailbox';
    } else if (text.match(/host\s+(?:not\s+reachable|unreachable|not\s+found|unknown)/i)) {
      category = 'network';
    } else if (text.match(/temporarily|try\s+again|later|busy|timeout|temporary\s+failure|try\s+again\s+later/i)) {
      category = 'temporary';
    } else if (text.match(/connection\s+(?:refused|timed?\s*out|failed|reset)|unreachable|network|dns\s+error/i)) {
      category = 'network';
    } else if (text.match(/policy/i)) {
      category = 'policy';
    }
  }

  return { email, category, status: statusResult.status };
}

export function parseBounceContent(subject: string | null, body: string | null): BounceParseResult {
  const text = `${subject ?? ''} \n ${body ?? ''}`;

  const dsnResult = extractFromDsn(text);
  const bodyResult = extractFromBodyText(text);

  let failedRecipientEmail: string | null = dsnResult.email || bodyResult.email;
  let bounceCategory: string | null = dsnResult.status
    ? (extractStatusFromText(text).category || bodyResult.category)
    : (bodyResult.category || null);
  let confidence = 0;
  let evidence: string | null = null;

  // Determine confidence based on source quality.
  if (dsnResult.email && dsnResult.status) {
    // Full DSN with status code and recipient: use status-based confidence.
    const sc = extractStatusFromText(text);
    confidence = sc.confidence || 0.95;
    evidence = `DSN ${dsnResult.status} → ${bounceCategory || 'unknown'}: ${dsnResult.email}`;
  } else if (dsnResult.email) {
    // DSN headers present but no explicit status code.
    confidence = 0.85;
    evidence = `DSN header recipient: ${dsnResult.email}`;
  } else if (bodyResult.email && bodyResult.category) {
    // Body text extraction with clear category.
    const bCat = bodyResult.category;
    if (bCat === 'invalid_mailbox') confidence = 0.80;
    else if (bCat === 'mailbox_full') confidence = 0.75;
    else if (bCat === 'blocked' || bCat === 'spam') confidence = 0.70;
    else if (bCat === 'domain_not_found') confidence = 0.75;
    else if (bCat === 'temporary') confidence = 0.50;
    else confidence = 0.60;
    evidence = `body text heuristic → ${bCat}: ${bodyResult.email}`;
  } else if (bodyResult.email) {
    confidence = 0.40;
    evidence = `body text fallback: ${bodyResult.email}`;
  } else if (text.match(/mailer-daemon|postmaster|mail delivery|delivery failed|undeliverable|failure notice/i)) {
    // Bounce-like but no recipient found.
    const match = text.match(/mailer-daemon|postmaster|mail delivery|delivery failed|undeliverable|failure notice/i);
    confidence = 0.30;
    bounceCategory = 'unknown';
    evidence = `bounce-like but no recipient extracted (matched "${match?.[0] ?? 'unknown'}")`;
  }

  // Filter out mailer-daemon/postmaster as failed recipients.
  if (failedRecipientEmail) {
    const fe = failedRecipientEmail.toLowerCase();
    if (fe.includes('mailer-daemon') || fe.includes('postmaster')) {
      failedRecipientEmail = null;
      bounceCategory = null;
      confidence = 0;
      evidence = 'sender is mailer-daemon/postmaster — not a real failed recipient';
    }
  }

  // If confidence was determined via body text but bounceCategory was missing, set based on text.
  if (!bounceCategory && failedRecipientEmail && confidence > 0) {
    bounceCategory = 'unknown';
  }

  return { failedRecipientEmail, bounceCategory, confidence, evidence };
}

export function isBounceSender(fromEmail: string | null): boolean {
  if (!fromEmail) return false;
  const e = fromEmail.toLowerCase();
  return e.includes('mailer-daemon') || e.includes('postmaster') || e.includes('mail delivery system') || e === 'mailer-daemon@mail.zoho.eu' || e === 'postmaster@asbury.onmicrosoft.com';
}

export function isMailerDaemon(fromEmail: string | null): boolean {
  if (!fromEmail) return false;
  const e = fromEmail.toLowerCase();
  return e.includes('mailer-daemon') || e.includes('postmaster');
}

/** Whether auto-suppression should be applied based on bounce category and confidence. */
export function shouldAutoSuppressBounce(result: BounceParseResult): boolean {
  // Only auto-suppress for definitive invalid_mailbox at high confidence.
  if (result.bounceCategory === 'invalid_mailbox' && result.confidence >= 0.90) {
    return true;
  }
  // Do NOT suppress: temporary, mailbox_full, network, policy, spam, domain_not_found, unknown
  return false;
}
