import { Router, Request, Response } from 'express';
import { pool } from '../db.js';
import crypto from 'node:crypto';

export const seoBlogRouter = Router();

const TOKEN = process.env.SEO_PUBLISH_TOKEN ?? '';

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function checkToken(req: Request, res: Response): boolean {
  const auth = req.headers.authorization ?? '';
  if (!TOKEN || !auth.startsWith('Bearer ')) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  try {
    if (!crypto.timingSafeEqual(Buffer.from(auth.slice(7)), Buffer.from(TOKEN))) {
      res.status(403).json({ error: 'forbidden' });
      return false;
    }
  } catch {
    res.status(403).json({ error: 'forbidden' });
    return false;
  }
  return true;
}

// Ensure table exists on first use
async function ensureTable(): Promise<void> {
  const conn = await pool.getConnection();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS blog_articles (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        slug VARCHAR(300) NOT NULL UNIQUE,
        title VARCHAR(500) NOT NULL,
        excerpt TEXT DEFAULT '',
        body LONGTEXT NOT NULL,
        language VARCHAR(10) DEFAULT 'en',
        status VARCHAR(20) DEFAULT 'draft',
        created_at DATETIME DEFAULT NOW(),
        updated_at DATETIME DEFAULT NOW() ON UPDATE NOW(),
        INDEX idx_slug (slug),
        INDEX idx_status_date (status, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  } finally {
    conn.release();
  }
}

ensureTable().catch(console.error);

// POST /seo/publish
seoBlogRouter.post('/seo/publish', async (req: Request, res: Response) => {
  if (!checkToken(req, res)) return;

  const { title, body, content, slug: rawSlug, excerpt = '', language = 'en', status = 'publish' } = req.body ?? {};
  const articleBody = body || content || '';
  if (!title || !articleBody) {
    res.status(422).json({ error: 'title and body required' });
    return;
  }
  const slug = rawSlug || slugify(title);

  const conn = await pool.getConnection();
  try {
    await conn.query(
      `INSERT INTO blog_articles (slug, title, excerpt, body, language, status)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE title=VALUES(title), excerpt=VALUES(excerpt),
         body=VALUES(body), language=VALUES(language), status=VALUES(status), updated_at=NOW()`,
      [slug, title, excerpt, articleBody, language, status],
    );
    const [row] = await conn.query('SELECT id FROM blog_articles WHERE slug = ?', [slug]) as any[];
    res.json({ ok: true, id: row.id, slug, url: `https://emails.cheap/blog/${slug}` });
  } catch (err: any) {
    res.status(500).json({ error: err.message?.slice(0, 200) });
  } finally {
    conn.release();
  }
});

// GET /blog — public blog listing
seoBlogRouter.get('/blog', async (_req: Request, res: Response) => {
  const conn = await pool.getConnection();
  try {
    const articles = await conn.query(
      `SELECT slug, title, excerpt, language, created_at FROM blog_articles WHERE status='publish' ORDER BY created_at DESC LIMIT 50`,
    ) as any[];
    const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Blog — Emails.Cheap</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f172a;color:#e5e7eb;line-height:1.6}.c{max-width:860px;margin:0 auto;padding:2rem 1.5rem}h1{font-size:2rem;font-weight:700;margin-bottom:.4rem}.m{color:#6b7280;font-size:.9rem}.card{border:1px solid rgba(255,255,255,.08);border-radius:1rem;padding:1.5rem;margin-bottom:1.5rem;background:rgba(255,255,255,.03)}.card h2{font-size:1.15rem;font-weight:600}.card h2 a{color:#e5e7eb;text-decoration:none}.card h2 a:hover{color:#818cf8}.meta{color:#6b7280;font-size:.8rem;margin-top:.6rem}a.read{color:#818cf8;text-decoration:none}header{padding:1rem 1.5rem;border-bottom:1px solid rgba(255,255,255,.07)}.logo{font-weight:700;font-size:1.1rem;color:#818cf8;text-decoration:none}</style>
</head>
<body>
<header><a href="/" class="logo">Emails.Cheap</a></header>
<div class="c">
  <h1>Blog</h1>
  <p class="m" style="margin-bottom:2rem">Email marketing insights, deliverability guides, and platform updates.</p>
  ${articles.length ? articles.map((a: any) => `<div class="card">
    <h2><a href="/blog/${a.slug}">${a.title}</a></h2>
    ${a.excerpt ? `<p class="m" style="margin:.4rem 0 0">${a.excerpt}</p>` : ''}
    <div class="meta">${String(a.created_at).slice(0, 10)} &nbsp;·&nbsp; <a href="/blog/${a.slug}" class="read">Read →</a></div>
  </div>`).join('') : '<p class="m">No posts yet.</p>'}
</div></body></html>`;
    res.setHeader('Content-Type', 'text/html').send(html);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// GET /blog/:slug — public article page
seoBlogRouter.get('/blog/:slug', async (req: Request, res: Response) => {
  const conn = await pool.getConnection();
  try {
    const [article] = await conn.query(
      `SELECT slug, title, excerpt, body, language, created_at FROM blog_articles WHERE slug=? AND status='publish'`,
      [req.params.slug],
    ) as any[];
    if (!article) { res.status(404).json({ error: 'not found' }); return; }
    const date = String(article.created_at).slice(0, 10);
    const html = `<!DOCTYPE html>
<html lang="${article.language}">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${article.title} — Emails.Cheap</title>
<meta name="description" content="${article.excerpt || ''}">
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f172a;color:#e5e7eb;line-height:1.6}.c{max-width:760px;margin:0 auto;padding:2rem 1.5rem}h1{font-size:2rem;font-weight:700;line-height:1.3;margin-bottom:.5rem}.m{color:#6b7280;font-size:.85rem}.prose h1,.prose h2,.prose h3{margin:1.5rem 0 .75rem;font-weight:600}.prose p{margin-bottom:1rem}.prose ul,.prose ol{margin:0 0 1rem 1.5rem}a.back{color:#818cf8;text-decoration:none;font-size:.9rem;display:inline-block;margin-bottom:1.5rem}header{padding:1rem 1.5rem;border-bottom:1px solid rgba(255,255,255,.07)}.logo{font-weight:700;font-size:1.1rem;color:#818cf8;text-decoration:none}</style>
</head>
<body>
<header><a href="/" class="logo">Emails.Cheap</a></header>
<div class="c">
  <a href="/blog" class="back">← Blog</a>
  <h1>${article.title}</h1>
  <p class="m" style="margin-bottom:2rem">${date}</p>
  <div class="prose">${article.body}</div>
</div></body></html>`;
    res.setHeader('Content-Type', 'text/html').send(html);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});
