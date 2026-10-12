import { useCallback, useEffect, useRef, useState } from 'react'

// A reading going past its limit. Spikes and recoveries are in the strip
// and the log; a notice over the page is kept for the thing worth an
// interruption - unless a message went to Telegram about it, which is
// always said.
const BREACH = new Set(['alarm-high', 'alarm-low'])
const LIFE_MS = 15000
const MAX_SHOWN = 4

/**
 * Notices for alerts that arrive while a mall's page is open.
 *
 * Reads nothing of its own: each tenant's newest alert already arrives in
 * mallOverview/{company}, and this only watches for one that is newer than
 * the last it saw. What was already there when the page opened is history,
 * not news, so the first data only sets the baseline.
 *
 * The notice is drawn from the tenant's CURRENT newest alert, not a copy
 * taken when it appeared - so "sent to Telegram", which the server marks a
 * moment after the alert itself, appears on a notice that is already up.
 */
export function useMallAlertToasts(tenants) {
  const seen = useRef(null)            // tenant id -> ts of the newest alert seen
  const timers = useRef(new Map())
  const [open, setOpen] = useState([]) // [{ id, tenantId, ts }]

  const dismiss = useCallback((id) => {
    const timer = timers.current.get(id)
    if (timer) { clearTimeout(timer); timers.current.delete(id) }
    setOpen((list) => list.filter((n) => n.id !== id))
  }, [])

  useEffect(() => {
    if (tenants.length === 0) return
    const first = seen.current === null
    if (first) seen.current = new Map()
    const fresh = []
    for (const t of tenants) {
      const a = t.lastAlert
      if (!a || typeof a.ts !== 'number') continue
      const before = seen.current.get(t.id)
      if (before !== undefined && a.ts <= before) continue
      seen.current.set(t.id, a.ts)
      if (!first && BREACH.has(a.kind)) fresh.push({ id: `${t.id}_${a.ts}`, tenantId: t.id, ts: a.ts })
    }
    if (fresh.length === 0) return
    for (const n of fresh) {
      timers.current.set(n.id, setTimeout(() => dismiss(n.id), LIFE_MS))
    }
    setOpen((list) => [...list, ...fresh].slice(-MAX_SHOWN))
  }, [tenants, dismiss])

  // Timers die with the page, so none fires into an unmounted component.
  useEffect(() => {
    const all = timers.current
    return () => { for (const timer of all.values()) clearTimeout(timer) }
  }, [])

  const byId = new Map(tenants.map((t) => [t.id, t]))
  const toasts = open.flatMap((n) => {
    const t = byId.get(n.tenantId)
    const a = t?.lastAlert
    // Superseded by a newer alert on the same tenant: that one has its own.
    if (!a || a.ts !== n.ts) return []
    return [{
      id: n.id,
      kind: a.kind,
      level: a.level || 'critical',
      message: `${t.name}: ${a.message}${a.tg ? ' · sent to Telegram' : ''}`,
    }]
  })

  return { toasts, dismiss }
}
