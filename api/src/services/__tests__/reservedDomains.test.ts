import { describe, it, expect } from 'vitest';
import { normalizeDomain, isReserved } from '../reservedDomains.js';

describe('reserved domains — normalizeDomain', () => {
  it('lowercases and strips www / trailing dot', () => {
    expect(normalizeDomain('WWW.Example.COM.')).toBe('example.com');
  });
  it('extracts the domain from an email', () => {
    expect(normalizeDomain('info@Foo.co.uk')).toBe('foo.co.uk');
  });
  it('strips scheme, path, query, port', () => {
    expect(normalizeDomain('https://www.bar.com:443/path?x=1#h')).toBe('bar.com');
  });
  it('returns empty for junk', () => {
    expect(normalizeDomain('')).toBe('');
    expect(normalizeDomain(null)).toBe('');
    expect(normalizeDomain('   ')).toBe('');
  });
});

describe('reserved domains — isReserved', () => {
  const set = new Set(['example.com', 'clinic.co.uk']);

  it('matches an exact reserved domain', () => {
    expect(isReserved('example.com', set)).toBe(true);
    expect(isReserved('www.example.com', set)).toBe(true);
  });
  it('matches an email on a reserved domain', () => {
    expect(isReserved('hello@clinic.co.uk', set)).toBe(true);
  });
  it('matches a subdomain of a reserved domain', () => {
    expect(isReserved('mail.example.com', set)).toBe(true);
    expect(isReserved('info@booking.clinic.co.uk', set)).toBe(true);
  });
  it('does NOT match an unrelated domain', () => {
    expect(isReserved('other.com', set)).toBe(false);
    expect(isReserved('notexample.com', set)).toBe(false);
  });
  it('does NOT match a domain that merely contains a reserved one as a suffix substring', () => {
    // "myexample.com" is not a subdomain of "example.com"
    expect(isReserved('myexample.com', set)).toBe(false);
  });
  it('empty reservation set never matches (gate is a no-op)', () => {
    expect(isReserved('example.com', new Set())).toBe(false);
  });
});
