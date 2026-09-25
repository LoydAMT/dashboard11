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
      lastAlert: t?.lastAlert || null,
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
    const first = visibleTags(t)[0]
    return first ? first.entry.v : -1
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

/**
 * Every reading this tenant should show on its tile, in display order.
 *
 * The admin page's choice (mallDisplay) decides WHICH appear and which is
 * first; with nothing configured every reading is shown. The viewer then
 * picks which of them sits on the dial, so the configured order is a
 * default rather than a cage.
 *
 * The accumulator is included deliberately. A dial of it is meaningless -
 * it only rises - but someone wanting the meter total as the tile's headline
 * number is a reasonable thing to want, and the tile renders it without an
 * arc rather than refusing.
 */
export function visibleTags(tenant, chosen = null) {
  const values = tenant?.values || {}
  const has = (k) => values[k] && typeof values[k].v === 'number'

  const picked = chosen
    ? Object.keys(chosen).filter((k) => chosen[k] && has(k))
    : []
  if (picked.length > 0) return picked.map((key) => ({ key, entry: values[key] }))

  // Nothing configured: show everything, with the readings a landlord most
  // often wants first so the default dial is usually the right one.
  const preferred = ['Current', 'Power', 'kW', 'Voltage']
  const keys = Object.keys(values).filter(has)
  keys.sort((a, b) => {
    const ia = preferred.indexOf(a)
    const ib = preferred.indexOf(b)
    if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
    // Accumulators last - they are a total, not a live reading.
    const ka = /kwh/i.test(a) ? 1 : 0
    const kb = /kwh/i.test(b) ? 1 : 0
    return ka !== kb ? ka - kb : a.localeCompare(b)
  })
  return keys.map((key) => ({ key, entry: values[key] }))
}

/**
 * The mall-wide alert feed, newest first.
 *
 * Assembled on the client from one field per tenant rather than fetched.
 * Each tenant carries only its most recent transition, so this is bounded
 * by the number of tenants and there is no log to page through - the full
 * per-tenant history is still on that tenant's own page, which is where
 * someone goes when they want it.
 */
export function recentAlerts(tenants, limit = 6) {
  return tenants
    .filter((t) => t.lastAlert && typeof t.lastAlert.ts === 'number')
    .sort((a, b) => b.lastAlert.ts - a.lastAlert.ts)
    .slice(0, limit)
}
