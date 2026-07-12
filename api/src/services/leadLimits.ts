import { query } from '../db.js';

export interface LeadLimits {
  enabled: boolean;
  maxLeadsMonth: number;
  maxSourcesMonth: number;
  maxVerificationsMonth: number;
  exportAllowed: boolean;
  usage: {
    leadsDiscovered: number;
    sourcesAdded: number;
    verifications: number;
    exports: number;
  };
}

function currentPeriod(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export async function getLeadLimits(tenantId: number): Promise<LeadLimits> {
  const rows = await query(
    `SELECT t.lead_discovery_enabled,
            COALESCE(t.override_max_discovered_leads_month,    p.max_discovered_leads_month)    AS m_leads,
            COALESCE(t.override_max_source_domains_month,      p.max_source_domains_month)      AS m_sources,
            COALESCE(t.override_max_verification_checks_month, p.max_verification_checks_month) AS m_verif,
            p.lead_export_allowed
     FROM tenants t
     LEFT JOIN plans p ON p.id = t.plan_id
     WHERE t.id = ? LIMIT 1`,
    [tenantId],
  );
  if (!rows.length) throw new Error('tenant_not_found');
  const r = rows[0];

  const usage = (await query(
    'SELECT leads_discovered, sources_added, verifications, exports FROM lead_usage_month WHERE tenant_id=? AND period=? LIMIT 1',
    [tenantId, currentPeriod()],
  ))[0] ?? { leads_discovered: 0, sources_added: 0, verifications: 0, exports: 0 };

  return {
    enabled: !!r.lead_discovery_enabled,
    maxLeadsMonth: r.m_leads ?? 0,
    maxSourcesMonth: r.m_sources ?? 0,
    maxVerificationsMonth: r.m_verif ?? 0,
    exportAllowed: !!r.lead_export_allowed,
    usage: {
      leadsDiscovered: usage.leads_discovered ?? 0,
      sourcesAdded: usage.sources_added ?? 0,
      verifications: usage.verifications ?? 0,
      exports: usage.exports ?? 0,
    },
  };
}

export async function incrementUsage(
  tenantId: number,
  field: 'leads_discovered' | 'sources_added' | 'verifications' | 'exports',
  delta = 1,
): Promise<void> {
  const period = currentPeriod();
  await query(
    `INSERT INTO lead_usage_month (tenant_id, period, ${field})
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE ${field} = ${field} + VALUES(${field})`,
    [tenantId, period, delta],
  );
}

export type LimitCheck = { ok: true } | { ok: false; reason: string; remaining: number };

export function checkLeadsRoom(limits: LeadLimits, wantedAdds: number): LimitCheck {
  if (!limits.enabled) return { ok: false, reason: 'lead_discovery_disabled', remaining: 0 };
  const remaining = limits.maxLeadsMonth - limits.usage.leadsDiscovered;
  return wantedAdds <= remaining ? { ok: true } : { ok: false, reason: 'leads_month_quota', remaining: Math.max(0, remaining) };
}

export function checkSourcesRoom(limits: LeadLimits, wantedAdds: number): LimitCheck {
  if (!limits.enabled) return { ok: false, reason: 'lead_discovery_disabled', remaining: 0 };
  const remaining = limits.maxSourcesMonth - limits.usage.sourcesAdded;
  return wantedAdds <= remaining ? { ok: true } : { ok: false, reason: 'sources_month_quota', remaining: Math.max(0, remaining) };
}

export function checkVerificationsRoom(limits: LeadLimits, wantedAdds: number): LimitCheck {
  if (!limits.enabled) return { ok: false, reason: 'lead_discovery_disabled', remaining: 0 };
  const remaining = limits.maxVerificationsMonth - limits.usage.verifications;
  return wantedAdds <= remaining ? { ok: true } : { ok: false, reason: 'verifications_month_quota', remaining: Math.max(0, remaining) };
}

export function checkExportAllowed(limits: LeadLimits): LimitCheck {
  if (!limits.enabled) return { ok: false, reason: 'lead_discovery_disabled', remaining: 0 };
  return limits.exportAllowed ? { ok: true } : { ok: false, reason: 'export_not_allowed_on_plan', remaining: 0 };
}
