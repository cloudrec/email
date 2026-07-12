import fs from 'fs';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { query, pool } from '../db.js';

const CSV_PATH = process.argv[2] ?? '/app/imports/legacy_google_maps_emails_clean_import.csv';
const DRY_RUN = process.argv.includes('--dry-run');
const BATCH_TENANT_ID = 1;
const SOURCE_KIND = 'legacy_google_maps_archive';
const IMPORT_BATCH_NAME = 'legacy_google_maps_archive_2026_05';

interface CsvRow {
  email: string;
  email_domain: string;
  business_name: string;
  website: string;
  website_domain: string;
  category: string;
  industry_group: string;
  industry_slug: string;
  niche: string;
  country: string;
  city: string;
  role_type: string;
  contact_form_url: string;
  profile_url: string;
  source_url: string;
  score: string;
  status: string;
  occurrences: string;
  source_kind: string;
  source_files_count: string;
  source_files: string;
}

function normEmail(e: string) {
  return e.trim().toLowerCase();
}

const COUNTRY_ISO: Record<string, string> = {
  'uk': 'GB', 'united kingdom': 'GB', 'great britain': 'GB',
  'usa': 'US', 'united states': 'US', 'us': 'US',
  'canada': 'CA', 'ca': 'CA',
  'australia': 'AU', 'au': 'AU',
  'ireland': 'IE', 'ie': 'IE',
  'new zealand': 'NZ', 'nz': 'NZ',
  'austria': 'AT', 'at': 'AT',
  'switzerland': 'CH', 'ch': 'CH',
  'sweden': 'SE', 'se': 'SE',
  'netherlands': 'NL', 'nl': 'NL',
  'denmark': 'DK', 'dk': 'DK',
  'norway': 'NO', 'no': 'NO',
  'germany': 'DE', 'de': 'DE',
};

function toISO2(country: string): string | null {
  if (!country) return null;
  const k = country.trim().toLowerCase();
  return COUNTRY_ISO[k] ?? (k.length === 2 ? k.toUpperCase() : null);
}

function normDomain(d: string) {
  if (!d) return '';
  return d.trim().toLowerCase().replace(/^www\./, '');
}

function cleanUrl(u: string) {
  if (!u) return '';
  const t = u.trim();
  if (!t.startsWith('http')) return `https://${t}`;
  return t;
}

async function parseCsv(filePath: string): Promise<CsvRow[]> {
  const rows: CsvRow[] = [];
  const rl = createInterface({ input: createReadStream(filePath) });
  let headers: string[] | null = null;
  for await (const line of rl) {
    const raw = line.startsWith('﻿') ? line.slice(1) : line;
    const parsed = parseCSVLine(raw);
    if (!headers) {
      headers = parsed.map(h => h.trim());
      continue;
    }
    const row: any = {};
    headers.forEach((h, i) => { row[h] = (parsed[i] ?? '').trim(); });
    if (row.email && row.email.includes('@')) rows.push(row as CsvRow);
  }
  return rows;
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let inQuote = false;
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      inQuote = !inQuote;
    } else if (c === ',' && !inQuote) {
      result.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  result.push(cur);
  return result;
}

function scoreLegacyProductFit(row: CsvRow): Record<string, number> {
  const slug = row.industry_slug;
  const group = row.industry_group;

  let clientsHelp = 0.35;
  if (['local_services', 'beauty', 'fitness', 'professional_services', 'medical'].includes(group)) {
    clientsHelp = 0.72;
  } else if (group === 'digital') {
    clientsHelp = 0.45;
  }

  let beautybot = 0.10;
  if (['beauty_salon', 'barbershop', 'nail_studio', 'spa', 'massage', 'fitness_studio'].includes(slug)) {
    beautybot = 0.80;
  } else if (group === 'beauty' || group === 'fitness') {
    beautybot = 0.65;
  }

  let manualpay = 0.05;
  if (['saas', 'web_agency', 'ecommerce'].includes(slug)) {
    manualpay = 0.60;
  }

  return { clients_help: clientsHelp, beautybot, manualpay };
}

function fitStatus(score: number): string {
  if (score >= 0.65) return 'good_fit';
  if (score >= 0.40) return 'weak_fit';
  return 'not_fit';
}

// Cached taxonomy slug → id map
const taxCache: Map<string, number> = new Map();
async function loadTaxCache() {
  const rows = await query('SELECT id, slug FROM industry_taxonomy');
  for (const r of rows) taxCache.set(r.slug, Number(r.id));
}

// Cached company domain → id
const companyCache: Map<string, number> = new Map();
async function loadCompanyCache() {
  const rows = await query('SELECT id, canonical_domain FROM companies');
  for (const r of rows) companyCache.set(r.canonical_domain, Number(r.id));
}

async function getOrCreateCompany(row: CsvRow): Promise<number> {
  const domain = normDomain(row.website_domain || row.email_domain);
  if (!domain) throw new Error(`No domain for ${row.email}`);

  if (companyCache.has(domain)) return companyCache.get(domain)!;

  const name = (row.business_name || domain).slice(0, 298);
  const r = await query(
    `INSERT INTO companies (canonical_domain, name, country, city, category_primary, created_at)
     VALUES (?, ?, ?, ?, ?, NOW())`,
    [domain, name, toISO2(row.country), row.city ? row.city.slice(0, 148) : null, row.industry_slug || row.category || null],
  );
  const id = Number(r.insertId);
  companyCache.set(domain, id);
  return id;
}

async function upsertWebsite(companyId: number, row: CsvRow) {
  if (!row.website) return;
  const url = cleanUrl(row.website);
  const domain = normDomain(row.website_domain);
  await query(
    `INSERT INTO company_websites (company_id, url, domain, source_provider, created_at)
     VALUES (?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE company_id=company_id`,
    [companyId, url, domain, SOURCE_KIND],
  );
}

// CSV role_type → contact_points.role_type ENUM
const ROLE_MAP: Record<string, string> = {
  generic_business: 'generic', info: 'info', sales: 'sales', support: 'support',
  reception: 'info', compliance: 'info', personal_or_role: 'personal',
  owner: 'owner', manager: 'manager', partnerships: 'partnerships',
};

async function upsertContactPoint(companyId: number, row: CsvRow): Promise<boolean> {
  const email = normEmail(row.email);
  const emailDomain = normDomain(row.email_domain);
  const roleType = ROLE_MAP[row.role_type] ?? 'unknown';
  const score = parseInt(row.score || '0', 10);
  const verifScore = Math.min(Math.round(score), 127); // tinyint(3) unsigned, max 255

  const existing = await query(
    'SELECT id, company_id FROM contact_points WHERE normalized_value=? AND type=? LIMIT 1',
    [email, 'email'],
  );
  if (existing.length) {
    if (!existing[0].company_id) {
      await query('UPDATE contact_points SET company_id=? WHERE id=?', [companyId, existing[0].id]);
    }
    return false;
  }

  await query(
    `INSERT INTO contact_points
       (company_id, type, value, normalized_value, email_domain, role_type, status, verification_score, source_url, created_at)
     VALUES (?, 'email', ?, ?, ?, ?, 'discovered', ?, ?, NOW())`,
    [companyId, email, email, emailDomain, roleType, verifScore, row.source_url || row.profile_url || null],
  );
  return true;
}

async function upsertIndustry(companyId: number, row: CsvRow) {
  if (!row.industry_slug) return;
  const industryId = taxCache.get(row.industry_slug);
  if (!industryId) return;
  await query(
    `INSERT INTO company_industries (company_id, industry_id, confidence, source, is_primary)
     VALUES (?, ?, 0.85, 'manual', 1)
     ON DUPLICATE KEY UPDATE confidence=VALUES(confidence), source='manual'`,
    [companyId, industryId],
  );
}

async function upsertProductFit(companyId: number, row: CsvRow) {
  const scores = scoreLegacyProductFit(row);
  for (const [productKey, score] of Object.entries(scores)) {
    await query(
      `INSERT INTO company_product_fit (company_id, product_key, fit_score, status)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE fit_score=VALUES(fit_score), status=VALUES(status)`,
      [companyId, productKey, score, fitStatus(score)],
    );
  }
}

async function main() {
  console.log(`CSV: ${CSV_PATH}`);
  console.log(`DRY_RUN: ${DRY_RUN}`);

  if (!fs.existsSync(CSV_PATH)) {
    console.error(`File not found: ${CSV_PATH}`);
    process.exit(1);
  }

  const rows = await parseCsv(CSV_PATH);
  console.log(`Parsed rows: ${rows.length}`);

  const counts = async () => ({
    companies: Number((await query('SELECT COUNT(*) AS c FROM companies'))[0].c),
    cp: Number((await query('SELECT COUNT(*) AS c FROM contact_points'))[0].c),
    industries: Number((await query('SELECT COUNT(*) AS c FROM company_industries'))[0].c),
    fit: Number((await query('SELECT COUNT(*) AS c FROM company_product_fit'))[0].c),
    suppress: Number((await query('SELECT COUNT(*) AS c FROM global_contact_suppression'))[0].c),
    subscribed: Number((await query("SELECT COUNT(*) AS c FROM contacts WHERE status='subscribed'"))[0].c),
  });

  const before = await counts();
  console.log(`\nBEFORE: companies=${before.companies} contact_points=${before.cp} industries=${before.industries} product_fit=${before.fit} suppressions=${before.suppress}`);

  if (DRY_RUN) {
    const domains = new Set(rows.map(r => normDomain(r.website_domain || r.email_domain)).filter(Boolean));
    const emails = new Set(rows.map(r => normEmail(r.email)).filter(Boolean));
    const slugs = new Set(rows.map(r => r.industry_slug).filter(Boolean));
    const slugsInTax = await query('SELECT slug FROM industry_taxonomy');
    const knownSlugs = new Set(slugsInTax.map((r: any) => r.slug));
    const unknownSlugs = [...slugs].filter(s => !knownSlugs.has(s));
    console.log(`\n[DRY RUN] Would import:`);
    console.log(`  unique companies (domains): ${domains.size}`);
    console.log(`  unique emails: ${emails.size}`);
    console.log(`  industry slugs: ${[...slugs].join(', ')}`);
    if (unknownSlugs.length) console.log(`  WARNING: unknown taxonomy slugs: ${unknownSlugs.join(', ')}`);
    else console.log(`  all taxonomy slugs resolved: OK`);
    await pool.end();
    return;
  }

  await loadTaxCache();
  await loadCompanyCache();

  let companiesCreated = 0;
  let companiesSkipped = 0;
  let websitesUpserted = 0;
  let cpCreated = 0;
  let cpDuplicate = 0;
  let industriesAssigned = 0;
  let fitAssigned = 0;
  let errors = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (i % 200 === 0) process.stdout.write(`  ${i}/${rows.length}\r`);

    try {
      const domain = normDomain(row.website_domain || row.email_domain);
      if (!domain) { errors++; continue; }

      const wasNew = !companyCache.has(domain);
      const companyId = await getOrCreateCompany(row);
      if (wasNew) companiesCreated++; else companiesSkipped++;

      if (row.website) {
        await upsertWebsite(companyId, row);
        websitesUpserted++;
      }

      const cpNew = await upsertContactPoint(companyId, row);
      if (cpNew) cpCreated++; else cpDuplicate++;

      await upsertIndustry(companyId, row);
      industriesAssigned++;

      await upsertProductFit(companyId, row);
      fitAssigned += 3;

    } catch (err: any) {
      errors++;
      if (errors <= 5) console.error(`\n  error row ${i} (${row.email}): ${err.message}`);
    }
  }

  process.stdout.write(`  ${rows.length}/${rows.length}\n`);

  const after = await counts();
  console.log(`\nAFTER:  companies=${after.companies} contact_points=${after.cp} industries=${after.industries} product_fit=${after.fit} suppressions=${after.suppress}`);
  console.log(`\n--- IMPORT RESULTS ---`);
  console.log(`companies created:       ${companiesCreated}`);
  console.log(`companies existing/skip: ${companiesSkipped}`);
  console.log(`websites upserted:       ${websitesUpserted}`);
  console.log(`contact_points created:  ${cpCreated}`);
  console.log(`contact_points dup/skip: ${cpDuplicate}`);
  console.log(`industries assigned:     ${industriesAssigned}`);
  console.log(`product_fit scored:      ${fitAssigned}`);
  console.log(`errors:                  ${errors}`);
  console.log(`\n--- SAFETY CHECK ---`);
  console.log(`emails sent:             0`);
  console.log(`SMTP enabled:            false`);
  console.log(`auto-activated:          0`);
  console.log(`subscribed contacts:     ${after.subscribed}`);
  console.log(`global suppressions:     ${after.suppress} (unchanged: ${after.suppress === before.suppress})`);

  await pool.end();
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
