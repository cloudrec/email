import argon2 from 'argon2';
import { v4 as uuid } from 'uuid';
import { pool, query } from '../db.js';

async function main() {
  const email = process.env.SEED_ADMIN_EMAIL ?? 'admin@email.clients.help';
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!password) {
    console.error('[seed] SEED_ADMIN_PASSWORD env required');
    process.exit(1);
  }

  // Plans
  await query(
    `INSERT IGNORE INTO plans
       (code, name, price_cents, currency, billing_period, max_contacts, max_sends_month, max_send_daily, max_domains, max_users, max_automations, max_api_calls_day, storage_mb, is_active, is_public)
     VALUES
       ('free','Free / Trial',0,'USD','manual',500,2000,500,1,2,2,5000,100,1,1),
       ('starter','Starter',1900,'USD','month',5000,50000,5000,2,5,10,30000,1000,1,1),
       ('pro','Pro',4900,'USD','month',25000,250000,25000,5,15,30,120000,5000,1,1),
       ('agency','Agency',14900,'USD','month',100000,1000000,100000,20,50,100,500000,20000,1,1)`,
  );

  const existing = await query('SELECT id FROM users WHERE email=? LIMIT 1', [email.toLowerCase()]);
  if (existing.length) {
    console.log(`[seed] admin user already exists: ${email}`);
  } else {
    const hash = await argon2.hash(password, { type: argon2.argon2id });
    await query(
      `INSERT INTO users (uuid, email, password_hash, full_name, locale, is_super_admin, email_verified_at)
       VALUES (?, ?, ?, 'Super Admin', 'en', 1, NOW())`,
      [uuid(), email.toLowerCase(), hash],
    );
    console.log(`[seed] super admin created: ${email}`);
  }

  await pool.end();
}

main().catch((e) => {
  console.error('[seed] fail', e);
  process.exit(1);
});
