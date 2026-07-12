// Tavily multi-key rotation.
//
// Reads env keys (TAVILY_API_KEY, TAVILY_API_KEYS, TAVILY_API_KEY_1..N) once at
// startup, deduplicates, assigns each a stable masked label, and exposes a
// rotation API.
//
// Rules:
// - NEVER export, log, or echo the raw secret. Only `label` (e.g. "tvly-…3Jq2")
//   leaves this module.
// - `pick()` returns the first key not currently flagged as exhausted.
// - When the caller hits a credits_exhausted / quota response, it calls
//   `markExhausted(label)` and the keyring excludes that key until the next
//   period boundary (UTC day reset by default).
// - When all keys are exhausted, `pick()` returns null and the caller should
//   surface the credits_exhausted status.
//
// This module is intentionally process-local (no DB). The DB-backed daily /
// monthly safety caps in routes/collector.ts stay in place and apply on top.

export interface TavilyKeyEntry {
  /** Stable label safe to log / show in admin (last 4 chars only). */
  label: string;
  /** Internal key value. Do not export. */
  // Marked `_secret` to discourage external use.
  _secret: string;
}

interface ExhaustionEntry {
  until: number; // epoch ms
  reason: string;
}

class TavilyKeyring {
  private keys: TavilyKeyEntry[] = [];
  private exhaustion = new Map<string, ExhaustionEntry>();
  private cursor = 0;

  /** Re-read env. Idempotent. */
  init(args: { single: string; csv: string; numbered: string[] }) {
    const raw: string[] = [];
    if (args.single) raw.push(args.single);
    if (args.csv) {
      for (const part of args.csv.split(',')) {
        const v = part.trim();
        if (v) raw.push(v);
      }
    }
    for (const v of args.numbered) if (v) raw.push(v);

    // Dedup, preserve order.
    const seen = new Set<string>();
    const keys: TavilyKeyEntry[] = [];
    for (const k of raw) {
      if (seen.has(k)) continue;
      seen.add(k);
      keys.push({ label: maskKey(k), _secret: k });
    }
    this.keys = keys;
    this.exhaustion.clear();
    this.cursor = 0;
  }

  /** Number of configured keys. */
  size(): number {
    return this.keys.length;
  }

  /** Returns true when at least one key is configured (regardless of exhaustion). */
  hasAnyKey(): boolean {
    return this.keys.length > 0;
  }

  /**
   * Pick the next usable key. Rotation order: starts at cursor, sweeps the
   * full list, returns first non-exhausted key. Advances cursor on success.
   * Returns null if every key is currently exhausted.
   */
  pick(): TavilyKeyEntry | null {
    if (this.keys.length === 0) return null;
    const now = Date.now();
    for (let i = 0; i < this.keys.length; i++) {
      const idx = (this.cursor + i) % this.keys.length;
      const entry = this.keys[idx];
      const ex = this.exhaustion.get(entry.label);
      if (ex && ex.until > now) continue;
      if (ex && ex.until <= now) this.exhaustion.delete(entry.label);
      this.cursor = (idx + 1) % this.keys.length;
      return entry;
    }
    return null;
  }

  /** Mark a key as exhausted until next UTC midnight (or until `untilMs`). */
  markExhausted(label: string, reason: string = 'credits_exhausted', untilMs?: number) {
    if (!label) return;
    const until = untilMs ?? nextUtcMidnightMs();
    this.exhaustion.set(label, { until, reason });
  }

  /** Snapshot for admin status — never leaks the raw secret. */
  status(): { label: string; exhausted: boolean; until: number | null; reason: string | null }[] {
    const now = Date.now();
    return this.keys.map((k) => {
      const ex = this.exhaustion.get(k.label);
      const active = !ex || ex.until <= now;
      return {
        label: k.label,
        exhausted: !active,
        until: active ? null : ex!.until,
        reason: active ? null : ex!.reason,
      };
    });
  }
}

export function maskKey(key: string): string {
  if (!key) return '';
  // Tavily keys look like `tvly-…XXXX`. Show prefix + last 4.
  const visibleEnd = key.slice(-4);
  const prefix = key.startsWith('tvly-') ? 'tvly-' : key.slice(0, 4);
  return `${prefix}…${visibleEnd}`;
}

function nextUtcMidnightMs(): number {
  const now = new Date();
  const next = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0, 0, 0, 0,
  ));
  return next.getTime();
}

export const tavilyKeyring = new TavilyKeyring();
