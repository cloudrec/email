// Message-generation quality gate (TZ §9.1). A pure, DB-free content screen that
// runs AFTER macro/spintax resolution (outboundContentGuard) and, for affiliate
// mode, ALONGSIDE the offer-compliance gate (affiliateCompliance / TZ §10). Its job
// is to stop a generated business message from shipping the classic cold-spam tells:
// invented facts, fake familiarity, fabricated case studies, false urgency,
// guaranteed-income / unverified-savings claims, misleading subject lines, a hidden
// affiliate nature, missing sender identity, or a missing opt-out.
//
// Two decision tiers, mirroring affiliateCompliance's blockers/requiresReview split:
//   - `blockers`  — hard, high-precision tells. Any one => MUST NOT send.
//   - `reviewFlags` — fuzzy heuristics (manipulative tone, familiarity, savings
//                     claims). Not a hard block, but forces a human to look first.
// The gate is deliberately fail-closed on the structural checks (identity, opt-out,
// subject) and conservative on the fuzzy ones so it does not swamp real messages.
//
// Pure so every TZ §9.1 tell is unit-testable in isolation (no I/O). The caller is
// responsible for treating `!passed` as a stop and `reviewFlags.length` as a
// human-approval requirement.

export interface MessageQualityContext {
  subject: string;
  body: string;
  // True when this message is a genuine reply in an existing thread. Controls the
  // "RE:/FWD: on a first-touch cold email" misleading-subject check.
  isReply?: boolean;
  // Sender identity must be present. Default true. When senderName is given it must
  // appear in the body; otherwise any signature-shaped block satisfies identity.
  requireSenderIdentity?: boolean;
  senderName?: string | null;
  // Jurisdiction / campaign requires an opt-out mechanism in the body. Default true.
  requireOptOut?: boolean;
  // Affiliate mode: the message must not hide its promotional/affiliate nature.
  // When true, a disclosure must be present (computed upstream by §10) OR the body
  // must carry an ad/sponsored marker — otherwise "hidden affiliate nature" blocks.
  isAffiliate?: boolean;
  disclosurePresent?: boolean;
}

export interface MessageQualityResult {
  passed: boolean;         // true only when blockers is empty
  blockers: string[];      // hard stops (codes)
  reviewFlags: string[];   // soft, needs human review before send
  checks: {
    sender_identity: boolean;
    opt_out: boolean;
    subject_ok: boolean;
    affiliate_disclosed: boolean | null; // null when not affiliate
  };
}

// --- high-precision "block" patterns -----------------------------------------

// Guaranteed income / risk-free money claims.
const GUARANTEED_INCOME = [
  /\bguaranteed?\s+(?:income|profit|profits|returns?|money|earnings?|results?)\b/i,
  /\b(?:earn|make)\s+\$?\d[\d,]*\s*(?:\+|plus)?\s*(?:\/|per\s+)?(?:day|week|month|hour)\b/i,
  /\brisk[-\s]?free\b/i,
  /\bdouble\s+your\s+(?:money|income|investment)\b/i,
  /\b100%\s+(?:guaranteed|returns?|profit)\b/i,
];

// False urgency / artificial scarcity.
const FALSE_URGENCY = [
  /\bact\s+now\b/i,
  /\b(?:limited\s+time|limited\s+offer)\b/i,
  /\bonly\s+today\b/i,
  /\blast\s+chance\b/i,
  /\bexpires?\s+(?:in|today|tonight|soon|within)\b/i,
  /\bhurry\b/i,
  /\bwhile\s+(?:supplies|spots|seats)\s+last\b/i,
  /\bdon'?t\s+miss\s+out\b/i,
];

// Fabricated case studies: a specific outcome stat attributed to an unnamed "client"
// / "customer" / "one company" with no verifiable source. Tight enough to skip real
// cited proof ("per Gartner", "case study at example.com/...").
const FAKE_CASE_STUDY =
  /\b(?:one|a)\s+(?:of\s+our\s+)?(?:clients?|customers?|companies|businesses)\s+(?:saw|got|achieved|increased|grew|boosted|reduced|cut|saved)\b/i;

// Manipulative / high-pressure tone (soft — review, not block).
const MANIPULATIVE = [
  /\byou'?d\s+be\s+(?:crazy|foolish|stupid|mad)\s+not\s+to\b/i,
  /\beveryone(?:'s| is)\s+(?:already\s+)?(?:using|switching|doing)\b/i,
  /\bcan'?t\s+afford\s+(?:to\s+)?(?:miss|ignore|wait)\b/i,
  /\bwhy\s+are\s+you\s+still\b/i,
];

// Fake familiarity on what should be a first touch (soft — review).
const FAKE_FAMILIARITY = [
  /\bas\s+(?:we\s+)?(?:discussed|agreed|promised)\b/i,
  /\b(?:per|following\s+up\s+on)\s+our\s+(?:call|conversation|chat|meeting)\b/i,
  /\bgreat\s+(?:to\s+)?(?:reconnect|catching\s+up|meeting\s+you)\b/i,
  /\bas\s+promised\b/i,
  /\bthanks\s+for\s+(?:the\s+call|your\s+time\s+(?:yesterday|earlier|the\s+other))\b/i,
];

// Unverified savings claims (soft — review; a real, sourced figure should pass a human).
const UNVERIFIED_SAVINGS = [
  /\bsave\s+(?:up\s+to\s+)?\$?\d[\d,]*(?:%|\s*(?:dollars|per|\/))?/i,
  /\bcut\s+(?:your\s+)?costs?\s+by\s+\d/i,
  /\b\d[\d,]*%\s+(?:cheaper|savings?|off\s+your)\b/i,
];

// Opt-out / unsubscribe markers.
const OPT_OUT =
  /\b(?:unsubscribe|opt[-\s]?out|stop\s+receiving|no\s+longer\s+wish|reply\s+(?:with\s+)?["']?stop["']?|remove\s+me|not\s+interested\??\s+reply)\b/i;

// Ad / sponsored disclosure markers (affiliate nature made explicit).
const AD_MARKER =
  /\b(?:this\s+is\s+an\s+advertisement|advertisement|sponsored|affiliate\s+link|paid\s+partnership|#ad\b|#sponsored\b|promotional\s+(?:email|message))\b/i;

// A signature-shaped identity block: a sign-off line followed by a name/company.
const SIGNATURE_SHAPE =
  /\b(?:regards|best|thanks|cheers|sincerely|warm\s+regards|kind\s+regards)\s*,?\s*\n+\s*\S/i;

function anyMatch(patterns: RegExp[], s: string): boolean {
  return patterns.some((re) => re.test(s));
}

export function evaluateMessageQuality(ctx: MessageQualityContext): MessageQualityResult {
  const subject = String(ctx.subject ?? '').trim();
  const body = String(ctx.body ?? '');
  const both = `${subject}\n${body}`;
  const blockers: string[] = [];
  const reviewFlags: string[] = [];

  // --- hard blocks ---
  if (anyMatch(GUARANTEED_INCOME, both)) blockers.push('guaranteed_income_claim');
  if (anyMatch(FALSE_URGENCY, both)) blockers.push('false_urgency');
  if (FAKE_CASE_STUDY.test(both)) blockers.push('fabricated_case_study');

  // Misleading subject: RE:/FWD: prefix on a message that is not an actual reply.
  const subjectMisleading = !ctx.isReply && /^\s*(?:re|fw|fwd)\s*:/i.test(subject);
  if (subjectMisleading) blockers.push('misleading_subject');

  // Sender identity.
  const requireIdentity = ctx.requireSenderIdentity !== false;
  let identityOk = true;
  if (requireIdentity) {
    identityOk = ctx.senderName
      ? new RegExp(`\\b${escapeRe(ctx.senderName.trim())}\\b`, 'i').test(body)
      : SIGNATURE_SHAPE.test(body);
    if (!identityOk) blockers.push('missing_sender_identity');
  }

  // Opt-out.
  const requireOptOut = ctx.requireOptOut !== false;
  let optOutOk = true;
  if (requireOptOut) {
    optOutOk = OPT_OUT.test(body);
    if (!optOutOk) blockers.push('missing_opt_out');
  }

  // Hidden affiliate nature.
  let affiliateDisclosed: boolean | null = null;
  if (ctx.isAffiliate) {
    affiliateDisclosed = ctx.disclosurePresent === true || AD_MARKER.test(both);
    if (!affiliateDisclosed) blockers.push('hidden_affiliate_nature');
  }

  // --- soft review flags ---
  if (anyMatch(MANIPULATIVE, both)) reviewFlags.push('manipulative_language');
  if (anyMatch(FAKE_FAMILIARITY, both)) reviewFlags.push('fake_familiarity');
  if (anyMatch(UNVERIFIED_SAVINGS, both)) reviewFlags.push('unverified_savings_claim');

  return {
    passed: blockers.length === 0,
    blockers,
    reviewFlags,
    checks: {
      sender_identity: identityOk,
      opt_out: optOutOk,
      subject_ok: !subjectMisleading,
      affiliate_disclosed: affiliateDisclosed,
    },
  };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
