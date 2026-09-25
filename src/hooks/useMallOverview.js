import { useMemo } from 'react'
import { useRtdbValue } from './useRtdbValue'

/**
 * The landlord view for one company: every tenant in it, in ONE listener.
 *
 * WHY NOT JUST SUBSCRIBE TO EACH TENANT
 * Because a mall is ninety of them. Ninety listeners per open tab means
 * ninety round trips before the page says anything, multiplied by however
 * many people in the mall office have it open. This node is written by the
 * alert sweep that already walks every device, so reading it costs one
 * subscription and the server does the fan-in once for everybody.
 *
 * It is a SUMMARY. Live values, alert state, and the daily 22:00 meter
 * reading - no history. Opening a tenant gives you the real dashboard, with
 * its trends, its chart and its full alert log; duplicating any of that here
 * would recreate the traffic this exists to avoid.
 */
export function useMallOverview(companyId, enabled = true) {
  const on = Boolean(companyId) && enabled
  const node = useRtdbValue(on ? `mallOverview/${companyId}` : null, on)

  const tenants = useMemo(() => {
    const raw = node.data?.tenants
    if (!raw) return []
    return Object.entries(raw).map(([id, t]) => ({
      id,
      name: t?.name || id,
      alarm: t?.alarm || 'ok',
      online: t?.online !== false,
      lastSeen: typeof t?.lastSeen === 'number' ? t.lastSeen : null,
      values: t?.values || {},
      kwh: t?.kwh || null,
    }))
  }, [node.data])

  return {
    loading: node.loading,
    // Surfaced rather than swallowed. An empty overview and a denied read
    // look identical on screen otherwise, and the difference is the whole
    // difference between "nothing to report" and "you cannot see this".
    error: node.error,
    tenants,
    totals: node.data?.totals || null,
    updatedAt: node.data?.updatedAt ?? null,
  }
}

/**
 * Tenants that want attention first, then the rest.
 *
 * Offline outranks an alarm: a tenant that stopped reporting while over its
 * threshold is an offline problem, and showing it as "high" would imply the
 * reading is current. Within a band, the heaviest consumer first - on a
 * quiet day that is the only ordering the mall actually cares about.
 */
export function rankTenants(tenants, sortKey = 'attention') {
  const rank = { offline: 0, high: 1, low: 1, ok: 2 }
  const load = (t) => {
    const v = t.values || {}
    const n = v.Current ?? v.Power ?? v.kW ?? null
    return typeof n === 'number' ? n : -1
  }
  const copy = [...tenants]
  if (sortKey === 'kwh') {
    return copy.sort((a, b) => (b.kwh?.deltaKwh ?? -1) - (a.kwh?.deltaKwh ?? -1))
  }
  if (sortKey === 'name') {
    return copy.sort((a, b) => a.name.localeCompare(b.name))
  }
  return copy.sort((a, b) => {
    const d = (rank[a.alarm] ?? 3) - (rank[b.alarm] ?? 3)
    return d !== 0 ? d : load(b) - load(a)
  })
}
