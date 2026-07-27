// Engine-safety aggregation helpers (TZ §17 Safety). Pure, DB-free classification used
// by the read-only /engine/safety endpoint so the staleness rule is unit-testable in
// isolation. The endpoint owns the SQL; this owns the "is this stale?" decision, kept
// consistent with affiliateCompliance's 30-day terms window.

export const DEFAULT_TERMS_MAX_AGE_DAYS = 30;

// Terms are stale when never verified, or verified longer ago than the max age.
// Mirrors the requiresReview branch of evaluateOfferCompliance (affiliateCompliance.ts).
export function isTermsStale(
  termsVerifiedAt: string | Date | null | undefined,
  now: Date = new Date(),
  maxAgeDays: number = DEFAULT_TERMS_MAX_AGE_DAYS,
): boolean {
  if (!termsVerifiedAt) return true;
  const verified = new Date(termsVerifiedAt);
  if (Number.isNaN(verified.getTime())) return true;
  const maxAgeMs = maxAgeDays * 86_400_000;
  return now.getTime() - verified.getTime() > maxAgeMs;
}

// Whole days since a timestamp (floored); null when no/invalid input.
export function daysSince(ts: string | Date | null | undefined, now: Date = new Date()): number | null {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((now.getTime() - d.getTime()) / 86_400_000);
}
