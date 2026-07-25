import { describe, it, expect } from 'vitest';
import { evaluateOfferCompliance, type AffiliateOffer } from '../affiliateCompliance.js';

// A fully compliant baseline offer; each test perturbs one field.
const fresh = new Date();
function base(): AffiliateOffer {
  return {
    id: 1,
    status: 'APPROVED',
    cold_email_allowed: 1,
    tracking_url_template: 'https://track.example.com/click?o=1&s={sub}',
    allowed_geos_json: ['GB', 'US'],
    blocked_geos_json: [],
    required_disclosure: 'This is an advertisement.',
    prohibited_claims_json: ['guaranteed income', 'risk free'],
    terms_verified_at: fresh.toISOString(),
  };
}
const ctxOk = {
  targetGeo: 'GB',
  subject: 'A tool for your team',
  message: 'Hello — a useful product. This is an advertisement.',
  now: fresh,
};

describe('affiliate compliance gate', () => {
  it('passes a fully compliant offer+message', () => {
    const r = evaluateOfferCompliance(base(), ctxOk);
    expect(r.allowed).toBe(true);
    expect(r.blockers).toEqual([]);
  });

  it('blocks an unapproved offer (TZ test 6)', () => {
    const r = evaluateOfferCompliance({ ...base(), status: 'PENDING_REVIEW' }, ctxOk);
    expect(r.allowed).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/not APPROVED/);
  });

  it('blocks when cold email is not permitted (TZ test 7)', () => {
    const r = evaluateOfferCompliance({ ...base(), cold_email_allowed: 0 }, ctxOk);
    expect(r.allowed).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/cold_email_allowed/);
  });

  it('blocks a disallowed geography (TZ test 8)', () => {
    const r = evaluateOfferCompliance(base(), { ...ctxOk, targetGeo: 'RU' });
    expect(r.allowed).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/allowed geos/);
  });

  it('blocks an explicitly blocked geography', () => {
    const r = evaluateOfferCompliance({ ...base(), blocked_geos_json: ['GB'] }, ctxOk);
    expect(r.allowed).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/blocked list/);
  });

  it('forces review on stale terms (TZ test 9)', () => {
    const old = new Date(fresh.getTime() - 40 * 86_400_000).toISOString();
    const r = evaluateOfferCompliance({ ...base(), terms_verified_at: old }, ctxOk);
    expect(r.allowed).toBe(false);
    expect(r.requiresReview).toBe(true);
    expect(r.blockers.join(' ')).toMatch(/stale/);
  });

  it('blocks a missing required disclosure (TZ test 10)', () => {
    const r = evaluateOfferCompliance(base(), { ...ctxOk, message: 'Hello — a useful product.' });
    expect(r.allowed).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/disclosure/);
  });

  it('blocks a prohibited claim (TZ test 11)', () => {
    const r = evaluateOfferCompliance(base(), { ...ctxOk, message: 'Guaranteed income! This is an advertisement.' });
    expect(r.allowed).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/prohibited claim/);
  });

  it('blocks an invalid tracking URL', () => {
    const r = evaluateOfferCompliance({ ...base(), tracking_url_template: 'not-a-url', destination_url: null }, ctxOk);
    expect(r.allowed).toBe(false);
    expect(r.blockers.join(' ')).toMatch(/tracking\/destination URL/);
  });
});
