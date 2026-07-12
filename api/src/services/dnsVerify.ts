import dns from 'node:dns/promises';
import crypto from 'node:crypto';
import { query } from '../db.js';

export interface DnsRecordSpec {
  type: 'TXT' | 'CNAME' | 'MX';
  host: string;
  expected: string;
  purpose: 'spf' | 'dkim' | 'dmarc' | 'tracking' | 'return_path' | 'mx';
}

export function generateDkimKeypair(): { publicKey: string; privateKey: string; dnsValue: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const pubB64 = publicKey
    .replace('-----BEGIN PUBLIC KEY-----', '')
    .replace('-----END PUBLIC KEY-----', '')
    .replace(/\s+/g, '');
  return {
    publicKey,
    privateKey,
    dnsValue: `v=DKIM1; k=rsa; p=${pubB64}`,
  };
}

export function expectedRecords(domain: string, dkimSelector: string, dkimDnsValue: string, platformDomain: string): DnsRecordSpec[] {
  return [
    { type: 'TXT', host: domain,                                  expected: `v=spf1 include:_spf.${platformDomain} ~all`, purpose: 'spf' },
    { type: 'TXT', host: `${dkimSelector}._domainkey.${domain}`,  expected: dkimDnsValue,                                  purpose: 'dkim' },
    { type: 'TXT', host: `_dmarc.${domain}`,                       expected: `v=DMARC1; p=quarantine; rua=mailto:postmaster@${domain}`, purpose: 'dmarc' },
    { type: 'CNAME', host: `bounces.${domain}`,                    expected: `bounces.${platformDomain}`,                  purpose: 'return_path' },
  ];
}

async function lookupTxt(host: string): Promise<string[]> {
  try {
    const r = await dns.resolveTxt(host);
    return r.map((parts) => parts.join(''));
  } catch {
    return [];
  }
}

async function lookupCname(host: string): Promise<string[]> {
  try {
    return await dns.resolveCname(host);
  } catch {
    return [];
  }
}

export async function verifyDomain(domainId: number): Promise<{ status: 'verified' | 'failed' | 'warning'; detail: any }> {
  const rows = await query(
    'SELECT id, tenant_id, domain, dkim_selector, dkim_public_key FROM domains WHERE id=? LIMIT 1',
    [domainId],
  );
  if (!rows.length) throw new Error('Domain not found');
  const d = rows[0];
  const platformDomain = process.env.PLATFORM_DOMAIN ?? 'email.clients.help';

  // Recover DKIM dns value from stored public key
  const pubB64 = (d.dkim_public_key ?? '')
    .replace('-----BEGIN PUBLIC KEY-----', '')
    .replace('-----END PUBLIC KEY-----', '')
    .replace(/\s+/g, '');
  const dkimDnsValue = `v=DKIM1; k=rsa; p=${pubB64}`;

  const records = expectedRecords(d.domain, d.dkim_selector, dkimDnsValue, platformDomain);
  const results: Array<{ purpose: string; ok: boolean; got: string[]; expected: string }> = [];

  for (const r of records) {
    let got: string[] = [];
    if (r.type === 'TXT')   got = await lookupTxt(r.host);
    if (r.type === 'CNAME') got = await lookupCname(r.host);

    let ok: boolean;
    if (r.purpose === 'spf') {
      // SPF must be ONE merged record co-existing with the tenant's existing provider
      // (Zoho/Spacemail). Don't demand an exact string — pass if the live SPF record
      // includes our platform mechanism. Avoids forcing a record that breaks current sending.
      ok = got.some((v) => /^v=spf1\b/i.test(v.trim()) && v.includes(`_spf.${platformDomain}`));
    } else if (r.purpose === 'dmarc') {
      // Any valid DMARC policy is acceptable (p=none/quarantine/reject) — operators often
      // keep p=none initially. Only require a well-formed DMARC1 record to exist.
      ok = got.some((v) => /^v=DMARC1\b/i.test(v.trim()) && /\bp=(none|quarantine|reject)\b/i.test(v));
    } else {
      ok = got.some((v) => v.includes(r.expected) || v === r.expected);
    }
    results.push({ purpose: r.purpose, ok, got, expected: r.expected });
  }

  const fails = results.filter((r) => !r.ok);
  const status: 'verified' | 'failed' | 'warning' =
    fails.length === 0 ? 'verified' : fails.length >= 3 ? 'failed' : 'warning';

  await query(
    'UPDATE domains SET status=?, last_checked_at=NOW(), last_status_detail=? WHERE id=?',
    [status, JSON.stringify(results), domainId],
  );

  return { status, detail: results };
}
