import { pool, query } from '../db.js';
import { verifyDomain } from '../services/dnsVerify.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const domain = arg('domain');
  if (!domain) {
    console.error('Usage: verify-domain --domain X');
    process.exit(1);
  }

  const rows = await query('SELECT id FROM domains WHERE domain=? LIMIT 1', [domain.toLowerCase()]);
  if (!rows.length) {
    console.error(`Domain not found: ${domain}`);
    process.exit(1);
  }
  const result = await verifyDomain(rows[0].id);
  console.log(JSON.stringify(result, null, 2));
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
