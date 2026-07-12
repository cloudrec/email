import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { authMiddleware, requireSuperAdmin } from '../middleware/auth.js';
import { audit } from '../middleware/audit.js';

export const themeRouter = Router();

// Theme codes are validated against this allow-list (kept in sync with the portal registry).
const THEME_CODES = [
  'mission-control','editorial','midnight','aurora','paper-studio','slate','carbon','ocean','forest',
  'warm-terminal','graphite','sunset','minimal-white','clay','monolith','arctic','studio','cobalt','nord','signal',
];
const themeCode = z.string().refine((v) => THEME_CODES.includes(v), { message: 'unknown_theme' });

async function getDefault(): Promise<string> {
  const rows = await query("SELECT `value` FROM platform_settings WHERE `key`='theme.default' LIMIT 1");
  if (!rows.length) return 'mission-control';
  try { return JSON.parse(rows[0].value); } catch { return rows[0].value ?? 'mission-control'; }
}

// PUBLIC — anyone can read the global default to render the right palette on first paint.
themeRouter.get('/system/theme', async (_req, res) => {
  res.json({ defaultTheme: await getDefault() });
});

// Super-admin: change the global default.
themeRouter.patch('/admin/theme-default', authMiddleware, requireSuperAdmin, async (req, res) => {
  const parsed = z.object({ theme: themeCode }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', detail: parsed.error.flatten() });
  await query(
    `INSERT INTO platform_settings (\`key\`, \`value\`) VALUES ('theme.default', JSON_QUOTE(?))
     ON DUPLICATE KEY UPDATE \`value\` = JSON_QUOTE(VALUES(\`value\`))`,
    [parsed.data.theme],
  );
  await audit(req, 'admin.theme_default.update', undefined, { theme: parsed.data.theme });
  res.json({ ok: true, defaultTheme: parsed.data.theme });
});

// User: read own preference + the global default for convenience.
themeRouter.get('/me/theme', authMiddleware, async (req, res) => {
  const rows = await query('SELECT theme_preference FROM users WHERE id=? LIMIT 1', [req.auth!.userId]);
  res.json({
    userTheme: rows[0]?.theme_preference ?? null,
    defaultTheme: await getDefault(),
  });
});

// User: set or clear own preference. Pass theme=null to revert to site default.
themeRouter.patch('/me/theme', authMiddleware, async (req, res) => {
  const parsed = z.object({ theme: themeCode.nullable() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });
  await query('UPDATE users SET theme_preference=? WHERE id=?', [parsed.data.theme, req.auth!.userId]);
  await audit(req, 'user.theme.update', undefined, { theme: parsed.data.theme });
  res.json({ ok: true, userTheme: parsed.data.theme });
});
