import crypto from 'node:crypto';

// 12-byte random → 16-char base64url. Cryptographically random, opaque, URL-safe.
// Never encodes lead/contact IDs.
export function generateInviteToken(): string {
  return crypto.randomBytes(12).toString('base64url');
}

// SHA-256 hash for privacy-aware IP/UA logging.
export function privacyHash(value: string, salt: string): string {
  return crypto.createHash('sha256').update(salt + ':' + value).digest('hex');
}
