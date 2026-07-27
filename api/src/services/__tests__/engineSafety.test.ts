import { describe, it, expect } from 'vitest';
import { isTermsStale, daysSince, DEFAULT_TERMS_MAX_AGE_DAYS } from '../engineSafety.js';

const now = new Date('2026-07-27T00:00:00Z');

describe('engine safety — terms staleness (TZ §17)', () => {
  it('treats never-verified terms as stale', () => {
    expect(isTermsStale(null, now)).toBe(true);
    expect(isTermsStale(undefined, now)).toBe(true);
  });

  it('treats an unparseable timestamp as stale', () => {
    expect(isTermsStale('not-a-date', now)).toBe(true);
  });

  it('fresh terms (verified today) are not stale', () => {
    expect(isTermsStale('2026-07-27T00:00:00Z', now)).toBe(false);
  });

  it('terms verified 29 days ago are not stale', () => {
    expect(isTermsStale('2026-06-28T00:00:00Z', now)).toBe(false);
  });

  it('terms verified 31 days ago are stale', () => {
    expect(isTermsStale('2026-06-26T00:00:00Z', now)).toBe(true);
  });

  it('respects a custom max age', () => {
    const sevenDaysAgo = '2026-07-20T00:00:00Z';
    expect(isTermsStale(sevenDaysAgo, now, 30)).toBe(false);
    expect(isTermsStale(sevenDaysAgo, now, 5)).toBe(true);
  });

  it('exposes the default 30-day window', () => {
    expect(DEFAULT_TERMS_MAX_AGE_DAYS).toBe(30);
  });
});

describe('engine safety — daysSince', () => {
  it('returns null for missing/invalid input', () => {
    expect(daysSince(null, now)).toBeNull();
    expect(daysSince('nope', now)).toBeNull();
  });

  it('floors whole days since a timestamp', () => {
    expect(daysSince('2026-07-20T00:00:00Z', now)).toBe(7);
    expect(daysSince('2026-07-26T12:00:00Z', now)).toBe(0);
  });
});
