// Domain reservation gate (Prospect Audit Email Safety Gate). A reserved domain is one
// queued for a new personal audit batch; it must be excluded from every automated
// selection (first-touch, follow-up, warmup) until the owner approves it. This module is
// the single source of truth both the senders and the reserve/import tooling share.
//
// normalizeDomain is pure (unit-testable). loadReservedDomains reads the ACTIVE reservation
// set (released_at IS NULL) so a rollback (setting released_at) instantly re-includes a
// domain with no code change.

export type Queryer = (sql: string, params?: any[]) => Promise<any>;

// Canonical form used everywhere: lowercase, no scheme, no leading www., no path/port,
// no trailing dot. An email or URL can be passed — the domain is extracted.
export function normalizeDomain(input: unknown): string {
  let s = String(input ?? '').trim().toLowerCase();
  if (!s) return '';
  if (s.includes('@')) s = s.split('@').pop() as string;         // email -> domain
  s = s.replace(/^[a-z]+:\/\//, '');                             // strip scheme
  s = s.split('/')[0].split('?')[0].split('#')[0];               // strip path/query
  s = s.split(':')[0];                                           // strip port
  s = s.replace(/^www\./, '').replace(/\.+$/, '');               // strip www. + trailing dots
  return s.trim();
}

// The active reserved set, normalized. Empty set => gate is a no-op (nothing reserved).
export async function loadReservedDomains(query: Queryer): Promise<Set<string>> {
  const rows = (await query(
    'SELECT domain FROM reserved_domains WHERE released_at IS NULL',
  )) as Array<{ domain: string }>;
  const set = new Set<string>();
  for (const r of rows) {
    const d = normalizeDomain(r.domain);
    if (d) set.add(d);
  }
  return set;
}

// True when `value` (a domain OR an email) is on the active reservation list. Matches the
// exact domain and any subdomain of a reserved domain (a reserved example.com also covers
// mail.example.com), so a reservation cannot be sidestepped by a subdomain address.
export function isReserved(value: unknown, reserved: Set<string>): boolean {
  if (reserved.size === 0) return false;
  const d = normalizeDomain(value);
  if (!d) return false;
  if (reserved.has(d)) return true;
  const parts = d.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    if (reserved.has(parts.slice(i).join('.'))) return true;
  }
  return false;
}
