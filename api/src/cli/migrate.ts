import fs from 'node:fs/promises';
import path from 'node:path';
import { pool } from '../db.js';

const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR ?? '/migrations';

async function ensureTable() {
  const c = await pool.getConnection();
  try {
    await c.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename VARCHAR(200) PRIMARY KEY,
        applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB`);
  } finally {
    c.release();
  }
}

async function appliedSet(): Promise<Set<string>> {
  const c = await pool.getConnection();
  try {
    const rows = await c.query('SELECT filename FROM schema_migrations');
    return new Set(rows.map((r: any) => r.filename));
  } finally {
    c.release();
  }
}

async function applyFile(file: string, body: string) {
  const c = await pool.getConnection();
  try {
    await c.beginTransaction();
    const statements = body
      .split(/;\s*$/m)
      .map((s) =>
        s.split('\n')
          .filter((line) => !line.trim().startsWith('--'))
          .join('\n')
          .trim(),
      )
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      await c.query(stmt);
    }
    await c.query('INSERT INTO schema_migrations (filename) VALUES (?)', [file]);
    await c.commit();
    console.log(`[migrate] applied ${file}`);
  } catch (e) {
    await c.rollback();
    throw e;
  } finally {
    c.release();
  }
}

async function main() {
  await ensureTable();
  const done = await appliedSet();
  const files = (await fs.readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const f of files) {
    if (done.has(f)) {
      console.log(`[migrate] skip ${f}`);
      continue;
    }
    const body = await fs.readFile(path.join(MIGRATIONS_DIR, f), 'utf8');
    await applyFile(f, body);
  }
  await pool.end();
}

main().catch((e) => {
  console.error('[migrate] fail', e);
  process.exit(1);
});
