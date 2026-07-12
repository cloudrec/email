import { v4 as uuid } from 'uuid';
import argon2 from 'argon2';
import { pool, query } from '../db.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const email = arg('email');
  const domain = arg('domain');
  const planCode = arg('plan') ?? 'starter';
  const locale = (arg('lang') ?? 'en') as 'en' | 'ru' | 'uk';
  const tempPassword = arg('password') ?? process.env.SEED_TENANT_PASSWORD;

  if (!email || !domain) {
    console.error('Usage: create-tenant --email X --domain Y [--plan starter] [--lang en|ru|uk] [--password ...]');
    process.exit(1);
  }

  const plans = await query('SELECT id FROM plans WHERE code=? LIMIT 1', [planCode]);
  if (!plans.length) {
    console.error(`Unknown plan: ${planCode}`);
    process.exit(1);
  }

  let user = (await query('SELECT id FROM users WHERE email=? LIMIT 1', [email.toLowerCase()]))[0];
  if (!user) {
    if (!tempPassword) {
      console.error('User missing and no --password provided');
      process.exit(1);
    }
    const hash = await argon2.hash(tempPassword, { type: argon2.argon2id });
    const r = await query(
      `INSERT INTO users (uuid, email, password_hash, locale, email_verified_at)
       VALUES (?, ?, ?, ?, NOW())`,
      [uuid(), email.toLowerCase(), hash, locale],
    );
    user = { id: Number(r.insertId) };
    console.log(`[create-tenant] user created: ${email}`);
  }

  const slug = `${domain.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60)}-${Date.now().toString(36)}`;
  const t = await query(
    `INSERT INTO tenants (uuid, slug, name, status, plan_id, default_locale)
     VALUES (?, ?, ?, 'active', ?, ?)`,
    [uuid(), slug, domain, plans[0].id, locale],
  );
  const tenantId = Number(t.insertId);

  await query(
    "INSERT INTO tenant_users (tenant_id, user_id, role, accepted_at) VALUES (?, ?, 'tenant_owner', NOW())",
    [tenantId, user.id],
  );

  console.log(`[create-tenant] tenant ${tenantId} (${slug}) for ${email}`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
