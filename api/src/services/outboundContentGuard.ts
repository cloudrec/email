// Canonical pre-send content blockers for outbound mail.
// Prevents sending broken/unresolved drafts (empty subject/body, leftover
// {{macros}}, spintax, <<<REPLACE>>> fields, or the known broken "the your
// business" phrase seen in production).
//
// IMPORTANT: an identical copy of this logic lives in
// workers/src/manualOutreachDrip.ts (the drip worker is a separate TS package
// and cannot import from api/src). Keep the two in sync — the test suite in
// api/src/services/__tests__/outboundContentGuard.test.ts pins the behaviour.

export function hasUnresolvedMacros(value: unknown): boolean {
  const s = String(value ?? '');
  // {{var}} handlebars-style, or {a|b} leftover spintax.
  return /\{\{[^}]+\}\}/.test(s) || /\{[^{}\n]+\|[^{}\n]+\}/.test(s);
}

export function hasReplacePlaceholder(value: unknown): boolean {
  const s = String(value ?? '');
  // <<< REPLACE: ... >>> operator-fill markers must never ship.
  return /<<<\s*REPLACE[\s\S]*?>>>/i.test(s);
}

export function hasBrokenGrammar(value: unknown): boolean {
  const s = String(value ?? '');
  return /\bthe your\s+\w+/i.test(s);
}

// Returns an array of blocker codes; empty array = content is safe to send.
export function contentBlockers(subject: unknown, body: unknown): string[] {
  const s = String(subject ?? '').trim();
  const b = String(body ?? '').trim();
  const out: string[] = [];
  if (!s) out.push('missing_subject');
  if (!b) out.push('missing_body');
  const both = `${s}\n${b}`;
  if (hasUnresolvedMacros(both)) out.push('unresolved_macro');
  if (hasReplacePlaceholder(both)) out.push('unfilled_replace_field');
  if (hasBrokenGrammar(both)) out.push('broken_grammar');
  return out;
}
