// Minimal robots.txt parser. Honors User-agent: *, User-agent: <ours>.
// Allow/Disallow exact-prefix match. Crawl-delay (seconds).

export interface RobotsRules {
  allowed: (path: string) => boolean;
  crawlDelaySec: number;
  raw: string;
}

const UA = 'EmailPlatformLeadDiscovery';

const cache = new Map<string, { rules: RobotsRules; expires: number }>();
const TTL_MS = 60 * 60 * 1000;

export async function loadRobots(origin: string): Promise<RobotsRules> {
  const cached = cache.get(origin);
  if (cached && cached.expires > Date.now()) return cached.rules;

  let body = '';
  try {
    const res = await fetch(`${origin}/robots.txt`, {
      headers: { 'user-agent': UA },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) body = (await res.text()).slice(0, 200_000);
  } catch {
    // Network/timeout — treat as no rules (permissive)
  }

  const rules = parse(body);
  cache.set(origin, { rules, expires: Date.now() + TTL_MS });
  return rules;
}

function parse(body: string): RobotsRules {
  if (!body.trim()) return { allowed: () => true, crawlDelaySec: 0, raw: '' };

  const lines = body.split(/\r?\n/);
  // groupings: user-agent -> { disallow:[], allow:[], crawlDelay }
  type Group = { disallow: string[]; allow: string[]; crawlDelay: number };
  const groups: Record<string, Group> = {};
  let currentAgents: string[] = [];

  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [k0, ...rest] = line.split(':');
    const key = k0.trim().toLowerCase();
    const value = rest.join(':').trim();

    if (key === 'user-agent') {
      const ua = value.toLowerCase();
      if (!groups[ua]) groups[ua] = { disallow: [], allow: [], crawlDelay: 0 };
      currentAgents = [ua];
    } else if (currentAgents.length) {
      for (const ua of currentAgents) {
        if (key === 'disallow') groups[ua].disallow.push(value);
        else if (key === 'allow') groups[ua].allow.push(value);
        else if (key === 'crawl-delay') {
          const n = parseFloat(value);
          if (Number.isFinite(n)) groups[ua].crawlDelay = n;
        }
      }
    }
  }

  const ourGroup =
    groups[UA.toLowerCase()] ??
    groups['*'] ??
    { disallow: [], allow: [], crawlDelay: 0 };

  const allowed = (path: string): boolean => {
    // Most-specific (longest) match wins; Allow overrides Disallow on tie.
    let best: { type: 'allow' | 'disallow'; len: number } | null = null;
    for (const p of ourGroup.disallow) {
      if (p === '') continue; // empty Disallow = allow all
      if (path.startsWith(p)) {
        if (!best || p.length > best.len || (p.length === best.len && best.type === 'allow')) {
          best = { type: 'disallow', len: p.length };
        }
      }
    }
    for (const p of ourGroup.allow) {
      if (path.startsWith(p)) {
        if (!best || p.length >= best.len) {
          best = { type: 'allow', len: p.length };
        }
      }
    }
    return !best || best.type === 'allow';
  };

  return { allowed, crawlDelaySec: ourGroup.crawlDelay, raw: body.slice(0, 4000) };
}
